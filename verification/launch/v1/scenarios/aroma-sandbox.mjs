import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { isDeepStrictEqual } from "node:util";
import {
  AdmissionError,
  assertAdmissionContractMatchesCandidate,
  canonicalHttpsOrigin,
  loadAdmissionContract,
  readRegular,
  validateAdmission,
  validateContext,
} from "./aroma-approval.mjs";
import {
  createConfigOnlyCheckout,
  inspectLaunchCheckout,
  runManagedRollbackChild,
  validateConfigOnlyLineage,
  writeRollbackLineageBundle,
} from "./rollback.mjs";
import { aromaSandboxResourceNames } from "./aroma-sandbox-resources.mjs";
import { buildBackupRestorePlan } from "./backup-restore.mjs";

export async function readApprovedG16Policy(candidateRoot, candidateSha) {
  const path = join(
    candidateRoot,
    "evidence/aroma-provider/controlled-account.json",
  );
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.size > 16384
  )
    throw new Error("G16_APPROVED_POLICY_BLOB_INVALID");
  const bytes = execFileSync(
    "git",
    [
      "cat-file",
      "blob",
      `${candidateSha}:evidence/aroma-provider/controlled-account.json`,
    ],
    {
      cwd: candidateRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  if (
    createHash("sha256").update(bytes).digest("hex") !==
      "e77a818d16b833f34c27de4c7500afe14160b96037eb6fe4767d53432ced5e8b" ||
    !(await readFile(path)).equals(bytes)
  )
    throw new Error("G16_APPROVED_POLICY_BLOB_INVALID");
  const artifact = JSON.parse(bytes.toString("utf8"));
  const policy = artifact.policy;
  if (
    artifact.sourceCommit !== "0dbe0a40685cbf348f0a63f8633a8db3a74a5467" ||
    artifact.sourceConfigSha256 !==
      "c2024437a11dadb34da27085cca15097e91ac7ffbed1534f99ae0c6fd40f725e" ||
    artifact.exceptionAuthority !== "user-2026-10-23" ||
    policy?.mode !== "controlled-live-existing-account" ||
    policy.existingAccountException?.authority !== "user-2026-10-23" ||
    Object.hasOwn(policy, "trustedApprovers")
  )
    throw new Error("G16_APPROVED_POLICY_INVALID");
  return policy;
}

export async function createG16Checkout({
  candidateRoot,
  candidateSha,
  publicKeyPem,
  keyId,
  approver,
}) {
  await inspectLaunchCheckout(candidateRoot, candidateSha);
  const parentBytes = execFileSync(
    "git",
    ["cat-file", "blob", `${candidateSha}:config/platform.yaml`],
    {
      cwd: candidateRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  const historicalPolicy = await readApprovedG16Policy(
    candidateRoot,
    candidateSha,
  );
  const childConfig = buildG16ChildConfig({
    parentBytes,
    historicalPolicy,
    publicKeyPem,
    keyId,
    approver,
  });
  return createConfigOnlyCheckout({ candidateRoot, candidateSha, childConfig });
}

export async function validateG16Checkout({
  candidateRoot,
  candidateSha,
  baselineRoot,
  baselineSha,
  publicKeyPem,
  keyId,
  approver,
}) {
  await validateConfigOnlyLineage({
    parentRoot: candidateRoot,
    parentSha: candidateSha,
    baselineRoot,
    baselineSha,
  });
  const configBlob = (root, sha) =>
    execFileSync("git", ["cat-file", "blob", `${sha}:config/platform.yaml`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
  const parentBytes = configBlob(candidateRoot, candidateSha);
  const expected = buildG16ChildConfig({
    parentBytes,
    historicalPolicy: await readApprovedG16Policy(candidateRoot, candidateSha),
    publicKeyPem,
    keyId,
    approver,
  });
  if (!configBlob(baselineRoot, baselineSha).equals(expected))
    throw new Error("G16_CHILD_CONFIG_LINEAGE_INVALID");
  return {
    parentSha: candidateSha,
    childSha: baselineSha,
    parentConfigSha256: createHash("sha256").update(parentBytes).digest("hex"),
    childConfigSha256: createHash("sha256").update(expected).digest("hex"),
  };
}

export function buildG16ChildConfig({
  parentBytes,
  historicalPolicy,
  publicKeyPem,
  keyId,
  approver,
}) {
  const source = parentBytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(parentBytes))
    throw new Error("G16_PARENT_CONFIG_INVALID");
  const parent = parseYaml(source);
  if (
    parent?.verification?.aromaSandbox !== null ||
    parent?.services?.["aroma-convergence"]?.mutationsEnabled !== false
  )
    throw new Error("G16_PARENT_CONFIG_INVALID");
  const publicKey = createPublicKey(publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    approver !== "g16-operator" ||
    keyId !==
      `g16-${createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex")
        .slice(0, 20)}`
  )
    throw new Error("G16_APPROVER_IDENTITY_INVALID");
  if (
    historicalPolicy?.mode !== "controlled-live-existing-account" ||
    historicalPolicy.existingAccountException?.authority !==
      "user-2026-10-23" ||
    Object.hasOwn(historicalPolicy, "trustedApprovers")
  )
    throw new Error("G16_HISTORICAL_POLICY_INVALID");
  const policy = {
    ...historicalPolicy,
    trustedApprovers: [{ keyId, approver, publicKeyPem }],
  };
  const policyText = dumpYaml(
    { aromaSandbox: policy },
    { noRefs: true, lineWidth: -1 },
  )
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  const marker = /^  aromaSandbox: null[\t ]*$/gmu;
  const flag = /^([\t ]*mutationsEnabled:[\t ]*)false([\t ]*(?:#.*)?)(\r?)$/gmu;
  if (
    [...source.matchAll(marker)].length !== 1 ||
    [...source.matchAll(flag)].length !== 1
  )
    throw new Error("G16_PARENT_CONFIG_AMBIGUOUS");
  const child = source.replace(marker, policyText).replace(flag, "$1true$2$3");
  const expected = {
    ...parent,
    verification: { ...parent.verification, aromaSandbox: policy },
    services: {
      ...parent.services,
      "aroma-convergence": {
        ...parent.services["aroma-convergence"],
        mutationsEnabled: true,
      },
    },
  };
  if (!isDeepStrictEqual(parseYaml(child), expected))
    throw new Error("G16_CHILD_CONFIG_DIFF_INVALID");
  return Buffer.from(child);
}

const ACCOUNT_FINGERPRINT_NAMESPACE = "coffee-platform:g16:account:v1";
const AROMA_PACKING_PROOF_PATH =
  "evidence/aroma-provider/2026-10-24-packing/packing-wire-facts.json";
const AROMA_PACKING_PROOF_SHA256 =
  "2ae7f8d6f81ac624a0daedc04322e7e0767c0fd47be8bd10e4aad4e065f4b742";
const AROMA_PACKING_RECEIPT_PATH =
  "evidence/aroma-provider/2026-10-24-packing/packing-probe-94dc4950-4c10-4c7c-ab2d-62e46ccb9d46.json";
const AROMA_PACKING_RECEIPT_SHA256 =
  "63a9ad4b968dfdc4e405c1d31705596ec68c00c0243c1d04ef04c3a4d1160284";
const AROMA_PACKING_OPERATOR_SHA256 =
  "64b37305ce8abe73201caea5c8c8a63f5cba51eced58dde4549031a95e4760e2";
const AROMA_PACKING_ACCOUNT_FINGERPRINT =
  "sha256:2f8dd83aa108ac1734086d80886592520ec814ae4912bc0f0dcfc2deeceffe2f";
const validatedAromaPackingProofs = new WeakSet();

function exactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(
      Object.keys(value).sort((left, right) => left.localeCompare(right)),
    ) ===
      JSON.stringify([...keys].sort((left, right) => left.localeCompare(right)))
  );
}

async function readPinnedAromaEvidence(
  root,
  relativePath,
  expectedSha256,
  maxBytes,
) {
  const rootPath = await realpath(root).catch(() => null);
  if (!rootPath) throw new Error("AROMA_PACKING_WIRE_PROOF_NOT_PROVEN");
  const path = resolve(rootPath, relativePath);
  if (!path.startsWith(`${rootPath}/`))
    throw new Error("AROMA_PACKING_WIRE_PROOF_NOT_PROVEN");
  let bytes;
  try {
    bytes = await readRegular(path, maxBytes);
  } catch {
    throw new Error("AROMA_PACKING_WIRE_PROOF_NOT_PROVEN");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
    throw new Error("AROMA_PACKING_WIRE_PROOF_NOT_PROVEN");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("AROMA_PACKING_WIRE_PROOF_NOT_PROVEN");
  }
}

export function validateAromaPackingWireProof(facts, receipt) {
  const factKeys = [
    "schemaVersion",
    "status",
    "sourceReceipt",
    "receiptSha256",
    "operatorSha256",
    "providerOfferId",
    "packing",
    "grindId",
    "grindFactBasis",
    "quantity",
    "accountFingerprint",
    "observedAtUtc",
    "baselineRestored",
    "scopedMaterialRemoved",
    "packingMismatchExceptionUsed",
    "g16Admission",
    "globalGuardChanged",
  ];
  const receiptKeys = [
    "purpose",
    "operationId",
    "operationIds",
    "offerId",
    "requestedPacking",
    "origin",
    "createdAtUtc",
    "expiresAtUtc",
    "accountVerified",
    "accountFingerprint",
    "baselineCartFingerprint",
    "postCartFingerprint",
    "preDeleteCartFingerprint",
    "postDeleteCartFingerprint",
    "observedPacking",
    "loginAttempts",
    "logicalSafeReads",
    "physicalSafeReadAttemptUpperBound",
    "unsafePostAttempts",
    "unsafeDeleteAttempts",
    "packingMismatchExceptionUsed",
    "postOutcome",
    "deleteOutcome",
    "cleanupStatus",
    "failureCode",
    "scopedMaterialRemoved",
    "status",
    "finishedAtUtc",
    "createdLineProven",
  ];
  const fail = () => {
    throw new Error("AROMA_PACKING_WIRE_PROOF_NOT_PROVEN");
  };
  if (
    !exactObjectKeys(facts, factKeys) ||
    !exactObjectKeys(receipt, receiptKeys) ||
    facts.schemaVersion !== 1 ||
    facts.status !== "PROVEN_FOR_OFFER_445_ONLY" ||
    facts.sourceReceipt !== AROMA_PACKING_RECEIPT_PATH.split("/").at(-1) ||
    facts.receiptSha256 !== AROMA_PACKING_RECEIPT_SHA256 ||
    facts.operatorSha256 !== AROMA_PACKING_OPERATOR_SHA256 ||
    facts.providerOfferId !== "445" ||
    facts.packing !== "Aroma" ||
    facts.grindId !== null ||
    facts.grindFactBasis !==
      "COMPLETE + createdLineProven from reviewed exactProbeLine: grindId===null before both post/pre-delete reads" ||
    facts.quantity !== 1 ||
    facts.accountFingerprint !== AROMA_PACKING_ACCOUNT_FINGERPRINT ||
    typeof facts.observedAtUtc !== "string" ||
    !Number.isFinite(Date.parse(facts.observedAtUtc)) ||
    facts.baselineRestored !== true ||
    facts.scopedMaterialRemoved !== true ||
    facts.packingMismatchExceptionUsed !== false ||
    facts.g16Admission !== false ||
    facts.globalGuardChanged !== false
  )
    fail();
  const operationId = "94dc4950-4c10-4c7c-ab2d-62e46ccb9d46";
  const fingerprint = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (
    receipt.operationId !== operationId ||
    receipt.operationIds?.add !== `${operationId}:add` ||
    receipt.operationIds?.delete !== `${operationId}:delete` ||
    receipt.purpose !== "bounded out-of-G16 exact-line packing probe" ||
    receipt.offerId !== "445" ||
    receipt.requestedPacking !== "Aroma" ||
    receipt.origin !== "https://aromateacoffee.ru" ||
    receipt.accountVerified !== true ||
    receipt.accountFingerprint !== facts.accountFingerprint ||
    !fingerprint(receipt.baselineCartFingerprint) ||
    receipt.postDeleteCartFingerprint !== receipt.baselineCartFingerprint ||
    !fingerprint(receipt.postCartFingerprint) ||
    receipt.preDeleteCartFingerprint !== receipt.postCartFingerprint ||
    receipt.observedPacking !== "Aroma" ||
    receipt.loginAttempts !== 1 ||
    receipt.logicalSafeReads !== 4 ||
    receipt.physicalSafeReadAttemptUpperBound !== 8 ||
    receipt.unsafePostAttempts !== 1 ||
    receipt.unsafeDeleteAttempts !== 1 ||
    receipt.packingMismatchExceptionUsed !== false ||
    receipt.postOutcome !== "accepted" ||
    receipt.deleteOutcome !== "accepted" ||
    receipt.cleanupStatus !== "DELETE_REMOVAL_CONFIRMED" ||
    receipt.failureCode !== null ||
    receipt.scopedMaterialRemoved !== true ||
    receipt.status !== "COMPLETE" ||
    receipt.createdLineProven !== true
  )
    fail();
  const proof = Object.freeze({
    providerOfferId: facts.providerOfferId,
    packing: facts.packing,
    grindId: facts.grindId,
    accountFingerprint: facts.accountFingerprint,
    receiptSha256: facts.receiptSha256,
    operatorSha256: facts.operatorSha256,
  });
  validatedAromaPackingProofs.add(proof);
  return proof;
}

export async function loadAromaPackingWireProof(root) {
  const facts = await readPinnedAromaEvidence(
    root,
    AROMA_PACKING_PROOF_PATH,
    AROMA_PACKING_PROOF_SHA256,
    4096,
  );
  const receipt = await readPinnedAromaEvidence(
    root,
    AROMA_PACKING_RECEIPT_PATH,
    AROMA_PACKING_RECEIPT_SHA256,
    8192,
  );
  return validateAromaPackingWireProof(facts, receipt);
}

function canonicalEmail(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length > 320)
    return null;
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes("\0") ||
    /\s/u.test(normalized) ||
    !/^[^@]+@[^@]+$/u.test(normalized)
  )
    return null;
  return normalized;
}

/** Fingerprint the authenticated account without retaining or returning its email. */
export function computeExistingAccountFingerprint({
  catalogIdentityKeyV1,
  origin,
  scopeRef,
  authenticatedEmail,
  credentialEmail,
}) {
  const canonicalOrigin = canonicalHttpsOrigin(origin);
  const authenticated = canonicalEmail(authenticatedEmail);
  const credential = canonicalEmail(credentialEmail);
  if (
    typeof catalogIdentityKeyV1 !== "string" ||
    !catalogIdentityKeyV1.isWellFormed() ||
    !catalogIdentityKeyV1 ||
    !canonicalOrigin ||
    typeof scopeRef !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(scopeRef) ||
    authenticated === null ||
    credential === null ||
    authenticated !== credential
  ) {
    throw new Error("AROMA_ACCOUNT_FINGERPRINT_INPUT_INVALID");
  }
  const material = [
    ACCOUNT_FINGERPRINT_NAMESPACE,
    canonicalOrigin,
    scopeRef,
    authenticated,
  ].join("\0");
  const digest = createHmac("sha256", Buffer.from(catalogIdentityKeyV1, "utf8"))
    .update(material, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** A run-local loopback proxy that drops one complete, validated Gateway ACK. */
export async function startAcknowledgementDropProxy({
  upstreamPort,
  dropFirstAcknowledgement = true,
}) {
  if (
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  )
    throw new Error("AROMA_PROXY_TARGET_INVALID");
  const droppedAcknowledgements = [];
  let requestCount = 0;
  const server = createServer(async (incoming, outgoing) => {
    requestCount += 1;
    const cartPath =
      /^\/api\/internal-v1\/aroma\/(?:cart-snapshots:read|cart-lines\/off_[0-9A-HJKMNP-TV-Z]{26}:(?:set-quantity|remove))$/u.test(
        incoming.url ?? "",
      );
    const catalogPath =
      /^\/api\/internal-v1\/catalog\/products\/prd_[0-9A-HJKMNP-TV-Z]{26}\/variants\/var_[0-9A-HJKMNP-TV-Z]{26}\/pricing-input$/u.test(
        incoming.url ?? "",
      );
    if (
      requestCount > 128 ||
      incoming.socket.remoteAddress !== "127.0.0.1" ||
      !(
        (incoming.method === "POST" && cartPath) ||
        (incoming.method === "GET" && catalogPath)
      )
    ) {
      outgoing.writeHead(404).end();
      incoming.resume();
      return;
    }
    const chunks = [];
    let requestBytes = 0;
    try {
      for await (const chunk of incoming) {
        requestBytes += chunk.length;
        if (requestBytes > 64 * 1024)
          throw new Error("AROMA_PROXY_REQUEST_TOO_LARGE");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, requestBytes);
      const mutation =
        incoming.method === "POST" && incoming.url.includes("cart-lines/");
      let operationRef;
      let offerRef;
      if (mutation) {
        let requestBody;
        try {
          requestBody = JSON.parse(body.toString("utf8"));
        } catch {
          throw new Error("AROMA_PROXY_REQUEST_INVALID");
        }
        operationRef = requestBody?.operationRef;
        const match =
          /^\/api\/internal-v1\/aroma\/cart-lines\/(off_[0-9A-HJKMNP-TV-Z]{26}):/u.exec(
            incoming.url,
          );
        offerRef = match?.[1];
        const expectedKeys = incoming.url.endsWith(":set-quantity")
          ? [
              "cartScopeRef",
              "operationRef",
              "quantity",
              ...(requestBody?.sourceGrindKeyHash === undefined
                ? []
                : ["sourceGrindKeyHash"]),
            ]
          : [
              "cartScopeRef",
              "operationRef",
              ...(requestBody?.sourceGrindKeyHash === undefined
                ? []
                : ["sourceGrindKeyHash"]),
            ];
        if (
          typeof operationRef !== "string" ||
          !/^op_[0-9A-HJKMNP-TV-Z]{26}$/u.test(operationRef) ||
          requestBody?.cartScopeRef !== "aroma-primary" ||
          Object.keys(requestBody ?? {})
            .sort()
            .join(",") !== expectedKeys.sort().join(",") ||
          (incoming.url.endsWith(":set-quantity") &&
            !["1", "2"].includes(requestBody?.quantity)) ||
          (requestBody?.sourceGrindKeyHash !== undefined &&
            !/^[a-f0-9]{64}$/u.test(requestBody.sourceGrindKeyHash))
        )
          throw new Error("AROMA_PROXY_REQUEST_INVALID");
      }
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: upstreamPort,
          method: incoming.method,
          path: incoming.url,
          headers: {
            accept: "application/json, application/problem+json",
            "content-type": "application/json",
            "content-length": String(body.length),
            ...(typeof incoming.headers["x-coffee-g16-capability"] === "string"
              ? {
                  "x-coffee-g16-capability":
                    incoming.headers["x-coffee-g16-capability"],
                }
              : {}),
            ...(typeof incoming.headers["x-coffee-g16-phase"] === "string"
              ? { "x-coffee-g16-phase": incoming.headers["x-coffee-g16-phase"] }
              : {}),
          },
        },
        (response) => {
          const responseChunks = [];
          let responseBytes = 0;
          response.on("data", (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > 64 * 1024) {
              response.destroy(new Error("AROMA_PROXY_RESPONSE_TOO_LARGE"));
              return;
            }
            responseChunks.push(chunk);
          });
          response.on("end", () => {
            const responseBody = Buffer.concat(responseChunks, responseBytes);
            let ack;
            if (
              mutation &&
              response.statusCode === 200 &&
              response.headers["content-type"]?.split(";", 1)[0] ===
                "application/json"
            ) {
              try {
                ack = JSON.parse(responseBody.toString("utf8"));
              } catch {
                ack = undefined;
              }
            }
            if (
              dropFirstAcknowledgement &&
              !droppedAcknowledgements.length &&
              ack?.state === "Acknowledged" &&
              ack.operationRef === operationRef &&
              ack.offerRef === offerRef &&
              ack.cartScopeRef === "aroma-primary"
            ) {
              droppedAcknowledgements.push({
                operationRef,
                offerRef,
                state: "Acknowledged",
                responseDropped: true,
              });
              outgoing.destroy();
              return;
            }
            const headers = {};
            for (const name of [
              "content-type",
              "content-length",
              "cache-control",
            ]) {
              const value = response.headers[name];
              if (typeof value === "string") headers[name] = value;
            }
            outgoing
              .writeHead(response.statusCode ?? 502, headers)
              .end(responseBody);
          });
          response.on("error", () => outgoing.destroy());
        },
      );
      upstream.on("error", () => {
        if (!outgoing.destroyed) outgoing.writeHead(502).end();
      });
      upstream.end(body);
    } catch {
      if (!outgoing.destroyed) outgoing.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("AROMA_PROXY_LISTEN_FAILED");
  return {
    url: `http://127.0.0.1:${address.port}`,
    droppedAcknowledgements,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const MUTATION_PHASES = Object.freeze({
  "single-mutation": Object.freeze({
    operation: "SetLineQuantity",
    quantity: "1",
    before: [],
  }),
  "lost-response": Object.freeze({
    operation: "SetLineQuantity",
    quantity: "2",
    before: [{ quantity: "1" }],
  }),
  restore: Object.freeze({
    operation: "RemoveLine",
    before: [{ quantity: "2" }],
  }),
});
const MAX_MUTATION_GRANT_TTL_MS = 2 * 60 * 60 * 1000;

/** Ephemeral local capability. Only the parent and its dedicated child receive the token over IPC. */
export function createAromaMutationGrant({
  offerRef,
  maximumQuantity,
  expiresAtUtc,
  capability = randomBytes(32).toString("hex"),
  now = Date.now,
}) {
  const expiresAt = Date.parse(expiresAtUtc ?? "");
  const issuedAt = now();
  if (
    !/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(offerRef ?? "") ||
    maximumQuantity !== "2" ||
    !/^[a-f0-9]{64}$/u.test(capability) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now() ||
    expiresAt - issuedAt > MAX_MUTATION_GRANT_TTL_MS
  ) {
    throw new Error("AROMA_GRANT_INVALID");
  }
  let phaseIndex = 0;
  let phaseClaimed = false;
  let activePhase = null;
  return Object.freeze({
    offerRef,
    capability,
    get expiresAtEpochMs() {
      return expiresAt;
    },
    authorize(phase) {
      const expected = ["single-mutation", "lost-response", "restore"][
        phaseIndex
      ];
      if (now() >= expiresAt) throw new Error("AROMA_APPROVAL_EXPIRED");
      if (phase !== expected || phaseClaimed || activePhase !== null)
        throw new Error("AROMA_PHASE_ORDER_INVALID");
      activePhase = phase;
      return phase;
    },
    claim({
      providedCapability,
      phase,
      operation,
      offerRef: requestedOfferRef,
      quantity,
      sourceGrindKeyHash,
    }) {
      const expectedPhase = ["single-mutation", "lost-response", "restore"][
        phaseIndex
      ];
      const phaseSpec = MUTATION_PHASES[expectedPhase];
      if (
        now() >= expiresAt ||
        !phaseSpec ||
        phase !== expectedPhase ||
        phase !== activePhase ||
        phaseClaimed ||
        requestedOfferRef !== offerRef ||
        operation !== phaseSpec.operation ||
        (phaseSpec.quantity !== undefined && quantity !== phaseSpec.quantity) ||
        (phaseSpec.quantity === undefined && quantity !== undefined) ||
        sourceGrindKeyHash !== undefined ||
        !constantTimeCapabilityMatch(capability, providedCapability)
      )
        return false;
      phaseClaimed = true;
      phaseIndex += 1;
      activePhase = null;
      phaseClaimed = false;
      return true;
    },
    disable() {
      activePhase = null;
      phaseClaimed = true;
      phaseIndex = 3;
    },
  });
}

/**
 * Bind the real mutator's preparation read and unsafe session call to this one
 * admitted phase. The complete provider body is buffered only up to the
 * Gateway response cap, checked, then yielded unchanged to ProviderCartMutator.
 */
export function createAromaProviderMutationGuard({
  phase,
  offerRef,
  expectedLines,
  expiresAtEpochMs,
  defaultPacking,
  decodeCartSnapshot,
  sessions: sourceSessions,
  bindings: sourceBindings,
  now = Date.now,
  deadlineMs = 20_000,
}) {
  if (
    !MUTATION_PHASES[phase] ||
    !/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(offerRef ?? "") ||
    !Array.isArray(expectedLines) ||
    expectedLines.length > 1 ||
    !Number.isFinite(expiresAtEpochMs) ||
    typeof defaultPacking !== "string" ||
    !defaultPacking ||
    typeof decodeCartSnapshot !== "function" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    !sourceSessions ||
    typeof sourceSessions.acquire !== "function" ||
    !sourceBindings ||
    typeof sourceBindings.resolveProviderOffer !== "function"
  )
    throw new Error("AROMA_MUTATION_PHASE_INVALID");
  const before = expectedLines.map(({ offerRef: ref, quantity }) => ({
    offerRef: ref,
    quantity,
  }));
  if (
    before.some(
      (line) =>
        line.offerRef !== offerRef || !/^[1-2]$/u.test(line.quantity ?? ""),
    ) ||
    (phase === "single-mutation" && before.length !== 0) ||
    (phase === "lost-response" &&
      (before.length !== 1 || before[0].quantity !== "1")) ||
    (phase === "restore" && (before.length !== 1 || before[0].quantity !== "2"))
  )
    throw new Error("AROMA_MUTATION_PHASE_INVALID");

  let identity;
  let preparationRead = null;
  let dispatchStarted = false;
  let expectedAfter = null;
  const assertProviderCart = (body, expected) => {
    const snapshot = decodeCartSnapshot(body);
    if (
      !Array.isArray(snapshot?.lines) ||
      snapshot.lines.length !== expected.length
    )
      throw new Error("AROMA_PREPARATION_CART_CHANGED");
    if (expected.length === 0) return;
    const line = snapshot.lines[0];
    if (
      !identity ||
      identity.rawProviderOfferId !== line.offerId ||
      line.quantity !== Number(expected[0].quantity) ||
      line.packing !== defaultPacking ||
      line.grindId !== null
    )
      throw new Error("AROMA_PREPARATION_CART_CHANGED");
  };
  const guardedBindings = Object.freeze({
    async resolveProviderOffer(requestedOfferRef, supplierRef, signal) {
      if (requestedOfferRef !== offerRef || dispatchStarted)
        throw new Error("AROMA_MUTATION_PHASE_INVALID");
      identity = await sourceBindings.resolveProviderOffer(
        requestedOfferRef,
        supplierRef,
        signal,
      );
      if (
        !identity ||
        typeof identity.rawProviderOfferId !== "string" ||
        !/^[1-9][0-9]*$/u.test(identity.rawProviderOfferId)
      ) {
        throw new Error("AROMA_MUTATION_PHASE_INVALID");
      }
      return identity;
    },
  });
  const guardedSessions = Object.freeze({
    async acquire(credentials, signal) {
      if (!identity || dispatchStarted)
        throw new Error("AROMA_MUTATION_PHASE_INVALID");
      const session = await sourceSessions.acquire(credentials, signal);
      return Object.freeze({
        async *read(operation, readSignal) {
          if (operation?.kind !== "cart")
            throw new Error("AROMA_MUTATION_PHASE_INVALID");
          const chunks = [];
          let bytes = 0;
          for await (const chunk of session.read(operation, readSignal)) {
            bytes += chunk.byteLength;
            if (bytes > 2 * 1024 * 1024)
              throw new Error("AROMA_PROXY_RESPONSE_TOO_LARGE");
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks, bytes);
          if (!dispatchStarted) {
            if (preparationRead !== null)
              throw new Error("AROMA_MUTATION_PHASE_INVALID");
            assertProviderCart(body, before);
            preparationRead = decodeCartSnapshot(body);
          } else {
            if (expectedAfter === null)
              throw new Error("AROMA_MUTATION_PHASE_INVALID");
            assertProviderCart(body, expectedAfter);
          }
          yield body;
        },
        async mutate(operation, mutationSignal) {
          if (!preparationRead || dispatchStarted || now() >= expiresAtEpochMs)
            throw new Error(
              now() >= expiresAtEpochMs
                ? "AROMA_APPROVAL_EXPIRED"
                : "AROMA_MUTATION_PHASE_INVALID",
            );
          const line = preparationRead.lines[0];
          if (phase === "single-mutation") {
            if (
              operation?.kind !== "add-cart-line" ||
              operation.offerId !== identity.rawProviderOfferId ||
              operation.quantity !== 1 ||
              operation.packing !== defaultPacking ||
              operation.grindId !== undefined
            )
              throw new Error("AROMA_MUTATION_PHASE_INVALID");
            expectedAfter = [{ offerRef, quantity: "1" }];
          } else if (phase === "lost-response") {
            if (
              operation?.kind !== "set-cart-line-quantity" ||
              operation.cartLineId !== line?.cartLineId ||
              operation.quantity !== 2 ||
              operation.packing !== defaultPacking ||
              operation.grindId !== undefined
            )
              throw new Error("AROMA_MUTATION_PHASE_INVALID");
            expectedAfter = [{ offerRef, quantity: "2" }];
          } else {
            if (
              operation?.kind !== "remove-cart-line" ||
              operation.cartLineId !== line?.cartLineId
            )
              throw new Error("AROMA_MUTATION_PHASE_INVALID");
            expectedAfter = [];
          }
          const remaining = expiresAtEpochMs - now();
          if (remaining <= 0) throw new Error("AROMA_APPROVAL_EXPIRED");
          dispatchStarted = true;
          return session.mutate(
            operation,
            AbortSignal.any([
              mutationSignal,
              AbortSignal.timeout(Math.min(deadlineMs, remaining)),
            ]),
          );
        },
      });
    },
  });
  return Object.freeze({
    sessions: guardedSessions,
    bindings: guardedBindings,
  });
}

/** Wait for DB-clock eligibility of the single unknown operation before one restart reconciliation attempt. */
export async function waitForAromaRestartEligibility({
  ordersClient,
  operationRef,
  providerDeadlineMs,
  safetyMarginMs,
  retryBackoffMs,
  signal,
  pause = delay,
  monotonicNow = () => performance.now(),
}) {
  if (
    !ordersClient ||
    typeof ordersClient.query !== "function" ||
    !/^op_[0-9A-HJKMNP-TV-Z]{26}$/u.test(operationRef ?? "") ||
    ![providerDeadlineMs, safetyMarginMs, retryBackoffMs].every(
      Number.isSafeInteger,
    ) ||
    providerDeadlineMs <= 0 ||
    safetyMarginMs < 0 ||
    retryBackoffMs <= 0
  ) {
    throw new Error("AROMA_RESTART_ELIGIBILITY_UNAVAILABLE");
  }
  const maximumWaitMs =
    providerDeadlineMs + safetyMarginMs + retryBackoffMs + 1_000;
  const started = monotonicNow();
  const sql = `SELECT GREATEST(w.next_attempt_at,r.reserved_until) AS eligible_at,
    ceil(extract(epoch FROM (GREATEST(w.next_attempt_at,r.reserved_until)-clock_timestamp()))*1000)::bigint::text AS wait_ms
    FROM orders.convergence_work w JOIN orders.mutation_reservations r ON r.cart_scope_ref=w.cart_scope_ref
    WHERE w.cart_scope_ref='aroma-primary' AND w.dirty AND r.operation_ref=$1
      AND r.state='UnknownOutcome' AND r.resolved_at IS NULL`;
  while (true) {
    signal?.throwIfAborted();
    const result = await ordersClient.query(sql, [operationRef]);
    const row = result?.rows?.[0];
    const wait = Number(row?.wait_ms);
    const eligibleAtMs = Date.parse(
      row?.eligible_at instanceof Date
        ? row.eligible_at.toISOString()
        : (row?.eligible_at ?? ""),
    );
    if (
      !Number.isSafeInteger(wait) ||
      !Number.isFinite(eligibleAtMs) ||
      wait > maximumWaitMs
    )
      throw new Error("AROMA_RESTART_ELIGIBILITY_UNAVAILABLE");
    if (wait <= 0)
      return {
        eligibleAtUtc: new Date(eligibleAtMs).toISOString(),
        waitMs: Math.max(0, Math.round(monotonicNow() - started)),
      };
    const remaining = maximumWaitMs - (monotonicNow() - started);
    if (remaining <= 0) throw new Error("AROMA_RESTART_ELIGIBILITY_TIMEOUT");
    await pause(Math.min(wait, Math.floor(remaining)), undefined, { signal });
  }
}

function constantTimeCapabilityMatch(expected, provided) {
  if (typeof provided !== "string" || !/^[a-f0-9]{64}$/u.test(provided))
    return false;
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(provided, "hex"),
  );
}

function normalizedCartLines(snapshot) {
  if (!Array.isArray(snapshot?.lines))
    throw new Error("AROMA_CART_SNAPSHOT_INVALID");
  return snapshot.lines
    .map((line) => {
      if (
        !line ||
        !/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(line.offerRef ?? "") ||
        !/^[1-9][0-9]*$/u.test(line.quantity ?? "") ||
        line.sourceGrindKeyHash !== undefined
      )
        throw new Error("AROMA_CART_CONTAINS_UNSUPPORTED_LINE");
      return { offerRef: line.offerRef, quantity: line.quantity };
    })
    .sort((a, b) => a.offerRef.localeCompare(b.offerRef));
}

export function assertAromaCartVector(snapshot, expectedLines) {
  const actual = normalizedCartLines(snapshot);
  const expected = [...expectedLines]
    .map((line) => ({ offerRef: line.offerRef, quantity: line.quantity }))
    .sort((a, b) => a.offerRef.localeCompare(b.offerRef));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("AROMA_FOREIGN_CART_CHANGE");
  return actual;
}

export function canCleanupAromaAfterFailure({
  snapshot,
  baselineFingerprint,
  unresolvedReservations,
  dirtyWorkRows,
}) {
  if (
    !Number.isSafeInteger(unresolvedReservations) ||
    unresolvedReservations !== 0 ||
    !Number.isSafeInteger(dirtyWorkRows) ||
    dirtyWorkRows !== 0 ||
    typeof baselineFingerprint !== "string" ||
    snapshot?.cartFingerprint !== baselineFingerprint
  )
    return false;
  try {
    assertAromaCartVector(snapshot, []);
    return true;
  } catch {
    return false;
  }
}

export function assertAromaControlledOfferFacts(
  binding,
  { offerRef, supplierRef, defaultPacking, accountFingerprint, wireProof },
) {
  const hasPacking = binding && Object.hasOwn(binding, "packing");
  const hasGrindId = binding && Object.hasOwn(binding, "grindId");
  const proofCanFillMissing =
    wireProof &&
    validatedAromaPackingProofs.has(wireProof) &&
    wireProof.providerOfferId === "445" &&
    binding?.rawProviderOfferId === "445" &&
    wireProof.accountFingerprint === accountFingerprint &&
    wireProof.packing === defaultPacking &&
    wireProof.grindId === null;
  if (
    !binding ||
    binding.offerRef !== offerRef ||
    binding.supplierRef !== supplierRef ||
    typeof defaultPacking !== "string" ||
    !defaultPacking ||
    (hasPacking && binding.packing !== defaultPacking) ||
    (hasGrindId && binding.grindId !== null) ||
    ((!hasPacking || !hasGrindId) && !proofCanFillMissing)
  ) {
    throw new Error("AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN");
  }
  return binding;
}

export function assertAromaApprovalForOffer(approval, offerRef) {
  if (approval?.maximumQuantity !== "2" || approval.offerRef !== offerRef)
    throw new Error("AROMA_APPROVAL_OPERATION_SCOPE_INVALID");
  return approval;
}

const SAFE_FAILURE_CODES = new Set([
  "AROMA_ACCOUNT_FINGERPRINT_INPUT_INVALID",
  "AROMA_PROXY_TARGET_INVALID",
  "AROMA_PROXY_REQUEST_TOO_LARGE",
  "AROMA_PROXY_REQUEST_INVALID",
  "AROMA_PROXY_RESPONSE_TOO_LARGE",
  "AROMA_PROXY_LISTEN_FAILED",
  "AROMA_GRANT_INVALID",
  "AROMA_APPROVAL_EXPIRED",
  "AROMA_PHASE_ORDER_INVALID",
  "AROMA_CART_SNAPSHOT_INVALID",
  "AROMA_CART_CONTAINS_UNSUPPORTED_LINE",
  "AROMA_FOREIGN_CART_CHANGE",
  "AROMA_SCOPED_SECRET_PATH_INVALID",
  "AROMA_SCOPED_SECRET_FILE_INVALID",
  "AROMA_SCOPED_SECRET_SCOPE_INVALID",
  "AROMA_LOCAL_REQUEST_TOO_LARGE",
  "AROMA_LOCAL_REQUEST_INVALID",
  "AROMA_PROFILE_TOO_LARGE",
  "AROMA_PROFILE_INVALID",
  "AROMA_MIGRATION_OWNER_INVALID",
  "AROMA_MIGRATION_PATH_INVALID",
  "AROMA_MIGRATION_SET_INVALID",
  "AROMA_MIGRATION_FILE_INVALID",
  "AROMA_DESIRED_FIXTURE_INVALID",
  "AROMA_DESIRED_REVISION_INVALID",
  "AROMA_GATEWAY_CONFIG_INVALID",
  "AROMA_GATEWAY_LOOPBACK_LISTEN_FAILED",
  "AROMA_ACCOUNT_FINGERPRINT_MISMATCH",
  "AROMA_ARGUMENTS_INVALID",
  "AROMA_APPROVAL_FILE_INVALID",
  "AROMA_CONVERGENCE_CHILD_TIMEOUT",
  "AROMA_CONVERGENCE_CHILD_START_FAILED",
  "AROMA_CONVERGENCE_CHILD_FAILED",
  "AROMA_CONVERGENCE_CHILD_RESULT_MISSING",
  "AROMA_WORKER_CONTEXT_INVALID",
  "AROMA_MUTATION_CONFIG_INVALID",
  "AROMA_APPROVAL_OPERATION_SCOPE_INVALID",
  "PRODUCTION_ENVIRONMENT_DENIED",
  "AROMA_APPROVAL_FILE_REQUIRED",
  "AROMA_APPROVAL_FILE_PATH_MUST_BE_ABSOLUTE",
  "AROMA_APPROVAL_QUANTITY_MUST_ALLOW_TWO",
  "AROMA_BASELINE_CART_NOT_EMPTY",
  "AROMA_APPROVAL_INVALID",
  "AROMA_NOOP_EQUALITY_FAILED",
  "AROMA_SINGLE_MUTATION_NOT_VERIFIED",
  "AROMA_SINGLE_GATEWAY_JOURNAL_INVALID",
  "AROMA_LOST_RESPONSE_NOT_UNKNOWN",
  "AROMA_ACKNOWLEDGEMENT_NOT_DROPPED_OR_JOURNALED",
  "AROMA_RESTART_RECOVERY_FAILED",
  "AROMA_OLD_OPERATION_REPLAYED",
  "AROMA_RECOVERY_DESIRED_CHANGED",
  "AROMA_BASELINE_RESTORE_FAILED",
  "AROMA_FINAL_DESIRED_NOT_VERIFIED",
  "AROMA_RESTORE_MUTATION_INVALID",
  "AROMA_BASELINE_CHANGED_BEFORE_PHASES",
  "AROMA_RESOURCE_CLEANUP_FAILED",
  "AROMA_MIGRATION_SET_INVALID",
  "AROMA_MIGRATION_LEDGER_INVALID",
  "AROMA_MIGRATION_APPLY_FAILED",
  "AROMA_PREPARATION_CART_CHANGED",
  "AROMA_MUTATION_PHASE_INVALID",
  "AROMA_RESTART_ELIGIBILITY_UNAVAILABLE",
  "AROMA_RESTART_ELIGIBILITY_TIMEOUT",
  "AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN",
  "AROMA_PACKING_WIRE_PROOF_NOT_PROVEN",
  "AROMA_CATALOG_STAGE_FAILED",
  "AROMA_SANDBOX_CATALOG_CHECK_FAILED",
  "RECOVERY_REQUIRED",
  "G16_CHILD_FAILURE_UNVERIFIED",
]);

export function safeAromaFailureCode(error) {
  if (error instanceof AdmissionError && /^[A-Z0-9_]{1,80}$/u.test(error.code))
    return error.code;
  if (
    typeof error?.message === "string" &&
    /^AROMA_MIGRATION_SQLSTATE_[0-9A-Z]{5}$/u.test(error.message)
  )
    return error.message;
  return SAFE_FAILURE_CODES.has(error?.message)
    ? error.message
    : "AROMA_SANDBOX_FAILED";
}

export function normalizeCleanupFailureOutcome(outcome) {
  if (!outcome?.cleanup?.failed) return outcome;
  return {
    ...outcome,
    status: "FAIL",
    code: "AROMA_RESOURCE_CLEANUP_FAILED",
    stage: "cleanup",
  };
}

const CONVERGENCE_ATTEMPT_STATES = new Set([
  "Started",
  "Observed",
  "MutationReserved",
  "MutationDispatched",
  "VerifiedInSync",
  "NoOpInSync",
  "OutOfSync",
  "UnknownOutcome",
  "Blocked",
  "Failed",
]);
const CONVERGENCE_RESERVATION_STATES = new Set([
  "Reserved",
  "Dispatched",
  "Acknowledged",
  "Verified",
  "UnknownOutcome",
  "RecoveredApplied",
  "RecoveredNotApplied",
]);
const GATEWAY_JOURNAL_STATES = new Set([
  "Reserved",
  "Dispatched",
  "Acknowledged",
  "Rejected",
  "UnknownOutcome",
]);
const CONVERGENCE_ACTIONS = new Set(["SetQuantity", "Remove"]);
const CONVERGENCE_CODES = new Set([
  "AROMA_WORKER_INTERRUPTED",
  "AROMA_OBSERVATION_UNAVAILABLE",
  "AROMA_OBSERVATION_INVALID",
  "AROMA_EXTERNAL_CHANGE",
  "AROMA_QUANTITY_NOT_SUPPORTED",
  "AROMA_MUTATIONS_DISABLED",
  "AROMA_MAPPING_NOT_AVAILABLE",
  "AROMA_CART_ITEM_NOT_FOUND",
  "AROMA_OPERATION_UNKNOWN_OUTCOME",
  "AROMA_VERIFICATION_UNAVAILABLE",
  "AROMA_VERIFICATION_INVALID",
  "MAPPING_CHANGED",
  "MAPPING_MISSING",
  "MAPPING_STOPPED",
  "PRODUCT_UNAVAILABLE",
]);
const SANDBOX_PHASES = new Set([
  "approval",
  "baseline-read",
  "noop",
  "single-mutation",
  "lost-response",
  "restart-reconcile",
  "restore",
  "final-read",
]);

function safeStateCounts(rows, states) {
  if (!Array.isArray(rows)) return [];
  return rows
    .flatMap((row) => {
      const count =
        typeof row?.count === "string" &&
        /^(0|[1-9][0-9]{0,8})$/u.test(row.count)
          ? Number(row.count)
          : row?.count;
      return states.has(row?.state) && Number.isSafeInteger(count) && count >= 0
        ? [{ state: row.state, count }]
        : [];
    })
    .sort((left, right) =>
      left.state < right.state ? -1 : left.state > right.state ? 1 : 0,
    );
}

/** Keep only the finite, non-payload convergence facts needed to diagnose a failed phase. */
export function safeAromaConvergenceEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const row = value.latestAttempt;
  const latestAttempt =
    row && CONVERGENCE_ATTEMPT_STATES.has(row.state)
      ? {
          state: row.state,
          failureCode: CONVERGENCE_CODES.has(row.failure_code)
            ? row.failure_code
            : null,
          blockerCodes: Array.isArray(row.blocker_codes)
            ? [
                ...new Set(
                  row.blocker_codes.filter((code) =>
                    CONVERGENCE_CODES.has(code),
                  ),
                ),
              ].sort((left, right) =>
                left < right ? -1 : left > right ? 1 : 0,
              )
            : [],
          selectedAction: CONVERGENCE_ACTIONS.has(row.selected_action)
            ? row.selected_action
            : null,
          selectedOfferMatches:
            typeof row.selected_offer_matches === "boolean"
              ? row.selected_offer_matches
              : null,
        }
      : null;
  return {
    latestAttempt,
    reservationStateCounts: safeStateCounts(
      value.reservationStateCounts,
      CONVERGENCE_RESERVATION_STATES,
    ),
    gatewayJournalStateCounts: safeStateCounts(
      value.gatewayJournalStateCounts,
      GATEWAY_JOURNAL_STATES,
    ),
  };
}

export function safeAromaPhaseFailureEvidence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.completedPhases) ||
    !SANDBOX_PHASES.has(value.failedPhase) ||
    typeof value.failedAtUtc !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
      value.failedAtUtc,
    )
  )
    return null;
  const completedPhases = value.completedPhases
    .flatMap((phase) => {
      if (
        !SANDBOX_PHASES.has(phase?.phase) ||
        phase.status !== "PASS" ||
        typeof phase.capturedAtUtc !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
          phase.capturedAtUtc,
        )
      )
        return [];
      return [
        {
          phase: phase.phase,
          status: "PASS",
          capturedAtUtc: phase.capturedAtUtc,
        },
      ];
    })
    .slice(-SANDBOX_PHASES.size);
  if (completedPhases.length !== value.completedPhases.length) return null;
  return {
    partialPhaseEvidence: [
      ...completedPhases,
      {
        phase: value.failedPhase,
        status: "FAIL",
        capturedAtUtc: value.failedAtUtc,
      },
    ],
    ...(safeAromaConvergenceEvidence(value.convergenceEvidence)
      ? {
          convergenceEvidence: safeAromaConvergenceEvidence(
            value.convergenceEvidence,
          ),
        }
      : {}),
  };
}

export async function captureAromaPhaseFailureFacts({
  completedPhases,
  failedPhase,
  readLatestEvidence,
}) {
  let convergenceEvidence = null;
  try {
    convergenceEvidence = await readLatestEvidence();
  } catch {
    /* Do not reuse an earlier phase snapshot. */
  }
  return {
    completedPhases,
    failedPhase,
    failedAtUtc: new Date().toISOString(),
    convergenceEvidence,
  };
}

const SANDBOX_STAGES = Object.freeze([
  "resources",
  "migrations",
  "runtime-databases",
  "gateway",
  "profile",
  "baseline",
  "catalog",
  "approval",
  "phases",
  "cleanup",
]);
function checkedStage(stage) {
  return SANDBOX_STAGES.includes(stage) ? stage : "resources";
}

function migrationDiagnostic(error) {
  const value = error?.safeDiagnostic;
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.migrationId !== "string" ||
    !/^\d{4}_[a-z][a-z0-9_]*$/u.test(value.migrationId)
  )
    return null;
  if (
    value.sqlState !== undefined &&
    (typeof value.sqlState !== "string" ||
      !/^[0-9A-Z]{5}$/u.test(value.sqlState))
  )
    return null;
  return {
    migrationId: value.migrationId,
    ...(value.sqlState ? { sqlState: value.sqlState } : {}),
  };
}

const SANDBOX_DIAGNOSTIC_SUBSTAGES = new Set([
  "catalog-import",
  "catalog-activation",
  "selection",
  "catalog-outbox",
  "orders-inbox",
]);
export function safeAromaDiagnostic(error) {
  const value = error?.safeDiagnostic;
  if (
    !value ||
    typeof value !== "object" ||
    !SANDBOX_DIAGNOSTIC_SUBSTAGES.has(value.substage)
  )
    return null;
  const validCode = (code) =>
    typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code);
  if (
    (value.ownerCode !== undefined && !validCode(value.ownerCode)) ||
    (value.causeCode !== undefined && !validCode(value.causeCode)) ||
    (value.sqlState !== undefined &&
      (typeof value.sqlState !== "string" ||
        !/^[0-9A-Z]{5}$/u.test(value.sqlState)))
  )
    return null;
  return {
    substage: value.substage,
    ...(value.ownerCode ? { ownerCode: value.ownerCode } : {}),
    ...(value.sqlState ? { sqlState: value.sqlState } : {}),
    ...(value.causeCode ? { causeCode: value.causeCode } : {}),
  };
}

/** Capture a failed private catalog persistence call without changing its error. */
export function captureAromaCatalogPersistenceFailure(operation, capture) {
  if (typeof operation !== "function" || typeof capture !== "function")
    throw new Error("AROMA_CATALOG_CAPTURE_INVALID");
  return async (...args) => {
    try {
      return await operation(...args);
    } catch (error) {
      try {
        capture(error);
      } catch {
        /* diagnostics must not replace the persistence failure */
      }
      throw error;
    }
  };
}

function sandboxDiagnostic(error) {
  return safeAromaDiagnostic(error) ?? migrationDiagnostic(error);
}

const MAX_HTTP_BODY = 64 * 1024;
const MIGRATION_PATHS = Object.freeze({
  catalog: "apps/catalog-service/migrations",
  orders: "apps/orders-service/migrations",
  integration: "apps/aroma-gateway/migrations",
});
const MAX_PROFILE_BYTES = 64 * 1024;

function requireValue(value, code) {
  if (
    typeof value !== "string" ||
    !value ||
    !value.isWellFormed() ||
    value.includes("\0")
  )
    throw new Error(code);
  return value;
}

function secretAt(value, path) {
  for (const part of path.split("."))
    value =
      value !== null && typeof value === "object" ? value[part] : undefined;
  return value;
}

async function readScopedSecrets(path, runtime) {
  const absolute = resolve(path ?? "");
  if (
    absolute.split("/").at(-1) !== "coffee-platform.yaml" ||
    absolute.split("/").at(-2) !== runtime ||
    !absolute.startsWith("/dev/shm/coffee-g16-secrets-") ||
    (await realpath(absolute).catch(() => null)) !== absolute
  ) {
    throw new Error("AROMA_SCOPED_SECRET_PATH_INVALID");
  }
  const info = await lstat(absolute);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o400 ||
    info.size > 256 * 1024
  ) {
    throw new Error("AROMA_SCOPED_SECRET_FILE_INVALID");
  }
  const document = parseYaml(await readFile(absolute, "utf8"));
  if (
    document?.runtime !== runtime ||
    !document?.secrets ||
    document.environment === "production"
  )
    throw new Error("AROMA_SCOPED_SECRET_SCOPE_INVALID");
  return document.secrets;
}

function jsonResponse(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type":
      status >= 400 ? "application/problem+json" : "application/json",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function requestBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_HTTP_BODY) throw new Error("AROMA_LOCAL_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("AROMA_LOCAL_REQUEST_INVALID");
  }
}

async function boundedProfile(
  sessions,
  credentials,
  decodeUser,
  readProviderSafely,
  signal,
) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of readProviderSafely(
    sessions,
    credentials,
    { kind: "user" },
    signal,
  )) {
    bytes += chunk.byteLength;
    if (bytes > MAX_PROFILE_BYTES) throw new Error("AROMA_PROFILE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  let profile;
  try {
    profile = decodeUser(
      JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")),
    );
  } catch {
    throw new Error("AROMA_PROFILE_INVALID");
  }
  return profile;
}

export async function applyCanonicalMigrations(
  root,
  ownerClient,
  owner,
  migrationTools,
) {
  const relative = MIGRATION_PATHS[owner];
  if (!relative) throw new Error("AROMA_MIGRATION_OWNER_INVALID");
  const directory = join(root, relative);
  if ((await realpath(directory).catch(() => null)) !== directory)
    throw new Error("AROMA_MIGRATION_PATH_INVALID");
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => /^\d{4}_[a-z][a-z0-9_]*\.sql$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    !migrations.length ||
    migrations.length !== entries.filter((entry) => entry.isFile()).length ||
    migrations.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new Error("AROMA_MIGRATION_SET_INVALID");
  }
  const files = [];
  for (const entry of migrations) {
    const path = join(directory, entry.name);
    if (
      (await realpath(path).catch(() => null)) !== path ||
      !(await lstat(path)).isFile()
    )
      throw new Error("AROMA_MIGRATION_FILE_INVALID");
    const sql = await readFile(path, "utf8");
    if (!sql || sql.length > 2 * 1024 * 1024)
      throw new Error("AROMA_MIGRATION_FILE_INVALID");
    files.push({ id: entry.name.slice(0, -4), sql });
  }
  let tools = migrationTools;
  if (!tools) {
    try {
      tools = await import(
        pathToFileURL(join(root, "packages/platform-migrations/dist/index.js"))
          .href
      );
    } catch {
      throw new Error("AROMA_MIGRATION_SET_INVALID");
    }
  }
  let validated;
  try {
    const withChecksums = files.map(({ id, sql }) => ({
      id,
      sql,
      checksum: tools.migrationChecksum(sql),
    }));
    validated = tools.validateMigrations(withChecksums);
  } catch {
    throw new Error("AROMA_MIGRATION_SET_INVALID");
  }
  const schema =
    owner === "catalog"
      ? "catalog"
      : owner === "orders"
        ? "orders"
        : "integration";
  const ledger = `${schema}.platform_schema_migrations`;
  let applyingId = null;
  await ownerClient.query("BEGIN");
  try {
    await ownerClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `coffee-platform-g16-migrations:${ledger}`,
    ]);
    await ownerClient.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
      id text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const appliedRows = (
      await ownerClient.query(`SELECT id,checksum FROM ${ledger} ORDER BY id`)
    ).rows;
    if (!Array.isArray(appliedRows) || appliedRows.length > validated.length)
      throw new Error("AROMA_MIGRATION_LEDGER_INVALID");
    for (const [index, row] of appliedRows.entries()) {
      if (
        row?.id !== validated[index]?.id ||
        row?.checksum !== validated[index]?.checksum
      )
        throw new Error("AROMA_MIGRATION_LEDGER_INVALID");
    }
    for (const migration of validated.slice(appliedRows.length)) {
      applyingId = migration.id;
      await ownerClient.query(migration.sql);
      await ownerClient.query(
        `INSERT INTO ${ledger}(id,checksum) VALUES($1,$2)`,
        [migration.id, migration.checksum],
      );
    }
    await ownerClient.query("COMMIT");
    return validated.length;
  } catch (error) {
    await ownerClient.query("ROLLBACK").catch(() => {});
    if (
      error instanceof Error &&
      ["AROMA_MIGRATION_LEDGER_INVALID"].includes(error.message)
    )
      throw error;
    const sqlState =
      typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
        ? error.code
        : null;
    const failure = new Error(
      sqlState
        ? `AROMA_MIGRATION_SQLSTATE_${sqlState}`
        : "AROMA_MIGRATION_APPLY_FAILED",
    );
    failure.safeDiagnostic = {
      migrationId: applyingId,
      ...(sqlState ? { sqlState } : {}),
    };
    throw failure;
  }
}

/** Append one run-owned Desired revision. The fixture never writes Observed or recovery facts. */
export async function appendAromaSandboxDesired(ownerClient, lines) {
  if (
    !Array.isArray(lines) ||
    lines.length > 1 ||
    lines.some(
      (line) =>
        !line ||
        !/^off_[0-9A-HJKMNP-TV-Z]{26}$/u.test(line.offerRef ?? "") ||
        !["1000", "2000"].includes(line.quantityMilli) ||
        line.sourceGrindKeyHash !== undefined,
    )
  ) {
    throw new Error("AROMA_DESIRED_FIXTURE_INVALID");
  }
  const normalizedLines = lines.map(({ offerRef, quantityMilli }) => ({
    offerRef,
    quantityMilli,
  }));
  const desiredHash = createHash("sha256")
    .update(JSON.stringify({ lines: normalizedLines, codes: [] }), "utf8")
    .digest("hex");
  await ownerClient.query("BEGIN");
  try {
    await ownerClient.query(
      "SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
    );
    const { rows } = await ownerClient.query(
      "SELECT (COALESCE(max(desired_revision),0)+1)::text AS revision FROM orders.cart_desired_revisions",
    );
    const revision = rows[0]?.revision;
    if (!/^[1-9][0-9]*$/u.test(revision ?? ""))
      throw new Error("AROMA_DESIRED_REVISION_INVALID");
    await ownerClient.query(
      "UPDATE orders.cart_desired_revisions SET state='Superseded' WHERE cart_scope_ref='aroma-primary' AND state='Current'",
    );
    await ownerClient.query(
      "INSERT INTO orders.cart_desired_revisions(cart_scope_ref,desired_revision,state,desired_hash,source_max_order_version) VALUES('aroma-primary',$1,'Current',$2,0)",
      [revision, desiredHash],
    );
    for (const line of normalizedLines) {
      await ownerClient.query(
        "INSERT INTO orders.cart_desired_lines(cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash,quantity_milli,contribution_hash,contributing_order_refs) VALUES('aroma-primary',$1,$2,NULL,$3,$4,'[]'::jsonb)",
        [revision, line.offerRef, line.quantityMilli, desiredHash],
      );
    }
    await ownerClient.query(
      `INSERT INTO orders.convergence_work(cart_scope_ref,desired_revision,reason,next_attempt_at)
      VALUES('aroma-primary',$1,'Recovery',clock_timestamp())
      ON CONFLICT(cart_scope_ref) DO UPDATE SET desired_revision=EXCLUDED.desired_revision,dirty=true,
        wake_revision=orders.convergence_work.wake_revision+1,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()`,
      [revision],
    );
    await ownerClient.query("COMMIT");
    return { revision, desiredHash };
  } catch (error) {
    await ownerClient.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function startGatewayOwnerHarness({
  root,
  config,
  databases,
  gatewaySecrets,
  signal,
}) {
  const moduleAt = (relative) =>
    import(pathToFileURL(join(root, relative)).href);
  const [
    httpModule,
    sessionModule,
    sessionStoreModule,
    readerModule,
    bindingModule,
    journalModule,
    mutatorModule,
    executorModule,
    catalogSourceModule,
    catalogExportModule,
    catalogStoreModule,
    catalogOwnerModule,
    decoderModule,
    catalogDiagnosticModule,
  ] = await Promise.all([
    moduleAt("apps/aroma-gateway/dist/infrastructure/provider/http-client.js"),
    moduleAt("apps/aroma-gateway/dist/infrastructure/provider/session.js"),
    moduleAt(
      "apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js",
    ),
    moduleAt("apps/aroma-gateway/dist/application/cart-reader.js"),
    moduleAt(
      "apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js",
    ),
    moduleAt(
      "apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js",
    ),
    moduleAt("apps/aroma-gateway/dist/application/provider-cart-mutator.js"),
    moduleAt("apps/aroma-gateway/dist/domain/mutation-journal.js"),
    moduleAt("apps/aroma-gateway/dist/application/provider-catalog-source.js"),
    moduleAt("apps/aroma-gateway/dist/application/catalog-export.js"),
    moduleAt(
      "apps/catalog-service/dist/infrastructure/postgres/catalog-store.js",
    ),
    moduleAt("apps/catalog-service/dist/http/index.js"),
    moduleAt("apps/aroma-gateway/dist/infrastructure/provider/decoder.js"),
    moduleAt("verification/launch/v1/scenarios/aroma-sandbox-catalog.mjs"),
  ]);
  const service = config.services["aroma-gateway"];
  const convergence = config.services["aroma-convergence"];
  const secret = (name) =>
    requireValue(
      secretAt(gatewaySecrets, `aroma.${name}`),
      `AROMA_GATEWAY_${name.toUpperCase()}_MISSING`,
    );
  const origin = canonicalHttpsOrigin(`https://${config.aroma.origin.host}`);
  if (!origin || origin !== config.verification.aromaSandbox.origin)
    throw new Error("AROMA_GATEWAY_CONFIG_INVALID");
  const credentials = {
    scopeRef: config.aroma.scopeRef,
    email: secret("email"),
    password: secret("password"),
  };
  const identityKey = Buffer.from(secret("catalogIdentityKeyV1"), "utf8");
  const providerHttp = new httpModule.ProviderHttpClient({
    origin,
    timeoutMs: service.deadlineProfiles.cartMs,
    maxResponseBytes: 2 * 1024 * 1024,
    connections: service.concurrency,
  });
  const sessions = new sessionModule.ProviderSessionManager({
    transport: providerHttp,
    store: new sessionStoreModule.ProviderSessionStoreAdapter(
      databases.gateway,
    ),
    encryptionKey: createHash("sha256")
      .update(secret("sessionEncryptionKey"), "utf8")
      .digest(),
  });
  const bindings = new bindingModule.OfferBindingStore(databases.gateway);
  const reader = new readerModule.ProviderCartReader({
    sessions,
    credentials,
    bindings,
    supplierRef: config.aroma.supplierRef,
    defaultPacking: config.aroma.defaultPacking,
    sourceIdentityKey: identityKey,
  });
  const journal = new journalModule.ProviderMutationJournalStore(
    databases.gateway,
  );
  let catalogExportFailureFacts = null;
  const captureCatalogPersistenceFailure = (operation) =>
    captureAromaCatalogPersistenceFailure(operation, (error) => {
      catalogExportFailureFacts =
        catalogDiagnosticModule.aromaCatalogErrorFacts(error);
    });
  let activeMutationGuard = null;
  const mutationSessions = Object.freeze({
    acquire: (...args) => {
      if (!activeMutationGuard) throw new Error("AROMA_MUTATION_PHASE_INVALID");
      return activeMutationGuard.sessions.acquire(...args);
    },
  });
  const mutationBindings = Object.freeze({
    resolveProviderOffer: (...args) => {
      if (!activeMutationGuard) throw new Error("AROMA_MUTATION_PHASE_INVALID");
      return activeMutationGuard.bindings.resolveProviderOffer(...args);
    },
  });
  const mutator = new mutatorModule.ProviderCartMutator({
    sessions: mutationSessions,
    credentials,
    bindings: mutationBindings,
    supplierRef: config.aroma.supplierRef,
    sourceIdentityKey: identityKey,
    defaultPacking: config.aroma.defaultPacking,
    transport: providerHttp,
  });
  const executor = new executorModule.GatewayMutationExecutor(
    journal,
    mutator.execute.bind(mutator),
  );
  const catalogOwner = catalogOwnerModule.createCatalogOwner(
    new catalogStoreModule.CatalogStore(databases.catalogRead),
  );
  const snapshotProofAge =
    config.services["catalog-service"]?.catalogSnapshotProof?.maxAgeMs;
  if (!Number.isSafeInteger(snapshotProofAge) || snapshotProofAge <= 0)
    throw new Error("AROMA_CATALOG_SNAPSHOT_PROOF_CONFIG_INVALID");
  const exportBoundary = {
    identity: {
      resolve: (offer, context) =>
        catalogSourceModule.sourceIdentityForOffer(
          offer,
          context.supplierRef,
          identityKey,
        ),
    },
    hash: { sha256: catalogExportModule.sha256CatalogHash },
    persistence: {
      beginExport: captureCatalogPersistenceFailure((record, currentSignal) =>
        bindings.beginExport(
          record.snapshotRef,
          record.supplierRef,
          currentSignal,
        ),
      ),
      recordBatch: captureCatalogPersistenceFailure((input, currentSignal) => {
        const supplierRef = input.identities[0]?.supplierRef;
        if (supplierRef !== undefined)
          return bindings.recordBatch(
            input.record.snapshotRef,
            supplierRef,
            input.record,
            input.identities,
            currentSignal,
          );
      }),
      completeExport: captureCatalogPersistenceFailure(
        (summary, currentSignal) =>
          bindings.completeExport(summary, currentSignal),
      ),
      failExport: (input, currentSignal) =>
        bindings.failExport(input.record.snapshotRef, currentSignal),
      abortExport: (snapshotRef, currentSignal) =>
        bindings.abortExport(snapshotRef, currentSignal),
    },
  };
  let mutationGrant;
  let activeMutationPhase = null;
  let expectedCartVector = null;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.socket.remoteAddress !== "127.0.0.1" || signal.aborted) {
        jsonResponse(response, 404, { code: "NOT_FOUND" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method === "POST" &&
        url.pathname === "/api/internal-v1/aroma/cart-snapshots:read"
      ) {
        const body = await requestBody(request);
        if (
          body?.cartScopeRef !== "aroma-primary" ||
          Object.keys(body).length !== 1
        ) {
          jsonResponse(response, 400, { code: "VALIDATION_FAILED" });
          return;
        }
        jsonResponse(
          response,
          200,
          await reader.read(
            AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          ),
        );
        return;
      }
      const mutation =
        /^\/api\/internal-v1\/aroma\/cart-lines\/(off_[0-9A-HJKMNP-TV-Z]{26}):(set-quantity|remove)$/u.exec(
          url.pathname,
        );
      if (request.method === "POST" && mutation) {
        const body = await requestBody(request);
        const operationRef = body?.operationRef;
        const isSetQuantity = mutation[2] === "set-quantity";
        const expectedKeys = isSetQuantity
          ? [
              "cartScopeRef",
              "operationRef",
              "quantity",
              ...(body?.sourceGrindKeyHash === undefined
                ? []
                : ["sourceGrindKeyHash"]),
            ]
          : [
              "cartScopeRef",
              "operationRef",
              ...(body?.sourceGrindKeyHash === undefined
                ? []
                : ["sourceGrindKeyHash"]),
            ];
        if (
          !/^op_[0-9A-HJKMNP-TV-Z]{26}$/u.test(operationRef ?? "") ||
          body?.cartScopeRef !== "aroma-primary" ||
          Object.keys(body ?? {})
            .sort()
            .join(",") !== expectedKeys.sort().join(",") ||
          (isSetQuantity && !["1", "2"].includes(body?.quantity)) ||
          (body?.sourceGrindKeyHash !== undefined &&
            !/^[a-f0-9]{64}$/u.test(body.sourceGrindKeyHash))
        ) {
          jsonResponse(response, 400, { code: "VALIDATION_FAILED" });
          return;
        }
        if (activeMutationGuard) {
          jsonResponse(response, 409, { code: "MUTATION_ALREADY_IN_PROGRESS" });
          return;
        }
        const operationKind = isSetQuantity ? "SetLineQuantity" : "RemoveLine";
        if (
          !mutationGrant ||
          !activeMutationPhase ||
          !Array.isArray(expectedCartVector) ||
          request.headers["x-coffee-g16-phase"] !== activeMutationPhase
        ) {
          jsonResponse(response, 403, { code: "MUTATION_NOT_AUTHORIZED" });
          return;
        }
        const freshSnapshot = await reader.read(
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        );
        assertAromaCartVector(freshSnapshot, expectedCartVector);
        const phase = activeMutationPhase;
        const expectedBefore = expectedCartVector;
        const claimed = mutationGrant.claim({
          providedCapability: request.headers["x-coffee-g16-capability"],
          phase: activeMutationPhase,
          operation: operationKind,
          offerRef: mutation[1],
          quantity: body.quantity,
          sourceGrindKeyHash: body.sourceGrindKeyHash,
        });
        if (!claimed) {
          jsonResponse(response, 403, { code: "MUTATION_NOT_AUTHORIZED" });
          return;
        }
        activeMutationGuard = createAromaProviderMutationGuard({
          phase,
          offerRef: mutation[1],
          expectedLines: expectedBefore,
          expiresAtEpochMs: mutationGrant.expiresAtEpochMs,
          defaultPacking: config.aroma.defaultPacking,
          decodeCartSnapshot: decoderModule.decodeCartSnapshot,
          sessions,
          bindings,
        });
        activeMutationPhase = null;
        expectedCartVector = null;
        const requestValue = {
          operationRef,
          cartScopeRef: "aroma-primary",
          operationKind,
          offerRef: mutation[1],
          ...(operationKind === "SetLineQuantity"
            ? { quantityMilli: body.quantity }
            : {}),
        };
        const delegation = {
          transportCaller: "api-internal",
          issuer: "api-internal",
          audience: "aroma-gateway",
          originalCaller: "aroma-convergence",
          operationId:
            operationKind === "SetLineQuantity"
              ? "setAromaCartLineQuantity"
              : "removeAromaCartLine",
          callerIdentity: "api-internal",
          correlationId: randomUUID(),
        };
        let result;
        try {
          result = await executor.execute(
            requestValue,
            delegation,
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          );
        } finally {
          activeMutationGuard = null;
        }
        if (result.state === "Acknowledged" || result.state === "Rejected") {
          jsonResponse(
            response,
            result.statusCode,
            JSON.parse(Buffer.from(result.responseBodyBytes).toString("utf8")),
          );
        } else {
          jsonResponse(response, 409, {
            type: "about:blank",
            title: "AROMA_OPERATION_UNKNOWN_OUTCOME",
            status: 409,
            code:
              result.state === "UnknownOutcome"
                ? "AROMA_OPERATION_UNKNOWN_OUTCOME"
                : "AROMA_OPERATION_IN_PROGRESS",
            detail: "mutation outcome requires reconciliation",
            errors: [],
          });
        }
        return;
      }
      const pricing =
        /^\/api\/internal-v1\/catalog\/products\/(prd_[0-9A-HJKMNP-TV-Z]{26})\/variants\/(var_[0-9A-HJKMNP-TV-Z]{26})\/pricing-input$/u.exec(
          url.pathname,
        );
      if (request.method === "GET" && pricing) {
        const correlationId = randomUUID();
        try {
          const result = await catalogOwner.pricingInput({
            productRef: pricing[1],
            variantRef: pricing[2],
            context: {
              correlationId,
              signal: AbortSignal.any([signal, AbortSignal.timeout(1_500)]),
            },
            maxSnapshotAgeMs: snapshotProofAge,
          });
          jsonResponse(response, result.status, result.body);
        } catch (error) {
          const code =
            error?.code === "CATALOG_PRODUCT_NOT_FOUND"
              ? "CATALOG_PRODUCT_NOT_FOUND"
              : error?.code === "CATALOG_SNAPSHOT_INCOMPLETE"
                ? "CATALOG_SNAPSHOT_INCOMPLETE"
                : "CATALOG_UNAVAILABLE";
          const status = code === "CATALOG_PRODUCT_NOT_FOUND" ? 404 : 503;
          jsonResponse(response, status, {
            type: "about:blank",
            title: code,
            status,
            code,
            detail:
              code === "CATALOG_PRODUCT_NOT_FOUND"
                ? "catalog product or variant was not found"
                : code === "CATALOG_SNAPSHOT_INCOMPLETE"
                  ? "active catalog snapshot is incomplete"
                  : "catalog is temporarily unavailable",
            instance: request.url ?? "/",
            correlationId,
            errors: [],
          });
        }
        return;
      }
      jsonResponse(response, 404, { code: "NOT_FOUND" });
    })().catch(() => {
      if (!response.destroyed)
        jsonResponse(response, 503, {
          type: "about:blank",
          title: "AROMA_PROVIDER_UNAVAILABLE",
          status: 503,
          code: "AROMA_PROVIDER_UNAVAILABLE",
          detail: "owner unavailable",
          errors: [],
        });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("AROMA_GATEWAY_LOOPBACK_LISTEN_FAILED");
  return {
    port: address.port,
    reader,
    sessions,
    resolveProviderOffer(offerRef, supplierRef, resolveSignal) {
      return bindings.resolveProviderOffer(
        offerRef,
        supplierRef,
        resolveSignal ?? signal,
      );
    },
    resolveByRawProviderOfferId(
      rawProviderOfferId,
      supplierRef,
      resolveSignal,
    ) {
      return bindings.resolveByRawProviderOfferId(
        rawProviderOfferId,
        supplierRef,
        resolveSignal ?? signal,
      );
    },
    activateGrant(approval, offerRef) {
      if (convergence.mutationsEnabled !== true)
        throw new Error("AROMA_MUTATION_CONFIG_INVALID");
      if (
        mutationGrant ||
        approval?.maximumQuantity !== "2" ||
        approval.offerRef !== offerRef
      )
        throw new Error("AROMA_GRANT_INVALID");
      mutationGrant = createAromaMutationGrant({
        offerRef,
        maximumQuantity: approval.maximumQuantity,
        expiresAtUtc: approval.expiresAtUtc,
      });
    },
    authorizeMutationPhase(phase, expectedLines) {
      if (
        !mutationGrant ||
        activeMutationPhase !== null ||
        !Array.isArray(expectedLines)
      )
        throw new Error("AROMA_PHASE_ORDER_INVALID");
      mutationGrant.authorize(phase);
      activeMutationPhase = phase;
      expectedCartVector = expectedLines.map(({ offerRef, quantity }) => ({
        offerRef,
        quantity,
      }));
      return mutationGrant.capability;
    },
    disableMutations() {
      mutationGrant?.disable();
      activeMutationPhase = null;
      expectedCartVector = null;
    },
    async exportCatalog({ snapshotRef, supplierRef, signal: exportSignal }) {
      const source = catalogSourceModule.createProviderCatalogSource({
        sessions,
        credentials,
        supplierRef,
        sourceIdentityKey: identityKey,
        pageSize: 10,
        signal: exportSignal,
      });
      const request = {
        snapshotRef,
        supplierRef,
        providerSnapshotRef: `aroma-gateway:catalog-export:${snapshotRef}`,
      };
      return catalogExportModule.createCatalogExportStream({
        source,
        request,
        boundary: exportBoundary,
        signal: exportSignal,
      });
    },
    catalogExportFailureFacts() {
      return catalogExportFailureFacts === null
        ? null
        : { ...catalogExportFailureFacts };
    },
    registerBinding(request, bindSignal) {
      return bindings.register(request, bindSignal ?? signal);
    },
    async close() {
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await sessions.close();
    },
  };
}

export async function inspectAromaProfile({
  sessions,
  credentials,
  identityKey,
  decodeUser,
  readProviderSafely,
  policy,
  signal,
}) {
  const profile = await boundedProfile(
    sessions,
    credentials,
    decodeUser,
    readProviderSafely,
    signal,
  );
  const fingerprint = computeExistingAccountFingerprint({
    catalogIdentityKeyV1: identityKey.toString("utf8"),
    origin: policy.origin,
    scopeRef: credentials.scopeRef,
    authenticatedEmail: profile.email,
    credentialEmail: credentials.email,
  });
  if (fingerprint !== policy.accountFingerprint)
    throw new Error("AROMA_ACCOUNT_FINGERPRINT_MISMATCH");
  return {
    accountFingerprint: fingerprint,
    wholesale: profile.wholesale,
    retail: profile.retail,
  };
}

export function parseArguments(args, env = process.env) {
  if (args[0] === "--") args = args.slice(1);
  if (args.length !== 2 || args[0] !== "--approval-file" || !args[1])
    throw new Error("AROMA_ARGUMENTS_INVALID");
  if (args[1] === "$AROMA_SANDBOX_APPROVAL_FILE") {
    const supplied = env.AROMA_SANDBOX_APPROVAL_FILE;
    if (typeof supplied !== "string" || !supplied)
      return { approvalFile: null };
    if (!supplied.startsWith("/"))
      throw new Error("AROMA_APPROVAL_FILE_PATH_MUST_BE_ABSOLUTE");
    return { approvalFile: resolve(supplied) };
  }
  return { approvalFile: resolve(args[1]) };
}

function result(status, code, details = {}) {
  process.stdout.write(
    `${JSON.stringify({ gate: "G16_AROMA_SANDBOX", status, code, ...details })}\n`,
  );
}

async function verifyApprovalFile(
  approvalFile,
  identity,
  contract,
  expectedOfferRef,
) {
  let approvalStat;
  try {
    approvalStat = await lstat(approvalFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("AROMA_APPROVAL_FILE_INVALID");
  }
  if (!approvalStat.isFile() || approvalStat.isSymbolicLink())
    throw new Error("AROMA_APPROVAL_FILE_INVALID");
  let signatureStat;
  try {
    signatureStat = await lstat(`${approvalFile}.sig`);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("AROMA_APPROVAL_FILE_INVALID");
  }
  if (!signatureStat.isFile() || signatureStat.isSymbolicLink())
    throw new Error("AROMA_APPROVAL_FILE_INVALID");
  let approvalBytes;
  let signatureBytes;
  try {
    approvalBytes = await readRegular(approvalFile, 16 * 1024);
    signatureBytes = await readRegular(`${approvalFile}.sig`, 1024);
  } catch (error) {
    if (
      error?.code === "FILE_PATH_INVALID" ||
      error?.code === "FILE_UNREADABLE"
    )
      return null;
    if (
      error instanceof AdmissionError &&
      [
        "FILE_INVALID_OR_TOO_LARGE",
        "FILE_PATH_INVALID",
        "FILE_UNREADABLE",
      ].includes(error.code)
    )
      throw error;
    throw new Error("AROMA_APPROVAL_FILE_INVALID");
  }
  const admitted = validateAdmission({
    approvalBytes,
    signatureBase64: signatureBytes.toString("utf8"),
    policy: contract.policy,
    identity: {
      context: identity.context,
      environment: contract.environment,
      credentialsAvailable: contract.credentialsAvailable,
    },
    encryptedSecrets: contract.encryptedSecrets,
    validateApproval: contract.validateApproval,
    expectedOfferRef,
  });
  return admitted.status === "PASS" ? admitted.approval : null;
}

async function waitForApproval(
  approvalFile,
  identity,
  contract,
  offerRef,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const approval = await verifyApprovalFile(
      approvalFile,
      identity,
      contract,
      offerRef,
    );
    if (approval) return approval;
    await new Promise((resolveWait) =>
      setTimeout(
        resolveWait,
        Math.min(250, Math.max(1, deadline - Date.now())),
      ),
    );
  }
  return null;
}

async function controlledParentRequest(stage, payload = {}) {
  if (process.env.COFFEE_G16_CONTROLLED_CHILD !== "1") return;
  if (!process.connected || !process.send)
    throw new Error("G16_PARENT_IPC_MISSING");
  await new Promise((resolvePromise, reject) => {
    const onDisconnect = () => {
      cleanup();
      reject(new Error("G16_PARENT_IPC_CLOSED"));
    };
    const onMessage = (message) => {
      cleanup();
      if (message?.ok === true && message.stage === stage) resolvePromise();
      else reject(new Error("G16_PARENT_IPC_REJECTED"));
    };
    const cleanup = () => {
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
    };
    process.once("disconnect", onDisconnect);
    process.once("message", onMessage);
    process.send({ stage, ...payload }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

async function migrateSandboxDatabases(root, resources) {
  const applied = {};
  for (const owner of ["catalog", "orders", "integration"]) {
    const client = await resources.openMigrator(owner);
    try {
      applied[owner] = await applyCanonicalMigrations(root, client, owner);
    } finally {
      await client.end();
    }
    await resources.finalizeDatabase(owner);
  }
  return applied;
}

async function readConvergenceEvidence(ordersClient, gatewayClient, offerRef) {
  const work = (
    await ordersClient.query(
      "SELECT desired_revision::text,dirty FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
    )
  ).rows[0];
  const currentLines = (
    await ordersClient.query(`SELECT l.offer_ref,l.quantity_milli::text FROM orders.cart_observed_revisions r
    LEFT JOIN orders.cart_observed_lines l ON l.cart_scope_ref=r.cart_scope_ref AND l.observed_revision=r.observed_revision
    WHERE r.cart_scope_ref='aroma-primary' AND r.state='Current' ORDER BY l.offer_ref`)
  ).rows
    .filter((row) => row.offer_ref !== null)
    .map(({ offer_ref, quantity_milli }) => ({
      offerRef: offer_ref,
      quantityMilli: quantity_milli,
    }));
  const reservations = (
    await ordersClient.query(
      "SELECT operation_ref,state,resolved_at IS NOT NULL AS resolved FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary' AND offer_ref=$1 ORDER BY reserved_at,operation_ref",
      [offerRef],
    )
  ).rows;
  const gatewayRows = (
    await gatewayClient.query(
      "SELECT operation_ref,operation_kind,state FROM integration.provider_mutation_journal WHERE cart_scope_ref='aroma-primary' AND offer_ref=$1 ORDER BY created_at,operation_ref",
      [offerRef],
    )
  ).rows;
  const latestAttempt =
    (
      await ordersClient.query(
        `SELECT state,failure_code,blocker_codes,selected_action,selected_offer_ref=$1 AS selected_offer_matches
    FROM orders.convergence_attempts WHERE cart_scope_ref='aroma-primary' ORDER BY started_at DESC,attempt_ref DESC LIMIT 1`,
        [offerRef],
      )
    ).rows[0] ?? null;
  const reservationStateCounts = (
    await ordersClient.query(
      `SELECT state,count(*)::text AS count FROM orders.mutation_reservations
    WHERE cart_scope_ref='aroma-primary' AND offer_ref=$1 GROUP BY state ORDER BY state`,
      [offerRef],
    )
  ).rows;
  const gatewayJournalStateCounts = (
    await gatewayClient.query(
      `SELECT state,count(*)::text AS count FROM integration.provider_mutation_journal
    WHERE cart_scope_ref='aroma-primary' AND offer_ref=$1 GROUP BY state ORDER BY state`,
      [offerRef],
    )
  ).rows;
  return {
    work,
    currentLines,
    reservations,
    gatewayRows,
    latestAttempt,
    reservationStateCounts,
    gatewayJournalStateCounts,
  };
}

function demand(condition, code) {
  if (!condition) throw new Error(code);
}

async function runConvergenceChild({
  root,
  identity,
  resourceLocator,
  gatewayPort,
  dropProxyPort,
  capability,
  phase,
}) {
  const workerPath = fileURLToPath(import.meta.url);
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR"])
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  env.COFFEE_LAUNCH_CONTEXT_FILE = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  const child = spawn(process.execPath, [workerPath, "--convergence-worker"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  return await new Promise((resolveChild, rejectChild) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectChild(new Error("AROMA_CONVERGENCE_CHILD_TIMEOUT"));
    }, 60_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectChild(error);
      else resolveChild(value);
    };
    child.once("error", () =>
      finish(new Error("AROMA_CONVERGENCE_CHILD_START_FAILED")),
    );
    child.once("exit", (code) => {
      if (code !== 0) finish(new Error("AROMA_CONVERGENCE_CHILD_FAILED"));
      else if (!settled)
        finish(new Error("AROMA_CONVERGENCE_CHILD_RESULT_MISSING"));
    });
    child.on("message", (message) => {
      if (message?.ok === true) finish(null, message.result);
      else
        finish(
          new Error(
            typeof message?.code === "string"
              ? message.code
              : "AROMA_CONVERGENCE_CHILD_FAILED",
          ),
        );
    });
    child.send({
      root,
      context: identity.context,
      resourceLocator,
      gatewayPort: dropProxyPort ?? gatewayPort,
      capability,
      phase,
    });
  });
}

async function convergenceWorker(message) {
  const identity = await validateContext(
    process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  );
  if (
    message?.root !== identity.candidateRoot ||
    message?.context?.runId !== identity.context.runId ||
    message?.context?.candidateSha !== identity.context.candidateSha ||
    !Number.isInteger(message?.gatewayPort) ||
    !/^[a-f0-9]{64}$/u.test(message?.capability ?? "") ||
    ![
      "noop",
      "single-mutation",
      "lost-response",
      "restart-reconcile",
      "restore",
    ].includes(message?.phase)
  ) {
    throw new Error("AROMA_WORKER_CONTEXT_INVALID");
  }
  const root = identity.candidateRoot;
  const [yamlModule, storeModule, clientModule, resourcesModule] =
    await Promise.all([
      import("js-yaml"),
      import(
        pathToFileURL(
          join(
            root,
            "apps/aroma-convergence/dist/infrastructure/convergence-store.js",
          ),
        ).href
      ),
      import(
        pathToFileURL(
          join(root, "apps/aroma-convergence/dist/gateway-client.js"),
        ).href
      ),
      import(
        pathToFileURL(
          join(
            root,
            "verification/launch/v1/scenarios/aroma-sandbox-resources.mjs",
          ),
        ).href
      ),
    ]);
  const config = yamlModule.load(
    await readFile(join(root, "config/platform.yaml"), "utf8"),
  );
  if (
    config.environment === "production" ||
    config.services["aroma-convergence"].mutationsEnabled !== true
  )
    throw new Error("AROMA_MUTATION_CONFIG_INVALID");
  const database = await resourcesModule.openAromaSandboxDatabase({
    root,
    context: message.context,
    runtime: "aroma-convergence",
    resourceLocator: message.resourceLocator,
  });
  const signal = AbortSignal.timeout(55_000);
  await database.resource.start(signal);
  try {
    const settings = config.services["aroma-convergence"].aromaConvergence;
    const { maxResponseBytes, ...storeSettings } = settings;
    const store = storeModule.createAromaConvergenceStore(database, {
      ownerInstanceId: randomUUID(),
      mutationsEnabled: true,
      ...storeSettings,
    });
    const base = `http://127.0.0.1:${message.gatewayPort}`;
    const gateway = new clientModule.AromaConvergenceGatewayClient(
      {
        fetch: (path, options) => {
          const headers = new Headers(options?.headers);
          headers.set("x-coffee-g16-capability", message.capability);
          headers.set("x-coffee-g16-phase", message.phase);
          return fetch(new URL(path, base), { ...options, headers });
        },
      },
      { deadlineMs: settings.providerDeadlineMs, maxResponseBytes },
    );
    await store.recover(signal);
    const outcome = await store.runOnce(gateway, signal);
    return { outcome, restarted: true };
  } finally {
    await database.resource.stop(
      AbortSignal.timeout(config.platform.shutdownGraceMs),
    );
  }
}

async function runApprovedPhases({
  root,
  identity,
  resources,
  gateway,
  baseline,
  selected,
  signal,
  approval,
  supplierRef,
  defaultPacking,
  accountFingerprint,
  convergenceSettings,
  onGrantActivated,
}) {
  const selectedBinding = await gateway.resolveProviderOffer(
    selected.offerRef,
    supplierRef,
    signal,
  );
  const packingWireProof = await loadAromaPackingWireProof(root);
  assertAromaControlledOfferFacts(selectedBinding, {
    offerRef: selected.offerRef,
    supplierRef,
    defaultPacking,
    accountFingerprint,
    wireProof: packingWireProof,
  });
  const ordersClient = await resources.openMigrator("orders");
  const integrationClient = await resources.openMigrator("integration");
  const gatewayPort = gateway.port;
  const phaseEvidence = [];
  let activePhase = "approval";
  try {
    gateway.activateGrant(
      assertAromaApprovalForOffer(approval, selected.offerRef),
      selected.offerRef,
    );
    onGrantActivated?.();
    activePhase = "baseline-read";
    const baselineRead = await gateway.reader.read(signal);
    assertAromaCartVector(baselineRead, []);
    demand(
      baselineRead.cartFingerprint === baseline.cartFingerprint,
      "AROMA_BASELINE_CHANGED_BEFORE_PHASES",
    );
    phaseEvidence.push({
      phase: "baseline-read",
      status: "PASS",
      capturedAtUtc: baselineRead.capturedAt,
      cartFingerprint: baselineRead.cartFingerprint,
      lineCount: baselineRead.lines.length,
    });
    activePhase = "noop";
    await appendAromaSandboxDesired(ordersClient, []);
    await runConvergenceChild({
      root,
      identity,
      resourceLocator: resources.resourceLocator,
      gatewayPort,
      capability: randomBytes(32).toString("hex"),
      phase: "noop",
    });
    let evidence = await readConvergenceEvidence(
      ordersClient,
      integrationClient,
      selected.offerRef,
    );
    demand(
      evidence.work?.dirty === false &&
        evidence.currentLines.length === 0 &&
        evidence.gatewayRows.length === 0,
      "AROMA_NOOP_EQUALITY_FAILED",
    );
    phaseEvidence.push({
      phase: "noop",
      status: "PASS",
      capturedAtUtc: new Date().toISOString(),
      desiredRevision: evidence.work?.desired_revision ?? null,
      workDirty: evidence.work?.dirty ?? null,
      observedLineCount: evidence.currentLines.length,
      gatewayJournalRows: evidence.gatewayRows.length,
      reservationRows: evidence.reservations.length,
    });

    activePhase = "single-mutation";
    assertAromaCartVector(await gateway.reader.read(signal), []);
    await appendAromaSandboxDesired(ordersClient, [
      { offerRef: selected.offerRef, quantityMilli: "1000" },
    ]);
    const capability = gateway.authorizeMutationPhase("single-mutation", []);
    await runConvergenceChild({
      root,
      identity,
      resourceLocator: resources.resourceLocator,
      gatewayPort,
      capability,
      phase: "single-mutation",
    });
    evidence = await readConvergenceEvidence(
      ordersClient,
      integrationClient,
      selected.offerRef,
    );
    demand(
      evidence.work?.dirty === false &&
        evidence.currentLines.length === 1 &&
        evidence.currentLines[0].offerRef === selected.offerRef &&
        evidence.currentLines[0].quantityMilli === "1000",
      "AROMA_SINGLE_MUTATION_NOT_VERIFIED",
    );
    demand(
      evidence.gatewayRows.length === 1 &&
        evidence.gatewayRows[0].operation_kind === "SetLineQuantity" &&
        evidence.gatewayRows[0].state === "Acknowledged",
      "AROMA_SINGLE_GATEWAY_JOURNAL_INVALID",
    );
    phaseEvidence.push({
      phase: "single-mutation",
      status: "PASS",
      capturedAtUtc: new Date().toISOString(),
      desiredRevision: evidence.work?.desired_revision ?? null,
      workDirty: evidence.work?.dirty ?? null,
      observedLines: evidence.currentLines,
      gateway: {
        operationRef: evidence.gatewayRows[0].operation_ref,
        operationKind: evidence.gatewayRows[0].operation_kind,
        state: evidence.gatewayRows[0].state,
      },
    });

    activePhase = "lost-response";
    assertAromaCartVector(await gateway.reader.read(signal), [
      { offerRef: selected.offerRef, quantity: "1" },
    ]);
    await appendAromaSandboxDesired(ordersClient, [
      { offerRef: selected.offerRef, quantityMilli: "2000" },
    ]);
    const lostCapability = gateway.authorizeMutationPhase("lost-response", [
      { offerRef: selected.offerRef, quantity: "1" },
    ]);
    const proxy = await startAcknowledgementDropProxy({
      upstreamPort: gatewayPort,
    });
    try {
      await runConvergenceChild({
        root,
        identity,
        resourceLocator: resources.resourceLocator,
        gatewayPort,
        dropProxyPort: Number(new URL(proxy.url).port),
        capability: lostCapability,
        phase: "lost-response",
      });
    } finally {
      await proxy.close();
    }
    evidence = await readConvergenceEvidence(
      ordersClient,
      integrationClient,
      selected.offerRef,
    );
    const unresolved = evidence.reservations.at(-1);
    const unknownOperationRef = unresolved?.operation_ref;
    demand(
      unresolved?.state === "UnknownOutcome" &&
        unresolved.resolved === false &&
        evidence.work?.dirty === true,
      "AROMA_LOST_RESPONSE_NOT_UNKNOWN",
    );
    demand(
      evidence.gatewayRows.length === 2 &&
        evidence.gatewayRows[1].state === "Acknowledged" &&
        proxy.droppedAcknowledgements.length === 1,
      "AROMA_ACKNOWLEDGEMENT_NOT_DROPPED_OR_JOURNALED",
    );
    phaseEvidence.push({
      phase: "lost-response",
      status: "PASS",
      capturedAtUtc: new Date().toISOString(),
      desiredRevision: evidence.work?.desired_revision ?? null,
      workDirty: evidence.work?.dirty ?? null,
      reservation: {
        operationRef: unknownOperationRef,
        state: unresolved.state,
        resolved: unresolved.resolved,
      },
      gateway: {
        operationRef: evidence.gatewayRows[1].operation_ref,
        state: evidence.gatewayRows[1].state,
      },
      droppedAcknowledgementCount: proxy.droppedAcknowledgements.length,
    });

    activePhase = "restart-reconcile";
    const restartEligibility = await waitForAromaRestartEligibility({
      ordersClient,
      operationRef: unknownOperationRef,
      providerDeadlineMs: convergenceSettings.providerDeadlineMs,
      safetyMarginMs: convergenceSettings.safetyMarginMs,
      retryBackoffMs: convergenceSettings.retryBackoffMs,
      signal,
    });
    assertAromaCartVector(await gateway.reader.read(signal), [
      { offerRef: selected.offerRef, quantity: "2" },
    ]);
    await runConvergenceChild({
      root,
      identity,
      resourceLocator: resources.resourceLocator,
      gatewayPort,
      capability: randomBytes(32).toString("hex"),
      phase: "restart-reconcile",
    });
    evidence = await readConvergenceEvidence(
      ordersClient,
      integrationClient,
      selected.offerRef,
    );
    const recovered = evidence.reservations.find(
      (entry) => entry.operation_ref === unknownOperationRef,
    );
    demand(
      recovered?.state === "RecoveredApplied" && recovered.resolved === true,
      "AROMA_RESTART_RECOVERY_FAILED",
    );
    demand(
      evidence.gatewayRows.filter(
        (entry) => entry.operation_ref === unknownOperationRef,
      ).length === 1 && evidence.gatewayRows.length === 2,
      "AROMA_OLD_OPERATION_REPLAYED",
    );
    demand(
      evidence.work?.dirty === false &&
        evidence.currentLines.length === 1 &&
        evidence.currentLines[0].quantityMilli === "2000",
      "AROMA_RECOVERY_DESIRED_CHANGED",
    );
    phaseEvidence.push({
      phase: "restart-reconcile",
      status: "PASS",
      capturedAtUtc: new Date().toISOString(),
      desiredRevision: evidence.work?.desired_revision ?? null,
      workDirty: evidence.work?.dirty ?? null,
      reservation: {
        operationRef: unknownOperationRef,
        state: recovered.state,
        resolved: recovered.resolved,
      },
      eligibleAtUtc: restartEligibility.eligibleAtUtc,
      eligibilityWaitMs: restartEligibility.waitMs,
      oldOperationJournalRows: evidence.gatewayRows.filter(
        (entry) => entry.operation_ref === unknownOperationRef,
      ).length,
      gatewayJournalRows: evidence.gatewayRows.length,
      observedLines: evidence.currentLines,
    });

    activePhase = "restore";
    assertAromaCartVector(await gateway.reader.read(signal), [
      { offerRef: selected.offerRef, quantity: "2" },
    ]);
    await appendAromaSandboxDesired(ordersClient, []);
    const restoreCapability = gateway.authorizeMutationPhase("restore", [
      { offerRef: selected.offerRef, quantity: "2" },
    ]);
    await runConvergenceChild({
      root,
      identity,
      resourceLocator: resources.resourceLocator,
      gatewayPort,
      capability: restoreCapability,
      phase: "restore",
    });
    const finalSnapshot = await gateway.reader.read(signal);
    evidence = await readConvergenceEvidence(
      ordersClient,
      integrationClient,
      selected.offerRef,
    );
    demand(
      finalSnapshot.cartFingerprint === baseline.cartFingerprint &&
        finalSnapshot.lines.length === 0,
      "AROMA_BASELINE_RESTORE_FAILED",
    );
    demand(
      evidence.work?.dirty === false && evidence.currentLines.length === 0,
      "AROMA_FINAL_DESIRED_NOT_VERIFIED",
    );
    demand(
      evidence.gatewayRows.length === 3 &&
        evidence.gatewayRows[2].operation_kind === "RemoveLine" &&
        evidence.gatewayRows[2].state === "Acknowledged",
      "AROMA_RESTORE_MUTATION_INVALID",
    );
    phaseEvidence.push({
      phase: "restore",
      status: "PASS",
      capturedAtUtc: new Date().toISOString(),
      desiredRevision: evidence.work?.desired_revision ?? null,
      workDirty: evidence.work?.dirty ?? null,
      gateway: {
        operationRef: evidence.gatewayRows[2].operation_ref,
        operationKind: evidence.gatewayRows[2].operation_kind,
        state: evidence.gatewayRows[2].state,
      },
      observedLineCount: evidence.currentLines.length,
    });
    activePhase = "final-read";
    phaseEvidence.push({
      phase: "final-read",
      status: "PASS",
      capturedAtUtc: finalSnapshot.capturedAt,
      cartFingerprint: finalSnapshot.cartFingerprint,
      lineCount: finalSnapshot.lines.length,
      matchesBaseline:
        finalSnapshot.cartFingerprint === baseline.cartFingerprint,
    });
    return {
      baselineFingerprint: baseline.cartFingerprint,
      finalFingerprint: finalSnapshot.cartFingerprint,
      phases: phaseEvidence,
      mutationJournalRows: evidence.gatewayRows.length,
      unknownOperationRef,
    };
  } catch (error) {
    const phaseFailureFacts = await captureAromaPhaseFailureFacts({
      completedPhases: phaseEvidence,
      failedPhase: activePhase,
      readLatestEvidence: () =>
        readConvergenceEvidence(
          ordersClient,
          integrationClient,
          selected.offerRef,
        ),
    });
    if (error && typeof error === "object") {
      try {
        error.phaseFailureFacts = phaseFailureFacts;
      } catch {
        /* Preserve the original phase failure. */
      }
    }
    throw error;
  } finally {
    await ordersClient.end();
    await integrationClient.end();
  }
}

async function runAromaSandbox({ approvalFile, env = process.env } = {}) {
  const contextFile = env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (!contextFile) return { status: "NOT_RUN", code: "LAUNCH_CONTEXT_ABSENT" };
  const identity = await validateContext(contextFile);
  assertAdmissionContractMatchesCandidate(
    identity.candidateRoot,
    identity.context.candidateSha,
  );
  const root = identity.candidateRoot;
  const contract = await loadAdmissionContract(root);
  const { config, policy, environment, credentialsAvailable } = contract;
  const runMetadata = {
    runId: identity.context.runId,
    candidateSha: identity.context.candidateSha,
    mode: policy?.mode ?? null,
    origin: policy?.origin ?? null,
  };
  if (environment === "production")
    throw new Error("PRODUCTION_ENVIRONMENT_DENIED");
  if (!policy)
    return { status: "NOT_RUN", code: "SANDBOX_POLICY_ABSENT", runMetadata };
  if (!credentialsAvailable)
    return {
      status: "NOT_RUN",
      code: "SCOPED_SANDBOX_CREDENTIALS_ABSENT",
      runMetadata,
    };
  if (config.services["aroma-convergence"]?.mutationsEnabled !== true)
    return {
      status: "NOT_RUN",
      code: "MUTATIONS_NOT_ENABLED_IN_CANONICAL_CONFIG",
      runMetadata,
    };
  if (!approvalFile)
    return { status: "NOT_RUN", code: "APPROVAL_FILE_ABSENT", runMetadata };
  const preexisting = await verifyApprovalFile(
    approvalFile,
    identity,
    contract,
  );
  if (preexisting && preexisting.maximumQuantity !== "2")
    throw new Error("AROMA_APPROVAL_QUANTITY_MUST_ALLOW_TWO");
  const runId = identity.context.runId;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(30 * 60 * 1000),
  ]);
  let resources;
  const databases = {};
  let gateway;
  let baseline;
  let verifiedAccountFingerprint;
  let mutationsAuthorized = false;
  let preserveResources = false;
  const cleanupEvidence = { removed: false, retained: false };
  let currentStage = "resources";
  try {
    currentStage = "resources";
    const resourcesModule = await import(
      pathToFileURL(
        join(
          root,
          "verification/launch/v1/scenarios/aroma-sandbox-resources.mjs",
        ),
      ).href
    );
    resources = await resourcesModule.prepareAromaSandboxResources({
      root,
      context: identity.context,
    });
    currentStage = "migrations";
    const migrations = await migrateSandboxDatabases(root, resources);
    currentStage = "runtime-databases";
    databases.gateway = await resources.openDatabase("aroma-gateway");
    databases.catalogImport = await resources.openDatabase(
      "catalog-supplier-sync",
    );
    databases.catalogActivation = await resources.openDatabase(
      "catalog-activation-worker",
    );
    databases.catalogRead = await resources.openDatabase("catalog-service");
    databases.ordersPreparation = await resources.openDatabase(
      "orders-aroma-preparation",
    );
    for (const database of Object.values(databases))
      await database.resource.start(signal);
    const gatewaySecrets = await readScopedSecrets(
      resources.resourceLocator.runtimes["aroma-gateway"].scopedSecretsFile,
      "aroma-gateway",
    );
    currentStage = "gateway";
    gateway = await startGatewayOwnerHarness({
      root,
      config,
      resources,
      databases,
      gatewaySecrets,
      signal,
    });
    const sessionModule = await import(
      pathToFileURL(
        join(
          root,
          "apps/aroma-gateway/dist/infrastructure/provider/session.js",
        ),
      ).href
    );
    const decoderModule = await import(
      pathToFileURL(
        join(
          root,
          "apps/aroma-gateway/dist/infrastructure/provider/decoder.js",
        ),
      ).href
    );
    const credentials = {
      scopeRef: config.aroma.scopeRef,
      email: requireValue(
        secretAt(gatewaySecrets, "aroma.email"),
        "AROMA_EMAIL_MISSING",
      ),
      password: requireValue(
        secretAt(gatewaySecrets, "aroma.password"),
        "AROMA_PASSWORD_MISSING",
      ),
    };
    const identityKey = Buffer.from(
      requireValue(
        secretAt(gatewaySecrets, "aroma.catalogIdentityKeyV1"),
        "AROMA_IDENTITY_KEY_MISSING",
      ),
      "utf8",
    );
    currentStage = "profile";
    const profile = await inspectAromaProfile({
      sessions: gateway.sessions,
      credentials,
      identityKey,
      decodeUser: decoderModule.decodeUser,
      readProviderSafely: sessionModule.readProviderSafely,
      policy,
      signal,
    });
    verifiedAccountFingerprint = profile.accountFingerprint;
    currentStage = "baseline";
    baseline = await gateway.reader.read(signal);
    demand(
      baseline.cartScopeRef === "aroma-primary" && baseline.lines.length === 0,
      "AROMA_BASELINE_CART_NOT_EMPTY",
    );
    currentStage = "catalog";
    const catalogModule = await import(
      pathToFileURL(
        join(
          root,
          "verification/launch/v1/scenarios/aroma-sandbox-catalog.mjs",
        ),
      ).href
    );
    const catalog = await catalogModule.prepareAromaSandboxCatalog({
      root,
      config,
      catalogImportDb: databases.catalogImport,
      catalogActivationDb: databases.catalogActivation,
      ordersPreparationDb: databases.ordersPreparation,
      gateway,
      runId,
      signal,
      ...(preexisting ? { approvedOfferRef: preexisting.offerRef } : {}),
    });
    const selected = catalog.selected;
    const selectedBinding = await gateway.resolveProviderOffer(
      selected.offerRef,
      config.aroma.supplierRef,
      signal,
    );
    const packingWireProof = await loadAromaPackingWireProof(root);
    assertAromaControlledOfferFacts(selectedBinding, {
      offerRef: selected.offerRef,
      supplierRef: config.aroma.supplierRef,
      defaultPacking: config.aroma.defaultPacking,
      accountFingerprint: profile.accountFingerprint,
      wireProof: packingWireProof,
    });
    currentStage = "approval";
    if (preexisting) {
      const approval = await verifyApprovalFile(
        approvalFile,
        identity,
        contract,
        selected.offerRef,
      );
      if (!approval) throw new Error("AROMA_APPROVAL_INVALID");
      currentStage = "phases";
      const result = await runApprovedPhases({
        root,
        identity,
        resources,
        gateway,
        baseline,
        selected,
        signal,
        approval,
        supplierRef: config.aroma.supplierRef,
        defaultPacking: config.aroma.defaultPacking,
        accountFingerprint: profile.accountFingerprint,
        convergenceSettings:
          config.services["aroma-convergence"].aromaConvergence,
        onGrantActivated: () => {
          mutationsAuthorized = true;
        },
      });
      return {
        status: "PASS",
        code: "CONTROLLED_LIVE_SCENARIO_COMPLETE",
        runMetadata,
        accountFingerprint: profile.accountFingerprint,
        selected,
        catalogEvidence: {
          catalog: catalog.catalog,
          orders: catalog.orders,
          proof: catalog.proof,
        },
        migrations,
        cleanup: cleanupEvidence,
        result,
      };
    }
    process.stdout.write(
      `${JSON.stringify({
        gate: "G16_AROMA_SANDBOX",
        status: "APPROVAL_REQUIRED",
        runId,
        candidateSha: identity.context.candidateSha,
        accountFingerprint: profile.accountFingerprint,
        selected,
        maximumQuantity: "2",
      })}\n`,
    );
    await controlledParentRequest("approval", {
      runId,
      candidateSha: identity.context.candidateSha,
      accountFingerprint: profile.accountFingerprint,
      selected: { offerRef: selected.offerRef },
      maximumQuantity: "2",
    });
    const approval = await waitForApproval(
      approvalFile,
      identity,
      contract,
      selected.offerRef,
      config.platform.shutdownGraceMs,
    );
    if (!approval)
      return {
        status: "NOT_RUN",
        code: "APPROVAL_NOT_PROVIDED",
        runMetadata,
        selected,
        cleanup: cleanupEvidence,
      };
    if (approval.maximumQuantity !== "2")
      throw new Error("AROMA_APPROVAL_QUANTITY_MUST_ALLOW_TWO");
    currentStage = "phases";
    const result = await runApprovedPhases({
      root,
      identity,
      resources,
      gateway,
      baseline,
      selected,
      signal,
      approval,
      supplierRef: config.aroma.supplierRef,
      defaultPacking: config.aroma.defaultPacking,
      accountFingerprint: profile.accountFingerprint,
      convergenceSettings:
        config.services["aroma-convergence"].aromaConvergence,
      onGrantActivated: () => {
        mutationsAuthorized = true;
      },
    });
    return {
      status: "PASS",
      code: "CONTROLLED_LIVE_SCENARIO_COMPLETE",
      runMetadata,
      accountFingerprint: profile.accountFingerprint,
      selected,
      catalogEvidence: {
        catalog: catalog.catalog,
        orders: catalog.orders,
        proof: catalog.proof,
      },
      migrations,
      cleanup: cleanupEvidence,
      resourceIDs: resources.resourceIDs,
      result,
    };
  } catch (error) {
    const failureEvidence = safeAromaPhaseFailureEvidence(
      error?.phaseFailureFacts,
    );
    if (mutationsAuthorized && gateway && resources) {
      gateway.disableMutations();
      let safeToCleanup = false;
      try {
        const fresh = await gateway.reader.read(AbortSignal.timeout(10_000));
        const orders = await resources.openMigrator("orders");
        const integration = await resources.openMigrator("integration");
        let unresolvedReservations;
        try {
          const reservationQuery = await orders.query(
            "SELECT count(*)::text AS count FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary' AND resolved_at IS NULL",
          );
          const reservationCount = reservationQuery.rows[0]?.count;
          const dirtyWorkQuery = await orders.query(
            "SELECT count(*)::text AS count FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary' AND dirty=true",
          );
          const dirtyWorkCount = dirtyWorkQuery.rows[0]?.count;
          const journalQuery = await integration.query(
            "SELECT count(*)::text AS count FROM integration.provider_mutation_journal WHERE cart_scope_ref='aroma-primary' AND state IN ('Reserved','Dispatched','UnknownOutcome')",
          );
          const journalCount = journalQuery.rows[0]?.count;
          if (
            !/^[0-9]+$/u.test(reservationCount ?? "") ||
            !/^[0-9]+$/u.test(dirtyWorkCount ?? "") ||
            !/^[0-9]+$/u.test(journalCount ?? "")
          )
            throw new Error("AROMA_RECOVERY_EVIDENCE_INVALID");
          unresolvedReservations =
            Number(reservationCount) + Number(journalCount);
          const pendingWorkRows = Number(dirtyWorkCount);
          safeToCleanup = canCleanupAromaAfterFailure({
            snapshot: fresh,
            baselineFingerprint: baseline?.cartFingerprint,
            unresolvedReservations,
            dirtyWorkRows: pendingWorkRows,
          });
        } finally {
          await orders.end();
          await integration.end();
        }
      } catch {
        safeToCleanup = false;
      }
      if (!safeToCleanup) {
        preserveResources = true;
        return {
          status: "FAIL",
          code: "RECOVERY_REQUIRED",
          accountFingerprint: verifiedAccountFingerprint,
          recovery: {
            runId,
            stage: checkedStage(currentStage),
            failureCode: safeAromaFailureCode(error),
            ...(sandboxDiagnostic(error)
              ? { diagnostic: sandboxDiagnostic(error) }
              : {}),
            cartState: "UNRESOLVED_OR_NONBASELINE",
            mutationsDisabled: true,
            resourceIDs: resources.resourceIDs,
            requiredAction: "CONTROLLED_G16_RECOVERY_BEFORE_RESOURCE_CLEANUP",
            cleanup: cleanupEvidence,
          },
          ...(failureEvidence ? { failureEvidence } : {}),
          runMetadata,
        };
      }
    }
    return {
      status: "FAIL",
      code: safeAromaFailureCode(error),
      stage: checkedStage(currentStage),
      runMetadata,
      cleanup: cleanupEvidence,
      ...(sandboxDiagnostic(error)
        ? { diagnostic: sandboxDiagnostic(error) }
        : {}),
      ...(failureEvidence ? { failureEvidence } : {}),
    };
  } finally {
    currentStage = "cleanup";
    controller.abort();
    await gateway?.close().catch(() => {});
    if (resources && preserveResources) cleanupEvidence.retained = true;
    else if (resources) {
      try {
        const cleaned = await resources.cleanup();
        if (cleaned?.removed === true) cleanupEvidence.removed = true;
        else {
          cleanupEvidence.failed = true;
          cleanupEvidence.failureCode = "AROMA_RESOURCE_CLEANUP_FAILED";
        }
      } catch {
        cleanupEvidence.failed = true;
        cleanupEvidence.failureCode = "AROMA_RESOURCE_CLEANUP_FAILED";
      }
    }
  }
}

const G16_PHASES = [
  "baseline-read",
  "noop",
  "single-mutation",
  "lost-response",
  "restart-reconcile",
  "restore",
  "final-read",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sanitizeControlledG16Recovery(outcome, context, policy, image) {
  const recovery = outcome?.recovery;
  const ids = recovery?.resourceIDs;
  const names = aromaSandboxResourceNames(context.runId);
  if (
    outcome?.gate !== "G16_AROMA_SANDBOX" ||
    outcome.status !== "FAIL" ||
    outcome.code !== "RECOVERY_REQUIRED" ||
    outcome.runId !== context.runId ||
    outcome.candidateSha !== context.candidateSha ||
    outcome.mode !== policy.mode ||
    outcome.origin !== policy.origin ||
    outcome.accountFingerprint !== policy.accountFingerprint ||
    recovery?.runId !== context.runId ||
    !SANDBOX_STAGES.includes(recovery.stage) ||
    recovery.cartState !== "UNRESOLVED_OR_NONBASELINE" ||
    recovery.mutationsDisabled !== true ||
    recovery.requiredAction !==
      "CONTROLLED_G16_RECOVERY_BEFORE_RESOURCE_CLEANUP" ||
    recovery.cleanup?.removed !== false ||
    recovery.cleanup?.retained !== true ||
    recovery.cleanup?.failed ||
    ids?.runId !== context.runId ||
    ids.image !== image ||
    !/^sha256:[a-f0-9]{64}$/u.test(ids.imageId ?? "") ||
    ids.container?.name !== names.container ||
    ids.network?.name !== names.network ||
    ids.container?.label !== "coffee.g16.run-id" ||
    ids.network?.label !== "coffee.g16.run-id" ||
    !/^[a-f0-9]{64}$/u.test(ids.container?.id ?? "") ||
    !/^[a-f0-9]{64}$/u.test(ids.network?.id ?? "") ||
    !/^[0-9]{1,20}$/u.test(ids.databaseSystemIdentifier ?? "")
  )
    return null;
  const partial = outcome.failureEvidence?.partialPhaseEvidence;
  let failureEvidence;
  if (partial !== undefined) {
    if (!Array.isArray(partial) || partial.length === 0) return null;
    const last = partial.at(-1);
    if (last?.status !== "FAIL") return null;
    const convergence = outcome.failureEvidence.convergenceEvidence;
    const latest = convergence?.latestAttempt;
    failureEvidence = safeAromaPhaseFailureEvidence({
      completedPhases: partial.slice(0, -1),
      failedPhase: last.phase,
      failedAtUtc: last.capturedAtUtc,
      convergenceEvidence: convergence && {
        latestAttempt: latest && {
          state: latest.state,
          failure_code: latest.failureCode,
          blocker_codes: latest.blockerCodes,
          selected_action: latest.selectedAction,
          selected_offer_matches: latest.selectedOfferMatches,
        },
        reservationStateCounts: convergence.reservationStateCounts,
        gatewayJournalStateCounts: convergence.gatewayJournalStateCounts,
      },
    });
    if (!failureEvidence) return null;
  }
  const checkedDiagnostic = safeAromaDiagnostic({
    safeDiagnostic: recovery.diagnostic,
  });
  const diagnostic = checkedDiagnostic && {
    substage: checkedDiagnostic.substage,
    ...(SAFE_FAILURE_CODES.has(checkedDiagnostic.ownerCode)
      ? { ownerCode: checkedDiagnostic.ownerCode }
      : {}),
    ...(SAFE_FAILURE_CODES.has(checkedDiagnostic.causeCode)
      ? { causeCode: checkedDiagnostic.causeCode }
      : {}),
    ...(checkedDiagnostic.sqlState
      ? { sqlState: checkedDiagnostic.sqlState }
      : {}),
  };
  return {
    gate: "G16_AROMA_SANDBOX",
    status: "FAIL",
    code: "RECOVERY_REQUIRED",
    runId: context.runId,
    candidateSha: context.candidateSha,
    mode: policy.mode,
    origin: policy.origin,
    accountFingerprint: policy.accountFingerprint,
    recovery: {
      runId: context.runId,
      stage: recovery.stage,
      failureCode: safeAromaFailureCode(new Error(recovery.failureCode)),
      ...(diagnostic ? { diagnostic } : {}),
      cartState: "UNRESOLVED_OR_NONBASELINE",
      mutationsDisabled: true,
      resourceIDs: {
        runId: context.runId,
        image,
        imageId: ids.imageId,
        container: {
          name: names.container,
          id: ids.container.id,
          label: "coffee.g16.run-id",
        },
        network: {
          name: names.network,
          id: ids.network.id,
          label: "coffee.g16.run-id",
        },
        databaseSystemIdentifier: ids.databaseSystemIdentifier,
      },
      requiredAction: "CONTROLLED_G16_RECOVERY_BEFORE_RESOURCE_CLEANUP",
      cleanup: { removed: false, retained: true },
    },
    ...(failureEvidence ? { failureEvidence } : {}),
  };
}

async function prepareG16Age({ candidateRoot, context }, env) {
  const locator = env.SOPS_AGE_KEY_FILE;
  if (
    typeof locator !== "string" ||
    !isAbsolute(locator) ||
    resolve(locator) !== locator
  )
    throw new Error("G16_AGE_KEY_INVALID");
  const info = await lstat(locator).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600 ||
    (await realpath(locator)) !== locator
  )
    throw new Error("G16_AGE_KEY_INVALID");
  const committed = async (path) => {
    const bytes = await readRegular(join(candidateRoot, path), 8 * 1024 * 1024);
    const expected = execFileSync(
      "git",
      ["cat-file", "blob", `${context.candidateSha}:${path}`],
      {
        cwd: candidateRoot,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (!bytes.equals(expected)) throw new Error("G16_AGE_AUTHORITY_INVALID");
    return bytes.toString("utf8");
  };
  const toolchain = JSON.parse(
    await committed("config/toolchain-versions.json"),
  );
  const ownership = JSON.parse(
    await committed("config/database-ownership.json"),
  );
  const roleMap = JSON.parse(await committed("config/database-role-map.json"));
  const policy = parseYaml(await committed(".sops.yaml"));
  const plan = buildBackupRestorePlan(context, ownership, roleMap, policy).age;
  try {
    const options = {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: 16384,
      encoding: "utf8",
    };
    if (
      toolchain.age !== plan.version ||
      execFileSync("age", ["--version"], options).trim() !==
        `v${plan.version}` ||
      execFileSync("age-keygen", ["--version"], options).trim() !==
        `v${plan.version}`
    )
      throw new Error("version");
    const publicKeys = execFileSync("age-keygen", ["-y", locator], options)
      .trim()
      .split(/\r?\n/u);
    if (!publicKeys.some((key) => plan.recipients.includes(key)))
      throw new Error("recipient");
  } catch {
    throw new Error("G16_AGE_PREFLIGHT_FAILED");
  }
  return { locator, recipients: plan.recipients };
}

function runG16Age(args, input) {
  try {
    return execFileSync("age", args, {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: 65536,
    });
  } catch {
    throw new Error("G16_AGE_OPERATION_FAILED");
  }
}

export function validateControlledG16Result(outcome, context, policy, image) {
  const names = aromaSandboxResourceNames(context.runId);
  if (
    outcome?.gate !== "G16_AROMA_SANDBOX" ||
    outcome.status !== "PASS" ||
    outcome.code !== "CONTROLLED_LIVE_SCENARIO_COMPLETE" ||
    outcome.runId !== context.runId ||
    outcome.candidateSha !== context.candidateSha ||
    outcome.accountFingerprint !== policy.accountFingerprint ||
    typeof outcome.selected?.offerRef !== "string" ||
    !outcome.selected.offerRef ||
    outcome.cleanup?.removed !== true ||
    outcome.cleanup?.retained !== false ||
    outcome.cleanup?.failed ||
    outcome.resourceIDs?.runId !== context.runId ||
    outcome.resourceIDs.image !== image ||
    !/^sha256:[a-f0-9]{64}$/.test(outcome.resourceIDs?.imageId ?? "") ||
    !/^[a-f0-9]{64}$/.test(outcome.resourceIDs?.container?.id ?? "") ||
    !/^[a-f0-9]{64}$/.test(outcome.resourceIDs?.network?.id ?? "") ||
    outcome.resourceIDs?.container?.name !== names.container ||
    outcome.resourceIDs?.network?.name !== names.network ||
    typeof outcome.resourceIDs?.databaseSystemIdentifier !== "string" ||
    !outcome.resourceIDs.databaseSystemIdentifier ||
    !Array.isArray(outcome.phases) ||
    outcome.phases.length !== G16_PHASES.length ||
    outcome.phases.some(
      (phase, index) =>
        phase.phase !== G16_PHASES[index] || phase.status !== "PASS",
    ) ||
    !outcome.baselineFingerprint ||
    outcome.baselineFingerprint !== outcome.finalFingerprint ||
    outcome.phases[0].cartFingerprint !== outcome.baselineFingerprint ||
    outcome.phases[0].lineCount !== 0 ||
    outcome.phases[1].workDirty !== false ||
    outcome.phases[1].observedLineCount !== 0 ||
    outcome.phases[1].gatewayJournalRows !== 0 ||
    outcome.phases[2].workDirty !== false ||
    outcome.phases[2].gateway?.operationKind !== "SetLineQuantity" ||
    outcome.phases[2].gateway?.state !== "Acknowledged" ||
    outcome.phases[2].observedLines?.length !== 1 ||
    outcome.phases[2].observedLines[0].offerRef !== outcome.selected.offerRef ||
    outcome.phases[2].observedLines[0].quantityMilli !== "1000" ||
    outcome.phases[3].workDirty !== true ||
    outcome.phases[3].reservation?.state !== "UnknownOutcome" ||
    outcome.phases[3].reservation?.resolved !== false ||
    outcome.phases[3].droppedAcknowledgementCount !== 1 ||
    outcome.phases[3].reservation?.operationRef !==
      outcome.unknownOperationRef ||
    outcome.phases[3].gateway?.state !== "Acknowledged" ||
    outcome.phases[4].workDirty !== false ||
    outcome.phases[4].reservation?.operationRef !==
      outcome.unknownOperationRef ||
    outcome.phases[4].reservation?.resolved !== true ||
    outcome.phases[4].oldOperationJournalRows !== 1 ||
    outcome.phases[5].workDirty !== false ||
    outcome.phases[5].gateway?.operationKind !== "RemoveLine" ||
    outcome.phases[5].gateway?.state !== "Acknowledged" ||
    outcome.phases[5].observedLineCount !== 0 ||
    outcome.phases.at(-1).cartFingerprint !== outcome.baselineFingerprint ||
    outcome.phases.at(-1).matchesBaseline !== true ||
    outcome.phases.at(-1).lineCount !== 0 ||
    outcome.mutationJournalRows !== 3 ||
    !outcome.unknownOperationRef
  )
    throw new Error("G16_CHILD_RESULT_INVALID");
  return outcome;
}

export async function verifyControlledG16Evidence({
  parentIdentity,
  parentContextPath,
  requireCleanup = true,
  env = process.env,
}) {
  const {
    context: parent,
    candidateRoot,
    sourceRoot,
    evidenceDir,
  } = parentIdentity;
  const artifacts = join(evidenceDir, "gates/G16_AROMA_SANDBOX/artifacts");
  const receipt = JSON.parse(
    (
      await readRegular(join(artifacts, "controlled-parent.json"), 16384)
    ).toString("utf8"),
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.runId !== parent.runId ||
    receipt.candidateSha !== parent.candidateSha ||
    receipt.cleanup?.checkoutRemoved !== requireCleanup ||
    receipt.cleanup?.evidenceRemoved !== requireCleanup ||
    receipt.cleanup?.signerRemoved !== requireCleanup ||
    !/^[a-f0-9]{64}$/.test(receipt.signerSha256 ?? "")
  )
    throw new Error("G16_PARENT_RECEIPT_INVALID");
  const checked = async (name, expected, maximum = 16 * 1024 * 1024) => {
    const bytes = await readRegular(join(artifacts, name), maximum);
    if (digest(bytes) !== expected)
      throw new Error("G16_PARENT_ARTIFACT_HASH_INVALID");
    return bytes;
  };
  const context = JSON.parse(
    (
      await checked(
        "controlled-child-context.json",
        receipt.childContextSha256,
        16384,
      )
    ).toString("utf8"),
  );
  if (
    context.runId !== receipt.childRunId ||
    context.candidateSha !== receipt.childSha ||
    !/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7}$/.test(context.runId ?? "") ||
    !/^[a-f0-9]{40}$/.test(context.candidateSha ?? "") ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`) ||
    context.sourceRepoRoot !== sourceRoot ||
    context.acceptedBaseCommit !== parent.acceptedBaseCommit ||
    context.evidenceDir !==
      join(sourceRoot, "evidence/launch", context.runId) ||
    context.resources?.controlledScope !== "G16" ||
    context.resources.controlledParentContextPath !== parentContextPath ||
    context.resources.controlledParentCandidateSha !== parent.candidateSha ||
    context.resources.controlledParentRunId !== parent.runId ||
    context.resources.composeProject !==
      `coffee-launch-${context.runId.toLowerCase()}` ||
    context.resources.kafkaPrefix !== context.runId
  )
    throw new Error("G16_CHILD_CONTEXT_INVALID");
  const outcome = JSON.parse(
    (
      await checked("controlled-child-result.json", receipt.childResultSha256)
    ).toString("utf8"),
  );
  for (const name of ["controlled-approval.json", "controlled-approval.sig"]) {
    const present = await lstat(join(artifacts, name)).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (present) throw new Error("G16_APPROVAL_PLAINTEXT_PRESENT");
  }
  for (const name of [
    "controlled-approval.json.age",
    "controlled-approval.sig.age",
  ]) {
    const info = await lstat(join(artifacts, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error("G16_APPROVAL_CIPHERTEXT_MODE_INVALID");
  }
  const encryptedApproval = await checked(
    "controlled-approval.json.age",
    receipt.approvalCiphertextSha256,
    65536,
  );
  const encryptedSignature = await checked(
    "controlled-approval.sig.age",
    receipt.signatureCiphertextSha256,
    65536,
  );
  const age = await prepareG16Age(parentIdentity, env);
  const approvalBytes = runG16Age(
    ["--decrypt", "--identity", age.locator],
    encryptedApproval,
  );
  const signature = runG16Age(
    ["--decrypt", "--identity", age.locator],
    encryptedSignature,
  );
  if (
    approvalBytes.length > 16384 ||
    signature.length > 1024 ||
    digest(approvalBytes) !== receipt.approvalSha256 ||
    digest(signature) !== receipt.signatureSha256
  )
    throw new Error("G16_APPROVAL_PLAINTEXT_HASH_INVALID");
  const approval = JSON.parse(approvalBytes.toString("utf8"));
  const policy = await readApprovedG16Policy(
    candidateRoot,
    parent.candidateSha,
  );
  const toolchain = JSON.parse(
    (
      await readRegular(
        join(candidateRoot, "config/toolchain-versions.json"),
        1024 * 1024,
      )
    ).toString("utf8"),
  );
  validateControlledG16Result(
    outcome,
    context,
    policy,
    toolchain.postgresImage,
  );
  const issued = Date.parse(approval.issuedAtUtc),
    expires = Date.parse(approval.expiresAtUtc),
    firstPhase = Date.parse(outcome.phases[0].capturedAtUtc);
  if (
    approval.runId !== context.runId ||
    approval.candidateSha !== context.candidateSha ||
    approval.accountFingerprint !== policy.accountFingerprint ||
    approval.offerRef !== outcome.selected.offerRef ||
    approval.maximumQuantity !== "2" ||
    approval.approver !== receipt.signer.approver ||
    approval.keyId !== receipt.signer.keyId ||
    approval.mode !== policy.mode ||
    approval.origin !== policy.origin ||
    approval.exceptionAuthority !== "user-2026-10-23" ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(firstPhase) ||
    expires <= issued ||
    expires - issued > 3600000 ||
    firstPhase < issued ||
    firstPhase >= expires ||
    !verify(
      null,
      approvalBytes,
      createPublicKey(receipt.signer.publicKeyPem),
      Buffer.from(signature.toString("utf8"), "base64"),
    )
  )
    throw new Error("G16_APPROVAL_PROOF_INVALID");
  const bundle = join(artifacts, "controlled-config.bundle");
  await checked("controlled-config.bundle", receipt.bundleSha256);
  const temporary = await mkdtemp(join(tmpdir(), "coffee-g16-admission-"));
  try {
    const childRoot = join(temporary, "child");
    const git = (cwd, ...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60000,
      }).trim();
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        candidateRoot,
        childRoot,
      ],
      { stdio: "ignore", timeout: 60000 },
    );
    git(childRoot, "bundle", "verify", bundle);
    if (
      git(childRoot, "bundle", "list-heads", bundle) !==
      `${context.candidateSha} HEAD`
    )
      throw new Error("G16_BUNDLE_INVALID");
    git(childRoot, "fetch", "--quiet", "--no-tags", bundle, "HEAD");
    git(childRoot, "checkout", "--quiet", "--detach", context.candidateSha);
    const lineage = await validateG16Checkout({
      candidateRoot,
      candidateSha: parent.candidateSha,
      baselineRoot: childRoot,
      baselineSha: context.candidateSha,
      ...receipt.signer,
    });
    if (
      lineage.parentConfigSha256 !== parent.baseConfigSha256 ||
      lineage.childConfigSha256 !== context.baseConfigSha256
    )
      throw new Error("G16_CONFIG_BINDING_INVALID");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return receipt;
}

export async function handleControlledG16ChildFailure({
  error,
  parent,
  childContext,
  candidateRoot,
  signerApproved,
  approvalRequests,
  artifacts,
}) {
  let recovery = null;
  if (
    signerApproved &&
    approvalRequests === 1 &&
    error?.result?.joined === true &&
    error.result.code !== 0
  ) {
    try {
      const last = error.result.stdout.split(/\r?\n/u).filter(Boolean).at(-1);
      const outcome = JSON.parse(last);
      const policy = await readApprovedG16Policy(
        candidateRoot,
        parent.candidateSha,
      );
      const toolchain = JSON.parse(
        (
          await readRegular(
            join(candidateRoot, "config/toolchain-versions.json"),
            1024 * 1024,
          )
        ).toString("utf8"),
      );
      recovery = sanitizeControlledG16Recovery(
        outcome,
        childContext,
        policy,
        toolchain.postgresImage,
      );
    } catch {
      /* Untrusted or incomplete child output cannot establish recovery facts. */
    }
  }
  const failure = {
    schemaVersion: 1,
    parentRunId: parent.runId,
    parentCandidateSha: parent.candidateSha,
    childRunId: childContext.runId,
    childCandidateSha: childContext.candidateSha,
    status: "FAIL",
    code: recovery ? "RECOVERY_REQUIRED" : "G16_CHILD_FAILURE_UNVERIFIED",
    childFailure: [
      "ROLLBACK_CHILD_FAILED",
      "ROLLBACK_CHILD_TIMEOUT",
      "ROLLBACK_CHILD_INTERRUPTED_SIGINT",
      "ROLLBACK_CHILD_INTERRUPTED_SIGTERM",
      "ROLLBACK_CHILD_OUTPUT_LIMIT",
      "ROLLBACK_CHILD_IPC_FAILED",
    ].includes(error?.message)
      ? error.message
      : "ROLLBACK_CHILD_FAILED",
    ...(recovery
      ? {
          mode: recovery.mode,
          origin: recovery.origin,
          accountFingerprint: recovery.accountFingerprint,
          recovery: recovery.recovery,
          ...(recovery.failureEvidence
            ? { failureEvidence: recovery.failureEvidence }
            : {}),
        }
      : {}),
  };
  const bytes = Buffer.from(`${JSON.stringify(failure, null, 2)}\n`);
  const path = join(artifacts, "controlled-child-failure.json");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const failureError = new Error(failure.code);
  failureError.safeDetails = {
    failureReceipt: { path, sha256: digest(bytes) },
    childFailure: failure.childFailure,
    ...(recovery
      ? {
          recovery: recovery.recovery,
          ...(recovery.failureEvidence
            ? { failureEvidence: recovery.failureEvidence }
            : {}),
        }
      : {}),
  };
  throw failureError;
}

export async function runControlledG16Parent({
  parentIdentity,
  parentContextPath,
  signerPath,
}) {
  if (
    typeof signerPath !== "string" ||
    !isAbsolute(signerPath) ||
    resolve(signerPath) !== signerPath ||
    (await realpath(signerPath)) !== signerPath
  )
    throw new Error("G16_SIGNER_PATH_INVALID");
  const signerBytes = await readRegular(signerPath, 1024 * 1024);
  const signerSha256 = digest(signerBytes);
  const {
    context: parent,
    candidateRoot,
    sourceRoot,
    evidenceDir,
  } = parentIdentity;
  const signer = spawn(process.execPath, [signerPath, "--hold"], {
    cwd: sourceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  signer.stdin.on("error", () => {});
  const joined = new Promise((resolvePromise) => {
    signer.once("error", () => resolvePromise({ code: null }));
    signer.once("close", (code) => resolvePromise({ code }));
  });
  signer.stderr.resume();
  const lines = createInterface({ input: signer.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const nextLine = async () => {
    const next = await Promise.race([
      lines.next(),
      delay(15000, null, { ref: false }).then(() => {
        throw new Error("G16_SIGNER_TIMEOUT");
      }),
    ]);
    if (next.done || next.value.length > 16384)
      throw new Error("G16_SIGNER_PROTOCOL_INVALID");
    return JSON.parse(next.value);
  };
  let ready,
    baseline,
    child,
    childStarted = false,
    childVerified = false,
    signerDone = false;
  let signerDirectory;
  try {
    ready = await nextLine();
    if (
      ready.mode !== "G16_RAM_SIGNER_READY" ||
      typeof ready.approvalFile !== "string" ||
      !/^\/dev\/shm\/coffee-g16-operator-[A-Za-z0-9]+\/approval\.json$/.test(
        ready.approvalFile,
      ) ||
      ready.approver !== "g16-operator" ||
      digest(await readRegular(signerPath, 1024 * 1024)) !== signerSha256
    )
      throw new Error("G16_SIGNER_READY_INVALID");
    const readyDirectory = dirname(ready.approvalFile);
    const signerInfo = await lstat(readyDirectory);
    if (
      !signerInfo.isDirectory() ||
      signerInfo.isSymbolicLink() ||
      signerInfo.uid !== process.getuid() ||
      (signerInfo.mode & 0o777) !== 0o700 ||
      (await realpath(readyDirectory)) !== readyDirectory
    )
      throw new Error("G16_SIGNER_DIRECTORY_INVALID");
    signerDirectory = readyDirectory;
    const age = await prepareG16Age(parentIdentity, process.env);
    const signerIdentity = {
      publicKeyPem: ready.publicKeyPem,
      keyId: ready.keyId,
      approver: ready.approver,
    };
    baseline = await createG16Checkout({
      candidateRoot,
      candidateSha: parent.candidateSha,
      ...signerIdentity,
    });
    const { prepareBrowserChildCheckout, writeControlledChildContext } =
      await import("./browser.mjs");
    await prepareBrowserChildCheckout(baseline.baselineRoot);
    child = await writeControlledChildContext({
      contextPath: parentContextPath,
      childRoot: baseline.baselineRoot,
      childSha: baseline.baselineSha,
      scope: "G16",
      signer: signerIdentity,
    });
    const bundle = await writeRollbackLineageBundle({
      candidateSha: parent.candidateSha,
      restoredRoot: baseline.baselineRoot,
      restoredSha: baseline.baselineSha,
      evidenceDir,
      scope: "G16",
    });
    const artifacts = join(evidenceDir, "gates/G16_AROMA_SANDBOX/artifacts");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      COFFEE_LAUNCH_CONTEXT_FILE: child.path,
      COFFEE_G16_CONTROLLED_CHILD: "1",
    };
    delete env.COFFEE_G16_SIGNER_PATH;
    let signed;
    let signerApproved = false;
    let approvalRequests = 0;
    childStarted = true;
    const execution = await runManagedRollbackChild({
      args: [
        join(
          baseline.baselineRoot,
          "verification/launch/v1/scenarios/aroma-sandbox.mjs",
        ),
        "--approval-file",
        ready.approvalFile,
      ],
      cwd: baseline.baselineRoot,
      env,
      onIpc: async (message) => {
        if (message.stage === "cleanup") {
          if (approvalRequests !== 1 || !signed)
            throw new Error("G16_APPROVAL_MISSING");
          return {};
        }
        const policy = await readApprovedG16Policy(
          candidateRoot,
          parent.candidateSha,
        );
        if (
          message.stage !== "approval" ||
          ++approvalRequests !== 1 ||
          message.runId !== child.context.runId ||
          message.candidateSha !== baseline.baselineSha ||
          message.accountFingerprint !== policy.accountFingerprint ||
          message.maximumQuantity !== "2" ||
          !exactObjectKeys(message.selected, ["offerRef"]) ||
          typeof message.selected.offerRef !== "string" ||
          !message.selected.offerRef
        )
          throw new Error("G16_APPROVAL_REQUEST_INVALID");
        signer.stdin.end(
          `${JSON.stringify({
            contextPath: child.path,
            runId: message.runId,
            candidateSha: message.candidateSha,
            accountFingerprint: message.accountFingerprint,
            selected: message.selected,
            maximumQuantity: message.maximumQuantity,
          })}\n`,
        );
        signed = await nextLine();
        const finished = await joined;
        signerDone = true;
        if (
          finished.code !== 0 ||
          signed.mode !== "G16_RAM_SIGNER_SIGNED" ||
          signed.approvalFile !== ready.approvalFile ||
          signed.runId !== message.runId ||
          signed.candidateSha !== message.candidateSha ||
          signed.offerRef !== message.selected.offerRef
        )
          throw new Error("G16_SIGNER_RESPONSE_INVALID");
        signerApproved = true;
        return {};
      },
    }).catch(async (error) => {
      return handleControlledG16ChildFailure({
        error,
        parent,
        childContext: child.context,
        candidateRoot,
        signerApproved,
        approvalRequests,
        artifacts,
      });
    });
    if (!signed || approvalRequests !== 1)
      throw new Error("G16_APPROVAL_MISSING");
    const last = execution.stdout.split(/\r?\n/u).filter(Boolean).at(-1);
    const outcome = JSON.parse(last);
    const policy = await readApprovedG16Policy(
      candidateRoot,
      parent.candidateSha,
    );
    const toolchain = JSON.parse(
      (
        await readRegular(
          join(candidateRoot, "config/toolchain-versions.json"),
          1024 * 1024,
        )
      ).toString("utf8"),
    );
    validateControlledG16Result(
      outcome,
      child.context,
      policy,
      toolchain.postgresImage,
    );
    const approvalBytes = await readRegular(ready.approvalFile, 16384);
    const signatureBytes = await readRegular(`${ready.approvalFile}.sig`, 1024);
    if (
      digest(approvalBytes) !== signed.approvalSha256 ||
      digest(signatureBytes) !== signed.signatureSha256
    )
      throw new Error("G16_SIGNER_OUTPUT_HASH_INVALID");
    const ageArgs = age.recipients.flatMap((recipient) => [
      "--recipient",
      recipient,
    ]);
    const files = [
      ["controlled-child-context.json", await readRegular(child.path, 16384)],
      [
        "controlled-child-result.json",
        Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
      ],
      ["controlled-approval.json.age", runG16Age(ageArgs, approvalBytes)],
      ["controlled-approval.sig.age", runG16Age(ageArgs, signatureBytes)],
    ];
    for (const [name, bytes] of files)
      await writeFile(join(artifacts, name), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    const receipt = {
      schemaVersion: 1,
      runId: parent.runId,
      candidateSha: parent.candidateSha,
      childRunId: child.context.runId,
      childSha: baseline.baselineSha,
      signer: signerIdentity,
      signerSha256,
      bundleSha256: bundle.sha256,
      childContextSha256: digest(files[0][1]),
      childResultSha256: digest(files[1][1]),
      approvalSha256: digest(approvalBytes),
      signatureSha256: digest(signatureBytes),
      approvalCiphertextSha256: digest(files[2][1]),
      signatureCiphertextSha256: digest(files[3][1]),
      cleanup: {
        checkoutRemoved: false,
        evidenceRemoved: false,
        signerRemoved: false,
      },
    };
    const receiptPath = join(artifacts, "controlled-parent.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await verifyControlledG16Evidence({
      parentIdentity,
      parentContextPath,
      requireCleanup: false,
    });
    childVerified = true;
    await rm(baseline.directory, { recursive: true });
    await rm(child.context.evidenceDir, { recursive: true });
    await rm(signerDirectory, { recursive: true });
    for (const path of [
      baseline.directory,
      child.context.evidenceDir,
      signerDirectory,
    ])
      if (
        await lstat(path).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        throw new Error("G16_CLEANUP_UNVERIFIED");
    receipt.cleanup = {
      checkoutRemoved: true,
      evidenceRemoved: true,
      signerRemoved: true,
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    await verifyControlledG16Evidence({ parentIdentity, parentContextPath });
    return {
      schemaVersion: 1,
      controlledChild: {
        candidateSha: baseline.baselineSha,
        runId: child.context.runId,
        cleanup: receipt.cleanup,
      },
      parentArtifact: {
        path: receiptPath,
        sha256: digest(await readFile(receiptPath)),
      },
    };
  } finally {
    if (!signerDone) {
      signer.kill("SIGTERM");
      const ended = await Promise.race([
        joined.then(() => true),
        delay(10000, false, { ref: false }),
      ]);
      if (!ended) {
        signer.kill("SIGKILL");
        signerDone = await Promise.race([
          joined.then(() => true),
          delay(10000, false, { ref: false }),
        ]);
      } else {
        signerDone = true;
      }
    }
    if (!childStarted && baseline)
      await rm(baseline.directory, { recursive: true, force: true });
    if (!childStarted && child)
      await rm(child.context.evidenceDir, { recursive: true, force: true });
    if (signerDirectory && signerDone)
      await rm(signerDirectory, { recursive: true, force: true });
    if (childStarted && !childVerified) {
      /* Preserve evidence and potentially unsafe owned resources. */
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--convergence-worker") {
    process.once("message", (message) => {
      void convergenceWorker(message)
        .then((value) => {
          if (process.connected)
            process.send({ ok: true, result: value }, () =>
              process.disconnect(),
            );
        })
        .catch((error) => {
          const code = safeAromaFailureCode(error);
          if (process.connected)
            process.send({ ok: false, code }, () => process.disconnect());
        });
    });
    return 0;
  }
  try {
    const { approvalFile } = parseArguments(args);
    if (process.env.COFFEE_G16_SIGNER_PATH) {
      const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
      const parentIdentity = await validateContext(contextPath);
      const receipt = await runControlledG16Parent({
        parentIdentity,
        parentContextPath: contextPath,
        signerPath: process.env.COFFEE_G16_SIGNER_PATH,
      });
      result("PASS", "CONTROLLED_LIVE_SCENARIO_COMPLETE", receipt);
      return 0;
    }
    const outcome = normalizeCleanupFailureOutcome(
      await runAromaSandbox({ approvalFile }),
    );
    await controlledParentRequest("cleanup");
    if (process.env.COFFEE_G16_CONTROLLED_CHILD === "1" && process.connected)
      process.disconnect();
    result(
      outcome.status,
      outcome.code,
      outcome.status === "PASS"
        ? {
            ...outcome.runMetadata,
            accountFingerprint: outcome.accountFingerprint,
            selected: outcome.selected,
            catalogEvidence: outcome.catalogEvidence,
            migrations: outcome.migrations,
            cleanup: outcome.cleanup,
            resourceIDs: outcome.resourceIDs,
            baselineFingerprint: outcome.result.baselineFingerprint,
            finalFingerprint: outcome.result.finalFingerprint,
            phases: outcome.result.phases,
            mutationJournalRows: outcome.result.mutationJournalRows,
            unknownOperationRef: outcome.result.unknownOperationRef,
            delivery: "private-loopback-owner-harness",
            kafkaBrokerTransport: false,
            apiInternalDelegationProof: false,
            orderConfirmationProof: false,
            desiredInput: "controlled-fixture-no-order-confirmation",
            cartGuard:
              "fresh-full-cart-read-before-dispatch; provider-has-no-compare-and-swap",
          }
        : outcome.status === "FAIL"
          ? {
              ...outcome.runMetadata,
              ...(outcome.accountFingerprint
                ? { accountFingerprint: outcome.accountFingerprint }
                : {}),
              ...(outcome.stage ? { stage: outcome.stage } : {}),
              ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
              ...(outcome.recovery ? { recovery: outcome.recovery } : {}),
              ...(outcome.failureEvidence
                ? { failureEvidence: outcome.failureEvidence }
                : {}),
              ...(outcome.cleanup ? { cleanup: outcome.cleanup } : {}),
            }
          : outcome.runMetadata
            ? {
                ...outcome.runMetadata,
                ...(outcome.selected ? { selected: outcome.selected } : {}),
                ...(outcome.cleanup ? { cleanup: outcome.cleanup } : {}),
              }
            : {},
    );
    return outcome.status === "PASS"
      ? 0
      : outcome.status === "NOT_RUN"
        ? 78
        : 1;
  } catch (error) {
    if (process.env.COFFEE_G16_CONTROLLED_CHILD === "1" && process.connected)
      process.disconnect();
    const code = safeAromaFailureCode(error);
    result(
      "FAIL",
      code,
      error?.safeDetails && typeof error.safeDetails === "object"
        ? error.safeDetails
        : {},
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await main();
