import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateLaunchContext } from "../verification/launch/v1/report.mjs";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const VERIFIED_TAG = /^coffee-g12-[a-f0-9]{12}-(?:kafka|storage-helper):latest$/u;
const KAFKA_RUNTIME_MARKER = "coffee-platform-kafka:verified-artifact-required";
const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function fail(code) {
  throw new Error(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readEvidenceFile(path, { maxBytes, mode = 0o600 } = {}) {
  const absolute = resolve(path);
  if ((await realpath(absolute).catch(() => null)) !== absolute)
    fail("G12_KAFKA_EVIDENCE_PATH_INVALID");
  const info = await lstat(absolute).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== mode ||
    info.size < 1 ||
    info.size > maxBytes
  )
    fail("G12_KAFKA_EVIDENCE_FILE_INVALID");
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid() ||
      (opened.mode & 0o777) !== mode ||
      opened.size !== info.size ||
      opened.size > maxBytes
    )
      fail("G12_KAFKA_EVIDENCE_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) fail("G12_KAFKA_EVIDENCE_FILE_INVALID");
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("G12_KAFKA_RECEIPT_INVALID");
  }
}

function dockerRun(args, { input } = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    stdio:
      input === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
}

function isMissingImage(error, reference) {
  if (!error || typeof error.message !== "string") return false;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\n)(?:(?:Error response from daemon: )|(?:Error: ))?No such (?:image|object): ${escaped}$`,
    "u",
  ).test(error.message.trim());
}

function inspectDockerImage(run, reference) {
  let output;
  try {
    output = run([
      "image",
      "inspect",
      "--format",
      "{{.Id}}|{{json .RepoTags}}",
      reference,
    ]);
  } catch (error) {
    if (isMissingImage(error, reference)) return null;
    fail("G12_KAFKA_IMAGE_INSPECT_FAILED");
  }
  const [imageId, rawTags, ...extra] = String(output).trim().split("|");
  let tags;
  try {
    tags = JSON.parse(rawTags);
  } catch {
    fail("G12_KAFKA_IMAGE_INSPECT_INVALID");
  }
  if (
    extra.length ||
    !IMAGE_ID.test(imageId ?? "") ||
    !(tags === null || Array.isArray(tags)) ||
    (tags ?? []).some((tag) => typeof tag !== "string" || !tag) ||
    new Set(tags ?? []).size !== (tags ?? []).length
  )
    fail("G12_KAFKA_IMAGE_INSPECT_INVALID");
  return Object.freeze({ imageId, tags: tags ?? [] });
}

function validateBaseMaterial(baseMaterial, baseImage, target) {
  if (
    !exactKeys(baseMaterial, [
      "sourceRef",
      "platformManifestDigest",
      "indexArtifact",
    ]) ||
    baseMaterial.sourceRef !== baseImage ||
    !IMAGE_ID.test(baseMaterial.platformManifestDigest ?? "") ||
    !exactKeys(baseMaterial.indexArtifact, ["path", "sha256", "sizeBytes"]) ||
    baseMaterial.indexArtifact.path !== `artifacts/${target}-base-index.json` ||
    !/^[a-f0-9]{64}$/u.test(baseMaterial.indexArtifact.sha256 ?? "") ||
    !Number.isSafeInteger(baseMaterial.indexArtifact.sizeBytes) ||
    baseMaterial.indexArtifact.sizeBytes < 1 ||
    baseMaterial.indexArtifact.sizeBytes > MAX_INDEX_BYTES
  )
    return false;
  return true;
}

function validateBinding(binding, receipt, context, environment, target) {
  return (
    exactKeys(binding, [
      "status",
      "sourceCommit",
      "sourceTreeSha",
      "archiveSha256",
      "archiveSizeBytes",
      "extractedTreeSha256",
      "extractedBytes",
      "sourceKind",
      "buildkitMaterialsCompleteness",
      "invocation",
    ]) &&
    binding.status === "OBSERVED" &&
    binding.sourceCommit === context.candidateSha &&
    binding.sourceTreeSha === environment.treeSha &&
    binding.sourceKind === "git-archive-local-context" &&
    binding.buildkitMaterialsCompleteness === "INCOMPLETE_LOCAL_CONTEXT" &&
    Number.isSafeInteger(binding.archiveSizeBytes) &&
    binding.archiveSizeBytes > 0 &&
    Number.isSafeInteger(binding.extractedBytes) &&
    binding.extractedBytes > 0 &&
    /^[a-f0-9]{64}$/u.test(binding.archiveSha256 ?? "") &&
    /^[a-f0-9]{64}$/u.test(binding.extractedTreeSha256 ?? "") &&
    exactKeys(binding.invocation, [
      "entryPoint",
      "builder",
      "target",
      "platform",
      "provenance",
      "output",
    ]) &&
    binding.invocation.entryPoint === "docker buildx build" &&
    binding.invocation.builder === "coffee-platform-mtu" &&
    binding.invocation.target === target &&
    binding.invocation.platform === "linux/amd64" &&
    binding.invocation.provenance === "mode=min" &&
    binding.invocation.output === "oci-layout-directory" &&
    receipt.target === target
  );
}

export async function loadVerifiedGateImage({
  target,
  contextFile = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  run = dockerRun,
  validateContext = validateLaunchContext,
  loadImage = true,
} = {}) {
  if (!["kafka", "storage-helper"].includes(target)) fail("G12_KAFKA_TARGET_INVALID");
  if (typeof contextFile !== "string" || !isAbsolute(contextFile))
    fail("G12_KAFKA_LAUNCH_CONTEXT_REQUIRED");
  const active = await validateContext(contextFile);
  const { context, evidenceDir, candidateRoot } = active;
  const environment = parseJson(
    await readEvidenceFile(join(evidenceDir, "environment.json"), {
      maxBytes: MAX_METADATA_BYTES,
    }),
  );
  if (
    environment.runId !== context.runId ||
    environment.candidateSha !== context.candidateSha ||
    environment.candidatePath !== candidateRoot ||
    environment.dirty !== false ||
    environment.configSha256 !== context.baseConfigSha256 ||
    !/^[0-9a-f]{40}$/u.test(environment.treeSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(environment.toolchainVersionsSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(environment.lockfileSha256 ?? "")
  )
    fail("G12_KAFKA_LAUNCH_IDENTITY_INVALID");

  const platformBytes = await readEvidenceFile(
    join(candidateRoot, "config/platform.yaml"),
    { maxBytes: MAX_METADATA_BYTES, mode: 0o644 },
  );
  const toolchainBytes = await readEvidenceFile(
    join(candidateRoot, "config/toolchain-versions.json"),
    { maxBytes: MAX_METADATA_BYTES, mode: 0o644 },
  );
  const lockfileBytes = await readEvidenceFile(
    join(candidateRoot, "pnpm-lock.yaml"),
    { maxBytes: 8 * 1024 * 1024, mode: 0o644 },
  );
  if (
    sha256(platformBytes) !== context.baseConfigSha256 ||
    sha256(toolchainBytes) !== environment.toolchainVersionsSha256 ||
    sha256(lockfileBytes) !== environment.lockfileSha256
  )
    fail("G12_KAFKA_SOURCE_IDENTITY_INVALID");
  const toolchain = parseJson(toolchainBytes);
  const baseImage = target === "kafka" ? toolchain.kafkaImage : toolchain.nodeImage;
  if (!/@sha256:[a-f0-9]{64}$/u.test(baseImage ?? ""))
    fail("G12_KAFKA_BASE_IMAGE_INVALID");

  const supplyChainDir = join(
    evidenceDir,
    "gates/G12_SUPPLY_CHAIN/artifacts/supply-chain",
  );
  const result = parseJson(
    await readEvidenceFile(join(supplyChainDir, "result.json"), {
      maxBytes: MAX_EVIDENCE_BYTES,
    }),
  );
  const receiptPath = join(supplyChainDir, `artifacts/${target}-receipt.json`);
  const receiptBytes = await readEvidenceFile(receiptPath, {
    maxBytes: MAX_METADATA_BYTES,
  });
  const receiptSha256 = sha256(receiptBytes);
  const receipt = parseJson(receiptBytes);
  const expectedTag = `coffee-g12-${sha256(Buffer.from(context.runId)).slice(0, 12)}-${target}:latest`;
  const image = target === "kafka" ? result.kafka : result.storageHelper;
  if (
    !exactKeys(image, [
      "path",
      "receiptSha256",
      "imageId",
      "importTag",
      "manifestDigest",
      "ociArtifactPath",
      "ociArtifactSha256",
    ]) ||
    image.path !== `artifacts/${target}-receipt.json` ||
    image.receiptSha256 !== receiptSha256 ||
    image.importTag !== expectedTag ||
    image.ociArtifactPath !== `artifacts/${target}.oci.tar` ||
    !exactKeys(receipt, [
      "schemaVersion",
      "gate",
      "status",
      "runId",
      "candidateSha",
      "treeSha",
      "configSha256",
      "toolchainVersionsSha256",
      "lockfileSha256",
      "target",
      "importTag",
      "baseImage",
      "imageId",
      "manifestDigest",
      "platformManifestDigest",
      "provenanceStatus",
      "provenanceSha256",
      "attestationSha256",
      "buildInputBinding",
      "ociArtifact",
      "baseMaterial",
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.gate !== "G12_SUPPLY_CHAIN" ||
    receipt.status !== "PASS" ||
    receipt.runId !== context.runId ||
    receipt.candidateSha !== context.candidateSha ||
    receipt.treeSha !== environment.treeSha ||
    receipt.configSha256 !== context.baseConfigSha256 ||
    receipt.toolchainVersionsSha256 !== environment.toolchainVersionsSha256 ||
    receipt.lockfileSha256 !== environment.lockfileSha256 ||
    receipt.target !== target ||
    receipt.importTag !== expectedTag ||
    receipt.baseImage !== baseImage ||
    !IMAGE_ID.test(receipt.imageId ?? "") ||
    !IMAGE_ID.test(receipt.manifestDigest ?? "") ||
    !IMAGE_ID.test(receipt.platformManifestDigest ?? "") ||
    receipt.provenanceStatus !== "INCOMPLETE_LOCAL_CONTEXT" ||
    !/^[a-f0-9]{64}$/u.test(receipt.provenanceSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(receipt.attestationSha256 ?? "") ||
    !validateBinding(
      receipt.buildInputBinding,
      receipt,
      context,
      environment,
      target,
    ) ||
    !exactKeys(receipt.ociArtifact, [
      "path",
      "sha256",
      "sizeBytes",
      "layoutTreeSha256",
      "layoutBytes",
    ]) ||
    receipt.ociArtifact.path !== `artifacts/${target}.oci.tar` ||
    !/^[a-f0-9]{64}$/u.test(receipt.ociArtifact.sha256 ?? "") ||
    !Number.isSafeInteger(receipt.ociArtifact.sizeBytes) ||
    receipt.ociArtifact.sizeBytes < 1 ||
    receipt.ociArtifact.sizeBytes > MAX_EVIDENCE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(receipt.ociArtifact.layoutTreeSha256 ?? "") ||
    !Number.isSafeInteger(receipt.ociArtifact.layoutBytes) ||
    receipt.ociArtifact.layoutBytes < 1 ||
    image.imageId !== receipt.imageId ||
    image.manifestDigest !== receipt.manifestDigest ||
    image.ociArtifactSha256 !== receipt.ociArtifact.sha256 ||
    result.gate !== "G12_SUPPLY_CHAIN" ||
    result.status !== "PASS" ||
    result.code !== "G12_SCAN_CLEAN" ||
    result.runId !== context.runId ||
    result.candidateSha !== context.candidateSha ||
    result.provenance?.status !== "PASS" ||
    result.provenance?.sourceRevision !== context.candidateSha ||
    result.provenance?.treeSha !== environment.treeSha ||
    result.provenance?.configSha256 !== context.baseConfigSha256 ||
    result.provenance?.toolchainVersionsSha256 !==
      environment.toolchainVersionsSha256 ||
    result.provenance?.lockfileSha256 !== environment.lockfileSha256
  )
    fail("G12_KAFKA_RECEIPT_INVALID");

  const sourceDigest = /@sha256:([a-f0-9]{64})$/u.exec(
    baseImage,
  )?.[1];
  const baseMaterial = receipt.baseMaterial;
  if (
    !validateBaseMaterial(baseMaterial, baseImage, target) ||
    baseMaterial.indexArtifact.sha256 !== sourceDigest
  )
    fail("G12_KAFKA_BASE_MATERIAL_INVALID");
  const indexBytes = await readEvidenceFile(
    join(supplyChainDir, baseMaterial.indexArtifact.path),
    { maxBytes: MAX_INDEX_BYTES },
  );
  const index = parseJson(indexBytes);
  if (
    indexBytes.length !== baseMaterial.indexArtifact.sizeBytes ||
    sha256(indexBytes) !== baseMaterial.indexArtifact.sha256 ||
    index?.schemaVersion !== 2 ||
    !INDEX_MEDIA_TYPES.has(index?.mediaType) ||
    !Array.isArray(index?.manifests) ||
    index.manifests.length < 1 ||
    index.manifests.some(
      (descriptor) =>
        !MANIFEST_MEDIA_TYPES.has(descriptor?.mediaType) ||
        !IMAGE_ID.test(descriptor?.digest ?? "") ||
        !Number.isSafeInteger(descriptor?.size) ||
        descriptor.size < 1,
    )
  )
    fail("G12_KAFKA_BASE_MATERIAL_INVALID");
  const platformDescriptors = index.manifests.filter(
    (descriptor) =>
      descriptor.platform?.os === "linux" &&
      descriptor.platform?.architecture === "amd64",
  );
  if (
    platformDescriptors.length !== 1 ||
    platformDescriptors[0].digest !== baseMaterial.platformManifestDigest
  )
    fail("G12_KAFKA_BASE_MATERIAL_INVALID");

  const artifactPath = join(supplyChainDir, `artifacts/${target}.oci.tar`);
  if (!within(supplyChainDir, artifactPath))
    fail("G12_KAFKA_ARTIFACT_PATH_INVALID");
  const artifactBytes = await readEvidenceFile(artifactPath, {
    maxBytes: MAX_EVIDENCE_BYTES,
  });
  if (
    artifactBytes.length !== receipt.ociArtifact.sizeBytes ||
    sha256(artifactBytes) !== receipt.ociArtifact.sha256
  )
    fail("G12_KAFKA_ARTIFACT_HASH_MISMATCH");
  const provenanceImages = result.provenance?.images?.filter(
    (entry) => entry.service === target,
  );
  const expectedProvenanceImage = {
    service: target,
    imageId: receipt.imageId,
    manifestDigest: receipt.manifestDigest,
    platformManifestDigest: receipt.platformManifestDigest,
    provenanceStatus: "PASS",
    metadataSha256: receipt.provenanceSha256,
    attestationSha256: receipt.attestationSha256,
    baseMaterial: receipt.baseMaterial,
  };
  if (
    provenanceImages?.length !== 1 ||
    !isDeepStrictEqual(provenanceImages[0], expectedProvenanceImage)
  )
    fail("G12_KAFKA_PROVENANCE_INVALID");

  let imported = false;
  if (loadImage) {
    if (target === "kafka") {
      let runtimeMarker;
      try {
        runtimeMarker = inspectDockerImage(run, KAFKA_RUNTIME_MARKER);
      } catch {
        fail("G12_KAFKA_RUNTIME_MARKER_UNKNOWN");
      }
      if (runtimeMarker) fail("G12_KAFKA_RUNTIME_MARKER_PRESENT");
    }
    const priorImage = inspectDockerImage(run, receipt.imageId);
    if (priorImage) {
      if (priorImage.imageId !== receipt.imageId)
        fail("G12_KAFKA_PREEXISTING_IMAGE_ID_INVALID");
      const priorTag = inspectDockerImage(run, receipt.importTag);
      if (
        priorTag &&
        (priorTag.imageId !== receipt.imageId ||
          !priorTag.tags.includes(receipt.importTag))
      )
        fail("G12_KAFKA_PREEXISTING_TAG_CONFLICT");
    } else {
      if (inspectDockerImage(run, receipt.importTag))
        fail("G12_KAFKA_IMPORT_TAG_COLLISION");
      let importOutput;
      try {
        importOutput = run(["image", "load"], { input: artifactBytes });
      } catch {
        fail("G12_KAFKA_IMPORT_FAILED");
      }
      const loadedImage = inspectDockerImage(run, receipt.imageId);
      const loadedTag = inspectDockerImage(run, receipt.importTag);
      if (
        loadedImage?.imageId !== receipt.imageId ||
        loadedTag?.imageId !== receipt.imageId ||
        loadedImage.tags.length !== 1 ||
        loadedImage.tags[0] !== receipt.importTag ||
        typeof importOutput !== "string"
      )
        fail("G12_KAFKA_IMPORTED_IMAGE_IDENTITY_INVALID");
      imported = true;
    }
  }
  return Object.freeze({
    imageId: receipt.imageId,
    manifestDigest: receipt.manifestDigest,
    receiptSha256,
    ociArtifactSha256: receipt.ociArtifact.sha256,
    baseImage: receipt.baseImage,
    candidateSha: receipt.candidateSha,
    runId: receipt.runId,
    importTag: receipt.importTag,
    imported,
  });
}

export function removeVerifiedGateImage({
  target,
  image,
  run = dockerRun,
} = {}) {
  if (!["kafka", "storage-helper"].includes(target)) fail("G12_KAFKA_TARGET_INVALID");
  if (!image || image.imported !== true) return false;
  if (
    !IMAGE_ID.test(image.imageId ?? "") ||
    !VERIFIED_TAG.test(image.importTag ?? "") ||
    !image.importTag.endsWith(`-${target}:latest`)
  )
    fail("G12_KAFKA_CLEANUP_OWNERSHIP_INVALID");
  const inspected = inspectDockerImage(run, image.imageId);
  if (
    inspected?.imageId !== image.imageId ||
    inspected.tags.length !== 1 ||
    inspected.tags[0] !== image.importTag
  )
    fail("G12_KAFKA_CLEANUP_STATE_UNKNOWN");
  let containers;
  try {
    containers = String(
      run([
        "container",
        "ls",
        "--all",
        "--filter",
        `ancestor=${image.imageId}`,
        "--format",
        "{{.ID}}",
      ]),
    ).trim();
  } catch {
    fail("G12_KAFKA_CLEANUP_STATE_UNKNOWN");
  }
  if (containers) fail("G12_KAFKA_IMAGE_IN_USE");
  run(["image", "rm", "--no-prune", image.imageId]);
  if (
    inspectDockerImage(run, image.imageId) !== null ||
    inspectDockerImage(run, image.importTag) !== null
  )
    fail("G12_KAFKA_CLEANUP_RETAINED");
  return true;
}
