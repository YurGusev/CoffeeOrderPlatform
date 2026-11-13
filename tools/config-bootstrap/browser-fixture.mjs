import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { loadPlatformConfig } from "../../scripts/config-lib.mjs";
import { validateLaunchContext } from "../../verification/launch/v1/report.mjs";
import { inspectLaunchCheckout } from "../../verification/launch/v1/scenarios/rollback.mjs";

const CONFIG = "config/platform.yaml";
const RECEIPT = "gates/browser/artifacts/oidc-fixture-lineage.json";
const SHA = /^[0-9a-f]{40}$/u;
const FIXTURE_PROFILE = Object.freeze({
  issuer: "https://idp.fixture.invalid",
  clientId: "realtime-browser-fixture",
  authorizationUrl: "https://idp.fixture.invalid/authorize",
  tokenUrl: "https://idp.fixture.invalid/token",
  jwksUrl: "https://idp.fixture.invalid/keys",
  redirectUri: "https://localhost:8443/auth/callback",
  allowedAlgorithms: ["RS256"],
  actorRefClaim: "actor_ref",
  permissionsClaim: "permissions",
});
const RECEIPT_KEYS = [
  "baseCandidateSha",
  "baseConfigSha256",
  "candidateSha",
  "candidateTreeSha",
  "configBlobSha",
  "configSha256",
  "issuer",
  "profile",
  "runId",
  "schemaVersion",
];
function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }).trim();
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((left, right) => left.localeCompare(right)),
      [...expected].sort((left, right) => left.localeCompare(right)),
    )
  );
}

export function fixtureConfigText(baseText) {
  const marker = "browserOidc: null";
  if (baseText.split(marker).length !== 2) fail("BROWSER_CONFIG_BASE_INVALID");
  const profile = [
    "browserOidc:",
    `  issuer: ${FIXTURE_PROFILE.issuer}`,
    `  clientId: ${FIXTURE_PROFILE.clientId}`,
    `  authorizationUrl: ${FIXTURE_PROFILE.authorizationUrl}`,
    `  tokenUrl: ${FIXTURE_PROFILE.tokenUrl}`,
    `  jwksUrl: ${FIXTURE_PROFILE.jwksUrl}`,
    `  redirectUri: ${FIXTURE_PROFILE.redirectUri}`,
    "  allowedAlgorithms:",
    "    - RS256",
    `  actorRefClaim: ${FIXTURE_PROFILE.actorRefClaim}`,
    `  permissionsClaim: ${FIXTURE_PROFILE.permissionsClaim}`,
  ].join("\n");
  return baseText.replace(marker, profile);
}

export async function validateBrowserFixtureGitLineage({
  candidateRoot,
  baseCandidateSha,
  candidateSha,
  runId,
  configSha256,
}) {
  if (!SHA.test(baseCandidateSha ?? "")) fail("BROWSER_BASE_SHA_INVALID");
  if (
    !SHA.test(candidateSha ?? "") ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(runId ?? "")
  )
    fail("BROWSER_CANDIDATE_INVALID");
  const checkout = await inspectLaunchCheckout(candidateRoot, candidateSha);
  if (checkout.parents.length !== 1 || checkout.parents[0] !== baseCandidateSha)
    fail("BROWSER_BASE_NOT_DIRECT_PARENT");
  git(
    candidateRoot,
    "merge-base",
    "--is-ancestor",
    baseCandidateSha,
    checkout.commitSha,
  );

  const changes = git(
    candidateRoot,
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "--no-renames",
    baseCandidateSha,
    checkout.commitSha,
  );
  if (changes !== `M\t${CONFIG}`) fail("BROWSER_CONFIG_ONLY_LINEAGE_REQUIRED");

  // Fetch raw Git blobs so byte comparison is independent of the worktree encoding.
  const baseBlob = execFileSync(
    "git",
    ["cat-file", "blob", `${baseCandidateSha}:${CONFIG}`],
    {
      cwd: candidateRoot,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const candidateBlob = execFileSync(
    "git",
    ["cat-file", "blob", `${checkout.commitSha}:${CONFIG}`],
    {
      cwd: candidateRoot,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const sourceText = baseBlob.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(baseBlob))
    fail("BROWSER_CONFIG_UTF8_INVALID");
  if (!candidateBlob.equals(Buffer.from(fixtureConfigText(sourceText), "utf8")))
    fail("BROWSER_CONFIG_DELTA_INVALID");
  let baseConfig;
  try {
    baseConfig = parseYaml(sourceText, { json: true });
  } catch {
    fail("BROWSER_CONFIG_BASE_INVALID");
  }
  const currentConfigBytes = await readFile(join(candidateRoot, CONFIG));
  if (!currentConfigBytes.equals(candidateBlob))
    fail("BROWSER_CONFIG_WORKTREE_MISMATCH");
  const currentConfig = await loadPlatformConfig(
    candidateRoot,
    join(candidateRoot, CONFIG),
  );
  const baseValue = baseConfig.browserOidc;
  if (
    baseValue !== null ||
    !isDeepStrictEqual(currentConfig.browserOidc, FIXTURE_PROFILE)
  )
    fail("BROWSER_PROFILE_INVALID");
  const baseWithoutOidc = structuredClone(baseConfig);
  const currentWithoutOidc = structuredClone(currentConfig);
  delete baseWithoutOidc.browserOidc;
  delete currentWithoutOidc.browserOidc;
  if (!isDeepStrictEqual(baseWithoutOidc, currentWithoutOidc))
    fail("BROWSER_CONFIG_SEMANTICS_CHANGED");
  if (
    currentConfig.environment !== "development" ||
    currentConfig.platform?.publicBaseUrl !== "https://localhost:8443"
  )
    fail("BROWSER_PROFILE_ENVIRONMENT_INVALID");
  const baseHash = sha256(baseBlob);
  const configHash = sha256(candidateBlob);
  if (configSha256 !== configHash) fail("BROWSER_CONTEXT_CONFIG_MISMATCH");
  const configBlobSha = git(
    candidateRoot,
    "rev-parse",
    `${checkout.commitSha}:${CONFIG}`,
  );
  if (!/^[0-9a-f]{40}$/u.test(configBlobSha))
    fail("BROWSER_CONFIG_BLOB_INVALID");
  return {
    receipt: {
      schemaVersion: 1,
      profile: "verification-only-pkce-jwks-v1",
      runId,
      baseCandidateSha,
      candidateSha: checkout.commitSha,
      candidateTreeSha: checkout.treeSha,
      baseConfigSha256: baseHash,
      configSha256: configHash,
      configBlobSha,
      issuer: FIXTURE_PROFILE.issuer,
    },
    checkout,
  };
}

async function checkedLineage({ contextPath, baseCandidateSha }) {
  if (!SHA.test(baseCandidateSha ?? "")) fail("BROWSER_BASE_SHA_INVALID");
  const validated = await validateLaunchContext(contextPath);
  const { candidateRoot, context, sourceRoot } = validated;
  const contextInfo = await lstat(contextPath);
  if (
    contextInfo.uid !== process.getuid() ||
    (contextInfo.mode & 0o777) !== 0o400
  )
    fail("BROWSER_CONTEXT_MODE_INVALID");
  if (candidateRoot === sourceRoot) fail("BROWSER_CANDIDATE_INVALID");
  const checked = await validateBrowserFixtureGitLineage({
    candidateRoot,
    baseCandidateSha,
    candidateSha: context.candidateSha,
    runId: context.runId,
    configSha256: context.baseConfigSha256,
  });
  return { receipt: checked.receipt, ...validated };
}

async function lineageArtifactPath(evidenceDir) {
  return join(evidenceDir, RECEIPT);
}

async function ensurePrivateDirectoryTree(root, target) {
  let current = resolve(root);
  const rootInfo = await lstat(current);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== process.getuid() ||
    (rootInfo.mode & 0o077) !== 0 ||
    (await realpath(current)) !== current
  )
    fail("BROWSER_RECEIPT_DIRECTORY_INVALID");
  const suffix = resolve(target)
    .slice(current.length)
    .split("/")
    .filter(Boolean);
  for (const component of suffix) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(current)) !== current
    )
      fail("BROWSER_RECEIPT_DIRECTORY_INVALID");
  }
}

async function verifyPrivateDirectoryTree(root, target) {
  let current = resolve(root);
  const rootInfo = await lstat(current);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== process.getuid() ||
    (rootInfo.mode & 0o077) !== 0 ||
    (await realpath(current)) !== current
  )
    fail("BROWSER_RECEIPT_DIRECTORY_INVALID");
  const suffix = resolve(target)
    .slice(current.length)
    .split("/")
    .filter(Boolean);
  for (const component of suffix) {
    current = join(current, component);
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(current)) !== current
    )
      fail("BROWSER_RECEIPT_DIRECTORY_INVALID");
  }
}

export async function validateBrowserFixtureLineage({
  root,
  contextPath,
  baseCandidateSha,
}) {
  const checked = await checkedLineage({ contextPath, baseCandidateSha });
  if (
    resolve(root) !== checked.sourceRoot &&
    resolve(root) !== checked.candidateRoot
  )
    fail("BROWSER_SOURCE_ROOT_INVALID");
  const path = await lineageArtifactPath(checked.evidenceDir);
  const parent = dirname(path);
  await ensurePrivateDirectoryTree(checked.evidenceDir, parent);
  const bytes = Buffer.from(`${JSON.stringify(checked.receipt, null, 2)}\n`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
  await chmod(path, 0o400);
  return { ...checked.receipt, receiptPath: path };
}

export async function readBrowserFixtureLineage({
  root,
  contextPath,
  baseCandidateSha,
}) {
  const checked = await checkedLineage({ contextPath, baseCandidateSha });
  if (
    resolve(root) !== checked.sourceRoot &&
    resolve(root) !== checked.candidateRoot
  )
    fail("BROWSER_SOURCE_ROOT_INVALID");
  const { receipt, validated } = await readVerifiedReceipt({
    contextPath,
    lineageArtifactLoc: await lineageArtifactPath(checked.evidenceDir),
  });
  if (
    validated.candidateRoot !== checked.candidateRoot ||
    !isDeepStrictEqual(receipt, checked.receipt)
  )
    fail("BROWSER_RECEIPT_STALE");
  return {
    ...receipt,
    receiptPath: await lineageArtifactPath(checked.evidenceDir),
  };
}

async function readVerifiedReceipt({ contextPath, lineageArtifactLoc }) {
  const validated = await validateLaunchContext(contextPath);
  const expectedPath = await lineageArtifactPath(validated.evidenceDir);
  if (resolve(lineageArtifactLoc) !== expectedPath)
    fail("BROWSER_RECEIPT_PATH_INVALID");
  await verifyPrivateDirectoryTree(
    validated.evidenceDir,
    dirname(expectedPath),
  );
  const info = await lstat(expectedPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o400
  )
    fail("BROWSER_RECEIPT_FILE_INVALID");
  const receipt = JSON.parse(await readFile(expectedPath, "utf8"));
  if (!exactKeys(receipt, RECEIPT_KEYS)) fail("BROWSER_RECEIPT_SCHEMA_INVALID");
  return { validated, receipt };
}

function assertPrivateFile(path, bytes, mode = 0o400) {
  return writeFile(path, bytes, { flag: "wx", mode }).then(() =>
    chmod(path, mode),
  );
}

async function assertTmpfsDirectory(root) {
  const canonical = resolve(root);
  if (canonical !== "/dev/shm" || (await realpath(canonical)) !== canonical)
    fail("BROWSER_TMPFS_REQUIRED");
  const info = await lstat(canonical);
  const fsInfo = await statfs(canonical);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    fsInfo.type !== 0x01021994
  )
    fail("BROWSER_TMPFS_REQUIRED");
}

export async function materializeBrowserFixture({
  root,
  contextPath,
  lineageArtifactLoc,
  publicIngressCaPem,
  tmpfsRoot = "/dev/shm",
}) {
  await assertTmpfsDirectory(tmpfsRoot);
  const { validated, receipt } = await readVerifiedReceipt({
    contextPath,
    lineageArtifactLoc,
  });
  const checked = await checkedLineage({
    contextPath,
    baseCandidateSha: receipt.baseCandidateSha,
  });
  if (
    resolve(root) !== checked.sourceRoot &&
    resolve(root) !== checked.candidateRoot
  )
    fail("BROWSER_SOURCE_ROOT_INVALID");
  if (!isDeepStrictEqual(receipt, checked.receipt))
    fail("BROWSER_RECEIPT_STALE");
  if (validated.candidateRoot !== checked.candidateRoot)
    fail("BROWSER_CANDIDATE_CHANGED");
  if (
    typeof publicIngressCaPem !== "string" ||
    !publicIngressCaPem.startsWith("-----BEGIN CERTIFICATE-----")
  )
    fail("BROWSER_INGRESS_CA_INVALID");
  let ingressCertificate;
  try {
    ingressCertificate = new X509Certificate(publicIngressCaPem);
  } catch {
    fail("BROWSER_INGRESS_CA_INVALID");
  }
  const now = Date.now();
  if (
    !ingressCertificate.ca ||
    Date.parse(ingressCertificate.validFrom) > now ||
    Date.parse(ingressCertificate.validTo) < now
  )
    fail("BROWSER_INGRESS_CA_INVALID");
  const canonicalIngressCaPem = ingressCertificate.toString();

  const fixtureRoot = await mkdtemp(
    join(tmpfsRoot, "coffee-g15-browser-fixture-"),
  );
  const fixtureStat = await lstat(fixtureRoot);
  const fixtureIdentity = {
    dev: fixtureStat.dev,
    ino: fixtureStat.ino,
    uid: fixtureStat.uid,
  };
  const cleanOwned = async () => {
    const current = await lstat(fixtureRoot);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== fixtureIdentity.dev ||
      current.ino !== fixtureIdentity.ino ||
      current.uid !== fixtureIdentity.uid ||
      (await realpath(fixtureRoot)) !== fixtureRoot
    )
      fail("BROWSER_FIXTURE_OWNERSHIP_CHANGED");
    await rm(fixtureRoot, { recursive: true, force: false });
  };
  try {
    await chmod(fixtureRoot, 0o700);
    const certDir = join(fixtureRoot, "certs");
    const idpDir = join(fixtureRoot, "idp");
    const nssDir = join(fixtureRoot, "browser-home/.local/share/pki/nssdb");
    await mkdir(certDir, { mode: 0o700 });
    await mkdir(idpDir, { mode: 0o700 });
    await mkdir(nssDir, { recursive: true, mode: 0o700 });
    const ingressCa = join(certDir, "public-ingress-ca.crt");
    const ingressCaDer = join(certDir, "public-ingress-ca.der");
    await assertPrivateFile(ingressCa, canonicalIngressCaPem);
    const caKey = join(certDir, "fixture-ca.key");
    const caCert = join(certDir, "fixture-ca.crt");
    const caDer = join(certDir, "fixture-ca.der");
    const idpKey = join(idpDir, "idp.key");
    const idpCsr = join(idpDir, "idp.csr");
    const idpCert = join(idpDir, "idp.crt");
    const extPath = join(idpDir, "idp.ext");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "2",
        "-keyout",
        caKey,
        "-out",
        caCert,
        "-subj",
        "/CN=Coffee Browser Fixture CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        "-addext",
        "subjectKeyIdentifier=hash",
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    await chmod(caKey, 0o400);
    await chmod(caCert, 0o400);
    for (const [pem, der] of [
      [ingressCa, ingressCaDer],
      [caCert, caDer],
    ]) {
      execFileSync(
        "/usr/bin/openssl",
        ["x509", "-in", pem, "-outform", "DER", "-out", der],
        {
          stdio: "ignore",
          timeout: 10000,
        },
      );
      await chmod(der, 0o400);
    }
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        idpKey,
        "-out",
        idpCsr,
        "-subj",
        "/CN=idp.fixture.invalid",
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    await chmod(idpKey, 0o400);
    await assertPrivateFile(
      extPath,
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:idp.fixture.invalid\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n",
    );
    execFileSync(
      "/usr/bin/openssl",
      [
        "x509",
        "-req",
        "-in",
        idpCsr,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-out",
        idpCert,
        "-days",
        "2",
        "-sha256",
        "-extfile",
        extPath,
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    await chmod(idpCert, 0o400);
    await rm(idpCsr, { force: true });
    await rm(extPath, { force: true });
    await rm(join(certDir, "fixture-ca.srl"), { force: true });
    await rm(caKey, { force: true });

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwtPrivate = join(idpDir, "jwks-signing.key");
    const jwtPublic = join(idpDir, "jwks.json");
    await assertPrivateFile(jwtPrivate, privateKey);
    const jwk = (await import("node:crypto"))
      .createPublicKey(publicKey)
      .export({ format: "jwk" });
    await assertPrivateFile(
      jwtPublic,
      JSON.stringify({
        keys: [
          {
            kty: "RSA",
            n: jwk.n,
            e: jwk.e,
            use: "sig",
            alg: "RS256",
            kid: "g15-fixture-rs256-v1",
          },
        ],
      }),
    );
    let nssResult;
    try {
      nssResult = execFileSync(
        "/usr/bin/python3",
        [
          fileURLToPath(new URL("./browser-nss-trust.py", import.meta.url)),
          "--database",
          nssDir,
          "--certificate",
          caDer,
          "--certificate",
          ingressCaDer,
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 4096 },
      );
    } catch {
      fail("BROWSER_NSS_IMPORT_FAILED");
    }
    let nssReceipt;
    try {
      nssReceipt = JSON.parse(nssResult.toString("utf8"));
    } catch {
      fail("BROWSER_NSS_RECEIPT_INVALID");
    }
    if (
      !exactKeys(nssReceipt, [
        "certificateCount",
        "schemaVersion",
        "sslTrustedCa",
        "status",
      ]) ||
      nssReceipt.schemaVersion !== 1 ||
      nssReceipt.certificateCount !== 2 ||
      nssReceipt.sslTrustedCa !== true ||
      nssReceipt.status !== "PUBLIC_CA_IMPORTED"
    )
      fail("BROWSER_NSS_RECEIPT_INVALID");
    for (const path of [
      caCert,
      ingressCa,
      idpKey,
      idpCert,
      jwtPrivate,
      jwtPublic,
    ]) {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o777) !== 0o400
      )
        fail("BROWSER_FIXTURE_FILE_MODE_INVALID");
    }
    return {
      profile: "verification-only-pkce-jwks-v1",
      runId: receipt.runId,
      fixtureRoot,
      issuer: FIXTURE_PROFILE.issuer,
      idp: {
        hostname: "idp.fixture.invalid",
        certificatePath: idpCert,
        privateKeyPath: idpKey,
        jwksPath: jwtPublic,
        jwksPrivateKeyPath: jwtPrivate,
      },
      publicIngressCaPath: ingressCa,
      browser: {
        caCertificatePath: caCert,
        nssProfilePath: nssDir,
        homePath: join(fixtureRoot, "browser-home"),
      },
      hashes: {
        caCertificateSha256: sha256(await readFile(caCert)),
        publicIngressCaSha256: sha256(await readFile(ingressCa)),
        idpCertificateSha256: sha256(await readFile(idpCert)),
        jwksSha256: sha256(await readFile(jwtPublic)),
        lineageReceiptSha256: sha256(await readFile(lineageArtifactLoc)),
      },
      cleanup: cleanOwned,
    };
  } catch (error) {
    await cleanOwned();
    throw error;
  }
}

export const BROWSER_FIXTURE_LINEAGE_ARTIFACT = RECEIPT;
