import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const IMAGE_INVENTORY_SCHEMA_VERSION = 1;
export const IMAGE_INVENTORY_FILE = "image-inventory.json";
export const IMAGE_INVENTORY_REFERENCE = `artifacts/${IMAGE_INVENTORY_FILE}`;

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const MAX_INVENTORY_BYTES = 256 * 1024;
const MAX_GATE_RESULT_BYTES = 8 * 1024 * 1024;
const INVENTORY_KEYS = [
  "schemaVersion",
  "gate",
  "status",
  "runId",
  "candidateSha",
  "treeSha",
  "configSha256",
  "toolchainVersionsSha256",
  "lockfileSha256",
  "composeProject",
  "buildInputSha256",
  "images",
];
const IMAGE_KEYS = [
  "service",
  "tag",
  "imageId",
  "manifestDigest",
  "platformManifestDigest",
  "provenanceSha256",
  "attestationSha256",
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code) {
  throw new Error(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const actual = Object.keys(value).sort(compare);
  const wanted = [...expected].sort(compare);
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function imageInventoryPath(evidenceDir) {
  return join(
    evidenceDir,
    "gates/supply_chain/artifacts/supply-chain/artifacts",
    IMAGE_INVENTORY_FILE,
  );
}

export function runtimeImageTag(composeProject, service) {
  return `${composeProject}-${service}:latest`;
}

/**
 * Build-input identity of the reusable image set. The tree digest covers every
 * Dockerfile, patch and source file, the toolchain pins cover base images and
 * the lockfile covers dependency resolution; together they are the cache key.
 */
export function imageBuildInputSha256({
  treeSha,
  configSha256,
  toolchainVersionsSha256,
  lockfileSha256,
}) {
  if (
    !GIT_SHA.test(treeSha ?? "") ||
    !SHA256.test(configSha256 ?? "") ||
    !SHA256.test(toolchainVersionsSha256 ?? "") ||
    !SHA256.test(lockfileSha256 ?? "")
  )
    fail("IMAGE_INVENTORY_IDENTITY_INVALID");
  return sha256(
    Buffer.from(
      `${JSON.stringify({
        schemaVersion: IMAGE_INVENTORY_SCHEMA_VERSION,
        treeSha,
        configSha256,
        toolchainVersionsSha256,
        lockfileSha256,
      })}\n`,
    ),
  );
}

export function buildImageInventory({
  context,
  environment,
  composeProject,
  services,
  images,
}) {
  if (!PROJECT.test(composeProject ?? ""))
    fail("IMAGE_INVENTORY_PROJECT_INVALID");
  const expected = [...services].sort(compareText);
  const recorded = [...images].sort((left, right) =>
    compareText(left.service, right.service),
  );
  if (
    recorded.length !== expected.length ||
    recorded.some((image) => !expected.includes(image.service)) ||
    new Set(recorded.map((image) => image.service)).size !== recorded.length
  )
    fail("IMAGE_INVENTORY_IMAGE_SET_INVALID");
  const inventory = {
    schemaVersion: IMAGE_INVENTORY_SCHEMA_VERSION,
    gate: "supply_chain",
    status: "PASS",
    runId: context.runId,
    candidateSha: context.candidateSha,
    treeSha: environment.treeSha,
    configSha256: environment.configSha256,
    toolchainVersionsSha256: environment.toolchainVersionsSha256,
    lockfileSha256: environment.lockfileSha256,
    composeProject,
    buildInputSha256: imageBuildInputSha256(environment),
    images: recorded.map((image) => ({
      service: image.service,
      tag: runtimeImageTag(composeProject, image.service),
      imageId: image.imageId,
      manifestDigest: image.manifestDigest,
      platformManifestDigest: image.platformManifestDigest,
      provenanceSha256: image.provenanceSha256,
      attestationSha256: image.attestationSha256,
    })),
  };
  return validateImageInventory(inventory, {
    context,
    environment,
    services,
    composeProject,
  });
}

export function validateImageInventory(
  inventory,
  { context, environment, services, composeProject },
) {
  const expected = [...services].sort(compareText);
  if (!exactKeys(inventory, INVENTORY_KEYS))
    fail("IMAGE_INVENTORY_SHAPE_INVALID");
  if (
    inventory.schemaVersion !== IMAGE_INVENTORY_SCHEMA_VERSION ||
    inventory.gate !== "supply_chain" ||
    inventory.status !== "PASS" ||
    inventory.runId !== context.runId ||
    inventory.candidateSha !== context.candidateSha ||
    inventory.treeSha !== environment.treeSha ||
    inventory.configSha256 !== environment.configSha256 ||
    inventory.toolchainVersionsSha256 !== environment.toolchainVersionsSha256 ||
    inventory.lockfileSha256 !== environment.lockfileSha256 ||
    inventory.composeProject !== composeProject ||
    !SHA256.test(inventory.buildInputSha256 ?? "") ||
    inventory.buildInputSha256 !== imageBuildInputSha256(environment) ||
    !Array.isArray(inventory.images) ||
    inventory.images.length !== expected.length
  )
    fail("IMAGE_INVENTORY_IDENTITY_INVALID");
  const seen = new Set();
  for (const image of inventory.images) {
    if (
      !exactKeys(image, IMAGE_KEYS) ||
      !expected.includes(image.service) ||
      seen.has(image.service) ||
      image.tag !== runtimeImageTag(composeProject, image.service) ||
      !IMAGE_ID.test(image.imageId ?? "") ||
      !IMAGE_ID.test(image.manifestDigest ?? "") ||
      !IMAGE_ID.test(image.platformManifestDigest ?? "") ||
      !SHA256.test(image.provenanceSha256 ?? "") ||
      !SHA256.test(image.attestationSha256 ?? "")
    )
      fail("IMAGE_INVENTORY_IMAGE_INVALID");
    seen.add(image.service);
  }
  return Object.freeze(inventory);
}

export function serializeImageInventory(inventory) {
  return Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
}

/**
 * Читает инвентарь образов `supply_chain` текущего запуска, если он опубликован.
 * Отсутствие файла означает, что `supply_chain` ещё не публиковал образы: вызывающий
 * обязан собрать их сам (standalone/тестовый путь).
 */
function supplyChainDir(evidenceDir) {
  return join(evidenceDir, "gates/supply_chain/artifacts/supply-chain");
}

async function readEvidenceJson(path, maxBytes) {
  const absolute = resolve(path);
  if ((await realpath(absolute).catch(() => null)) !== absolute)
    fail("IMAGE_INVENTORY_EVIDENCE_PATH_INVALID");
  const info = await lstat(absolute).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size < 1 ||
    info.size > maxBytes
  )
    fail("IMAGE_INVENTORY_EVIDENCE_FILE_INVALID");
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info.size)
      fail("IMAGE_INVENTORY_EVIDENCE_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size)
      fail("IMAGE_INVENTORY_EVIDENCE_FILE_INVALID");
    try {
      return {
        bytes,
        value: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ),
      };
    } catch {
      fail("IMAGE_INVENTORY_EVIDENCE_JSON_INVALID");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Сверяет инвентарь с независимо прочитанным evidence `supply_chain`: PASS-результатом,
 * его checksum-ссылкой и записями provenance для каждого образа. Инвентарь сам
 * по себе не является доказательством — только согласие с этими файлами.
 */
async function verifyInventoryAgainstGateEvidence({
  evidenceDir,
  context,
  environment,
  inventory,
  inventoryBytes,
  services,
  composeProject,
}) {
  const gateDir = supplyChainDir(evidenceDir);
  const { value: result } = await readEvidenceJson(
    join(gateDir, "result.json"),
    MAX_GATE_RESULT_BYTES,
  );
  if (
    result?.gate !== "supply_chain" ||
    result?.status !== "PASS" ||
    result?.code !== "G12_SCAN_CLEAN" ||
    result?.runId !== context.runId ||
    result?.candidateSha !== context.candidateSha ||
    result?.provenance?.status !== "PASS" ||
    result?.provenance?.sourceRevision !== context.candidateSha ||
    result?.provenance?.treeSha !== environment.treeSha ||
    result?.provenance?.configSha256 !== environment.configSha256 ||
    result?.provenance?.toolchainVersionsSha256 !==
      environment.toolchainVersionsSha256 ||
    result?.provenance?.lockfileSha256 !== environment.lockfileSha256
  )
    fail("IMAGE_INVENTORY_GATE_RESULT_INVALID");
  const reference = result?.imageInventory;
  if (
    !exactKeys(reference, ["path", "sha256", "sizeBytes"]) ||
    reference.path !== IMAGE_INVENTORY_REFERENCE ||
    reference.sha256 !== sha256(inventoryBytes) ||
    reference.sizeBytes !== inventoryBytes.length
  )
    fail("IMAGE_INVENTORY_REFERENCE_INVALID");
  const provenance = result?.provenance?.images;
  if (!Array.isArray(provenance)) fail("IMAGE_INVENTORY_GATE_RESULT_INVALID");
  for (const image of inventory.images) {
    const records = provenance.filter(
      (entry) => entry?.service === image.service,
    );
    if (
      records.length !== 1 ||
      records[0].imageId !== image.imageId ||
      records[0].manifestDigest !== image.manifestDigest ||
      records[0].platformManifestDigest !== image.platformManifestDigest ||
      records[0].provenanceStatus !== "PASS" ||
      records[0].metadataSha256 !== image.provenanceSha256 ||
      records[0].attestationSha256 !== image.attestationSha256
    )
      fail("IMAGE_INVENTORY_PROVENANCE_MISMATCH");
  }
  if (
    services.length !== inventory.images.length ||
    composeProject !== inventory.composeProject
  )
    fail("IMAGE_INVENTORY_IMAGE_SET_INVALID");
}

export async function readLaunchImageInventory({
  evidenceDir,
  context,
  environmentFile,
  services,
}) {
  const path = imageInventoryPath(evidenceDir);
  const info = await lstat(path).catch(() => null);
  if (info === null) {
    // Если `supply_chain` в этом scope уже дал PASS-результат, инвентарь обязан быть:
    // иначе proof-стеки, которые не сверяют образ `supply_chain`, тихо пересобрали бы его.
    const gateResult = await lstat(
      join(supplyChainDir(evidenceDir), "result.json"),
    ).catch(() => null);
    if (gateResult !== null) fail("IMAGE_INVENTORY_MISSING");
    // Иного `supply_chain` в этом scope нет (например, дочерний run), сборка допустима.
    return null;
  }
  const environment = JSON.parse(
    await readFile(environmentFile ?? join(evidenceDir, "environment.json"), {
      encoding: "utf8",
    }),
  );
  if (
    environment?.runId !== context.runId ||
    environment?.candidateSha !== context.candidateSha ||
    environment?.dirty !== false
  )
    fail("IMAGE_INVENTORY_ENVIRONMENT_INVALID");
  const composeProject = context.resources?.composeProject;
  const inventory = await readImageInventoryFile(path, {
    evidenceDir,
    expected: {
      context,
      environment,
      services,
      composeProject,
    },
  });
  const inventoryBytes = await readFile(path);
  await verifyInventoryAgainstGateEvidence({
    evidenceDir,
    context,
    environment,
    inventory,
    inventoryBytes,
    services,
    composeProject,
  });
  return inventory;
}

export async function readImageInventoryFile(path, { expected, evidenceDir }) {
  const absolute = resolve(path);
  if (evidenceDir !== undefined && !within(evidenceDir, absolute))
    fail("IMAGE_INVENTORY_PATH_INVALID");
  if ((await realpath(absolute).catch(() => null)) !== absolute)
    fail("IMAGE_INVENTORY_PATH_INVALID");
  const info = await lstat(absolute).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size < 1 ||
    info.size > MAX_INVENTORY_BYTES
  )
    fail("IMAGE_INVENTORY_FILE_INVALID");
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info.size)
      fail("IMAGE_INVENTORY_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) fail("IMAGE_INVENTORY_FILE_INVALID");
    let parsed;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      fail("IMAGE_INVENTORY_JSON_INVALID");
    }
    return validateImageInventory(parsed, expected);
  } finally {
    await handle.close();
  }
}
