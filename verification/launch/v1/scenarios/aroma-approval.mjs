#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateLaunchContext } from "../../../../scripts/launch-support/launch-context.mjs";

const MAX_APPROVAL_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_TTL_MS = 2 * 60 * 60 * 1000;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/;
const SHA = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const ENCRYPTED =
  /^ENC\[AES256_GCM,data:[^,]+,iv:[^,]+,tag:[^,]+,type:(?:str|bytes)\]$/;
const APPROVER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APPROVAL_MODE = "controlled-live-existing-account";
const EXISTING_ACCOUNT_AUTHORITY = "user-2026-10-23";
const MAX_APPROVED_QUANTITY = 2n;
const SECRET_REFS = Object.freeze(["aroma.email", "aroma.password"]);
const ADMISSION_CONTRACT_PATHS = Object.freeze([
  "config/platform.yaml",
  "config/platform.schema.json",
  "config/nginx-profile.schema.json",
  "secrets/platform.secrets.sops.yaml",
  "verification/launch/v1/schemas/aroma-approval.schema.json",
]);
const ADMISSION_CONTRACT_MAX_BYTES = Object.freeze({
  "config/platform.yaml": 2 * 1024 * 1024,
  "config/platform.schema.json": 2 * 1024 * 1024,
  "config/nginx-profile.schema.json": 512 * 1024,
  "secrets/platform.secrets.sops.yaml": 8 * 1024 * 1024,
  "verification/launch/v1/schemas/aroma-approval.schema.json": 64 * 1024,
});
const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export class AdmissionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new AdmissionError(code);
}

export function canonicalHttpsOrigin(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port ||
    value !== url.origin
  )
    return null;
  if (
    !url.hostname ||
    url.hostname !== url.hostname.toLowerCase() ||
    url.hostname.endsWith(".")
  )
    return null;
  return url.origin;
}

function canonicalFingerprint(value) {
  return typeof value === "string" && FINGERPRINT.test(value);
}

function originHost(value) {
  const origin = canonicalHttpsOrigin(value);
  if (!origin) return null;
  return new URL(origin).hostname.toLowerCase().replace(/\.+$/, "");
}

function isHardcodedProductionOrigin(value) {
  const host = originHost(value);
  return (
    host === "aromateacoffee.ru" ||
    host?.endsWith(".aromateacoffee.ru") === true
  );
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  if (new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19))
    return null;
  return milliseconds;
}

function policyKeys(policy) {
  if (
    !policy ||
    !Array.isArray(policy.trustedApprovers) ||
    !policy.trustedApprovers.length
  )
    fail("POLICY_INVALID");
  const ids = new Set();
  const approvers = new Set();
  const keyMaterial = new Set();
  const trustedKeys = [];
  for (const entry of policy.trustedApprovers) {
    if (
      !APPROVER_ID.test(entry?.keyId ?? "") ||
      !APPROVER_ID.test(entry?.approver ?? "") ||
      ids.has(entry.keyId) ||
      approvers.has(entry.approver)
    )
      fail("POLICY_DUPLICATE_OR_INVALID_APPROVER");
    if (
      typeof entry.publicKeyPem !== "string" ||
      !entry.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----") ||
      entry.publicKeyPem.includes("PRIVATE KEY")
    )
      fail("APPROVER_KEY_INVALID");
    let publicKey;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
    } catch {
      fail("APPROVER_KEY_INVALID");
    }
    if (publicKey.asymmetricKeyType !== "ed25519")
      fail("APPROVER_KEY_TYPE_INVALID");
    const key = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    if (keyMaterial.has(key)) fail("POLICY_DUPLICATE_OR_INVALID_APPROVER");
    ids.add(entry.keyId);
    approvers.add(entry.approver);
    keyMaterial.add(key);
    trustedKeys.push({ ...entry, publicKey });
  }
  return trustedKeys;
}

function matchCredentialRefs(policy, encryptedSecrets, environment) {
  if (
    !Array.isArray(policy.credentialRefs) ||
    policy.credentialRefs.length !== SECRET_REFS.length ||
    policy.credentialRefs.some((ref, index) => ref !== SECRET_REFS[index])
  )
    fail("POLICY_CREDENTIAL_REFS_INVALID");
  const aroma = encryptedSecrets?.environments?.[environment]?.aroma;
  if (
    !aroma ||
    !ENCRYPTED.test(aroma.email ?? "") ||
    !ENCRYPTED.test(aroma.password ?? "")
  )
    return false;
  return true;
}

export function validateAdmission({
  approvalBytes,
  signatureBase64,
  policy,
  identity,
  encryptedSecrets,
  validateApproval,
  now = Date.now(),
  expectedOfferRef,
  expectedQuantity,
}) {
  if (!policy) return { status: "NOT_RUN", code: "SANDBOX_POLICY_ABSENT" };
  if (!identity || !identity.context)
    return { status: "NOT_RUN", code: "LAUNCH_CONTEXT_ABSENT" };
  if (identity.environment === "production")
    fail("PRODUCTION_ENVIRONMENT_DENIED");
  if (!new Set(["development", "staging"]).has(identity.environment))
    fail("ENVIRONMENT_INVALID");
  if (policy.mode !== APPROVAL_MODE) fail("POLICY_MODE_INVALID");
  const policyOrigin = canonicalHttpsOrigin(policy.origin);
  const exception = policy.existingAccountException;
  if (
    !exception ||
    exception.authority !== EXISTING_ACCOUNT_AUTHORITY ||
    canonicalHttpsOrigin(exception.origin) !== policyOrigin ||
    exception.accountFingerprint !== policy.accountFingerprint
  )
    fail("POLICY_EXCEPTION_INVALID");
  const productionOrigins = Array.isArray(policy.productionOrigins)
    ? policy.productionOrigins
    : [];
  const productionFingerprints = Array.isArray(
    policy.productionAccountFingerprints,
  )
    ? policy.productionAccountFingerprints
    : [];
  if (
    !policyOrigin ||
    productionOrigins.some((origin) => !canonicalHttpsOrigin(origin))
  )
    fail("POLICY_ORIGIN_DENIED");
  if (
    !canonicalFingerprint(policy.accountFingerprint) ||
    productionFingerprints.some(
      (fingerprint) => !canonicalFingerprint(fingerprint),
    )
  )
    fail("POLICY_ACCOUNT_DENIED");
  const approvers = policyKeys(policy);
  if (
    identity.credentialsAvailable !== true ||
    !matchCredentialRefs(policy, encryptedSecrets, identity.environment)
  ) {
    return { status: "NOT_RUN", code: "SCOPED_SANDBOX_CREDENTIALS_ABSENT" };
  }
  const context = identity.context;
  if (
    !RUN_ID.test(context.runId ?? "") ||
    !SHA.test(context.candidateSha ?? "") ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`)
  )
    fail("LAUNCH_CONTEXT_INVALID");
  if (
    !Buffer.isBuffer(approvalBytes) ||
    approvalBytes.length === 0 ||
    approvalBytes.length > MAX_APPROVAL_BYTES
  )
    fail("APPROVAL_SIZE_INVALID");
  if (
    typeof signatureBase64 !== "string" ||
    signatureBase64.length > MAX_SIGNATURE_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(signatureBase64)
  )
    fail("SIGNATURE_ENCODING_INVALID");

  let approval;
  const approvalText = approvalBytes.toString("utf8");
  if (!Buffer.from(approvalText, "utf8").equals(approvalBytes))
    fail("APPROVAL_JSON_INVALID");
  try {
    approval = JSON.parse(approvalText);
  } catch {
    fail("APPROVAL_JSON_INVALID");
  }
  if (typeof validateApproval !== "function" || !validateApproval(approval))
    fail("APPROVAL_SCHEMA_INVALID");

  if (
    approval.mode !== APPROVAL_MODE ||
    approval.exceptionAuthority !== exception.authority ||
    approval.origin !== policyOrigin ||
    approval.accountFingerprint !== policy.accountFingerprint ||
    approval.runId !== context.runId ||
    approval.candidateSha !== context.candidateSha
  )
    fail("APPROVAL_BINDING_MISMATCH");
  const productionTarget =
    isHardcodedProductionOrigin(approval.origin) ||
    productionOrigins.some(
      (origin) => originHost(origin) === originHost(approval.origin),
    ) ||
    productionFingerprints.includes(approval.accountFingerprint);
  const exactException =
    exception.authority === approval.exceptionAuthority &&
    exception.origin === approval.origin &&
    exception.accountFingerprint === approval.accountFingerprint;
  if (productionTarget && !exactException) fail("PRODUCTION_TARGET_DENIED");
  if (expectedOfferRef !== undefined && approval.offerRef !== expectedOfferRef)
    fail("OFFER_BINDING_MISMATCH");
  if (
    expectedQuantity !== undefined &&
    (!Number.isSafeInteger(expectedQuantity) ||
      expectedQuantity < 1 ||
      BigInt(approval.maximumQuantity) < BigInt(expectedQuantity))
  )
    fail("QUANTITY_BINDING_MISMATCH");
  if (
    BigInt(approval.maximumQuantity) > BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(approval.maximumQuantity) > MAX_APPROVED_QUANTITY
  )
    fail("QUANTITY_OUT_OF_RANGE");

  const issuedAt = timestamp(approval.issuedAtUtc);
  const expiresAt = timestamp(approval.expiresAtUtc);
  if (
    issuedAt === null ||
    expiresAt === null ||
    issuedAt > now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_TTL_MS
  )
    fail("APPROVAL_TIME_INVALID");
  if (expiresAt <= now) fail("APPROVAL_EXPIRED");

  const trusted = approvers.find(
    (entry) =>
      entry.keyId === approval.keyId && entry.approver === approval.approver,
  );
  if (!trusted) fail("APPROVER_NOT_TRUSTED");
  const signature = Buffer.from(signatureBase64, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureBase64 ||
    !verifySignature(null, approvalBytes, trusted.publicKey, signature)
  )
    fail("SIGNATURE_INVALID");
  return {
    status: "PASS",
    code: "SIGNED_APPROVAL_ADMITTED",
    approval: {
      runId: approval.runId,
      candidateSha: approval.candidateSha,
      mode: approval.mode,
      exceptionAuthority: approval.exceptionAuthority,
      origin: approval.origin,
      accountFingerprint: approval.accountFingerprint,
      offerRef: approval.offerRef,
      maximumQuantity: approval.maximumQuantity,
      expiresAtUtc: approval.expiresAtUtc,
    },
  };
}

function repoHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) fail("REPOSITORY_IDENTITY_INVALID");
  return result.stdout.trim();
}

function readAdmissionContractFile(root, path) {
  const absolute = resolve(root, path);
  let descriptor;
  try {
    if (realpathSync(absolute) !== absolute)
      fail("ADMISSION_CONTRACT_FILE_INVALID");
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > ADMISSION_CONTRACT_MAX_BYTES[path])
      fail("ADMISSION_CONTRACT_FILE_INVALID");
    const bytes = readFileSync(descriptor);
    if (bytes.length > ADMISSION_CONTRACT_MAX_BYTES[path])
      fail("ADMISSION_CONTRACT_FILE_INVALID");
    return bytes;
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    fail("ADMISSION_CONTRACT_FILE_INVALID");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertAdmissionContractMatchesCandidate(root, candidateSha) {
  if (!SHA.test(candidateSha ?? ""))
    fail("ADMISSION_CONTRACT_CANDIDATE_INVALID");
  for (const path of ADMISSION_CONTRACT_PATHS) {
    const tree = spawnSync("git", ["ls-tree", candidateSha, "--", path], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (tree.error || tree.status !== 0)
      fail("ADMISSION_CONTRACT_MISSING_FROM_CANDIDATE");
    const [header, treePath] = tree.stdout.trimEnd().split("\t");
    const [mode, type, blobOid] = (header ?? "").split(" ");
    if (
      treePath !== path ||
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      !/^[0-9a-f]{40}$/.test(blobOid ?? "")
    ) {
      fail("ADMISSION_CONTRACT_MISSING_FROM_CANDIDATE");
    }

    try {
      const absolute = resolve(root, path);
      const info = lstatSync(absolute);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > ADMISSION_CONTRACT_MAX_BYTES[path] ||
        realpathSync(absolute) !== absolute
      )
        fail("ADMISSION_CONTRACT_FILE_INVALID");
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
      fail("ADMISSION_CONTRACT_FILE_INVALID");
    }
  }
  const expectedPaths = new Set(ADMISSION_CONTRACT_PATHS);
  for (const mode of ["-v", "-t"]) {
    const result = spawnSync(
      "git",
      ["ls-files", mode, "--", ...ADMISSION_CONTRACT_PATHS],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (result.error || result.status !== 0)
      fail("ADMISSION_CONTRACT_INDEX_FLAGS_INVALID");
    const rows = result.stdout.split("\n").filter(Boolean);
    const seen = new Set();
    if (rows.length !== expectedPaths.size)
      fail("ADMISSION_CONTRACT_INDEX_FLAGS_INVALID");
    for (const row of rows) {
      const tag = row[0];
      const path = row.slice(2);
      if (tag !== "H" || !expectedPaths.has(path) || seen.has(path))
        fail("ADMISSION_CONTRACT_INDEX_FLAGS_INVALID");
      seen.add(path);
    }
    if (seen.size !== expectedPaths.size)
      fail("ADMISSION_CONTRACT_INDEX_FLAGS_INVALID");
  }
  for (const path of ADMISSION_CONTRACT_PATHS) {
    let workingBytes;
    workingBytes = readAdmissionContractFile(root, path);
    const committed = spawnSync(
      "git",
      ["cat-file", "blob", `${candidateSha}:${path}`],
      {
        cwd: root,
        encoding: null,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (
      committed.error ||
      committed.status !== 0 ||
      createHash("sha256").update(workingBytes).digest("hex") !==
        createHash("sha256").update(committed.stdout).digest("hex")
    ) {
      fail("ADMISSION_CONTRACT_DIFFERS_FROM_CANDIDATE");
    }
  }
  for (const args of [
    [
      "diff",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
      candidateSha,
      "--",
      ...ADMISSION_CONTRACT_PATHS,
    ],
    [
      "diff",
      "--cached",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
      candidateSha,
      "--",
      ...ADMISSION_CONTRACT_PATHS,
    ],
  ]) {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0)
      fail("ADMISSION_CONTRACT_DIFFERS_FROM_CANDIDATE");
  }
}

export async function readRegular(path, maxBytes) {
  const absolute = resolve(path);
  if ((await realpath(absolute).catch(() => null)) !== absolute)
    fail("FILE_PATH_INVALID");
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    fail("FILE_INVALID_OR_TOO_LARGE");
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) fail("FILE_UNREADABLE");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes)
      fail("FILE_INVALID_OR_TOO_LARGE");
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(8192, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail("FILE_INVALID_OR_TOO_LARGE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function validateContext(contextFile) {
  const contextPath = resolve(contextFile);
  const contextInfo = await lstat(contextPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!contextInfo) fail("LAUNCH_CONTEXT_ABSENT");
  if (!contextInfo.isFile() || contextInfo.isSymbolicLink())
    fail("LAUNCH_CONTEXT_INVALID");
  let identity;
  try {
    identity = await validateLaunchContext(contextPath);
  } catch {
    fail("LAUNCH_CONTEXT_INVALID");
  }
  const { context, sourceRoot, candidateRoot } = identity;
  if (
    !RUN_ID.test(context.runId ?? "") ||
    !SHA.test(context.candidateSha ?? "") ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`)
  )
    fail("LAUNCH_CONTEXT_INVALID");
  if (
    ![context.sourceRepoRoot, context.checkoutDir, context.evidenceDir].every(
      (path) => typeof path === "string" && resolve(path) === path,
    )
  )
    fail("LAUNCH_CONTEXT_INVALID");
  const cwd = resolve(process.cwd());
  if (
    ![candidateRoot, sourceRoot].includes(cwd) ||
    repoHead(cwd) !== context.candidateSha
  )
    fail("LAUNCH_CWD_MISMATCH");
  const moduleRoot = await realpath(PROJECT_ROOT);
  if (moduleRoot !== cwd) fail("LAUNCH_MODULE_CWD_MISMATCH");
  return identity;
}

function requireFrom(root, packageName) {
  const require = createRequire(join(root, "package.json"));
  return require(packageName);
}

async function loadConfig(root) {
  const yaml = requireFrom(root, "js-yaml");
  const Ajv2020 = requireFrom(root, "ajv/dist/2020").default;
  const configPath = join(root, "config/platform.yaml");
  const schemaPath = join(root, "config/platform.schema.json");
  const nginxSchemaPath = join(root, "config/nginx-profile.schema.json");
  const [configBytes, configSchemaBytes, nginxSchemaBytes] = await Promise.all([
    readRegular(configPath, 2 * 1024 * 1024),
    readRegular(schemaPath, 2 * 1024 * 1024),
    readRegular(nginxSchemaPath, 512 * 1024),
  ]);
  let config;
  let configSchema;
  let nginxSchema;
  try {
    config = yaml.load(configBytes.toString("utf8"));
    configSchema = JSON.parse(configSchemaBytes.toString("utf8"));
    nginxSchema = JSON.parse(nginxSchemaBytes.toString("utf8"));
  } catch {
    fail("PLATFORM_CONFIG_INVALID");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(nginxSchema);
  const valid = ajv.compile(configSchema);
  if (!valid(config)) fail("PLATFORM_CONFIG_INVALID");
  return { config, yaml, ajv };
}

async function readEncryptedSecrets(root, yaml) {
  const path = join(root, "secrets/platform.secrets.sops.yaml");
  const bytes = await readRegular(path, 8 * 1024 * 1024);
  try {
    return yaml.load(bytes.toString("utf8"));
  } catch {
    fail("ENCRYPTED_SECRET_INVENTORY_INVALID");
  }
}

export async function loadAdmissionContract(root = PROJECT_ROOT) {
  const { config, ajv } = await loadConfig(root);
  const approvalSchemaPath = join(
    root,
    "verification/launch/v1/schemas/aroma-approval.schema.json",
  );
  const schemaBytes = await readRegular(approvalSchemaPath, 64 * 1024);
  let schema;
  try {
    schema = JSON.parse(schemaBytes.toString("utf8"));
  } catch {
    fail("APPROVAL_SCHEMA_INVALID");
  }
  const validateApproval = ajv.compile(schema);
  const environment = config.environment;
  const policy = config.verification?.aromaSandbox ?? null;
  if (!policy)
    return {
      config,
      encryptedSecrets: null,
      environment,
      policy: null,
      validateApproval,
      credentialsAvailable: false,
    };
  if (environment === "production")
    return {
      config,
      encryptedSecrets: null,
      environment,
      policy,
      validateApproval,
      credentialsAvailable: false,
    };
  const encryptedSecrets = await readEncryptedSecrets(
    root,
    requireFrom(root, "js-yaml"),
  );
  const credentialsAvailable = policy
    ? matchCredentialRefs(policy, encryptedSecrets, environment)
    : false;
  return {
    config,
    encryptedSecrets,
    environment,
    policy,
    validateApproval,
    credentialsAvailable,
  };
}

function parseArguments(args) {
  const result = { approvalFile: null };
  if (args[0] === "--") args = args.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    if (
      args[index] === "--approval-file" &&
      result.approvalFile === null &&
      args[index + 1]
    )
      result.approvalFile = args[++index];
    else fail("ARGUMENTS_INVALID");
  }
  if (!result.approvalFile) fail("ARGUMENTS_INVALID");
  return result;
}

function printResult(status, code) {
  process.stdout.write(
    `${JSON.stringify({ gate: "aroma_sandbox", approvalAdmission: status, code, liveWorkflow: "NOT_RUN" })}\n`,
  );
}

export async function main(args = process.argv.slice(2), env = process.env) {
  try {
    const { approvalFile } = parseArguments(args);
    if (!env.COFFEE_LAUNCH_CONTEXT_FILE) {
      printResult("NOT_RUN", "LAUNCH_CONTEXT_ABSENT");
      return 78;
    }
    const identity = await validateContext(env.COFFEE_LAUNCH_CONTEXT_FILE);
    assertAdmissionContractMatchesCandidate(
      identity.candidateRoot,
      identity.context.candidateSha,
    );
    const {
      encryptedSecrets,
      environment,
      policy,
      validateApproval,
      credentialsAvailable,
    } = await loadAdmissionContract(identity.candidateRoot);
    if (environment === "production") {
      printResult("FAIL", "PRODUCTION_ENVIRONMENT_DENIED");
      return 1;
    }
    if (!policy) {
      printResult("NOT_RUN", "SANDBOX_POLICY_ABSENT");
      return 78;
    }
    if (!credentialsAvailable) {
      printResult("NOT_RUN", "SCOPED_SANDBOX_CREDENTIALS_ABSENT");
      return 78;
    }
    const approvalBytes = await readRegular(approvalFile, MAX_APPROVAL_BYTES);
    const signatureBytes = await readRegular(
      `${approvalFile}.sig`,
      MAX_SIGNATURE_BYTES,
    );
    const decision = validateAdmission({
      approvalBytes,
      signatureBase64: signatureBytes.toString("utf8"),
      policy,
      identity: {
        context: identity.context,
        environment,
        credentialsAvailable,
      },
      encryptedSecrets,
      validateApproval,
    });
    if (decision.status !== "PASS") {
      printResult("NOT_RUN", decision.code);
      return 78;
    }
    printResult("PASS", decision.code);
    return 78;
  } catch (error) {
    if (error instanceof AdmissionError) {
      if (
        error.code === "LAUNCH_CONTEXT_ABSENT" ||
        error.code === "SANDBOX_POLICY_ABSENT" ||
        error.code === "SCOPED_SANDBOX_CREDENTIALS_ABSENT"
      ) {
        printResult("NOT_RUN", error.code);
        return 78;
      }
      printResult("FAIL", error.code);
      return 1;
    }
    printResult("FAIL", "ADMISSION_INTERNAL_ERROR");
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await main();
