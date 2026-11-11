#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { load as parseYaml } from "js-yaml";
import {
  parsePlatformConfig,
  parseSecurityScanVerification,
} from "../packages/platform-config/src/index.ts";
import { RUNTIME_NAMES } from "../packages/platform-config/src/index.ts";
import { validateLaunchContext } from "../verification/launch/v1/report.mjs";
import { materializeBuildRegistryCredentials } from "./config-bootstrap/index.mjs";
import { buildkitPolicy, verifyBuildkitPolicy } from "./buildkit-policy.mjs";

const SCANNER_IMAGE =
  "ghcr.io/aquasecurity/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c";
const SCANNER_VERSION = "0.76.1";
export const G12_SCAN_BUDGET_MS = 40 * 60_000;
const BUILD_NETWORK = "coffee_platform_build_mtu";
const UPSTREAM_IMAGES = Object.freeze([
  "lokiImage",
  "prometheusImage",
  "tempoImage",
]);
const SCAN_LOCK = join(tmpdir(), "coffee-platform-trivy.lock");
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 8 * 1024 * 1024;
const MAX_KAFKA_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_BUILD_CONTEXT_BYTES = 512 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DATABASE_BYTES = 2 * 1024 ** 3;
const CONTAINER_OWNER_LABEL = "io.coffeeorderplatform.g12.owner";
const CONTAINER_RUN_LABEL = "io.coffeeorderplatform.g12.run-id";
const CONTAINER_NONCE_LABEL = "io.coffeeorderplatform.g12.nonce";
const CONTAINER_INSPECT_FORMAT = `{{.Id}}|{{.Name}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "${CONTAINER_OWNER_LABEL}"}}|{{index .Config.Labels "${CONTAINER_RUN_LABEL}"}}|{{index .Config.Labels "${CONTAINER_NONCE_LABEL}"}}`;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

// This is the owner-approved artifact identity, not a version-range waiver.
const APPROVED_TEMPO = Object.freeze({
  version: "13.4.1",
  zipSha256: "08b0de5ed46b3b60693b41495bc00633ae63c3f2e76faa819c7fa95a4dbbc529",
  manifestSha256:
    "7c6d68297c3c30623c2f123aeef4e5163de98351af3f31557d72c6796516c9c4",
  binarySha256:
    "292f1875dbcc18125701cca2762da7e65300a4ca3ea3c4105f24b7cd57694588",
  signingKeySourceSha256:
    "010f8c4bc078a6b11be3f7a902c90a559a13e2e6f44c4d5632f01b9e8e6e68a2",
  signingKeyFingerprint: "F33B25B691074E84636570F37E4D0C6A708866E7",
  moduleVersion: "v1.5.1-0.20260910130453-bcfe9f230c1d",
  moduleH1: "h1:BphMCaYqWY+j1fdRPNFPkYE4A4QIev1KlHjRkSVJ8O4=",
  revision: "bcfe9f230c1de0f79cfd2110b38062e0f41c81e9",
  fixCommits: [
    "650eb1985a0776789c8564122990f588a742356f",
    "bb8ca663db34a0980c9758b40d918fda3b4dbec3",
  ],
});
const APPROVED_CVES = Object.freeze(["CVE-2026-21728", "CVE-2026-28377"]);
const CVE_78661_PRODUCTS = Object.freeze({
  grafana: "grafana/grafana",
  "otel-collector": "grafana/alloy",
  loki: "grafana/loki",
  prometheus: "prom/prometheus",
});
export const CVE_78661_PROOF_SHA256 =
  "7de1f821bfd697d66ae93da77776848e2d49a2e1665a55a9d2be3499f91a9b11";

export async function readCve78661Proof(candidateRoot) {
  const bytes = await readRegular(
    join(candidateRoot, "evidence/security/cve-2026-78661.json"),
    MAX_METADATA_BYTES,
  );
  if (sha256(bytes) !== CVE_78661_PROOF_SHA256) fail("CVE_78661_PROOF_INVALID");
  return parseJson(bytes, "CVE_78661_PROOF_INVALID");
}

export function adjudicateCve78661({ proof, reports, images, toolchain }) {
  if (
    proof?.cve !== "CVE-2026-78661" ||
    proof?.severity !== "HIGH" ||
    proof?.justification !== "vulnerable_code_not_present" ||
    !Array.isArray(proof.binaries) ||
    proof.binaries.length !== 8
  )
    return [];
  const decisions = [];
  for (const binary of proof.binaries) {
    const imageRows = images.filter(
      (entry) => entry.service === binary.service,
    );
    const image = imageRows[0];
    const report = reports[binary.service];
    if (
      imageRows.length !== 1 ||
      image?.imageId !== binary.imageId ||
      image?.manifestDigest !== binary.manifestDigest ||
      report?.Metadata?.ImageID !== image.imageId ||
      (binary.platformManifestDigest
        ? image.platformManifestDigest !== binary.platformManifestDigest ||
          image.provenanceStatus !== "PASS"
        : image.sourceReference !== binary.sourceReference ||
          toolchain?.[`${binary.service}Image`] !== binary.sourceReference ||
          image.identityStatus !== "PINNED_DIGEST_VERIFIED")
    )
      continue;
    const rows = (report.Results ?? []).filter(
      (row) => row?.Target === binary.target,
    );
    if (rows.length !== 1 || !Array.isArray(rows[0].Vulnerabilities)) continue;
    const occurrences = report.Results.flatMap((row) =>
      (row.Vulnerabilities ?? []).filter(
        (finding) => finding?.Fingerprint === binary.fingerprint,
      ),
    );
    const findings = rows[0].Vulnerabilities.filter(
      (finding) => finding?.VulnerabilityID === proof.cve,
    );
    if (
      occurrences.length !== 1 ||
      findings.length !== 1 ||
      findings[0].Fingerprint !== binary.fingerprint ||
      findings[0].Severity !== proof.severity ||
      findings[0].PkgName !== binary.package ||
      findings[0].InstalledVersion !== binary.installedVersion
    )
      continue;
    decisions.push({
      vulnerabilityId: proof.cve,
      fingerprint: binary.fingerprint,
      status: "not_affected",
      service: binary.service,
      target: binary.target,
      binarySha256: binary.binarySha256,
      manifestDigest: binary.platformManifestDigest ?? binary.manifestDigest,
    });
  }
  return decisions;
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
}
function isoTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)
  )
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
export function verifyBuildxMetadata(service, metadata, candidateSha) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    fail("PROVENANCE_METADATA_INVALID");
  const imageId = metadata["containerimage.config.digest"] ?? null;
  const manifestDigest = metadata["containerimage.digest"];
  if (
    (imageId !== null && !SHA256.test(imageId)) ||
    !SHA256.test(manifestDigest ?? "") ||
    metadata["containerimage.descriptor"]?.digest !== manifestDigest
  )
    fail("PROVENANCE_IMAGE_DIGEST_INVALID");
  return Object.freeze({
    service,
    imageId,
    manifestDigest,
    sourceRevision: candidateSha,
  });
}

export function verifySlsaStatement(
  service,
  statement,
  manifestDigest,
  candidateSha,
  baseMaterial = null,
) {
  if (
    !statement ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    statement.subject[0]?.digest?.sha256 !==
      manifestDigest.slice("sha256:".length)
  )
    fail("PROVENANCE_SUBJECT_MISMATCH");
  const predicate = statement.predicate;
  const validV02 =
    statement._type === "https://in-toto.io/Statement/v0.1" &&
    statement.predicateType === "https://slsa.dev/provenance/v0.2" &&
    predicate?.buildType === "https://mobyproject.org/buildkit@v1";
  const validV1 =
    statement._type === "https://in-toto.io/Statement/v1" &&
    statement.predicateType === "https://slsa.dev/provenance/v1" &&
    predicate?.buildDefinition?.buildType ===
      "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md";
  if ((!validV02 && !validV1) || !/^[0-9a-f]{40}$/u.test(candidateSha))
    fail("PROVENANCE_ATTESTATION_ABSENT");
  const complete = validV1
    ? predicate.runDetails?.metadata?.buildkit_completeness
        ?.resolvedDependencies
    : predicate.metadata?.completeness?.materials;
  if (typeof complete !== "boolean") fail("PROVENANCE_COMPLETENESS_INVALID");
  if (service === "keycloak") {
    verifyBaseMaterialStatement(
      statement,
      baseMaterial?.distribution,
      "keycloak-distribution",
    );
    verifyBaseMaterialStatement(
      statement,
      baseMaterial?.runtime,
      "keycloak-runtime",
    );
  } else if (
    ["kafka", "storage-helper", "grafana", "otel-collector"].includes(service)
  ) {
    verifyBaseMaterialStatement(statement, baseMaterial, service);
  }
  return Object.freeze({
    service,
    manifestDigest,
    sourceRevision: candidateSha,
    buildkitMaterialsCompleteness: complete
      ? "COMPLETE"
      : "INCOMPLETE_LOCAL_CONTEXT",
  });
}

function baseReference(sourceRef, target) {
  const pattern =
    target === "kafka"
      ? /^(apache\/kafka):(4\.3\.2)@(sha256:[0-9a-f]{64})$/u
      : target === "otel-collector"
        ? /^(grafana\/alloy):([^@/]+)@(sha256:[0-9a-f]{64})$/u
        : target === "grafana"
          ? /^(grafana\/grafana):([^@/]+)@(sha256:[0-9a-f]{64})$/u
          : target === "keycloak-distribution"
            ? /^(dhi\.io\/keycloak)()@(sha256:[0-9a-f]{64})$/u
            : target === "keycloak-runtime"
              ? /^(eclipse-temurin):(21\.0\.13_9-jre-alpine-3\.24)@(sha256:[0-9a-f]{64})$/u
              : /^(node):([^@/]+)@(sha256:[0-9a-f]{64})$/u;
  return typeof sourceRef === "string" ? sourceRef.match(pattern) : null;
}

function verifyBaseMaterialStatement(statement, baseMaterial, target) {
  const prefix = target.toUpperCase().replaceAll("-", "_");
  const match = baseReference(baseMaterial?.sourceRef, target);
  const indexSha256 = baseMaterial?.indexArtifact?.sha256;
  if (
    !SHA256.test(baseMaterial?.platformManifestDigest ?? "") ||
    !match ||
    !/^[0-9a-f]{64}$/u.test(indexSha256 ?? "") ||
    match[3].slice(7) !== indexSha256
  )
    fail(`${prefix}_BASE_MATERIAL_INVALID`);
  const dependencies =
    statement?.predicateType === "https://slsa.dev/provenance/v1"
      ? statement?.predicate?.buildDefinition?.resolvedDependencies
      : statement?.predicate?.materials;
  if (!Array.isArray(dependencies)) fail(`${prefix}_BASE_MATERIAL_ABSENT`);
  const packagePrefix =
    target === "kafka"
      ? /^pkg:docker\/(?:docker\.io\/)?apache\/kafka@/u
      : target === "otel-collector"
        ? /^pkg:docker\/(?:docker\.io\/)?grafana\/alloy@/u
        : target === "grafana"
          ? /^pkg:docker\/(?:docker\.io\/)?grafana\/grafana@/u
          : target === "keycloak-distribution"
            ? /^pkg:docker\/dhi\.io\/keycloak\?/u
            : target === "keycloak-runtime"
              ? /^pkg:docker\/(?:docker\.io\/)?(?:library\/)?eclipse-temurin@/u
              : /^pkg:docker\/(?:docker\.io\/)?(?:library\/)?node@/u;
  const matches = dependencies.filter((material) =>
    packagePrefix.test(material?.uri ?? ""),
  );
  const expectedUri = `pkg:docker/${match[1]}${match[2] ? `@${match[2]}` : ""}?digest=${match[3]}&platform=linux%2Famd64`;
  if (
    matches.length !== 1 ||
    matches[0]?.uri !== expectedUri ||
    matches[0]?.digest?.sha256 !== indexSha256
  )
    fail(`${prefix}_BASE_MATERIAL_MISMATCH`);
  return true;
}

export function verifyKafkaBaseMaterialStatement(statement, baseMaterial) {
  return verifyBaseMaterialStatement(statement, baseMaterial, "kafka");
}

function parseBaseIndex(sourceRef, bytes, target) {
  const prefix = target.toUpperCase().replaceAll("-", "_");
  const match = baseReference(sourceRef, target);
  if (
    !match ||
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_KAFKA_INDEX_BYTES ||
    `sha256:${sha256(bytes)}` !== match[3]
  )
    fail(`${prefix}_BASE_INDEX_INVALID`);
  const index = parseJson(bytes, `${prefix}_BASE_INDEX_INVALID`);
  if (
    index?.schemaVersion !== 2 ||
    !new Set([
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
    ]).has(index.mediaType) ||
    !Array.isArray(index.manifests)
  )
    fail(`${prefix}_BASE_INDEX_INVALID`);
  const descriptors = index.manifests.filter(
    (item) =>
      item?.platform?.os === "linux" &&
      item?.platform?.architecture === "amd64",
  );
  if (
    descriptors.length !== 1 ||
    !SHA256.test(descriptors[0]?.digest ?? "") ||
    !Number.isSafeInteger(descriptors[0]?.size) ||
    descriptors[0].size <= 0 ||
    !new Set([
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ]).has(descriptors[0]?.mediaType)
  )
    fail(`${prefix}_BASE_PLATFORM_MANIFEST_INVALID`);
  return Object.freeze({
    sourceRef,
    platformManifestDigest: descriptors[0].digest,
    indexArtifact: Object.freeze({
      path: `artifacts/${target}-base-index.json`,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    }),
  });
}

export function parseKafkaBaseIndex(sourceRef, bytes) {
  return parseBaseIndex(sourceRef, bytes, "kafka");
}

export function inspectFindings(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.Results))
    fail("VULNERABILITY_REPORT_INVALID");
  let high = 0;
  let critical = 0;
  for (const result of report.Results) {
    if (
      result?.Vulnerabilities !== undefined &&
      result.Vulnerabilities !== null &&
      !Array.isArray(result.Vulnerabilities)
    )
      fail("VULNERABILITY_REPORT_INVALID");
    for (const finding of result.Vulnerabilities ?? []) {
      if (finding?.Severity === "HIGH") high += 1;
      if (finding?.Severity === "CRITICAL") critical += 1;
    }
  }
  return Object.freeze({ high, critical });
}

export function adjudicateGrafanaFindings({
  report,
  image,
  toolchain,
  approvedFixed = [],
}) {
  const pin = toolchain.grafanaPlugins?.tempo;
  const module = toolchain.grafanaTempoModule;
  const binding = image?.buildInputBinding?.vendorPlugins;
  const effective = binding?.effectiveFiles?.tempo;
  const target =
    "opt/grafana/plugins/tempo/gpx_grafana-tempo-datasource_linux_amd64";
  if (
    !Array.isArray(approvedFixed) ||
    approvedFixed.length !== 2 ||
    new Set(approvedFixed).size !== 2 ||
    APPROVED_CVES.some((id) => !approvedFixed.includes(id)) ||
    image?.service !== "grafana" ||
    !SHA256.test(image?.imageId ?? "") ||
    !SHA256.test(image?.manifestDigest ?? "") ||
    !SHA256.test(image?.platformManifestDigest ?? "") ||
    report?.Metadata?.ImageID !== image.imageId ||
    pin?.version !== APPROVED_TEMPO.version ||
    pin?.zipSha256 !== APPROVED_TEMPO.zipSha256 ||
    pin?.manifestSha256 !== APPROVED_TEMPO.manifestSha256 ||
    pin?.binarySha256 !== APPROVED_TEMPO.binarySha256 ||
    toolchain.grafanaSigningKeySourceSha256 !==
      APPROVED_TEMPO.signingKeySourceSha256 ||
    toolchain.grafanaSigningKeyFingerprint !==
      APPROVED_TEMPO.signingKeyFingerprint ||
    module?.version !== APPROVED_TEMPO.moduleVersion ||
    module?.h1 !== APPROVED_TEMPO.moduleH1 ||
    module?.revision !== APPROVED_TEMPO.revision ||
    module?.replacement !== null ||
    JSON.stringify(module?.fixCommits) !==
      JSON.stringify(APPROVED_TEMPO.fixCommits) ||
    effective?.path !== `/${target}` ||
    effective?.sha256 !== APPROVED_TEMPO.binarySha256 ||
    !SHA256.test(effective?.layerDigest ?? "") ||
    binding?.signingKeyFingerprint !== APPROVED_TEMPO.signingKeyFingerprint ||
    binding?.signingKeySourceSha256 !== APPROVED_TEMPO.signingKeySourceSha256 ||
    JSON.stringify(binding?.plugins?.tempo) !== JSON.stringify(pin)
  )
    return [];
  const rows = (report.Results ?? []).filter((row) => row?.Target === target);
  if (rows.length !== 1 || !Array.isArray(rows[0].Vulnerabilities)) return [];
  const decisions = [];
  for (const id of APPROVED_CVES) {
    const found = rows[0].Vulnerabilities.filter(
      (v) => v?.VulnerabilityID === id && v?.Severity === "HIGH",
    );
    if (found.length !== 1) continue;
    const finding = found[0];
    if (
      finding.PkgName !== "github.com/grafana/tempo" ||
      finding.InstalledVersion !== APPROVED_TEMPO.moduleVersion ||
      finding.PkgIdentifier?.PURL !==
        `pkg:golang/github.com/grafana/tempo@${APPROVED_TEMPO.moduleVersion}` ||
      !SHA256.test(finding.Fingerprint ?? "") ||
      decisions.some((decision) => decision.fingerprint === finding.Fingerprint)
    )
      continue;
    decisions.push({
      vulnerabilityId: id,
      fingerprint: finding.Fingerprint,
      status: "fixed_in_exact_vendor_artifact",
    });
  }
  return decisions;
}

// Interchange projection of the already-verified local decision, not a vendor statement.
export function buildOpenVex({
  decisions,
  notAffected = [],
  runId,
  candidateSha,
  platformManifestDigest,
  timestamp,
}) {
  if (
    !Array.isArray(notAffected) ||
    new Set(notAffected.map((decision) => decision.fingerprint)).size !==
      notAffected.length ||
    notAffected.some(
      (decision) =>
        decision.vulnerabilityId !== "CVE-2026-78661" ||
        decision.status !== "not_affected" ||
        !SHA256.test(decision.fingerprint ?? "") ||
        !SHA256.test(decision.manifestDigest ?? "") ||
        !/^[a-f0-9]{64}$/u.test(decision.binarySha256 ?? "") ||
        typeof decision.target !== "string" ||
        !Object.hasOwn(CVE_78661_PRODUCTS, decision.service),
    ) ||
    !Array.isArray(decisions) ||
    decisions.some(
      (decision) => !APPROVED_CVES.includes(decision.vulnerabilityId),
    ) ||
    new Set(decisions.map((decision) => decision.vulnerabilityId)).size !==
      decisions.length ||
    typeof runId !== "string" ||
    !runId ||
    !/^[a-f0-9]{40}$/u.test(candidateSha ?? "") ||
    !SHA256.test(platformManifestDigest ?? "") ||
    isoTime(timestamp) === null
  )
    fail("OPENVEX_INPUT_INVALID");
  if (!decisions.length && !notAffected.length) return null;
  const id = sha256(
    Buffer.from(`${runId}\0${candidateSha}\0${platformManifestDigest}`),
  );
  const notes =
    `Project Operations assessment of Grafana-signed plugin binary sha256:${APPROVED_TEMPO.binarySha256}; ` +
    `ZIP sha256:${APPROVED_TEMPO.zipSha256}, signed manifest sha256:${APPROVED_TEMPO.manifestSha256}, key ${APPROVED_TEMPO.signingKeyFingerprint}; ` +
    `${APPROVED_TEMPO.moduleVersion}, ${APPROVED_TEMPO.moduleH1}, no replacement; source fixes ${APPROVED_TEMPO.fixCommits.join(", ")}. ` +
    "Machine-code reproducibility was not proven; this is not a vendor statement.";
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `https://github.com/YurGusev/CoffeeOrderPlatform/vex/${id}`,
    author: "CoffeeOrderPlatform Operations",
    timestamp,
    version: 1,
    statements: [
      ...decisions.map(({ vulnerabilityId }) => ({
        vulnerability: { name: vulnerabilityId },
        products: [{ "@id": `pkg:oci/grafana@${platformManifestDigest}` }],
        status: "fixed",
        status_notes: notes,
      })),
      ...notAffected.map((decision) => ({
        vulnerability: { name: decision.vulnerabilityId },
        products: [
          {
            "@id": `pkg:oci/${CVE_78661_PRODUCTS[decision.service]}@${decision.manifestDigest}`,
            subcomponents: [
              {
                "@id": `urn:coffee:binary:${encodeURIComponent(decision.target)}`,
                hashes: { "sha-256": decision.binarySha256 },
              },
            ],
          },
        ],
        status: "not_affected",
        justification: "vulnerable_code_not_present",
      })),
    ],
  };
}

export function validateOpenVex(document, inputs) {
  return isDeepStrictEqual(document, buildOpenVex(inputs));
}

export function validateDatabaseMetadata(
  metadata,
  now,
  maxAgeMs = 24 * 60 * 60 * 1000,
) {
  const updatedAt = isoTime(metadata?.UpdatedAt);
  const nextUpdate = isoTime(metadata?.NextUpdate);
  const downloadedAt = isoTime(metadata?.DownloadedAt);
  if (
    !Number.isSafeInteger(metadata?.Version) ||
    updatedAt === null ||
    nextUpdate === null ||
    downloadedAt === null ||
    updatedAt > now + 5 * 60_000 ||
    downloadedAt > now + 5 * 60_000 ||
    now - updatedAt > maxAgeMs ||
    now - downloadedAt > maxAgeMs ||
    nextUpdate <= now ||
    nextUpdate <= updatedAt
  )
    fail("VULNERABILITY_DB_STALE_OR_INVALID");
  return Object.freeze({
    version: metadata.Version,
    updatedAt: new Date(updatedAt).toISOString(),
    nextUpdate: new Date(nextUpdate).toISOString(),
    downloadedAt: new Date(downloadedAt).toISOString(),
  });
}

async function readRegular(path, maxBytes = MAX_METADATA_BYTES, { mode } = {}) {
  const absolute = resolve(path);
  if ((await realpath(absolute).catch(() => null)) !== absolute)
    fail("INPUT_PATH_INVALID");
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    fail("INPUT_FILE_INVALID");
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) fail("INPUT_FILE_INVALID");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) fail("INPUT_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail("INPUT_FILE_INVALID");
    if (mode !== undefined) {
      await handle.chmod(mode);
      if (((await handle.stat()).mode & 0o777) !== mode)
        fail("INPUT_FILE_INVALID");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function validateEvidencePaths(evidenceDir, outputDir) {
  const evidence = resolve(evidenceDir);
  const output = resolve(outputDir);
  const evidenceInfo = await lstat(evidence).catch(() => null);
  if (
    !evidenceInfo?.isDirectory() ||
    evidenceInfo.isSymbolicLink() ||
    (await realpath(evidence)) !== evidence
  )
    fail("EVIDENCE_PATH_INVALID");
  if (
    await lstat(output).then(
      () => true,
      () => false,
    )
  )
    fail("EVIDENCE_OUTPUT_ALREADY_EXISTS");
  let parent = dirname(output);
  while (
    !(await lstat(parent).then(
      () => true,
      () => false,
    ))
  ) {
    const next = dirname(parent);
    if (next === parent) fail("EVIDENCE_PATH_INVALID");
    parent = next;
  }
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (await realpath(parent)) !== parent ||
    !within(evidence, parent)
  )
    fail("EVIDENCE_PATH_INVALID");
}

export function git(root, ...args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0;
    let overflow = false;
    let spawnError;
    child.stdout.on("data", (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_GIT_OUTPUT_BYTES) {
        overflow = true;
        chunks.length = 0;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (overflow)
        reject(
          Object.assign(new Error("GIT_OUTPUT_TOO_LARGE"), {
            code: "GIT_OUTPUT_TOO_LARGE",
          }),
        );
      else if (spawnError) reject(spawnError);
      else if (code === 0)
        resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
      else
        reject(
          Object.assign(new Error("GIT_IDENTITY_INVALID"), {
            code: "GIT_IDENTITY_INVALID",
          }),
        );
    });
  });
}

async function verifyCandidateFiles(identity) {
  const { candidateRoot, context, environment } = identity;
  if (
    (await git(candidateRoot, "rev-parse", "HEAD")) !== context.candidateSha ||
    (await git(
      candidateRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    )) !== ""
  )
    fail("CANDIDATE_NOT_CLEAN");
  if (await hasHiddenIndexFlags(candidateRoot))
    fail("CANDIDATE_INDEX_FLAGS_PRESENT");
  const treeSha = await git(
    candidateRoot,
    "rev-parse",
    `${context.candidateSha}^{tree}`,
  );
  if (treeSha !== environment.treeSha) fail("CANDIDATE_TREE_MISMATCH");
  const files = [
    ["config/platform.yaml", context.baseConfigSha256],
    ["config/toolchain-versions.json", environment.toolchainVersionsSha256],
    ["pnpm-lock.yaml", environment.lockfileSha256],
  ];
  for (const [path, expected] of files) {
    if (!/^[0-9a-f]{64}$/u.test(expected ?? ""))
      fail("CANDIDATE_HASH_CONTEXT_ABSENT");
    const working = await readRegular(
      join(candidateRoot, path),
      8 * 1024 * 1024,
    );
    const committed = await new Promise((resolvePromise, reject) => {
      const child = spawn(
        "git",
        ["cat-file", "blob", `${context.candidateSha}:${path}`],
        {
          cwd: candidateRoot,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            GIT_OPTIONAL_LOCKS: "0",
          },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const chunks = [];
      let size = 0;
      let overflow = false;
      child.stdout.on("data", (chunk) => {
        if (overflow) return;
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          overflow = true;
          chunks.length = 0;
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) =>
        overflow
          ? reject(new Error("CANDIDATE_BLOB_INVALID"))
          : code === 0
            ? resolvePromise(Buffer.concat(chunks))
            : reject(new Error("CANDIDATE_BLOB_INVALID")),
      );
    });
    if (sha256(working) !== expected || sha256(committed) !== expected)
      fail("CANDIDATE_FILE_HASH_MISMATCH");
  }
}

export async function hasHiddenIndexFlags(candidateRoot) {
  const assumeUnchanged = await git(candidateRoot, "ls-files", "-v", "-z");
  const skipWorktree = await git(candidateRoot, "ls-files", "-t", "-z");
  return (
    assumeUnchanged
      .split("\0")
      .some((entry) => entry && entry[0] >= "a" && entry[0] <= "z") ||
    skipWorktree.split("\0").some((entry) => entry.startsWith("S "))
  );
}

async function validateInputs({
  contextFile,
  outputDir,
  validateContext = validateLaunchContext,
}) {
  const baseIdentity = await validateContext(contextFile);
  const { context, candidateRoot, evidenceDir } = baseIdentity;
  const environmentBytes = await readRegular(
    join(evidenceDir, "environment.json"),
    64 * 1024,
  );
  const environment = parseJson(environmentBytes, "LAUNCH_ENVIRONMENT_INVALID");
  const identity = { ...baseIdentity, environment };
  if (
    environment.runId !== context.runId ||
    environment.candidateSha !== context.candidateSha ||
    environment.candidatePath !== context.checkoutDir ||
    resolve(environment.candidatePath ?? "") !== candidateRoot ||
    environment.dirty !== false ||
    !/^[0-9a-f]{40}$/u.test(environment.treeSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(context.baseConfigSha256 ?? "") ||
    environment.configSha256 !== context.baseConfigSha256 ||
    !/^[0-9a-f]{64}$/u.test(environment.toolchainVersionsSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(environment.lockfileSha256 ?? "")
  )
    fail("LAUNCH_ENVIRONMENT_MISMATCH");
  const targetOutputDir =
    outputDir ??
    join(evidenceDir, "gates", "G12_SUPPLY_CHAIN", "artifacts", "supply-chain");
  if (
    resolve(targetOutputDir) !== targetOutputDir ||
    !within(evidenceDir, targetOutputDir)
  )
    fail("EVIDENCE_PATH_INVALID");
  await validateEvidencePaths(evidenceDir, targetOutputDir);
  if (
    candidateRoot === evidenceDir ||
    context.candidateSha !== (await git(candidateRoot, "rev-parse", "HEAD"))
  )
    fail("CANDIDATE_SHA_MISMATCH");
  await verifyCandidateFiles(identity);
  const platformBytes = await readRegular(
    join(candidateRoot, "config/platform.yaml"),
    2 * 1024 * 1024,
  );
  const toolchainBytes = await readRegular(
    join(candidateRoot, "config/toolchain-versions.json"),
    2 * 1024 * 1024,
  );
  const lockfileBytes = await readRegular(
    join(candidateRoot, "pnpm-lock.yaml"),
    8 * 1024 * 1024,
  );
  const platform = parseYaml(platformBytes.toString("utf8"), { json: true });
  parsePlatformConfig(platform);
  const policy = parseSecurityScanVerification(
    platform?.verification?.securityScan,
  );
  const toolchain = parseJson(toolchainBytes, "TOOLCHAIN_PIN_INVALID");
  if (
    toolchain.trivy !== SCANNER_VERSION ||
    toolchain.trivyImage !== SCANNER_IMAGE
  )
    fail("SCANNER_PIN_MISMATCH");
  for (const key of [
    ...UPSTREAM_IMAGES,
    "otelCollectorImage",
    "kafkaImage",
    "nodeImage",
    "grafanaImage",
    "keycloakDistributionImage",
    "keycloakRuntimeImage",
  ])
    if (!/^.+@sha256:[0-9a-f]{64}$/u.test(toolchain[key] ?? ""))
      fail("UPSTREAM_IMAGE_PIN_INVALID");
  if (toolchain.muslVersion !== "1.2.6-r3") fail("TOOLCHAIN_PIN_INVALID");
  if (
    !/^apache\/kafka:4\.3\.2@sha256:[0-9a-f]{64}$/u.test(toolchain.kafkaImage)
  )
    fail("KAFKA_BASE_IMAGE_PIN_INVALID");
  const composeBytes = await readRegular(
    join(candidateRoot, "compose.yaml"),
    4 * 1024 * 1024,
  );
  const compose = parseYaml(composeBytes.toString("utf8"), { json: true });
  const kafkaService = compose?.services?.kafka;
  if (
    kafkaService?.image !==
      "coffee-platform-kafka:verified-artifact-required" ||
    kafkaService?.pull_policy !== "never" ||
    Object.hasOwn(kafkaService ?? {}, "build")
  )
    fail("KAFKA_SERVICE_DECLARATION_INVALID");
  return {
    identity,
    policy,
    toolchain,
    outputDir: targetOutputDir,
    platform,
    sourceInputs: { platformBytes, toolchainBytes, lockfileBytes },
  };
}

async function collectManifestFiles(root) {
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "package.json")
        files.push(relative(root, path));
    }
  }
  for (const directory of ["apps", "packages"])
    await visit(join(root, directory));
  return [...new Set(files)].sort((a, b) => a.localeCompare(b, "en"));
}

async function prepareGrafanaPlugins({
  toolchain,
  temporary,
  outputRoot,
  run,
}) {
  const version =
    /^grafana\/grafana:(\d+\.\d+\.\d+)-slim@sha256:[a-f0-9]{64}$/u.exec(
      toolchain.grafanaImage ?? "",
    )?.[1];
  if (!version) fail("GRAFANA_BASE_IMAGE_PIN_INVALID");
  const root = join(temporary, "grafana-plugins");
  const keyDir = join(temporary, "grafana-signing-key");
  await mkdir(root, { mode: 0o700 });
  await mkdir(keyDir, { mode: 0o700 });
  const keySource = join(temporary, "grafana-static-retriever.go");
  await run("curl", [
    "--fail",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--max-filesize",
    "2097152",
    "--output",
    keySource,
    `https://raw.githubusercontent.com/grafana/grafana/v${version}/pkg/plugins/manager/signature/statickey/static_retriever.go`,
  ]);
  const keyBytes = await readRegular(keySource);
  if (sha256(keyBytes) !== toolchain.grafanaSigningKeySourceSha256)
    fail("GRAFANA_KEY_SOURCE_MISMATCH");
  const publicKey = /const publicKeyText = `([\s\S]+?)`/u.exec(
    keyBytes.toString("utf8"),
  )?.[1];
  if (!publicKey) fail("GRAFANA_KEY_INVALID");
  const keyFile = join(temporary, "grafana-signing-key.asc");
  await writeFile(keyFile, publicKey, { flag: "wx", mode: 0o600 });
  const gpg = [
    "--no-options",
    "--homedir",
    keyDir,
    "--batch",
    "--no-auto-key-retrieve",
  ];
  await run("gpg", [...gpg, "--import", keyFile]);
  const bindings = {};
  for (const name of ["loki", "tempo", "prometheus"]) {
    const pin = toolchain.grafanaPlugins?.[name];
    if (
      !/^\d+\.\d+\.\d+$/u.test(pin?.version ?? "") ||
      ["zipSha256", "manifestSha256", "binarySha256"].some(
        (key) => !/^[0-9a-f]{64}$/u.test(pin?.[key] ?? ""),
      )
    )
      fail("GRAFANA_PLUGIN_PIN_INVALID");
    const archive = join(temporary, `${name}.zip`);
    const url = `https://github.com/grafana/grafana-${name}-datasource/releases/download/v${pin.version}/${name}-${pin.version}.linux_amd64.zip`;
    await run("curl", [
      "--fail",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-filesize",
      "33554432",
      "--output",
      archive,
      url,
    ]);
    if ((await hashRegularFile(archive, 33554432)) !== pin.zipSha256)
      fail("GRAFANA_PLUGIN_ZIP_MISMATCH");
    const names = (
      await run("unzip", ["-Z1", archive], {
        capture: true,
        maxCaptureBytes: 2 * 1024 * 1024,
      })
    )
      .split("\n")
      .filter(Boolean);
    const detail = (
      await run("zipinfo", ["-l", archive], {
        capture: true,
        maxCaptureBytes: 2 * 1024 * 1024,
      })
    ).split("\n");
    const entries = detail.filter((line) =>
      /^[bcdlps-][rwxstST-]{9}\s/u.test(line),
    );
    const sizes = entries.map((line) => Number(line.trim().split(/\s+/u)[3]));
    if (
      !names.length ||
      new Set(names).size !== names.length ||
      entries.length !== names.length ||
      names.some(
        (entry) =>
          !new RegExp(`^${name}/[A-Za-z0-9._/-]*$`, "u").test(entry) ||
          entry
            .split("/")
            .some((segment) => segment === ".." || segment === "."),
      ) ||
      entries.some((line) => !["-", "d"].includes(line[0])) ||
      sizes.some((size) => !Number.isSafeInteger(size) || size < 0) ||
      sizes.reduce((sum, size) => sum + size, 0) > 128 * 1024 * 1024
    )
      fail("GRAFANA_PLUGIN_ZIP_INVALID");
    await run("unzip", ["-q", archive, "-d", root]);
    const pluginRoot = join(root, name);
    const signedPath = join(pluginRoot, "MANIFEST.txt");
    const signed = await readRegular(signedPath);
    if (sha256(signed) !== pin.manifestSha256)
      fail("GRAFANA_PLUGIN_MANIFEST_MISMATCH");
    const statusPath = join(temporary, `${name}-gpg.status`);
    const plainPath = join(temporary, `${name}-manifest.json`);
    await run("gpg", [
      ...gpg,
      "--status-file",
      statusPath,
      "--output",
      plainPath,
      "--decrypt",
      signedPath,
    ]);
    const status = (await readRegular(statusPath)).toString("utf8");
    if (
      !status
        .split("\n")
        .some((line) =>
          line.startsWith(
            `[GNUPG:] VALIDSIG ${toolchain.grafanaSigningKeyFingerprint} `,
          ),
        )
    )
      fail("GRAFANA_PLUGIN_SIGNATURE_INVALID");
    const manifest = parseJson(
      await readRegular(plainPath),
      "GRAFANA_PLUGIN_MANIFEST_INVALID",
    );
    if (
      manifest.plugin !== name ||
      manifest.version !== pin.version ||
      manifest.signatureType !== "grafana" ||
      manifest.signedByOrg !== "grafana" ||
      !manifest.files ||
      typeof manifest.files !== "object" ||
      Array.isArray(manifest.files)
    )
      fail("GRAFANA_PLUGIN_MANIFEST_INVALID");
    const files = names
      .filter(
        (entry) => !entry.endsWith("/") && entry !== `${name}/MANIFEST.txt`,
      )
      .map((entry) => entry.slice(name.length + 1));
    if (
      files.length !== Object.keys(manifest.files).length ||
      files.some((file) => !Object.hasOwn(manifest.files, file))
    )
      fail("GRAFANA_PLUGIN_FILE_SET_MISMATCH");
    for (const file of files)
      if (
        (await hashRegularFile(join(pluginRoot, file), 64 * 1024 * 1024)) !==
        manifest.files[file]
      )
        fail("GRAFANA_PLUGIN_FILE_HASH_MISMATCH");
    const binaryPath = `gpx_grafana-${name}-datasource_linux_amd64`;
    if (
      (await hashRegularFile(
        join(pluginRoot, binaryPath),
        64 * 1024 * 1024,
      )) !== pin.binarySha256
    )
      fail("GRAFANA_PLUGIN_BINARY_MISMATCH");
    await writeScannerOutput(
      join(outputRoot, `grafana-${name}-manifest.txt`),
      signed,
    );
    bindings[name] = { ...pin };
  }
  const tree = await hashDirectoryTree(root);
  return {
    path: root,
    treeSha256: tree.sha256,
    treeBytes: tree.bytes,
    binding: {
      treeSha256: tree.sha256,
      treeBytes: tree.bytes,
      signingKeySourceSha256: toolchain.grafanaSigningKeySourceSha256,
      signingKeyFingerprint: toolchain.grafanaSigningKeyFingerprint,
      plugins: bindings,
    },
  };
}

async function createManifestInput(root, target) {
  for (const path of await collectManifestFiles(root)) {
    const bytes = await readRegular(join(root, path), 8 * 1024 * 1024);
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
  }
}

export async function createBuildInputSnapshot({
  candidateRoot,
  candidateSha,
  temporary,
  run = runCommand,
  onChild = () => {},
}) {
  const archivePath = join(temporary, "candidate-source.tar");
  const contextPath = join(temporary, "candidate-source");
  const archiveHandle = await open(
    archivePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const child = spawn(
    "git",
    ["-c", "tar.umask=0022", "archive", "--format=tar", candidateSha],
    {
      cwd: candidateRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  onChild(child);
  const hasher = createHash("sha256");
  let size = 0;
  let exceeded = false;
  let timedOut = false;
  let forceTimer;
  const close = new Promise((resolveClose) => {
    child.once("error", (error) => resolveClose({ error }));
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forceTimer.unref?.();
  }, 120_000);
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > MAX_BUILD_CONTEXT_BYTES) {
        exceeded = true;
        child.kill("SIGTERM");
        continue;
      }
      if (exceeded) continue;
      hasher.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = await archiveHandle.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        offset += written.bytesWritten;
      }
    }
    const exit = await close;
    if (timedOut) fail("COMMAND_TIMEOUT");
    if (exit.error) fail("GIT_ARCHIVE_FAILED");
    if (exceeded) fail("BUILD_CONTEXT_TOO_LARGE");
    if (exit.code !== 0) fail("GIT_ARCHIVE_FAILED");
    await archiveHandle.sync();
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        close,
        new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await close;
      }
    }
    await archiveHandle.close();
  }
  await mkdir(contextPath, { mode: 0o700 });
  await run("tar", ["-xpf", archivePath, "-C", contextPath], {
    timeoutMs: 120_000,
    onChild,
  });
  const sourceTreeSha = await git(
    candidateRoot,
    "rev-parse",
    `${candidateSha}^{tree}`,
  );
  if (sourceTreeSha.length !== 40) fail("CANDIDATE_TREE_MISMATCH");
  const extractedTree = await hashDirectoryTree(contextPath);
  return Object.freeze({
    archivePath,
    contextPath,
    archiveSha256: hasher.digest("hex"),
    sourceTreeSha,
    extractedTreeSha256: extractedTree.sha256,
    extractedBytes: extractedTree.bytes,
    size,
  });
}

export async function verifyBuildInputSnapshot(sourceSnapshot) {
  const tree = await hashDirectoryTree(sourceSnapshot.contextPath);
  if (
    tree.sha256 !== sourceSnapshot.extractedTreeSha256 ||
    tree.bytes !== sourceSnapshot.extractedBytes ||
    (await hashRegularFile(
      sourceSnapshot.archivePath,
      MAX_BUILD_CONTEXT_BYTES,
    )) !== sourceSnapshot.archiveSha256
  )
    fail("BUILD_CONTEXT_CHANGED");
}

async function hashRegularFile(path, maxBytes) {
  return (await inspectRegularFile(path, maxBytes)).sha256;
}

async function inspectRegularFile(path, maxBytes) {
  const info = await lstat(path).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size > maxBytes ||
    (await realpath(path).catch(() => null)) !== path
  )
    fail("INPUT_FILE_INVALID");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) fail("INPUT_FILE_INVALID");
  const hasher = createHash("sha256");
  let size = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) fail("INPUT_FILE_INVALID");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 1024 * 1024,
    })) {
      size += chunk.length;
      if (size > maxBytes) fail("INPUT_FILE_INVALID");
      hasher.update(chunk);
    }
    return Object.freeze({ sha256: hasher.digest("hex"), bytes: size });
  } finally {
    await handle.close();
  }
}

async function hashDirectoryTree(root) {
  const hasher = createHash("sha256");
  let bytes = 0;
  async function visit(directory, parent = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        hasher.update(`l\0${relativePath}\0${target}\0`);
      } else if (info.isDirectory()) {
        hasher.update(`d\0${relativePath}\0${info.mode & 0o777}\0`);
        await visit(path, relativePath);
      } else if (info.isFile()) {
        bytes += info.size;
        if (bytes > MAX_BUILD_CONTEXT_BYTES) fail("BUILD_CONTEXT_TOO_LARGE");
        const digest = await hashRegularFile(path, MAX_BUILD_CONTEXT_BYTES);
        hasher.update(
          `f\0${relativePath}\0${info.mode & 0o777}\0${info.size}\0${digest}\0`,
        );
      } else fail("BUILD_CONTEXT_FILE_TYPE_INVALID");
    }
  }
  await visit(root);
  return Object.freeze({ sha256: hasher.digest("hex"), bytes });
}

function mount(host, container, readonly = false) {
  return `type=bind,src=${host},dst=${container}${readonly ? ",readonly" : ""}`;
}
export function trivyArgs({
  network,
  cacheDir,
  outputDir,
  scannerImage,
  command,
  inputDir,
  imageTar,
  reportInput,
  reportName,
}) {
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--cpus=2",
    "--memory=2048m",
    "--memory-swap=2048m",
    "--pids-limit=128",
    "--read-only",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m",
    "--network",
    network,
    "--mount",
    mount(cacheDir, "/cache"),
    ...(!["fs", "image"].includes(command[0])
      ? []
      : [
          "--mount",
          mount(join(cacheDir, "db"), "/cache/db", true),
          "--mount",
          mount(join(cacheDir, "java-db"), "/cache/java-db", true),
        ]),
    "--mount",
    mount(outputDir, "/out"),
    ...(imageTar ? ["--env", "TMPDIR=/cache"] : []),
    ...(inputDir ? ["--mount", mount(inputDir, "/input", true)] : []),
    ...(reportInput
      ? ["--mount", mount(reportInput, "/scan/report.json", true)]
      : []),
    ...(imageTar
      ? [
          "--mount",
          mount(
            imageTar.path,
            imageTar.layout ? "/scan/image" : "/scan/image.tar",
            true,
          ),
        ]
      : []),
    scannerImage,
    "--cache-dir",
    "/cache",
    ...(command[0] === "convert"
      ? []
      : ["--disable-telemetry", "--no-progress", "--parallel", "1"]),
    ...command,
  ];
  if (reportName) args.push("--output", `/out/${reportName}`);
  return args;
}

export function trivyScanCommand(
  inputType,
  format,
  imageInput = "/scan/image.tar",
) {
  if (
    !new Set(["fs", "image"]).has(inputType) ||
    !new Set(["cyclonedx", "json"]).has(format)
  )
    fail("SCAN_TARGET_INVALID");
  return [
    inputType,
    "--scanners",
    "vuln",
    "--skip-db-update",
    "--skip-java-db-update",
    "--offline-scan",
    ...(inputType === "fs" ? ["--include-dev-deps"] : []),
    "--list-all-pkgs",
    "--format",
    format,
    ...(inputType === "image" ? ["--input", imageInput] : ["/input"]),
  ];
}

function packageInventory(report) {
  if (!Array.isArray(report?.Results)) fail("VULNERABILITY_REPORT_INVALID");
  const packages = [];
  for (const result of report.Results) {
    if (result?.Packages !== undefined && !Array.isArray(result.Packages))
      fail("VULNERABILITY_REPORT_INVALID");
    for (const pkg of result.Packages ?? []) {
      if (
        typeof pkg?.Name !== "string" ||
        pkg.Name.length === 0 ||
        (pkg.Version !== undefined && typeof pkg.Version !== "string")
      )
        fail("VULNERABILITY_REPORT_INVALID");
      const purl = pkg.Identifier?.PURL;
      packages.push(
        typeof purl === "string" && purl.length > 0
          ? `purl:${purl}`
          : `name:${pkg.Name}\0version:${pkg.Version ?? ""}`,
      );
    }
  }
  return new Set(packages);
}

export function assertSbomPackageInventory(report, expected, imageId) {
  if (report?.bomFormat !== "CycloneDX" || !Array.isArray(report.components))
    fail("SBOM_INVALID");
  const components = new Set(
    report.components.flatMap((component) => {
      if (component?.type !== "library") return [];
      if (
        typeof component?.name !== "string" ||
        (component.version !== undefined &&
          typeof component.version !== "string")
      )
        return [];
      return [
        typeof component.purl === "string" && component.purl.length > 0
          ? `purl:${component.purl}`
          : `name:${component.name}\0version:${component.version ?? ""}`,
      ];
    }),
  );
  if (
    components.size !== expected.size ||
    [...expected].some((pkg) => !components.has(pkg))
  )
    fail("SBOM_PACKAGE_INVENTORY_MISMATCH");
  if (imageId !== undefined) {
    const properties = report.metadata?.component?.properties;
    if (!Array.isArray(properties)) fail("SBOM_IMAGE_ID_MISMATCH");
    const imageProperties = properties.filter(
      (property) => property?.name === "aquasecurity:trivy:ImageID",
    );
    if (imageProperties.length !== 1 || imageProperties[0]?.value !== imageId)
      fail("SBOM_IMAGE_ID_MISMATCH");
  }
}

function trivyConvertCommand(outputName) {
  if (
    typeof outputName !== "string" ||
    !/^[a-z0-9-]+\.sbom\.cdx\.json$/u.test(outputName)
  )
    fail("SCAN_TARGET_INVALID");
  return [
    "convert",
    "--format",
    "cyclonedx",
    "--output",
    `/out/${outputName}`,
    "/scan/report.json",
  ];
}

const SCANNER_STDERR_CLASSES = Object.freeze([
  "AUTHENTICATION_FAILURE",
  "DNS_FAILURE",
  "DISK_FULL",
  "EMPTY",
  "HTTP_FAILURE",
  "NETWORK_TIMEOUT",
  "NETWORK_UNREACHABLE",
  "RATE_LIMITED",
  "REGISTRY_NOT_FOUND",
  "TLS_FAILURE",
  "UNCLASSIFIED",
]);

function classifyCommandStderr(stderr) {
  const text = stderr.toLowerCase();
  if (!text.trim()) return "EMPTY";
  if (/no space left on device|enospc/u.test(text)) return "DISK_FULL";
  if (/\b429\b|too many requests|rate.?limit/u.test(text))
    return "RATE_LIMITED";
  if (
    /\b401\b|\b403\b|unauthorized|authentication required|access denied/u.test(
      text,
    )
  )
    return "AUTHENTICATION_FAILURE";
  if (/x509|tls|certificate|handshake/u.test(text)) return "TLS_FAILURE";
  if (
    /no such host|temporary failure in name resolution|could not resolve|lookup .* failed|dns/u.test(
      text,
    )
  )
    return "DNS_FAILURE";
  if (
    /i\/o timeout|context deadline exceeded|connection timed out|operation timed out/u.test(
      text,
    )
  )
    return "NETWORK_TIMEOUT";
  if (/connection refused|network is unreachable|no route to host/u.test(text))
    return "NETWORK_UNREACHABLE";
  if (/manifest unknown|not found/u.test(text)) return "REGISTRY_NOT_FOUND";
  if (
    /protocol[_ ]error|unexpected status code|http status|server returned/u.test(
      text,
    )
  )
    return "HTTP_FAILURE";
  return "UNCLASSIFIED";
}

function safeSignal(signal) {
  return [
    "SIGABRT",
    "SIGBUS",
    "SIGINT",
    "SIGKILL",
    "SIGQUIT",
    "SIGSEGV",
    "SIGTERM",
  ].includes(signal)
    ? signal
    : null;
}

function scannerDatabaseSubstage(args) {
  if (args.includes("--download-db-only")) return "vulnerability-db";
  if (args.includes("--download-java-db-only")) return "java-db";
  return null;
}

function attachDatabaseSubstage(error, args) {
  const substage = scannerDatabaseSubstage(args);
  if (!substage || !(error instanceof Error)) return;
  const diagnostic = error.safeDiagnostic;
  const safeDiagnostic = {
    substage,
    exitCode:
      Number.isInteger(diagnostic?.exitCode) &&
      diagnostic.exitCode >= 0 &&
      diagnostic.exitCode <= 255
        ? diagnostic.exitCode
        : null,
    signal: safeSignal(diagnostic?.signal),
    stderrClass: SCANNER_STDERR_CLASSES.includes(diagnostic?.stderrClass)
      ? diagnostic.stderrClass
      : "UNCLASSIFIED",
  };
  try {
    error.safeDiagnostic = safeDiagnostic;
  } catch {}
}

function databaseFailureDiagnostic(error, stage) {
  if (stage !== "vulnerability-database") return null;
  const diagnostic = error?.safeDiagnostic;
  if (
    !diagnostic ||
    !["vulnerability-db", "java-db"].includes(diagnostic.substage) ||
    !SCANNER_STDERR_CLASSES.includes(diagnostic.stderrClass)
  )
    return null;
  return {
    substage: diagnostic.substage,
    exitCode:
      Number.isInteger(diagnostic.exitCode) &&
      diagnostic.exitCode >= 0 &&
      diagnostic.exitCode <= 255
        ? diagnostic.exitCode
        : null,
    signal: safeSignal(diagnostic.signal),
    stderrClass: diagnostic.stderrClass,
  };
}

function scanFailureDiagnostic(error, stage) {
  if (stage !== "manifest-scan" && stage !== "image-scan") return null;
  const target = error?.scanTarget;
  if (
    !target ||
    !(
      target.name === "lockfile" ||
      target.name === "edge-nginx" ||
      RUNTIME_NAMES.includes(target.name)
    ) ||
    !["cyclonedx", "json"].includes(target.format)
  )
    return null;
  const diagnostic = error?.safeDiagnostic;
  if (!diagnostic) return null;
  return {
    target: target.name,
    format: target.format,
    exitCode:
      Number.isInteger(diagnostic.exitCode) &&
      diagnostic.exitCode >= 0 &&
      diagnostic.exitCode <= 255
        ? diagnostic.exitCode
        : null,
    signal: safeSignal(diagnostic.signal),
    stderrClass: SCANNER_STDERR_CLASSES.includes(diagnostic.stderrClass)
      ? diagnostic.stderrClass
      : "UNCLASSIFIED",
    stderrSha256: /^[0-9a-f]{64}$/u.test(diagnostic.stderrSha256 ?? "")
      ? diagnostic.stderrSha256
      : null,
    stderrBytes:
      Number.isSafeInteger(diagnostic.stderrBytes) &&
      diagnostic.stderrBytes >= 0 &&
      diagnostic.stderrBytes <= 8192
        ? diagnostic.stderrBytes
        : null,
    stderrTruncated:
      typeof diagnostic.stderrTruncated === "boolean"
        ? diagnostic.stderrTruncated
        : null,
  };
}

export async function runCommand(
  command,
  args,
  {
    capture = false,
    trimCapture = true,
    maxCaptureBytes = 8192,
    timeoutMs = 10 * 60_000,
    killGraceMs = 1_000,
    onChild = () => {},
    dockerConfig,
    cwd,
    env,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
      env: env ?? {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/nonexistent",
        DOCKER_CONFIG: dockerConfig,
        DOCKER_HOST: "unix:///var/run/docker.sock",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    onChild(child);
    let stdout = "";
    let stderr = Buffer.alloc(0);
    let stderrTruncated = false;
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxCaptureBytes - stderr.length);
      if (remaining > 0)
        stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
      if (bytes.length > remaining) stderrTruncated = true;
    });
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > maxCaptureBytes) child.kill("SIGKILL");
      });
    }
    let settled = false;
    let timedOut = false;
    let forceTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      forceTimer.unref?.();
    }, timeoutMs);
    child.once("error", (error) =>
      finish(
        Object.assign(new Error("COMMAND_START_FAILED"), { cause: error }),
      ),
    );
    child.once("close", (code, signal) => {
      if (timedOut)
        return finish(
          Object.assign(new Error("COMMAND_TIMEOUT"), {
            code: "COMMAND_TIMEOUT",
          }),
        );
      if (code === 0) return finish(null, trimCapture ? stdout.trim() : stdout);
      const stderrText = stderr.toString("utf8");
      const missingImage = isMissingImageInspection(command, args, stderrText);
      const error = Object.assign(
        new Error(missingImage ? "IMAGE_NOT_FOUND" : "COMMAND_FAILED"),
        {
          code: missingImage ? "IMAGE_NOT_FOUND" : "COMMAND_FAILED",
          safeDiagnostic: {
            exitCode:
              Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
            signal: safeSignal(signal),
            stderrClass: classifyCommandStderr(stderrText),
            stderrSha256: sha256(stderr),
            stderrBytes: stderr.length,
            stderrTruncated,
          },
        },
      );
      finish(error);
    });
  });
}

function isMissingImageInspection(command, args, stderr) {
  if (
    command !== "docker" ||
    args[0] !== "image" ||
    args[1] !== "inspect" ||
    !args.includes("{{.Id}}")
  )
    return false;
  const reference = args.at(-1);
  if (typeof reference !== "string" || !reference) return false;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^(?:Error response from daemon: )?No such image: ${escaped}$|^Error: No such object: ${escaped}$`,
    "u",
  ).test(stderr.trim());
}

async function inspectImageId(run, reference, options = {}) {
  try {
    const imageId = await run(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", reference],
      { capture: true, ...options },
    );
    if (typeof imageId !== "string" || !imageId) fail("IMAGE_ID_INVALID");
    return imageId;
  } catch (error) {
    if (error?.code === "IMAGE_NOT_FOUND") return null;
    throw error;
  }
}

async function listDockerContainers(run, filter) {
  let output;
  try {
    output = await run(
      "docker",
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        filter,
        "--format",
        "{{.ID}}|{{.Names}}",
      ],
      { capture: true, maxCaptureBytes: 16 * 1024, timeoutMs: 30_000 },
    );
  } catch {
    fail("CONTAINER_STATE_UNVERIFIABLE");
  }
  if (!output) return [];
  const rows = output.split("\n").map((line) => {
    const [id, name, ...extra] = line.split("|");
    if (
      extra.length ||
      !/^[0-9a-f]{64}$/u.test(id ?? "") ||
      typeof name !== "string" ||
      !name
    )
      fail("CONTAINER_STATE_UNVERIFIABLE");
    return { id, name };
  });
  return rows;
}

async function inspectOwnedContainer(run, spec, id) {
  let output;
  try {
    output = await run(
      "docker",
      ["container", "inspect", "--format", CONTAINER_INSPECT_FORMAT, id],
      { capture: true, maxCaptureBytes: 4 * 1024, timeoutMs: 30_000 },
    );
  } catch {
    fail("CONTAINER_STATE_UNVERIFIABLE");
  }
  const [actualId, name, imageId, imageRef, owner, runId, nonce, ...extra] =
    output.split("|");
  if (
    extra.length ||
    actualId !== id ||
    name !== `/${spec.name}` ||
    !SHA256.test(imageId ?? "") ||
    imageId !== spec.imageId ||
    imageRef !== SCANNER_IMAGE ||
    owner !== "G12_SUPPLY_CHAIN" ||
    runId !== spec.runId ||
    nonce !== spec.nonce
  )
    fail("CONTAINER_OWNERSHIP_MISMATCH");
  return Object.freeze({ id: actualId });
}

async function containerIdFromCidfile(spec) {
  const info = await lstat(spec.cidfile).catch(() => null);
  if (!info) return null;
  const bytes = await readRegular(spec.cidfile, 128).catch(() =>
    fail("CONTAINER_STATE_UNVERIFIABLE"),
  );
  if (bytes.length === 0) return null;
  const value = bytes.toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/u.test(value)) fail("CONTAINER_STATE_UNVERIFIABLE");
  return value;
}

async function findOwnedContainer(run, spec) {
  const byName = await listDockerContainers(run, `name=${spec.name}`);
  const named = byName.filter((row) => row.name === spec.name);
  if (named.length > 1) fail("CONTAINER_OWNERSHIP_MISMATCH");
  const cidfileId = await containerIdFromCidfile(spec);
  if (named.length && cidfileId && named[0].id !== cidfileId)
    fail("CONTAINER_OWNERSHIP_MISMATCH");
  const candidateId = named[0]?.id ?? cidfileId;
  if (!candidateId) return null;
  const byId = await listDockerContainers(run, `id=${candidateId}`);
  const identified = byId.filter((row) => row.id === candidateId);
  if (identified.length === 0) {
    if (named.length) fail("CONTAINER_STATE_UNVERIFIABLE");
    return null;
  }
  if (
    identified.length !== 1 ||
    (named.length && identified[0].name !== spec.name)
  )
    fail("CONTAINER_OWNERSHIP_MISMATCH");
  return inspectOwnedContainer(run, spec, candidateId);
}

async function removeOwnedContainer(run, spec) {
  let owned = await findOwnedContainer(run, spec);
  if (!owned && spec.ambiguous) {
    const deadline = Date.now() + 5_000;
    while (!owned && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      owned = await findOwnedContainer(run, spec);
    }
  }
  if (!owned) {
    if (spec.ambiguous) fail("CONTAINER_CLEANUP_FAILED");
    return false;
  }
  try {
    await run("docker", ["container", "rm", "--force", owned.id], {
      timeoutMs: 30_000,
    });
  } catch {
    const afterFailure = await findOwnedContainer(run, spec);
    if (afterFailure) fail("CONTAINER_CLEANUP_FAILED");
    return true;
  }
  if (await findOwnedContainer(run, spec)) fail("CONTAINER_CLEANUP_FAILED");
  return true;
}

async function writeScannerOutput(path, bytes) {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function preserveProductArtifact({
  service,
  image,
  temporary,
  outputRoot,
  run,
}) {
  const imageArchivePath = join(outputRoot, `${service}.oci.tar`);
  const layoutTree = await hashDirectoryTree(image.imageLayoutPath);
  const archiveHandle = await open(
    imageArchivePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  await archiveHandle.close();
  await run("tar", ["-cf", imageArchivePath, "-C", image.imageLayoutPath, "."]);
  await chmod(imageArchivePath, 0o600);
  const archive = await inspectRegularFile(
    imageArchivePath,
    MAX_BUILD_CONTEXT_BYTES,
  );
  const verifyDir = join(temporary, `${service}-archive-check`);
  await mkdir(verifyDir, { mode: 0o700 });
  await run("tar", ["-xf", imageArchivePath, "-C", verifyDir]);
  const extracted = await hashDirectoryTree(verifyDir);
  if (
    extracted.sha256 !== layoutTree.sha256 ||
    extracted.bytes !== layoutTree.bytes
  )
    fail(`${service.toUpperCase().replaceAll("-", "_")}_ARCHIVE_MISMATCH`);
  return Object.freeze({
    imageArchivePath,
    imageArchiveSha256: archive.sha256,
    imageArchiveBytes: archive.bytes,
    layoutTreeSha256: layoutTree.sha256,
    layoutBytes: layoutTree.bytes,
  });
}

async function inspectBaseMaterial({ sourceRef, target, outputRoot, run }) {
  const raw = await run(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", sourceRef],
    {
      capture: true,
      trimCapture: false,
      maxCaptureBytes: MAX_KAFKA_INDEX_BYTES + 1,
    },
  );
  const bytes = Buffer.from(raw);
  const material = parseBaseIndex(sourceRef, bytes, target);
  await writeScannerOutput(
    join(outputRoot, `${target}-base-index.json`),
    bytes,
  );
  if (target !== "keycloak-runtime") return material;
  const reference = `${sourceRef.slice(0, sourceRef.lastIndexOf("@"))}@${material.platformManifestDigest}`;
  const manifestBytes = Buffer.from(
    await run(
      "docker",
      ["buildx", "imagetools", "inspect", "--raw", reference],
      {
        capture: true,
        trimCapture: false,
        maxCaptureBytes: MAX_KAFKA_INDEX_BYTES + 1,
      },
    ),
  );
  const manifest = parseJson(
    manifestBytes,
    "KEYCLOAK_RUNTIME_BASE_MANIFEST_INVALID",
  );
  const descriptor = parseJson(
    bytes,
    "KEYCLOAK_RUNTIME_BASE_INDEX_INVALID",
  ).manifests.find((item) => item.digest === material.platformManifestDigest);
  if (
    manifestBytes.length !== descriptor?.size ||
    `sha256:${sha256(manifestBytes)}` !== material.platformManifestDigest ||
    manifest?.schemaVersion !== 2 ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length < 1 ||
    manifest.layers.some((layer) => !SHA256.test(layer?.digest ?? ""))
  )
    fail("KEYCLOAK_RUNTIME_BASE_MANIFEST_INVALID");
  await writeScannerOutput(
    join(outputRoot, `${target}-base-manifest.json`),
    manifestBytes,
  );
  return {
    ...material,
    manifestArtifact: {
      path: `artifacts/${target}-base-manifest.json`,
      sha256: sha256(manifestBytes),
      sizeBytes: manifestBytes.length,
      layerCount: manifest.layers.length,
    },
  };
}

async function prepareBuildxRegistration(dockerConfig, run, config, versions) {
  const policy = buildkitPolicy(config, versions);
  const configPath = join(dockerConfig, "buildkitd.toml");
  await writeScannerOutput(configPath, policy.toml);
  await run("docker", [
    ...policy.createArguments(configPath),
    "unix:///var/run/docker.sock",
  ]).catch(() => fail("BUILD_BUILDER_REGISTRATION_FAILED"));
  // Buildx inspect включает public CA bundles; обычного лимита 8 КиБ недостаточно.
  await verifyBuildkitPolicy(policy, (args) =>
    run("docker", args, { capture: true, maxCaptureBytes: 1024 * 1024 }),
  ).catch(() => fail("BUILD_BUILDER_POLICY_INVALID"));
  await run("docker", ["network", "inspect", BUILD_NETWORK]).catch(() =>
    fail("BUILD_NETWORK_UNAVAILABLE"),
  );
}

async function readOciJson(layout, entry, maxBytes = MAX_ATTESTATION_BYTES) {
  const path = resolve(layout, entry);
  if (!within(layout, path)) fail("OCI_LAYOUT_INVALID");
  return readRegular(path, maxBytes).catch(() => fail("OCI_LAYOUT_INVALID"));
}

async function verifyOciContentBlob(layout, descriptor, code) {
  const digest = descriptor?.digest;
  const size = descriptor?.size;
  if (!SHA256.test(digest ?? "") || !Number.isSafeInteger(size) || size < 0)
    fail(code);
  const entry = `blobs/sha256/${digest.slice(7)}`;
  const path = resolve(layout, entry);
  if (!within(layout, path)) fail(code);
  const blob = await inspectRegularFile(path, MAX_BUILD_CONTEXT_BYTES).catch(
    () => fail(code),
  );
  if (blob.sha256 !== digest.slice(7) || blob.bytes !== size) fail(code);
  return entry;
}

async function writeDockerCompatibilityManifest({
  service,
  tag,
  runId,
  layout,
  archiveManifest,
}) {
  if (
    ![
      "kafka",
      "storage-helper",
      "grafana",
      "keycloak",
      "otel-collector",
    ].includes(service)
  )
    fail("OCI_DOCKER_MANIFEST_TARGET_INVALID");
  const runTag = sha256(Buffer.from(runId)).slice(0, 12);
  const expectedTag = `coffee-g12-${runTag}-${service}:latest`;
  if (tag !== expectedTag) fail("OCI_DOCKER_MANIFEST_TAG_INVALID");
  const manifestBytes = Buffer.from(
    `${JSON.stringify([
      {
        Config: archiveManifest?.Config,
        RepoTags: [tag],
        Layers: archiveManifest?.Layers,
      },
    ])}\n`,
  );
  const manifestPath = join(layout, "manifest.json");
  await writeScannerOutput(manifestPath, manifestBytes);
  const written = await readRegular(manifestPath, MAX_METADATA_BYTES);
  if (!written.equals(manifestBytes)) fail("OCI_DOCKER_MANIFEST_INVALID");
}

export async function verifyOciAttestation({
  service,
  layout,
  imageId = null,
  manifestDigest,
  candidateSha,
  baseMaterial = null,
  kafkaBaseMaterial = baseMaterial,
}) {
  const layoutInfo = await lstat(layout).catch(() => null);
  if (
    !layoutInfo?.isDirectory() ||
    layoutInfo.isSymbolicLink() ||
    (await realpath(layout).catch(() => null)) !== layout
  )
    fail("OCI_LAYOUT_INVALID");
  const index = parseJson(
    await readOciJson(layout, "index.json"),
    "OCI_INDEX_INVALID",
  );
  if (index?.schemaVersion !== 2 || !Array.isArray(index.manifests))
    fail("OCI_INDEX_INVALID");
  const imageDescriptors = index.manifests.filter(
    (item) => item?.digest === manifestDigest,
  );
  if (
    imageDescriptors.length !== 1 ||
    !SHA256.test(imageDescriptors[0]?.digest ?? "")
  )
    fail("OCI_IMAGE_MANIFEST_ABSENT");
  const rootBytes = await readOciJson(
    layout,
    `blobs/sha256/${manifestDigest.slice(7)}`,
  );
  if (
    `sha256:${sha256(rootBytes)}` !== manifestDigest ||
    rootBytes.length !== imageDescriptors[0].size
  )
    fail("OCI_IMAGE_MANIFEST_INVALID");
  const rootObject = parseJson(rootBytes, "OCI_IMAGE_MANIFEST_INVALID");
  const nested =
    rootObject?.mediaType === "application/vnd.oci.image.index.v1+json" ||
    Array.isArray(rootObject?.manifests);
  const imageIndex = nested ? rootObject : index;
  if (!Array.isArray(imageIndex.manifests)) fail("OCI_INDEX_INVALID");
  const platformImages = imageIndex.manifests.filter(
    (item) =>
      item?.annotations?.["vnd.docker.reference.type"] !==
        "attestation-manifest" &&
      item?.platform?.os === "linux" &&
      item?.platform?.architecture === "amd64" &&
      SHA256.test(item?.digest ?? ""),
  );
  const directManifest =
    !nested && rootObject?.schemaVersion === 2 && rootObject.config?.digest;
  if (
    (!directManifest && platformImages.length !== 1) ||
    (directManifest && platformImages.length !== 0)
  )
    fail("OCI_PLATFORM_IMAGE_AMBIGUOUS");
  const platformDescriptor = directManifest
    ? imageDescriptors[0]
    : platformImages[0];
  const platformDigest = platformDescriptor.digest;
  const imageManifestBytes = directManifest
    ? rootBytes
    : await readOciJson(layout, `blobs/sha256/${platformDigest.slice(7)}`);
  if (
    `sha256:${sha256(imageManifestBytes)}` !== platformDigest ||
    imageManifestBytes.length !== platformDescriptor.size
  )
    fail("OCI_IMAGE_MANIFEST_INVALID");
  const imageManifest = directManifest
    ? rootObject
    : parseJson(imageManifestBytes, "OCI_IMAGE_MANIFEST_INVALID");
  const actualImageId = imageManifest?.config?.digest;
  if (
    imageManifest?.schemaVersion !== 2 ||
    !SHA256.test(actualImageId ?? "") ||
    (imageId && imageId !== actualImageId)
  )
    fail("OCI_IMAGE_CONFIG_MISMATCH");
  const configPath = await verifyOciContentBlob(
    layout,
    imageManifest.config,
    "OCI_IMAGE_CONFIG_BLOB_INVALID",
  );
  if (!Array.isArray(imageManifest.layers)) fail("OCI_IMAGE_MANIFEST_INVALID");
  const layerPaths = [];
  for (const layer of imageManifest.layers)
    layerPaths.push(
      await verifyOciContentBlob(layout, layer, "OCI_IMAGE_LAYER_BLOB_INVALID"),
    );
  const descriptors = imageIndex.manifests.filter(
    (item) =>
      item?.annotations?.["vnd.docker.reference.type"] ===
        "attestation-manifest" &&
      item.annotations["vnd.docker.reference.digest"] === platformDigest,
  );
  if (descriptors.length !== 1 || !SHA256.test(descriptors[0]?.digest ?? ""))
    fail("PROVENANCE_ATTESTATION_ABSENT");
  const descriptorDigest = descriptors[0].digest;
  const descriptorBytes = await readOciJson(
    layout,
    `blobs/sha256/${descriptorDigest.slice(7)}`,
  );
  if (
    `sha256:${sha256(descriptorBytes)}` !== descriptorDigest ||
    descriptorBytes.length !== descriptors[0].size
  )
    fail("OCI_ATTESTATION_MANIFEST_INVALID");
  const attestationManifest = parseJson(
    descriptorBytes,
    "OCI_ATTESTATION_MANIFEST_INVALID",
  );
  if (!Array.isArray(attestationManifest.layers))
    fail("OCI_ATTESTATION_MANIFEST_INVALID");
  const layers = attestationManifest.layers.filter(
    (layer) =>
      layer?.mediaType === "application/vnd.in-toto+json" &&
      new Set([
        "https://slsa.dev/provenance/v0.2",
        "https://slsa.dev/provenance/v1",
      ]).has(layer.annotations?.["in-toto.io/predicate-type"]),
  );
  if (layers.length !== 1 || !SHA256.test(layers[0]?.digest ?? ""))
    fail("PROVENANCE_ATTESTATION_ABSENT");
  const layerDigest = layers[0].digest;
  const statementBytes = await readOciJson(
    layout,
    `blobs/sha256/${layerDigest.slice(7)}`,
  );
  if (
    `sha256:${sha256(statementBytes)}` !== layerDigest ||
    statementBytes.length !== layers[0].size
  )
    fail("OCI_ATTESTATION_BLOB_INVALID");
  const statement = parseJson(statementBytes, "OCI_ATTESTATION_BLOB_INVALID");
  const record = verifySlsaStatement(
    service,
    statement,
    platformDigest,
    candidateSha,
    kafkaBaseMaterial,
  );
  return Object.freeze({
    ...record,
    imageId: actualImageId,
    platformManifestDigest: platformDigest,
    attestationSha256: sha256(statementBytes),
    dockerArchiveManifest: Object.freeze({
      Config: configPath,
      Layers: Object.freeze(layerPaths),
    }),
  });
}

export async function verifyGrafanaImageFiles({
  image,
  toolchain,
  temporary,
  run,
}) {
  const config = parseJson(
    await readOciJson(
      image.imageLayoutPath,
      image.dockerArchiveManifest.Config,
    ),
    "GRAFANA_IMAGE_CONFIG_INVALID",
  );
  if (
    !Array.isArray(config?.config?.Env) ||
    config.config.Env.filter((value) =>
      value.startsWith("GF_PATHS_PLUGINS="),
    ).join("\0") !== "GF_PATHS_PLUGINS=/opt/grafana/plugins"
  )
    fail("GRAFANA_IMAGE_CONFIG_INVALID");
  const targets = Object.fromEntries(
    ["loki", "tempo", "prometheus"].map((name) => [
      name,
      `opt/grafana/plugins/${name}/gpx_grafana-${name}-datasource_linux_amd64`,
    ]),
  );
  const matches = Object.fromEntries(
    Object.keys(targets).map((name) => [name, []]),
  );
  const directories = new Set();
  const whiteouts = new Set([".wh..wh..opq"]);
  for (const target of Object.values(targets)) {
    const parts = target.split("/");
    for (let i = 0; i < parts.length; i++) {
      whiteouts.add([...parts.slice(0, i), `.wh.${parts[i]}`].join("/"));
      if (i < parts.length - 1) {
        const directory = parts.slice(0, i + 1).join("/");
        directories.add(directory);
        whiteouts.add(`${directory}/.wh..wh..opq`);
      }
    }
  }
  const protectedPaths = [
    ...directories,
    ...whiteouts,
    ...Object.values(targets),
  ];
  // Inspect types in every layer: textual tar listings omit links and file types.
  const inspectTar = `import json,sys,tarfile
wanted=set(json.loads(sys.argv[2]))
rows=[]
with tarfile.open(sys.argv[1], mode="r|*") as archive:
 for member in archive:
  name=member.name
  if name.startswith("/") or ".." in name.split("/"): raise ValueError("unsafe layer path")
  name="/".join(part for part in name.split("/") if part not in ("", "."))
  if name in wanted: rows.append([name, member.name, "directory" if member.isdir() else "file" if member.isfile() else "other"])
print(json.dumps(rows))`;
  for (const layer of image.dockerArchiveManifest.Layers) {
    const archive = join(image.imageLayoutPath, layer);
    const entries = parseJson(
      Buffer.from(
        await run(
          "python3",
          ["-c", inspectTar, archive, JSON.stringify(protectedPaths)],
          { capture: true, maxCaptureBytes: MAX_GIT_OUTPUT_BYTES },
        ),
      ),
      "GRAFANA_IMAGE_LAYER_INVALID",
    );
    if (!Array.isArray(entries)) fail("GRAFANA_IMAGE_LAYER_INVALID");
    for (const [entry, original, type] of entries) {
      if (whiteouts.has(entry)) fail("GRAFANA_IMAGE_WHITEOUT_INVALID");
      if (directories.has(entry) && type !== "directory")
        fail("GRAFANA_IMAGE_ANCESTOR_INVALID");
      for (const [name, target] of Object.entries(targets)) {
        if (entry === target) {
          if (type !== "file") fail("GRAFANA_IMAGE_BINARY_INVALID");
          matches[name].push({ layer, original });
        }
      }
    }
  }
  const proofRoot = join(temporary, "grafana-image-files");
  await mkdir(proofRoot, { mode: 0o700 });
  const files = {};
  for (const [name, target] of Object.entries(targets)) {
    if (matches[name].length !== 1)
      fail("GRAFANA_IMAGE_BINARY_ABSENT_OR_AMBIGUOUS");
    const { layer, original } = matches[name][0];
    await run("tar", [
      "-xf",
      join(image.imageLayoutPath, layer),
      "-C",
      proofRoot,
      original,
    ]);
    const observed = await inspectRegularFile(
      join(proofRoot, target),
      64 * 1024 * 1024,
    );
    if (observed.sha256 !== toolchain.grafanaPlugins[name].binarySha256)
      fail("GRAFANA_IMAGE_BINARY_MISMATCH");
    files[name] = {
      path: `/${target}`,
      sha256: observed.sha256,
      sizeBytes: observed.bytes,
      layerDigest: `sha256:${layer.split("/").at(-1)}`,
    };
  }
  await rm(proofRoot, { recursive: true, force: true });
  return files;
}

export async function verifyKeycloakImageFiles({ image, toolchain, run }) {
  const imageConfig = parseJson(
    await readOciJson(
      image.imageLayoutPath,
      image.dockerArchiveManifest.Config,
    ),
    "KEYCLOAK_IMAGE_CONFIG_INVALID",
  );
  const config = imageConfig?.config;
  if (
    config?.User !== "1000:1000" ||
    config.WorkingDir !== "/opt/keycloak" ||
    !isDeepStrictEqual(config.Entrypoint, ["/opt/keycloak/bin/kc.sh"]) ||
    !isDeepStrictEqual(config.Cmd, ["start", "--optimized"]) ||
    !Array.isArray(config.Env) ||
    config.Env.filter((value) => value.startsWith("JAVA_HOME=")).join("\0") !==
      "JAVA_HOME=/opt/java/openjdk"
  )
    fail("KEYCLOAK_IMAGE_CONFIG_INVALID");
  const layers = image.dockerArchiveManifest.Layers;
  const baseLayers = image.baseMaterial.runtime.manifestArtifact.layerCount;
  if (
    !Number.isSafeInteger(baseLayers) ||
    baseLayers < 1 ||
    layers.length <= baseLayers
  )
    fail("KEYCLOAK_IMAGE_BASE_LAYERS_INVALID");
  const targets = {
    guava: [
      "opt/keycloak/lib/lib/main/com.google.guava.guava-33.7.2-jre.jar",
      toolchain.keycloakGuavaSha256,
    ],
    javaRelease: [
      "opt/java/openjdk/release",
      toolchain.keycloakJavaReleaseSha256,
    ],
    javaCacerts: [
      "opt/java/openjdk/lib/security/cacerts",
      toolchain.keycloakJavaCacertsSha256,
    ],
    javaSecurity: [
      "opt/java/openjdk/conf/security/java.security",
      toolchain.keycloakJavaSecuritySha256,
    ],
  };
  const inspectTar = `import hashlib,json,sys,tarfile
layer,targets,base=sys.argv[1],json.loads(sys.argv[2]),sys.argv[3]=="1"
ancestors=set()
for target in targets.values():
 parts=target.split("/")
 for i in range(1,len(parts)): ancestors.add("/".join(parts[:i]))
seen=[]
with tarfile.open(layer, mode="r|*") as archive:
 for member in archive:
  name=member.name
  if name.startswith("/") or ".." in name.split("/"): raise ValueError("unsafe layer path")
  name="/".join(part for part in name.split("/") if part not in ("", "."))
  if not name: continue
  parts=name.split("/")
  if any(part.startswith(".wh.") for part in parts) and (name.startswith("opt/") or name.startswith(".wh.")): raise ValueError("whiteout")
  if name in ancestors and not member.isdir(): raise ValueError("ancestor")
  if not base and (name=="opt/java/openjdk" or name.startswith("opt/java/openjdk/")): raise ValueError("runtime overwritten")
  for key,target in targets.items():
   if name==target:
    if not member.isfile() or member.size>67108864: raise ValueError("file")
    data=archive.extractfile(member)
    digest=hashlib.sha256()
    for chunk in iter(lambda:data.read(1048576),b""): digest.update(chunk)
    seen.append([key,digest.hexdigest(),member.size])
print(json.dumps(seen))`;
  const files = {};
  for (let index = 0; index < layers.length; index++) {
    const rows = parseJson(
      Buffer.from(
        await run(
          "python3",
          [
            "-c",
            inspectTar,
            join(image.imageLayoutPath, layers[index]),
            JSON.stringify(
              Object.fromEntries(
                Object.entries(targets).map(([name, [path]]) => [name, path]),
              ),
            ),
            index < baseLayers ? "1" : "0",
          ],
          { capture: true, maxCaptureBytes: MAX_GIT_OUTPUT_BYTES },
        ),
      ),
      "KEYCLOAK_IMAGE_LAYER_INVALID",
    );
    if (!Array.isArray(rows)) fail("KEYCLOAK_IMAGE_LAYER_INVALID");
    for (const [name, digest, sizeBytes] of rows) {
      if (
        !Object.hasOwn(targets, name) ||
        files[name] ||
        digest !== targets[name][1] ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        (name !== "guava" && index >= baseLayers) ||
        (name === "guava" && index < baseLayers)
      )
        fail("KEYCLOAK_IMAGE_FILE_INVALID");
      files[name] = {
        path: `/${targets[name][0]}`,
        sha256: digest,
        sizeBytes,
        layerDigest: `sha256:${layers[index].split("/").at(-1)}`,
      };
    }
  }
  if (
    !files.guava ||
    !files.javaRelease ||
    !files.javaCacerts ||
    !files.javaSecurity
  )
    fail("KEYCLOAK_IMAGE_FILE_INVALID");
  return files;
}

function imageBuildArgs({
  tag,
  metadataFile,
  ociArchive,
  runtime,
  service,
  kafkaImage,
  nodeImage,
  grafanaImage,
  otelCollectorImage,
  keycloakDistributionImage,
  keycloakRuntimeImage,
  libexpatVersion,
  muslVersion,
  pluginContext,
}) {
  return [
    "buildx",
    "build",
    "--builder",
    "coffee-platform-mtu",
    "--allow",
    "network.host",
    ...(!["keycloak", "grafana", "otel-collector", "edge-nginx"].includes(
      service,
    )
      ? ["--build-arg", `MUSL_VERSION=${muslVersion}`]
      : []),
    ...(["kafka", "keycloak"].includes(service)
      ? ["--build-arg", `LIBEXPAT_VERSION=${libexpatVersion}`]
      : []),
    ...(service === "keycloak"
      ? [
          "--build-arg",
          `KEYCLOAK_DISTRIBUTION_IMAGE=${keycloakDistributionImage}`,
          "--build-arg",
          `KEYCLOAK_RUNTIME_IMAGE=${keycloakRuntimeImage}`,
          "--target",
          "keycloak",
        ]
      : service === "otel-collector"
        ? [
            "--build-arg",
            `OTEL_COLLECTOR_IMAGE=${otelCollectorImage}`,
            "--target",
            "otel-collector",
          ]
        : service === "grafana"
          ? [
              "--build-arg",
              `GRAFANA_IMAGE=${grafanaImage}`,
              "--build-context",
              `grafana-plugins=${pluginContext}`,
              "--target",
              "grafana",
            ]
          : service === "edge-nginx"
            ? ["--file", "apps/edge-nginx/Dockerfile", "--target", "edge-nginx"]
            : service === "kafka"
              ? [
                  "--build-arg",
                  `KAFKA_IMAGE=${kafkaImage}`,
                  "--target",
                  "kafka",
                ]
              : service === "storage-helper"
                ? [
                    "--build-arg",
                    `NODE_IMAGE=${nodeImage}`,
                    "--target",
                    "storage-helper",
                  ]
                : ["--build-arg", `RUNTIME=${runtime}`, "--target", "runtime"]),
    "--platform",
    "linux/amd64",
    "--metadata-file",
    metadataFile,
    "--provenance=mode=min",
    "--output",
    `type=oci,tar=false,dest=${ociArchive},source-date-epoch=0,rewrite-timestamp=true`,
    "-t",
    tag,
  ];
}

async function buildProductImages({
  identity,
  toolchain,
  sourceSnapshot,
  temporary,
  run,
  onChild,
  statfsFn,
  policy,
  outputRoot,
  onValidatedImage,
  kafkaBaseMaterial,
  storageHelperBaseMaterial,
  grafanaBaseMaterial,
  otelCollectorBaseMaterial,
  keycloakBaseMaterial,
  vendorPlugins,
}) {
  const services = [
    ...RUNTIME_NAMES.map((runtime) => ({ service: runtime, runtime })),
    { service: "grafana", runtime: null },
    { service: "otel-collector", runtime: null },
    { service: "keycloak", runtime: null },
    { service: "storage-helper", runtime: null },
    { service: "edge-nginx", runtime: null },
    { service: "kafka", runtime: null },
  ];
  for (const { service, runtime } of services) {
    await verifyCandidateFiles(identity);
    await freeSpace(temporary, policy, statfsFn);
    await freeSpace(outputRoot, policy, statfsFn);
    const runTag = sha256(Buffer.from(identity.context.runId)).slice(0, 12);
    const tag = `coffee-g12-${runTag}-${service}:latest`;
    const metadataPath = join(temporary, `${service}.metadata.json`);
    const imageLayoutPath = join(temporary, `${service}.oci`);
    const args = imageBuildArgs({
      tag,
      metadataFile: metadataPath,
      ociArchive: imageLayoutPath,
      runtime,
      service,
      kafkaImage: toolchain.kafkaImage,
      nodeImage: toolchain.nodeImage,
      grafanaImage: toolchain.grafanaImage,
      otelCollectorImage: toolchain.otelCollectorImage,
      keycloakDistributionImage: toolchain.keycloakDistributionImage,
      keycloakRuntimeImage: toolchain.keycloakRuntimeImage,
      libexpatVersion: toolchain.libexpatVersion,
      muslVersion: toolchain.muslVersion,
      pluginContext: vendorPlugins?.path,
    });
    const contextPath = sourceSnapshot.contextPath;
    args.push(contextPath);
    await verifyBuildInputSnapshot(sourceSnapshot);
    if (service === "grafana") {
      const before = await hashDirectoryTree(vendorPlugins.path);
      if (
        before.sha256 !== vendorPlugins.treeSha256 ||
        before.bytes !== vendorPlugins.treeBytes
      )
        fail("PLUGIN_CONTEXT_CHANGED");
    }
    await run("docker", args, { cwd: contextPath, onChild });
    if (service === "grafana") {
      const after = await hashDirectoryTree(vendorPlugins.path);
      if (
        after.sha256 !== vendorPlugins.treeSha256 ||
        after.bytes !== vendorPlugins.treeBytes
      )
        fail("PLUGIN_CONTEXT_CHANGED");
    }
    await verifyBuildInputSnapshot(sourceSnapshot);
    const metadataBytes = await readRegular(metadataPath);
    const metadata = parseJson(metadataBytes, "PROVENANCE_METADATA_INVALID");
    const record = verifyBuildxMetadata(
      service,
      metadata,
      identity.context.candidateSha,
    );
    const baseMaterial =
      service === "kafka"
        ? kafkaBaseMaterial
        : service === "storage-helper"
          ? storageHelperBaseMaterial
          : service === "grafana"
            ? grafanaBaseMaterial
            : service === "otel-collector"
              ? otelCollectorBaseMaterial
              : service === "keycloak"
                ? keycloakBaseMaterial
                : null;
    const attestation = await verifyOciAttestation({
      service,
      layout: imageLayoutPath,
      imageId: record.imageId,
      manifestDigest: record.manifestDigest,
      candidateSha: identity.context.candidateSha,
      baseMaterial,
    });
    if (
      attestation.buildkitMaterialsCompleteness !== "INCOMPLETE_LOCAL_CONTEXT"
    )
      fail("PROVENANCE_COMPLETENESS_UNEXPECTED");
    const image = {
      ...record,
      ...attestation,
      ...(baseMaterial ? { baseMaterial } : {}),
      imageLayoutPath,
      provenanceSha256: sha256(metadataBytes),
      tag,
      upstream: false,
      buildInputBinding: {
        status: "OBSERVED",
        sourceCommit: identity.context.candidateSha,
        sourceTreeSha: sourceSnapshot.sourceTreeSha,
        archiveSha256: sourceSnapshot.archiveSha256,
        archiveSizeBytes: sourceSnapshot.size,
        extractedTreeSha256: sourceSnapshot.extractedTreeSha256,
        extractedBytes: sourceSnapshot.extractedBytes,
        sourceKind:
          service === "grafana"
            ? "git-archive-plus-verified-plugins"
            : "git-archive-local-context",
        ...(service === "grafana"
          ? { vendorPlugins: vendorPlugins.binding }
          : {}),
        buildkitMaterialsCompleteness:
          attestation.buildkitMaterialsCompleteness,
        invocation: {
          entryPoint: "docker buildx build",
          builder: "coffee-platform-mtu",
          target: service,
          platform: "linux/amd64",
          provenance: "mode=min",
          output: "oci-layout-directory",
        },
      },
    };
    if (service === "grafana") {
      image.buildInputBinding.vendorPlugins.effectiveFiles =
        await verifyGrafanaImageFiles({ image, toolchain, temporary, run });
    }
    if (service === "keycloak") {
      image.buildInputBinding.effectiveFiles = await verifyKeycloakImageFiles({
        image,
        toolchain,
        run,
      });
    }
    if (
      [
        "kafka",
        "storage-helper",
        "grafana",
        "keycloak",
        "otel-collector",
      ].includes(service)
    )
      await writeDockerCompatibilityManifest({
        service,
        tag: image.tag,
        runId: identity.context.runId,
        layout: imageLayoutPath,
        archiveManifest: image.dockerArchiveManifest,
      });
    await onValidatedImage?.(image);
    await rm(metadataPath, { force: true });
  }
}

async function loadUpstreamImages({
  toolchain,
  run,
  onChild,
  ownedImages,
  onValidatedImage,
}) {
  const names = {
    lokiImage: "loki",
    prometheusImage: "prometheus",
    tempoImage: "tempo",
  };
  for (const key of UPSTREAM_IMAGES) {
    const reference = toolchain[key];
    let imageId = await inspectImageId(run, reference, { onChild });
    if (imageId === null) {
      const ownership = { reference, imageId: null };
      ownedImages.push(ownership);
      await run("docker", ["pull", reference], { onChild });
      imageId = await inspectImageId(run, reference, { onChild });
      if (imageId === null) fail("IMAGE_ID_INVALID");
      if (!SHA256.test(imageId)) fail("UPSTREAM_IMAGE_DIGEST_INVALID");
      ownership.imageId = imageId;
    }
    const repoDigests = parseJson(
      Buffer.from(
        await run(
          "docker",
          ["image", "inspect", "--format", "{{json .RepoDigests}}", reference],
          { capture: true, onChild },
        ),
      ),
      "UPSTREAM_IMAGE_DIGEST_INVALID",
    );
    const expected = reference.replace(/:[^/@]+@/u, "@");
    if (
      !SHA256.test(imageId ?? "") ||
      !Array.isArray(repoDigests) ||
      !repoDigests.includes(expected)
    )
      fail("UPSTREAM_IMAGE_DIGEST_INVALID");
    const image = {
      service: names[key],
      imageId,
      manifestDigest: reference.slice(reference.lastIndexOf("@") + 1),
      reference,
      upstream: true,
      identityStatus: "PINNED_DIGEST_VERIFIED",
    };
    await onValidatedImage?.(image);
  }
}

async function inspectDatabaseFile(
  path,
  maxBytes,
  { expected, hashContent = false, readBytes = false } = {},
) {
  const failure = expected ? "VULNERABILITY_DB_CHANGED" : "INPUT_FILE_INVALID";
  const fingerprint = (info) => ({
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mode: info.mode,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  });
  const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
  const before = await lstat(path, { bigint: true }).catch(() => null);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(maxBytes) ||
    (await realpath(path).catch(() => null)) !== path
  )
    fail(failure);
  const original = fingerprint(before);
  if (expected && !same(original, expected)) fail(failure);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) fail(failure);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !same(fingerprint(opened), original)) fail(failure);
    let bytes;
    let contentSha256;
    if (readBytes) bytes = await handle.readFile();
    else if (hashContent) {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        highWaterMark: 1024 * 1024,
      })) {
        size += chunk.length;
        if (size > maxBytes) fail(failure);
        hash.update(chunk);
      }
      if (BigInt(size) !== original.size) fail(failure);
      contentSha256 = hash.digest("hex");
    }
    const afterFd = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true }).catch(() => null);
    if (
      !afterPath?.isFile() ||
      afterPath.isSymbolicLink() ||
      !same(fingerprint(afterFd), original) ||
      !same(fingerprint(afterPath), original) ||
      (await realpath(path).catch(() => null)) !== path ||
      (bytes && BigInt(bytes.length) !== original.size)
    )
      fail(failure);
    return {
      fingerprint: original,
      bytes,
      contentSha256,
      contentBytes: Number(original.size),
    };
  } finally {
    await handle.close();
  }
}

async function validateDb(
  cacheDir,
  now,
  policy,
  { baseline, hashContents = true } = {},
) {
  const records = [];
  const fingerprints = [];
  for (const [name, databaseFile] of [
    ["db", "trivy.db"],
    ["java-db", "trivy-java.db"],
  ]) {
    const path = join(cacheDir, name, "metadata.json");
    const metadataFile = await inspectDatabaseFile(path, 64 * 1024, {
      expected: baseline?.[records.length]?.metadata,
      readBytes: true,
    });
    const bytes = metadataFile.bytes;
    const metadata = parseJson(bytes, "VULNERABILITY_DB_METADATA_INVALID");
    const freshness = validateDatabaseMetadata(
      metadata,
      now,
      policy.maximumDatabaseAgeHours * 60 * 60 * 1000,
    );
    const content = await inspectDatabaseFile(
      join(cacheDir, name, databaseFile),
      MAX_DATABASE_BYTES,
      {
        expected: baseline?.[records.length]?.content,
        hashContent: hashContents,
      },
    );
    records.push({
      name,
      ...freshness,
      metadataSha256: sha256(bytes),
      ...(hashContents ? { contentSha256: content.contentSha256 } : {}),
      contentBytes: content.contentBytes,
    });
    fingerprints.push({
      metadata: metadataFile.fingerprint,
      content: content.fingerprint,
    });
  }
  return { records, fingerprints };
}

async function assertDatabasesUnchanged({
  cacheDir,
  clock,
  policy,
  expected,
  baseline,
  final = false,
}) {
  const { records: current } = await validateDb(cacheDir, clock(), policy, {
    baseline,
    hashContents: final,
  });
  if (
    current.length !== expected.length ||
    current.some(
      (database, index) =>
        database.name !== expected[index].name ||
        database.metadataSha256 !== expected[index].metadataSha256 ||
        (final && database.contentSha256 !== expected[index].contentSha256) ||
        database.contentBytes !== expected[index].contentBytes,
    )
  )
    fail("VULNERABILITY_DB_CHANGED");
}

async function scanTarget({
  name,
  inputType,
  cacheDir,
  outputDir,
  scannerImage,
  run,
  onChild,
  inputDir,
  imageTar,
  conversionDir,
  conversionCacheDir,
  clock,
  policy,
  databases,
  databaseFingerprints,
}) {
  const vulnerabilityName = `${name}.vulnerabilities.json`;
  const sbomName = `${name}.sbom.cdx.json`;
  const scanArgs = trivyArgs({
    network: "none",
    cacheDir,
    outputDir,
    scannerImage,
    command: trivyScanCommand(
      inputType,
      "json",
      imageTar?.layout ? "/scan/image" : "/scan/image.tar",
    ),
    inputDir,
    imageTar,
    reportName: vulnerabilityName,
  });
  let scanError;
  try {
    await assertDatabasesUnchanged({
      cacheDir,
      clock,
      policy,
      expected: databases,
      baseline: databaseFingerprints,
    });
    await run("docker", scanArgs, { onChild });
  } catch (error) {
    scanError = error;
  }
  try {
    await assertDatabasesUnchanged({
      cacheDir,
      clock,
      policy,
      expected: databases,
      baseline: databaseFingerprints,
    });
  } catch (error) {
    try {
      error.scanTarget = { name, format: "json" };
    } catch {}
    throw error;
  }
  if (scanError) {
    try {
      scanError.scanTarget = { name, format: "json" };
    } catch {}
    throw scanError;
  }
  const vulnerabilityPath = join(outputDir, vulnerabilityName);
  const vulnerabilityBytes = await readRegular(
    vulnerabilityPath,
    MAX_REPORT_BYTES,
    { mode: 0o600 },
  );
  const vulnerabilityReport = parseJson(
    vulnerabilityBytes,
    "VULNERABILITY_REPORT_INVALID",
  );
  const findings = inspectFindings(vulnerabilityReport);
  const expectedPackages = packageInventory(vulnerabilityReport);
  if (
    inputType === "image" &&
    vulnerabilityReport.Metadata?.ImageID !== imageTar.imageId
  )
    fail("SCANNED_IMAGE_ID_MISMATCH");

  const sourceSha256 = sha256(vulnerabilityBytes);
  const vulnerabilityOutput = {
    path: vulnerabilityName,
    sha256: sourceSha256,
    findings,
  };
  try {
    if (
      within(cacheDir, conversionCacheDir) ||
      within(conversionCacheDir, cacheDir)
    )
      fail("CONVERSION_CACHE_INVALID");
    await mkdir(conversionCacheDir, { recursive: true, mode: 0o700 });
    if ((await readdir(conversionCacheDir)).length !== 0)
      fail("CONVERSION_CACHE_NOT_EMPTY");
    const inputBytes = await readRegular(vulnerabilityPath, MAX_REPORT_BYTES);
    if (sha256(inputBytes) !== sourceSha256) fail("SCAN_REPORT_CHANGED");
    await mkdir(conversionDir, { recursive: true, mode: 0o700 });
    const convertArgs = trivyArgs({
      network: "none",
      cacheDir: conversionCacheDir,
      outputDir: conversionDir,
      scannerImage,
      command: trivyConvertCommand(sbomName),
      reportInput: vulnerabilityPath,
    });
    await run("docker", convertArgs, { onChild });
    const unchangedBytes = await readRegular(
      vulnerabilityPath,
      MAX_REPORT_BYTES,
    );
    if (sha256(unchangedBytes) !== sourceSha256) fail("SCAN_REPORT_CHANGED");
    const convertedSbomPath = join(conversionDir, sbomName);
    const sbomBytes = await readRegular(convertedSbomPath, MAX_REPORT_BYTES);
    const sbomReport = parseJson(sbomBytes, "SBOM_INVALID");
    assertSbomPackageInventory(
      sbomReport,
      expectedPackages,
      inputType === "image" ? imageTar.imageId : undefined,
    );
    await writeScannerOutput(join(outputDir, sbomName), sbomBytes);
    await rm(convertedSbomPath, { force: true });
    return [
      {
        path: sbomName,
        sha256: sha256(sbomBytes),
        findings: { high: 0, critical: 0 },
      },
      vulnerabilityOutput,
    ];
  } catch (error) {
    try {
      error.scanTarget ??= { name, format: "cyclonedx" };
      error.completedReports = [vulnerabilityOutput];
    } catch {}
    throw error;
  }
}

async function freeSpace(path, policy, statfsFn) {
  const space = await statfsFn(path);
  if (space.bavail * space.bsize < policy.minimumFreeDiskGiB * 1024 ** 3)
    fail("DISK_BUDGET_NOT_MET");
}

async function writeResult(outputDir, result) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeScannerOutput(
    join(outputDir, "result.json"),
    Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
  );
}

function summarizeFindings(reports) {
  const findings = { high: 0, critical: 0 };
  for (const report of reports) {
    findings.high += report.findings.high;
    findings.critical += report.findings.critical;
  }
  return findings;
}

export async function runSecurityScan({
  contextFile,
  outputDir,
  clock = Date.now,
  nonceFactory = randomUUID,
  validateContext = validateLaunchContext,
  run = runCommand,
  statfsFn = statfs,
  removeImageInput = rm,
  materializeRegistryCredentials = materializeBuildRegistryCredentials,
  lockPath = SCAN_LOCK,
} = {}) {
  const scanDeadlineAt = clock() + G12_SCAN_BUDGET_MS;
  const runStartedAt = clock();
  let identity;
  let policy;
  let temporary;
  let lockHandle;
  let activeChild = null;
  let stopped = null;
  let cleaning = false;
  const onInt = () => {
    if (cleaning) return;
    stopped = "SIGINT";
    activeChild?.kill("SIGTERM");
  };
  const onTerm = () => {
    if (cleaning) return;
    stopped = "SIGTERM";
    activeChild?.kill("SIGTERM");
  };
  const onChild = (child) => {
    activeChild = child;
    if (stopped) child.kill("SIGTERM");
  };
  let dockerConfig;
  let scannerId;
  const ownedImages = [];
  const containerCandidates = [];
  const runDirect = (command, args, options = {}) =>
    run(command, args, {
      ...options,
      dockerConfig,
      onChild: (child) => {
        activeChild = child;
      },
    });
  const runOwnedContainer = async (args, options = {}) => {
    if (
      !temporary ||
      !identity ||
      !scannerId ||
      !args.length ||
      args[0] !== "run"
    )
      fail("CONTAINER_LIFECYCLE_INVALID");
    const nonce = nonceFactory();
    if (typeof nonce !== "string" || !/^[a-f0-9-]{16,64}$/u.test(nonce))
      fail("CONTAINER_LIFECYCLE_INVALID");
    const name = `coffee-image-scan-${nonce}`;
    const cidDirectory = join(temporary, "container-ids");
    await mkdir(cidDirectory, { recursive: true, mode: 0o700 });
    const spec = Object.freeze({
      name,
      nonce,
      runId: identity.context.runId,
      imageId: scannerId,
      cidfile: join(cidDirectory, `${nonce}.cid`),
    });
    const before = await listDockerContainers(runDirect, `name=${name}`);
    if (before.some((row) => row.name === name))
      fail("CONTAINER_NAME_COLLISION");
    containerCandidates.push({ ...spec, pending: false });
    const labels = [
      "--label",
      `${CONTAINER_OWNER_LABEL}=G12_SUPPLY_CHAIN`,
      "--label",
      `${CONTAINER_RUN_LABEL}=${spec.runId}`,
      "--label",
      `${CONTAINER_NONCE_LABEL}=${spec.nonce}`,
    ];
    let value;
    let commandError;
    try {
      value = await run(
        "docker",
        [
          "run",
          "--name",
          name,
          "--cidfile",
          spec.cidfile,
          ...labels,
          ...args.slice(1),
        ],
        { ...options, dockerConfig, onChild },
      );
    } catch (error) {
      commandError = error;
    }
    const pending = containerCandidates.at(-1);
    try {
      const cidfileId = await containerIdFromCidfile(spec);
      const found = await findOwnedContainer(runDirect, spec);
      const confirmedAutoRemoval =
        args.includes("--rm") && cidfileId !== null && !found;
      pending.pending = Boolean(
        found || (commandError && !confirmedAutoRemoval),
      );
      pending.ambiguous = Boolean(commandError && !confirmedAutoRemoval);
    } catch (error) {
      pending.pending = true;
      throw error;
    }
    if (commandError) {
      attachDatabaseSubstage(commandError, args);
      throw commandError;
    }
    return value;
  };
  const runBounded = (command, args, options = {}) => {
    if (stopped)
      return Promise.reject(
        Object.assign(new Error("INTERRUPTED"), { code: "INTERRUPTED" }),
      );
    const bounded = {
      ...options,
      timeoutMs: options.timeoutMs ?? Math.max(1, scanDeadlineAt - clock()),
    };
    if (command === "docker" && args[0] === "run")
      return runOwnedContainer(args, bounded);
    return run(command, args, { ...bounded, dockerConfig, onChild });
  };
  const runDatabaseDownload = async (args) => {
    const timeoutMs = scanDeadlineAt - clock();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      const error = Object.assign(new Error("COMMAND_TIMEOUT"), {
        code: "COMMAND_TIMEOUT",
      });
      attachDatabaseSubstage(error, args);
      throw error;
    }
    await runBounded("docker", args, { timeoutMs });
  };
  let result = {
    schemaVersion: 1,
    gate: "G12_SUPPLY_CHAIN",
    status: "FAIL",
    code: "NOT_STARTED",
    runId: null,
    candidateSha: null,
    scanner: { version: SCANNER_VERSION, image: SCANNER_IMAGE },
    provenance: null,
    databases: [],
    reports: [],
    findings: { high: 0, critical: 0 },
    evaluation: null,
    adjudication: null,
    kafka: null,
    storageHelper: null,
    grafana: null,
    keycloak: null,
    otelCollector: null,
    failure: null,
    cleanupFailures: [],
    imageCleanup: [],
    timings: [],
  };
  let stage = "input-validation";
  let stageStartedAt = clock();
  const markStage = (name) => {
    const now = clock();
    result.timings.push({
      stage,
      durationMs: Math.max(0, now - stageStartedAt),
    });
    stage = name;
    stageStartedAt = now;
  };
  const finishTiming = () => {
    const now = clock();
    result.timings.push({
      stage,
      durationMs: Math.max(0, now - stageStartedAt),
    });
    stageStartedAt = now;
  };
  let kafkaBuild = null;
  let storageHelperBuild = null;
  let grafanaBuild = null;
  let keycloakBuild = null;
  let otelCollectorBuild = null;
  const setCleanupFailure = (code, failureStage) => {
    result.status = "FAIL";
    result.cleanupFailures.push({ code, stage: failureStage });
    if (!result.failure) {
      result.code = code;
      result.failure = { code, stage: failureStage };
    }
  };
  const retainImageProvenance = (image) => {
    result.provenance ??= {
      status: "PARTIAL",
      sourceRevision: identity.context.candidateSha,
      treeSha: identity.environment.treeSha,
      configSha256: identity.environment.configSha256,
      toolchainVersionsSha256: identity.environment.toolchainVersionsSha256,
      lockfileSha256: identity.environment.lockfileSha256,
      buildInputBinding: image.buildInputBinding ?? null,
      images: [],
    };
    if (!result.provenance.buildInputBinding && image.buildInputBinding)
      result.provenance.buildInputBinding = image.buildInputBinding;
    result.provenance.images.push({
      service: image.service,
      imageId: image.imageId,
      manifestDigest: image.manifestDigest,
      ...(image.upstream
        ? {
            sourceReference: image.reference,
            identityStatus: image.identityStatus,
          }
        : {
            platformManifestDigest: image.platformManifestDigest,
            provenanceStatus: "PASS",
            metadataSha256: image.provenanceSha256,
            attestationSha256: image.attestationSha256,
            ...(image.baseMaterial ? { baseMaterial: image.baseMaterial } : {}),
          }),
    });
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const validated = await validateInputs({
      contextFile,
      outputDir,
      validateContext,
    });
    identity = validated.identity;
    policy = validated.policy;
    outputDir = validated.outputDir;
    result.runId = identity.context.runId;
    result.candidateSha = identity.context.candidateSha;
    if (stopped) fail("INTERRUPTED");
    markStage("lock-acquisition");
    lockHandle = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    ).catch(() => null);
    if (!lockHandle) fail("SCANNER_ALREADY_RUNNING");
    await lockHandle.writeFile(`${process.pid} ${identity.context.runId}\n`);
    await lockHandle.sync();
    temporary = await mkdtemp(join(tmpdir(), "coffee-image-scan-"));
    await chmod(temporary, 0o700);
    const cacheDir = join(temporary, "cache");
    const inputDir = join(temporary, "manifests");
    dockerConfig = await mkdtemp("/dev/shm/coffee-image-registry-");
    await Promise.all([
      mkdir(cacheDir, { mode: 0o700 }),
      mkdir(inputDir, { mode: 0o700 }),
    ]);
    markStage("registry-credentials");
    const registryEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !(name.startsWith("COFFEE_") || name.startsWith("SOPS_")) ||
          name === "SOPS_AGE_KEY_FILE",
      ),
    );
    await materializeRegistryCredentials({
      root: identity.candidateRoot,
      outputDir: dockerConfig,
      env: registryEnv,
    });
    markStage("source-preparation");
    await prepareBuildxRegistration(
      dockerConfig,
      runBounded,
      validated.platform,
      validated.toolchain,
    );
    const outputRoot = join(outputDir, "artifacts");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const sourceSnapshot = await createBuildInputSnapshot({
      candidateRoot: identity.candidateRoot,
      candidateSha: identity.context.candidateSha,
      temporary,
      run: runBounded,
      onChild,
    });
    if (sourceSnapshot.sourceTreeSha !== identity.environment.treeSha)
      fail("CANDIDATE_TREE_MISMATCH");
    markStage("kafka-base-index");
    await freeSpace(outputRoot, policy, statfsFn);
    const kafkaBaseMaterial = await inspectBaseMaterial({
      sourceRef: validated.toolchain.kafkaImage,
      target: "kafka",
      outputRoot,
      run: runBounded,
    });
    markStage("storage-helper-base-index");
    const storageHelperBaseMaterial = await inspectBaseMaterial({
      sourceRef: validated.toolchain.nodeImage,
      target: "storage-helper",
      outputRoot,
      run: runBounded,
    });
    markStage("grafana-base-index");
    const grafanaBaseMaterial = await inspectBaseMaterial({
      sourceRef: validated.toolchain.grafanaImage,
      target: "grafana",
      outputRoot,
      run: runBounded,
    });
    markStage("otel-collector-base-index");
    const otelCollectorBaseMaterial = await inspectBaseMaterial({
      sourceRef: validated.toolchain.otelCollectorImage,
      target: "otel-collector",
      outputRoot,
      run: runBounded,
    });
    markStage("keycloak-base-index");
    const keycloakBaseMaterial = {
      distribution: await inspectBaseMaterial({
        sourceRef: validated.toolchain.keycloakDistributionImage,
        target: "keycloak-distribution",
        outputRoot,
        run: runBounded,
      }),
      runtime: await inspectBaseMaterial({
        sourceRef: validated.toolchain.keycloakRuntimeImage,
        target: "keycloak-runtime",
        outputRoot,
        run: runBounded,
      }),
    };
    markStage("grafana-plugins");
    const vendorPlugins = await prepareGrafanaPlugins({
      toolchain: validated.toolchain,
      temporary,
      outputRoot,
      run: runBounded,
    });
    await createManifestInput(sourceSnapshot.contextPath, inputDir);
    const scannerImage = SCANNER_IMAGE;
    await freeSpace(outputRoot, policy, statfsFn);
    await freeSpace(temporary, policy, statfsFn);
    markStage("scanner-image-load");
    scannerId = await inspectImageId(runBounded, scannerImage);
    if (scannerId === null) {
      const ownership = { reference: SCANNER_IMAGE, imageId: null };
      ownedImages.push(ownership);
      await runBounded("docker", ["pull", SCANNER_IMAGE]);
      scannerId = await inspectImageId(runBounded, scannerImage);
      if (scannerId === null) fail("SCANNER_IMAGE_INVALID");
      if (!SHA256.test(scannerId)) fail("SCANNER_IMAGE_INVALID");
      ownership.imageId = scannerId;
    }
    if (!SHA256.test(scannerId ?? "")) fail("SCANNER_IMAGE_INVALID");
    const scannerDigests = parseJson(
      Buffer.from(
        await runBounded(
          "docker",
          [
            "image",
            "inspect",
            "--format",
            "{{json .RepoDigests}}",
            scannerImage,
          ],
          { capture: true },
        ),
      ),
      "SCANNER_IMAGE_INVALID",
    );
    if (
      !Array.isArray(scannerDigests) ||
      !scannerDigests.includes(SCANNER_IMAGE.replace(/:[^/@]+@/u, "@"))
    )
      fail("SCANNER_IMAGE_DIGEST_MISMATCH");
    markStage("scanner-validation");
    const version = await runBounded(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        scannerImage,
        "--version",
      ],
      { capture: true },
    );
    if (
      !new RegExp(
        `^Version: ${SCANNER_VERSION.replaceAll(".", "\\.")}\\b`,
        "u",
      ).test(version)
    )
      fail("SCANNER_VERSION_MISMATCH");
    const dbPrefix = [
      "run",
      "--rm",
      "--pull=never",
      "--cpus=2",
      "--memory=2048m",
      "--memory-swap=2048m",
      "--pids-limit=128",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=128m",
      "--network",
      BUILD_NETWORK,
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--env",
      "TMPDIR=/cache",
      "--env",
      "GODEBUG=http2client=0",
      "--mount",
      mount(cacheDir, "/cache"),
      scannerImage,
      "--cache-dir",
      "/cache",
      "--disable-telemetry",
      "--no-progress",
      "--parallel",
      "1",
      "image",
    ];
    markStage("vulnerability-database");
    await freeSpace(temporary, policy, statfsFn);
    await freeSpace(outputRoot, policy, statfsFn);
    await runDatabaseDownload([
      ...dbPrefix,
      "--db-repository",
      policy.egressRepositories[0],
      "--download-db-only",
    ]);
    await runDatabaseDownload([
      ...dbPrefix,
      "--java-db-repository",
      policy.egressRepositories[1],
      "--download-java-db-only",
    ]);
    const initialDatabases = await validateDb(cacheDir, clock(), policy);
    result.databases = initialDatabases.records;
    const databaseFingerprints = initialDatabases.fingerprints;
    await freeSpace(temporary, policy, statfsFn);
    await freeSpace(outputRoot, policy, statfsFn);
    markStage("manifest-scan");
    const manifestReports = await scanTarget({
      name: "lockfile",
      inputType: "fs",
      cacheDir,
      outputDir: outputRoot,
      conversionDir: join(temporary, "converted-reports"),
      conversionCacheDir: join(temporary, "conversion-cache", "lockfile"),
      scannerImage,
      run: runBounded,
      onChild,
      inputDir,
      clock,
      policy,
      databases: result.databases,
      databaseFingerprints,
    });
    result.reports.push(...manifestReports);

    const scanValidatedImage = async (image) => {
      const imageTarPath =
        image.imageLayoutPath ?? join(temporary, `${image.service}.tar`);
      let operationError;
      try {
        retainImageProvenance(image);
        if (stopped) fail("INTERRUPTED");
        await freeSpace(temporary, policy, statfsFn);
        await freeSpace(outputRoot, policy, statfsFn);
        if (!image.imageLayoutPath)
          await runBounded("docker", [
            "image",
            "save",
            image.imageId,
            "--output",
            imageTarPath,
          ]);
        const imageReports = await scanTarget({
          name: image.service,
          inputType: "image",
          cacheDir,
          outputDir: outputRoot,
          conversionDir: join(temporary, "converted-reports"),
          conversionCacheDir: join(
            temporary,
            "conversion-cache",
            image.service,
          ),
          scannerImage,
          run: runBounded,
          onChild,
          imageTar: {
            path: imageTarPath,
            imageId: image.imageId,
            layout: Boolean(image.imageLayoutPath),
          },
          clock,
          policy,
          databases: result.databases,
          databaseFingerprints,
        });
        result.reports.push(...imageReports);
        if (
          [
            "kafka",
            "storage-helper",
            "grafana",
            "keycloak",
            "otel-collector",
          ].includes(image.service)
        ) {
          const artifact = {
            image,
            ...(await preserveProductArtifact({
              service: image.service,
              image,
              temporary,
              outputRoot,
              run: runBounded,
            })),
          };
          if (image.service === "kafka") kafkaBuild = artifact;
          else if (image.service === "storage-helper")
            storageHelperBuild = artifact;
          else if (image.service === "grafana") grafanaBuild = artifact;
          else if (image.service === "keycloak") keycloakBuild = artifact;
          else otelCollectorBuild = artifact;
        }
      } catch (error) {
        operationError = error;
      }
      try {
        await removeImageInput(imageTarPath, {
          recursive: true,
          force: true,
        });
      } catch {
        setCleanupFailure("TEMP_CLEANUP_FAILED", "temporary-cleanup");
        if (!operationError)
          operationError = Object.assign(new Error("TEMP_CLEANUP_FAILED"), {
            code: "TEMP_CLEANUP_FAILED",
          });
      }
      if (operationError) throw operationError;
    };

    markStage("product-image-build");
    await buildProductImages({
      identity,
      toolchain: validated.toolchain,
      sourceSnapshot,
      temporary,
      run: runBounded,
      onChild,
      statfsFn,
      policy,
      outputRoot,
      kafkaBaseMaterial,
      storageHelperBaseMaterial,
      grafanaBaseMaterial,
      otelCollectorBaseMaterial,
      keycloakBaseMaterial,
      vendorPlugins,
      onValidatedImage: async (image) => {
        markStage("image-scan");
        await scanValidatedImage(image);
        markStage("product-image-build");
      },
    });
    markStage("upstream-image-load");
    await loadUpstreamImages({
      toolchain: validated.toolchain,
      run: runBounded,
      onChild,
      ownedImages,
      onValidatedImage: async (image) => {
        markStage("image-scan");
        await scanValidatedImage(image);
        markStage("upstream-image-load");
      },
    });
    markStage("vulnerability-db-final-check");
    await assertDatabasesUnchanged({
      cacheDir,
      clock,
      policy,
      expected: result.databases,
      baseline: databaseFingerprints,
      final: true,
    });
    await assertDatabasesUnchanged({
      cacheDir,
      clock,
      policy,
      expected: result.databases,
      baseline: databaseFingerprints,
    });
    if (
      result.reports.length !==
      (RUNTIME_NAMES.length + 6 + UPSTREAM_IMAGES.length + 1) * 2
    )
      fail("SCAN_REPORT_SET_INCOMPLETE");
    if (result.provenance) result.provenance.status = "PASS";
    result.findings = summarizeFindings(result.reports);
    markStage("finding-evaluation");
    if (!grafanaBuild) fail("GRAFANA_ARTIFACT_MISSING");
    const grafanaReportBytes = await readRegular(
      join(outputRoot, "grafana.vulnerabilities.json"),
      MAX_REPORT_BYTES,
    );
    const grafanaReport = parseJson(
      grafanaReportBytes,
      "VULNERABILITY_REPORT_INVALID",
    );
    const recordedGrafana = result.reports.filter(
      (entry) => entry.path === "grafana.vulnerabilities.json",
    );
    const observedGrafana = inspectFindings(grafanaReport);
    if (
      recordedGrafana.length !== 1 ||
      recordedGrafana[0].sha256 !== sha256(grafanaReportBytes) ||
      recordedGrafana[0].findings.high !== observedGrafana.high ||
      recordedGrafana[0].findings.critical !== observedGrafana.critical
    )
      fail("GRAFANA_SCAN_REPORT_CHANGED");
    const decisions = adjudicateGrafanaFindings({
      report: grafanaReport,
      image: grafanaBuild.image,
      toolchain: validated.toolchain,
      approvedFixed: policy.approvedFixed ?? [],
    });
    const proof = await readCve78661Proof(identity.candidateRoot);
    const reports = { grafana: grafanaReport };
    for (const name of ["otel-collector", "loki", "prometheus"]) {
      const bytes = await readRegular(
        join(outputRoot, `${name}.vulnerabilities.json`),
        MAX_REPORT_BYTES,
      );
      const report = parseJson(bytes, "VULNERABILITY_REPORT_INVALID");
      const recorded = result.reports.filter(
        (entry) => entry.path === `${name}.vulnerabilities.json`,
      );
      if (
        recorded.length !== 1 ||
        recorded[0].sha256 !== sha256(bytes) ||
        !isDeepStrictEqual(recorded[0].findings, inspectFindings(report))
      )
        fail("VULNERABILITY_REPORT_INVALID");
      reports[name] = report;
    }
    const notAffected = adjudicateCve78661({
      proof,
      reports,
      images: result.provenance.images,
      toolchain: validated.toolchain,
    });
    result.evaluation = {
      rawHigh: result.findings.high,
      resolvedFixed: decisions.length,
      resolvedNotAffected: notAffected.length,
      unresolvedHigh:
        result.findings.high - decisions.length - notAffected.length,
      critical: result.findings.critical,
    };
    const evaluatedAt = new Date(clock()).toISOString();
    const openVex = buildOpenVex({
      decisions,
      notAffected,
      runId: identity.context.runId,
      candidateSha: identity.context.candidateSha,
      platformManifestDigest: grafanaBuild.image.platformManifestDigest,
      timestamp: evaluatedAt,
    });
    const adjudication = {
      schemaVersion: 1,
      gate: "G12_SUPPLY_CHAIN",
      runId: identity.context.runId,
      candidateSha: identity.context.candidateSha,
      treeSha: identity.environment.treeSha,
      configSha256: identity.environment.configSha256,
      toolchainVersionsSha256: identity.environment.toolchainVersionsSha256,
      lockfileSha256: identity.environment.lockfileSha256,
      imageId: grafanaBuild.image.imageId,
      manifestDigest: grafanaBuild.image.manifestDigest,
      platformManifestDigest: grafanaBuild.image.platformManifestDigest,
      rawReportSha256: sha256(grafanaReportBytes),
      approvedFixed: policy.approvedFixed ?? [],
      vendorPlugins: grafanaBuild.image.buildInputBinding.vendorPlugins,
      module: validated.toolchain.grafanaTempoModule,
      decisions,
      notAffected,
      proofSha256: CVE_78661_PROOF_SHA256,
      evaluatedAt,
      openVex,
    };
    const adjudicationBytes = Buffer.from(
      `${JSON.stringify(adjudication, null, 2)}\n`,
    );
    await writeScannerOutput(
      join(outputRoot, "grafana-adjudication.json"),
      adjudicationBytes,
    );
    result.adjudication = {
      path: "artifacts/grafana-adjudication.json",
      sha256: sha256(adjudicationBytes),
    };
    result.code =
      result.evaluation.unresolvedHigh + result.evaluation.critical > 0
        ? "HIGH_OR_CRITICAL_FINDINGS"
        : "G12_SCAN_CLEAN";
    result.status = result.code === "G12_SCAN_CLEAN" ? "PASS" : "FAIL";
    if (result.status === "FAIL") result.failure = { code: result.code, stage };
    if (result.status === "PASS") {
      for (const [target, build, baseImage, resultKey] of [
        ["kafka", kafkaBuild, validated.toolchain.kafkaImage, "kafka"],
        [
          "otel-collector",
          otelCollectorBuild,
          validated.toolchain.otelCollectorImage,
          "otelCollector",
        ],
        ["grafana", grafanaBuild, validated.toolchain.grafanaImage, "grafana"],
        [
          "keycloak",
          keycloakBuild,
          validated.toolchain.keycloakDistributionImage,
          "keycloak",
        ],
        [
          "storage-helper",
          storageHelperBuild,
          validated.toolchain.nodeImage,
          "storageHelper",
        ],
      ]) {
        if (!build)
          fail(`${target.toUpperCase().replaceAll("-", "_")}_ARTIFACT_MISSING`);
        const image = build.image;
        const receipt = {
          schemaVersion: 1,
          gate: "G12_SUPPLY_CHAIN",
          status: "PASS",
          runId: identity.context.runId,
          candidateSha: identity.context.candidateSha,
          treeSha: identity.environment.treeSha,
          configSha256: identity.environment.configSha256,
          toolchainVersionsSha256: identity.environment.toolchainVersionsSha256,
          lockfileSha256: identity.environment.lockfileSha256,
          target,
          importTag: image.tag,
          baseImage,
          imageId: image.imageId,
          manifestDigest: image.manifestDigest,
          platformManifestDigest: image.platformManifestDigest,
          provenanceStatus: image.buildkitMaterialsCompleteness,
          provenanceSha256: image.provenanceSha256,
          attestationSha256: image.attestationSha256,
          buildInputBinding: image.buildInputBinding,
          ociArtifact: {
            path: `artifacts/${target}.oci.tar`,
            sha256: build.imageArchiveSha256,
            sizeBytes: build.imageArchiveBytes,
            layoutTreeSha256: build.layoutTreeSha256,
            layoutBytes: build.layoutBytes,
          },
          baseMaterial: image.baseMaterial,
        };
        const receiptBytes = Buffer.from(
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
        await writeScannerOutput(
          join(outputRoot, `${target}-receipt.json`),
          receiptBytes,
        );
        result[resultKey] = {
          path: `artifacts/${target}-receipt.json`,
          receiptSha256: sha256(receiptBytes),
          imageId: image.imageId,
          importTag: image.tag,
          manifestDigest: image.manifestDigest,
          ociArtifactPath: receipt.ociArtifact.path,
          ociArtifactSha256: receipt.ociArtifact.sha256,
        };
      }
    }
  } catch (error) {
    if (Array.isArray(error?.completedReports))
      result.reports.push(...error.completedReports);
    const recordedTemporaryCleanupFailure =
      result.failure?.stage === "temporary-cleanup" &&
      result.failure.code === error?.code;
    result.code = stopped
      ? "INTERRUPTED"
      : /^[A-Z0-9_]{1,64}$/u.test(error?.code ?? "")
        ? error.code
        : "SECURITY_SCAN_FAILED";
    result.status = "FAIL";
    const diagnostic =
      databaseFailureDiagnostic(error, stage) ??
      scanFailureDiagnostic(error, stage);
    if (!recordedTemporaryCleanupFailure)
      result.failure = {
        code: result.code,
        stage,
        ...(diagnostic ? { diagnostic } : {}),
      };
  } finally {
    cleaning = true;
    markStage("cleanup");
    let containerCleanupFailed = false;
    for (const spec of [...containerCandidates]
      .reverse()
      .filter((candidate) => candidate.pending)) {
      try {
        await removeOwnedContainer(runDirect, spec);
      } catch {
        containerCleanupFailed = true;
      }
    }
    if (containerCleanupFailed) {
      setCleanupFailure("CONTAINER_CLEANUP_FAILED", "container-cleanup");
      await lockHandle?.close().catch(() => {});
    } else {
      for (const image of [...ownedImages].reverse()) {
        let currentImageId;
        try {
          currentImageId = await inspectImageId(runDirect, image.reference, {
            timeoutMs: 30_000,
          });
        } catch {
          result.imageCleanup.push({
            reference: image.reference,
            expectedImageId: image.imageId,
            observedImageId: null,
            action: "inspect-reference",
            outcome: "inspection-failed",
          });
          setCleanupFailure("IMAGE_CLEANUP_INSPECT_FAILED", "image-cleanup");
          continue;
        }
        if (currentImageId === null) {
          result.imageCleanup.push({
            reference: image.reference,
            expectedImageId: image.imageId,
            observedImageId: null,
            action: "inspect-reference",
            outcome: "already-absent",
          });
          continue;
        }
        if (!image.imageId) {
          result.imageCleanup.push({
            reference: image.reference,
            expectedImageId: null,
            observedImageId: currentImageId,
            action: "retain",
            outcome: "ownership-unconfirmed",
          });
          setCleanupFailure("IMAGE_OWNERSHIP_UNCONFIRMED", "image-cleanup");
          continue;
        }
        if (currentImageId !== image.imageId) {
          result.imageCleanup.push({
            reference: image.reference,
            expectedImageId: image.imageId,
            observedImageId: currentImageId,
            action: "retain",
            outcome: "identity-changed",
          });
          setCleanupFailure("IMAGE_OWNERSHIP_CHANGED", "image-cleanup");
          continue;
        }
        try {
          await runDirect("docker", ["image", "rm", image.imageId], {
            timeoutMs: 30_000,
          });
        } catch {}
        let remainingImageId;
        try {
          remainingImageId = await inspectImageId(runDirect, image.imageId, {
            timeoutMs: 30_000,
          });
        } catch {
          result.imageCleanup.push({
            reference: image.reference,
            expectedImageId: image.imageId,
            observedImageId: null,
            action: "remove-image-id",
            outcome: "absence-unverified",
          });
          setCleanupFailure("IMAGE_CLEANUP_INSPECT_FAILED", "image-cleanup");
          continue;
        }
        if (remainingImageId === null) {
          result.imageCleanup.push({
            reference: image.reference,
            expectedImageId: image.imageId,
            observedImageId: null,
            action: "remove-image-id",
            outcome: "absent-after-removal",
          });
          continue;
        }
        result.imageCleanup.push({
          reference: image.reference,
          expectedImageId: image.imageId,
          observedImageId: remainingImageId,
          action: "remove-image-id",
          outcome: "retained",
        });
        setCleanupFailure("IMAGE_CLEANUP_FAILED", "image-cleanup");
      }
      if (temporary)
        await rm(temporary, { recursive: true, force: true }).catch(() => {
          setCleanupFailure("TEMP_CLEANUP_FAILED", "temporary-cleanup");
        });
      if (lockHandle) {
        await lockHandle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {
          setCleanupFailure("LOCK_CLEANUP_FAILED", "lock-cleanup");
        });
      }
    }
    // Docker config не монтируется в проверяемые контейнеры и удаляется даже при их неоднозначной очистке.
    if (dockerConfig)
      await rm(dockerConfig, { recursive: true, force: true }).catch(() => {
        setCleanupFailure("REGISTRY_CLEANUP_FAILED", "registry-cleanup");
      });
    result.findings = summarizeFindings(result.reports);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    markStage("evidence-finalization");
  }
  if (outputDir && isAbsolute(outputDir) && result.runId) {
    try {
      const artifactDir = join(outputDir, "artifacts");
      const checksums = [];
      for (const entry of await readdir(artifactDir, {
        withFileTypes: true,
      }).catch(() => [])) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const maxBytes = [
          "kafka.oci.tar",
          "storage-helper.oci.tar",
          "grafana.oci.tar",
          "keycloak.oci.tar",
          "otel-collector.oci.tar",
        ].includes(entry.name)
          ? MAX_BUILD_CONTEXT_BYTES
          : [
                "kafka-base-index.json",
                "storage-helper-base-index.json",
                "grafana-base-index.json",
                "otel-collector-base-index.json",
              ].includes(entry.name)
            ? MAX_KAFKA_INDEX_BYTES
            : MAX_REPORT_BYTES;
        const artifact = await inspectRegularFile(
          join(artifactDir, entry.name),
          maxBytes,
        );
        checksums.push({
          path: `artifacts/${entry.name}`,
          sha256: artifact.sha256,
        });
      }
      checksums.sort((a, b) => a.path.localeCompare(b.path, "en"));
      if (checksums.length)
        await writeScannerOutput(
          join(artifactDir, "checksums.json"),
          Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`),
        );
      finishTiming();
      result.totalDurationMs = Math.max(0, clock() - runStartedAt);
      await writeResult(outputDir, result);
    } catch {
      result.status = "FAIL";
      result.code = "EVIDENCE_WRITE_FAILED";
    }
  }
  if (result.timings.at(-1)?.stage !== "evidence-finalization") {
    finishTiming();
    result.totalDurationMs = Math.max(0, clock() - runStartedAt);
  }
  return result;
}

function parseArguments(argv) {
  if (argv.length !== 0) fail("ARGUMENT_INVALID");
  const contextFile = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (typeof contextFile !== "string" || !isAbsolute(contextFile))
    fail("LAUNCH_CONTEXT_REQUIRED");
  return { contextFile: resolve(contextFile) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSecurityScan(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({ gate: result.gate, status: result.status, code: result.code, runId: result.runId, candidateSha: result.candidateSha, kafkaReceiptSha256: result.kafka?.receiptSha256 ?? null, storageHelperReceiptSha256: result.storageHelper?.receiptSha256 ?? null })}\n`,
    );
    if (result.status !== "PASS")
      process.exitCode = result.code === "INTERRUPTED" ? 130 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ gate: "G12_SUPPLY_CHAIN", status: "FAIL", code: /^[A-Z0-9_]{1,64}$/u.test(error?.code ?? "") ? error.code : "SECURITY_SCAN_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}
