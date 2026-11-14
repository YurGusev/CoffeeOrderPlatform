#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS_FILE = join(REPO_ROOT, "secrets/platform.secrets.sops.yaml");
const SOPS_CONFIG = join(REPO_ROOT, ".sops.yaml");
const DEFAULT_DAYS = 90;
const DEFAULT_ENVIRONMENT = "development";

function usage() {
  return [
    "Использование: node scripts/renew-service-transport-certs.mjs [--check] [--write]",
    "  --days <n>          срок действия новых сертификатов (по умолчанию 90)",
    "  --environment <env> окружение в secrets (по умолчанию development)",
    "  --write             записать результат обратно в SOPS-файл",
    "  --check             только проверить сроки действия, код 1 при истечении",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    days: DEFAULT_DAYS,
    environment: DEFAULT_ENVIRONMENT,
    write: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") options.write = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--days") {
      options.days = Number(argv[++index]);
      if (!Number.isSafeInteger(options.days) || options.days < 2)
        throw new Error("--days требует целое число не меньше 2");
    } else if (argument === "--environment") {
      options.environment = argv[++index];
      if (typeof options.environment !== "string" || !options.environment)
        throw new Error("--environment требует непустое значение");
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`неизвестный аргумент: ${argument}`);
  }
  return options;
}

function sops(arguments_, input) {
  return execFileSync("sops", arguments_, {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function openssl(arguments_) {
  execFileSync("openssl", arguments_, { stdio: "ignore" });
}

function certificateValidity(pem) {
  const text = execFileSync(
    "openssl",
    ["x509", "-noout", "-startdate", "-enddate", "-subjectAltName"],
    { input: pem, encoding: "utf8" },
  );
  const notAfter = /notAfter=(.+)/u.exec(text)?.[1]?.trim();
  const notBefore = /notBefore=(.+)/u.exec(text)?.[1]?.trim();
  const san = /URI:([^,\s]+)/u.exec(text)?.[1];
  return {
    notBefore,
    notAfter,
    notAfterEpochMs: Date.parse(notAfter),
    san,
  };
}

async function issueCertificate(
  directory,
  caCertificate,
  caKey,
  service,
  environment,
  days,
) {
  const prefix = join(directory, service);
  const extension = join(directory, `${service}.ext`);
  await writeFile(
    extension,
    [
      `subjectAltName=URI:spiffe://coffee-platform/${environment}/${service},DNS:${service}.${environment}.svc.coffee-platform.internal`,
      "extendedKeyUsage=serverAuth,clientAuth",
      "keyUsage=digitalSignature,keyEncipherment",
      "basicConstraints=critical,CA:FALSE",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o400 },
  );
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${prefix}.key`,
    "-out",
    `${prefix}.csr`,
    "-subj",
    `/CN=${service}`,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    `${prefix}.csr`,
    "-CA",
    caCertificate,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-days",
    String(days),
    "-extfile",
    extension,
    "-out",
    `${prefix}.crt`,
  ]);
  const [keyPem, certPem] = await Promise.all([
    readFile(`${prefix}.key`, "utf8"),
    readFile(`${prefix}.crt`, "utf8"),
  ]);
  return { keyPem, certPem };
}

function checkOnly(options) {
  const extracted = sops([
    "-d",
    "--extract",
    `["environments"]["${options.environment}"]["security"]["serviceTransportKeys"]`,
    "--output-type",
    "json",
    SECRETS_FILE,
  ]);
  const materials = JSON.parse(extracted);
  const expired = [];
  const services = Object.keys(materials).sort();
  for (const service of services) {
    const material = JSON.parse(materials[service]);
    const { notAfterEpochMs, notAfter } = certificateValidity(material.certPem);
    if (!(notAfterEpochMs > Date.now())) {
      expired.push({ service, notAfter });
      continue;
    }
    if (!(notAfterEpochMs - Date.now() > 7 * 24 * 60 * 60 * 1000))
      expired.push({ service, notAfter, warning: true });
  }
  const hardFailures = expired.filter((entry) => !entry.warning);
  for (const entry of expired)
    process.stdout.write(
      `${entry.warning ? "WARN" : "FAIL"} ${entry.service}: notAfter=${entry.notAfter}\n`,
    );
  process.stdout.write(
    hardFailures.length === 0
      ? `transport certificates: ${services.length} проверено, просроченных нет\n`
      : `transport certificates: просрочено ${hardFailures.length} из ${services.length}\n`,
  );
  return hardFailures.length === 0 ? 0 : 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.check) return checkOnly(options);
  const { load, dump } = await import("js-yaml");
  const plaintext = sops(["-d", "--input-type", "yaml", SECRETS_FILE]);
  const document = load(plaintext);
  const environmentSecrets = document?.environments?.[options.environment];
  if (!environmentSecrets)
    throw new Error(`в secrets нет окружения ${options.environment}`);
  const security = environmentSecrets.security;
  const authority = JSON.parse(security.serviceTransportAuthority);
  if (
    typeof authority.certificatePem !== "string" ||
    typeof authority.privateKeyPem !== "string"
  )
    throw new Error(
      "serviceTransportAuthority не содержит пары сертификат/ключ",
    );
  const authorityValidity = certificateValidity(authority.certificatePem);
  if (!(authorityValidity.notAfterEpochMs > Date.now()))
    throw new Error(
      `CA serviceTransportAuthority истёк ${authorityValidity.notAfter}; перевыпуск CA требует отдельного решения`,
    );

  const services = Object.keys(security.serviceTransportKeys).sort();

  const directory = await mkdtemp(join(tmpdir(), "coffee-transport-renew-"));
  try {
    const caCertificate = join(directory, "ca.crt");
    const caKey = join(directory, "ca.key");
    await writeFile(caCertificate, authority.certificatePem, { mode: 0o400 });
    await writeFile(caKey, authority.privateKeyPem, { mode: 0o400 });
    const issued = [];
    for (const service of services) {
      const { keyPem, certPem } = await issueCertificate(
        directory,
        caCertificate,
        caKey,
        service,
        options.environment,
        options.days,
      );
      security.serviceTransportKeys[service] = JSON.stringify({
        caPem: authority.certificatePem,
        certPem,
        keyPem,
      });
      issued.push({ service, notAfter: certificateValidity(certPem).notAfter });
    }

    const { parseServiceTransportMaterial } =
      await import("../packages/platform-security/dist/index.js");
    for (const service of services)
      parseServiceTransportMaterial(
        security.serviceTransportKeys[service],
        options.environment,
        service,
      );

    const sopsConfig = load(await readFile(SOPS_CONFIG, "utf8"));
    const rule = sopsConfig.creation_rules.find((candidate) =>
      new RegExp(candidate.path_regex, "u").test(
        "secrets/platform.secrets.sops.yaml",
      ),
    );
    if (!rule?.age?.length) throw new Error("в .sops.yaml нет age-получателей");
    const plaintextPath = join(directory, "platform.secrets.yaml");
    await writeFile(
      plaintextPath,
      dump(document, { noRefs: true, lineWidth: 4096 }),
      {
        mode: 0o600,
      },
    );
    const encrypted = sops([
      "-e",
      "--config",
      "/dev/null",
      "--input-type",
      "yaml",
      "--output-type",
      "yaml",
      "--age",
      rule.age.join(","),
      "--unencrypted-regex",
      rule.unencrypted_regex ?? "^(schemaVersion)$",
      plaintextPath,
    ]);

    for (const entry of issued)
      process.stdout.write(
        `issued ${entry.service}: notAfter=${entry.notAfter}\n`,
      );

    if (!options.write) {
      process.stdout.write("dry-run: файл не изменён, добавьте --write\n");
      return 0;
    }
    await writeFile(`${SECRETS_FILE}.next`, encrypted, { mode: 0o600 });
    await rename(`${SECRETS_FILE}.next`, SECRETS_FILE);
    const info = await lstat(SECRETS_FILE);
    process.stdout.write(
      `записано ${services.length} сертификатов в secrets/platform.secrets.sops.yaml (mode ${(info.mode & 0o777).toString(8)})\n`,
    );
    return 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`renew-service-transport-certs: ${error.message}\n`);
  return 1;
});
