import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RUNTIMES = [
  "edge-gateway",
  "api-public",
  "api-internal",
  "customer-service",
  "catalog-service",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "pricing-service",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "aroma-gateway",
  "realtime-gateway",
];

// Inspect named references and dangling image IDs together; a failed inventory
// is never treated as an empty cache.
const runImageControl = (args) =>
  execFileSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });

export function inspectLaunchRuntimeImages(
  projectName,
  verifiedImages,
  run = runImageControl,
) {
  const expected = new Map(
    verifiedImages.map(({ service, imageId }) => [
      `${projectName}-${service}:latest`,
      imageId,
    ]),
  );
  assert.equal(expected.size, RUNTIMES.length + 1);
  assert.deepEqual(
    new Set(verifiedImages.map(({ service }) => service)),
    new Set([...RUNTIMES, "edge-nginx"]),
  );
  for (const id of expected.values())
    assert.match(id, /^sha256:[a-f0-9]{64}$/u);
  const rows = run([
    "image",
    "ls",
    "--all",
    "--no-trunc",
    "--format",
    "{{json .}}",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const row of rows) {
    assert.match(row.ID ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(typeof row.Repository, "string");
    assert.equal(typeof row.Tag, "string");
  }
  const listedIds = [...new Set(rows.map((row) => row.ID))];
  const inspectedIds = listedIds.length
    ? run(["image", "inspect", "--format", "{{.Id}}", ...listedIds])
        .trim()
        .split("\n")
    : [];
  assert.equal(
    inspectedIds.length,
    listedIds.length,
    "image inventory inspection is incomplete",
  );
  for (const id of inspectedIds) assert.match(id, /^sha256:[a-f0-9]{64}$/u);
  const identities = new Map(
    listedIds.map((id, index) => [id, inspectedIds[index]]),
  );
  const refs = new Map();
  const preexisting = new Map();
  let dangling = false;
  for (const row of rows) {
    const reference = `${row.Repository}:${row.Tag}`;
    const imageId = identities.get(row.ID);
    if ([...expected.values()].includes(imageId)) {
      const references = preexisting.get(imageId) ?? [];
      references.push(reference);
      preexisting.set(imageId, references);
      if (row.Repository === "<none>" && row.Tag === "<none>") dangling = true;
    }
    if (expected.has(reference)) {
      assert.ok(!refs.has(reference), "duplicate run-owned image reference");
      refs.set(reference, imageId);
    }
  }
  return { expected, refs, dangling, preexisting };
}

export function captureRuntimeImageBaseline(inventory) {
  // supply_chain публикует проверенные образы под теми же run-ссылками до integration, поэтому
  // существующие ссылки — это уже подтверждённое владение, а не коллизия.
  for (const [reference, imageId] of inventory.refs)
    assert.equal(
      inventory.expected.get(reference),
      imageId,
      "run image reference does not match the verified image",
    );
  return [...inventory.preexisting]
    .map(([imageId, references]) => ({
      imageId,
      references: [...references].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .sort((a, b) =>
      a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0,
    );
}

export function validateRuntimeImageOwnership(inventory, baseline, phase) {
  assert.ok(["baseline", "ready", "cleanup"].includes(phase));
  assert.ok(Array.isArray(baseline));
  const ids = new Set(baseline.map(({ imageId }) => imageId));
  assert.equal(ids.size, baseline.length, "duplicate baseline image ID");
  for (const { imageId, references } of baseline) {
    assert.ok(
      [...inventory.expected.values()].includes(imageId) &&
        Array.isArray(references) &&
        references.length > 0,
    );
    const actual = inventory.preexisting.get(imageId) ?? [];
    for (const reference of references)
      assert.ok(
        actual.includes(reference),
        "pre-existing image reference changed",
      );
  }
  const owned = [...inventory.expected].filter(
    ([, imageId]) => !ids.has(imageId),
  );
  // Образы, опубликованные supply_chain и вошедшие в baseline, остаются
  // в daemon для следующих гейтов и не являются run-owned.
  for (const [reference, imageId] of inventory.refs)
    if (!ids.has(imageId))
      assert.ok(
        owned.some(
          ([expectedRef, expectedId]) =>
            expectedRef === reference && expectedId === imageId,
        ),
        "run image ownership mismatch",
      );
  if (phase === "baseline") {
    for (const [reference, imageId] of owned)
      if (!inventory.refs.has(reference) && inventory.preexisting.has(imageId))
        assert.ok(
          owned.some(
            ([otherRef, otherId]) =>
              otherId === imageId && inventory.refs.has(otherRef),
          ),
          "new image appeared after baseline",
        );
  } else if (phase === "ready") {
    // Опубликованные supply_chain ссылки уже в baseline, поэтому ready-фаза
    // требует наличия всех run-owned ссылок, а не точного равенства размеров.
    for (const [reference] of owned)
      assert.ok(
        inventory.refs.has(reference),
        "run image references are incomplete",
      );
    for (const [, imageId] of inventory.expected)
      assert.ok(
        inventory.preexisting.has(imageId),
        "verified image is missing",
      );
  }
  return {
    owned,
    pending: owned.filter(([reference]) => !inventory.refs.has(reference)),
  };
}

export function cleanupLaunchRuntimeImages(
  projectName,
  verifiedImages,
  run = runImageControl,
  baseline,
) {
  const inventory = inspectLaunchRuntimeImages(
    projectName,
    verifiedImages,
    run,
  );
  if (baseline) validateRuntimeImageOwnership(inventory, baseline, "cleanup");
  for (const [reference, id] of inventory.refs)
    assert.equal(
      id,
      inventory.expected.get(reference),
      "run image cleanup ownership is unknown",
    );
  // Образы, опубликованные supply_chain и вошедшие в baseline, переиспользуются
  // следующими гейтами (compose–rollback), поэтому cleanup их не удаляет.
  const baselineIds = new Set((baseline ?? []).map(({ imageId }) => imageId));
  const removable = [...inventory.refs].filter(
    ([, id]) => !baselineIds.has(id),
  );
  if (removable.length) {
    const references = removable.map(([reference]) => reference);
    const ids = run(["image", "inspect", "--format", "{{.Id}}", ...references])
      .trim()
      .split("\n");
    assert.deepEqual(
      ids,
      references.map((reference) => inventory.refs.get(reference)),
      "run image changed before cleanup",
    );
    run(["image", "rm", "--no-prune", ...references]);
  }
  const after = inspectLaunchRuntimeImages(projectName, verifiedImages, run);
  // supply_chain-owned ссылки остаются доступными для последующих гейтов запуска.
  assert.equal(
    [...after.refs].filter(([, id]) => !baselineIds.has(id)).length,
    0,
    "run image cleanup is incomplete",
  );
  if (baseline) {
    validateRuntimeImageOwnership(after, baseline, "cleanup");
    const ids = new Set(baseline.map(({ imageId }) => imageId));
    for (const [imageId, references] of after.preexisting)
      if (!ids.has(imageId))
        assert.ok(
          !references.includes("<none>:<none>"),
          "run image cleanup left an unowned dangling image",
        );
    return;
  }
  assert.equal(
    after.dangling,
    false,
    "run image cleanup left an unowned dangling image",
  );
}
