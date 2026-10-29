import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  stat,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertSbomPackageInventory,
  git,
  hasHiddenIndexFlags,
  inspectFindings,
  parseKafkaBaseIndex,
  runCommand,
  runSecurityScan,
  trivyArgs,
  trivyScanCommand,
  validateDatabaseMetadata,
  verifyBuildxMetadata,
  verifyOciAttestation,
  verifySlsaStatement,
  verifyKafkaBaseMaterialStatement,
} from "../../tools/security-scan.mjs";
import { RUNTIME_NAMES } from "../../packages/platform-config/src/index.ts";
import { loadVerifiedGateImage } from "../../tools/verified-infrastructure-image.mjs";

const candidateSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const BUILDKIT_032_SCRATCH_FIXTURE = Object.freeze({
  metadataSha256:
    "906a4b19abc4bc95853f469612a44699cfcc3fb6b6d9fe5a036cd112290b06b2",
  outerIndexSha256:
    "28a694743f11eb1225011e2a3999287af21b8f074363a9e7a476010e47f6c7e0",
  imageIndexDigest:
    "sha256:6c07f9b06f13b972c8c506edacf23e1e0dd152bc61b3fec93b47e0ab68ac507c",
  platformManifestDigest:
    "sha256:1d91b09825d4d1373c7d2db2047fb6dd29e147560baddb1fe583f3163ccd6645",
  configDigest:
    "sha256:8b85dc9a4edd993f84a4fa8eed75ec9787a9723dc54299450006bf6d4b68513a",
  attestationManifestDigest:
    "sha256:bed0e5ba7b58ee132978ce9d4a3d22778595df35e95654300d32eec4f6b9dad3",
  statementSha256:
    "31d6a3c9b31003f8790686e356d90b3cffca5b45934a74bda8753ee33cba5768",
  shape:
    "outer OCI index -> image index -> linux/amd64 manifest + unknown/unknown attestation; SLSA v1 subject is platform manifest",
});

function buildMetadata() {
  return {
    "image.name": "fixture:latest",
    "containerimage.digest": imageDigest,
    "containerimage.descriptor": {
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: imageDigest,
    },
    "buildx.build.ref": "fixture/builder/123",
    "buildx.build.provenance": {
      buildType:
        "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
      builder: { id: "fixture" },
      invocation: { configSource: { path: "Dockerfile" } },
    },
  };
}

void test("G12 accepts Buildx mode=min metadata shape and requires statement subject to match", () => {
  const metadata = buildMetadata();
  assert.deepEqual(verifyBuildxMetadata("orders", metadata, candidateSha), {
    service: "orders",
    imageId: null,
    manifestDigest: imageDigest,
    sourceRevision: candidateSha,
  });
  assert.equal(
    verifyBuildxMetadata(
      "orders",
      { ...metadata, "buildx.build.provenance": undefined },
      candidateSha,
    ).manifestDigest,
    imageDigest,
  );
  assert.deepEqual(
    Object.keys(metadata).sort(),
    [
      "buildx.build.provenance",
      "buildx.build.ref",
      "containerimage.descriptor",
      "containerimage.digest",
      "image.name",
    ].sort(),
  );
  const observed = verifyBuildxMetadata(
    "fixture",
    {
      "containerimage.digest": BUILDKIT_032_SCRATCH_FIXTURE.imageIndexDigest,
      "containerimage.descriptor": {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: BUILDKIT_032_SCRATCH_FIXTURE.imageIndexDigest,
      },
      "buildx.build.provenance": {
        buildType:
          "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        builder: { id: "fixture" },
        invocation: { configSource: { path: "Dockerfile" } },
      },
    },
    candidateSha,
  );
  assert.equal(observed.imageId, null);
  assert.equal(
    observed.manifestDigest,
    BUILDKIT_032_SCRATCH_FIXTURE.imageIndexDigest,
  );
  assert.match(BUILDKIT_032_SCRATCH_FIXTURE.metadataSha256, /^[0-9a-f]{64}$/u);
  assert.match(
    BUILDKIT_032_SCRATCH_FIXTURE.outerIndexSha256,
    /^[0-9a-f]{64}$/u,
  );
  assert.match(BUILDKIT_032_SCRATCH_FIXTURE.statementSha256, /^[0-9a-f]{64}$/u);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "fixture", digest: { sha256: imageDigest.slice(7) } }],
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        externalParameters: { configSource: { path: "Dockerfile" } },
      },
      runDetails: {
        metadata: { buildkit_completeness: { resolvedDependencies: false } },
      },
    },
  };
  assert.equal(
    verifySlsaStatement("orders", statement, imageDigest, candidateSha)
      .buildkitMaterialsCompleteness,
    "INCOMPLETE_LOCAL_CONTEXT",
  );
  assert.throws(
    () =>
      verifySlsaStatement(
        "orders",
        { ...statement, subject: [{ digest: { sha256: "e".repeat(64) } }] },
        imageDigest,
        candidateSha,
      ),
    { code: "PROVENANCE_SUBJECT_MISMATCH" },
  );
  const nodeBase = {
    sourceRef: `node:26.8.1-alpine@${imageDigest}`,
    platformManifestDigest: `sha256:${"d".repeat(64)}`,
    indexArtifact: { sha256: imageDigest.slice(7) },
  };
  const helperStatement = {
    ...statement,
    predicate: {
      ...statement.predicate,
      buildDefinition: {
        ...statement.predicate.buildDefinition,
        resolvedDependencies: [
          {
            uri: `pkg:docker/node@26.8.1-alpine?digest=${imageDigest}&platform=linux%2Famd64`,
            digest: { sha256: imageDigest.slice(7) },
          },
        ],
      },
    },
  };
  assert.equal(
    verifySlsaStatement(
      "storage-helper",
      helperStatement,
      imageDigest,
      candidateSha,
      nodeBase,
    ).service,
    "storage-helper",
  );
  assert.throws(
    () =>
      verifySlsaStatement(
        "storage-helper",
        helperStatement,
        imageDigest,
        candidateSha,
        {
          ...nodeBase,
          sourceRef: `node:26.8.1-alpine@sha256:${"c".repeat(64)}`,
          indexArtifact: { sha256: "c".repeat(64) },
        },
      ),
    { code: "STORAGE_HELPER_BASE_MATERIAL_MISMATCH" },
  );
});

void test("G12 binds Kafka provenance to the single pinned linux/amd64 base descriptor", () => {
  const platformDigest = `sha256:${"d".repeat(64)}`;
  const indexBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: platformDigest,
          size: 128,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${"e".repeat(64)}`,
          size: 128,
          platform: { os: "linux", architecture: "arm64" },
        },
      ],
    }),
  );
  const sourceRef = `apache/kafka:4.3.2@sha256:${createHash("sha256")
    .update(indexBytes)
    .digest("hex")}`;
  const baseMaterial = parseKafkaBaseIndex(sourceRef, indexBytes);
  assert.equal(baseMaterial.sourceRef, sourceRef);
  assert.equal(baseMaterial.platformManifestDigest, platformDigest);
  assert.deepEqual(baseMaterial.indexArtifact, {
    path: "artifacts/kafka-base-index.json",
    sha256: createHash("sha256").update(indexBytes).digest("hex"),
    sizeBytes: indexBytes.length,
  });
  assert.throws(
    () =>
      parseKafkaBaseIndex(
        sourceRef,
        Buffer.concat([indexBytes, Buffer.from(" ")]),
      ),
    { code: "KAFKA_BASE_INDEX_INVALID" },
  );
  assert.throws(
    () => parseKafkaBaseIndex(sourceRef, Buffer.alloc(2 * 1024 * 1024 + 1)),
    { code: "KAFKA_BASE_INDEX_INVALID" },
  );
  const duplicateDescriptorsBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        ...JSON.parse(indexBytes).manifests,
        JSON.parse(indexBytes).manifests[0],
      ],
    }),
  );
  const duplicateDescriptorsRef = `apache/kafka:4.3.2@sha256:${createHash(
    "sha256",
  )
    .update(duplicateDescriptorsBytes)
    .digest("hex")}`;
  assert.throws(
    () =>
      parseKafkaBaseIndex(duplicateDescriptorsRef, duplicateDescriptorsBytes),
    { code: "KAFKA_BASE_PLATFORM_MANIFEST_INVALID" },
  );

  const indexSha256 = baseMaterial.indexArtifact.sha256;
  const kafkaMaterial = (uri, sha256 = indexSha256) => ({
    uri,
    digest: { sha256 },
  });
  const expectedUri = `pkg:docker/apache/kafka@4.3.2?digest=sha256:${indexSha256}&platform=linux%2Famd64`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ digest: { sha256: "f".repeat(64) } }],
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        resolvedDependencies: [kafkaMaterial(expectedUri)],
      },
      runDetails: {
        metadata: { buildkit_completeness: { resolvedDependencies: false } },
      },
    },
  };
  assert.equal(
    verifySlsaStatement(
      "kafka",
      statement,
      `sha256:${"f".repeat(64)}`,
      "a".repeat(40),
      baseMaterial,
    ).buildkitMaterialsCompleteness,
    "INCOMPLETE_LOCAL_CONTEXT",
  );
  assert.throws(
    () =>
      verifyKafkaBaseMaterialStatement(
        {
          ...statement,
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                ...statement.predicate.buildDefinition.resolvedDependencies,
                ...statement.predicate.buildDefinition.resolvedDependencies,
              ],
            },
          },
        },
        baseMaterial,
      ),
    { code: "KAFKA_BASE_MATERIAL_MISMATCH" },
  );
  assert.throws(
    () =>
      verifyKafkaBaseMaterialStatement(
        {
          ...statement,
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                kafkaMaterial(
                  `pkg:docker/apache/kafka@4.3.2?digest=sha256:${"0".repeat(64)}&platform=linux%2Famd64`,
                ),
              ],
            },
          },
        },
        baseMaterial,
      ),
    { code: "KAFKA_BASE_MATERIAL_MISMATCH" },
  );
  assert.throws(
    () =>
      verifyKafkaBaseMaterialStatement(
        {
          ...statement,
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                kafkaMaterial(expectedUri, "0".repeat(64)),
              ],
            },
          },
        },
        baseMaterial,
      ),
    { code: "KAFKA_BASE_MATERIAL_MISMATCH" },
  );
  assert.throws(
    () =>
      verifyKafkaBaseMaterialStatement(
        {
          ...statement,
          predicate: {
            buildDefinition: {
              resolvedDependencies: [
                kafkaMaterial(
                  `pkg:docker/apache/kafka@4.3.1?digest=sha256:${indexSha256}&platform=linux%2Famd64`,
                ),
              ],
            },
          },
        },
        baseMaterial,
      ),
    { code: "KAFKA_BASE_MATERIAL_MISMATCH" },
  );
  for (const invalidUri of [
    `pkg:docker/apache/kafka@4.3.2?digest=sha256:${indexSha256}&platform=linux%2Farm64`,
    `pkg:docker/apache/kafka@4.3.2?digest=sha256:${indexSha256}&platform=linux%2Famd64&extra=1`,
    "pkg:docker/apache/kafka@4.3.2?platform=linux%2Famd64",
  ]) {
    assert.throws(
      () =>
        verifyKafkaBaseMaterialStatement(
          {
            ...statement,
            predicate: {
              buildDefinition: {
                resolvedDependencies: [kafkaMaterial(invalidUri)],
              },
            },
          },
          baseMaterial,
        ),
      { code: "KAFKA_BASE_MATERIAL_MISMATCH" },
    );
  }
});

void test("G12 subprocess timeout escalates to SIGKILL and settles", async () => {
  const started = Date.now();
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { timeoutMs: 30, killGraceMs: 30 },
    ),
    { code: "COMMAND_TIMEOUT" },
  );
  assert.ok(Date.now() - started < 2_000);
});

void test("G12 failed commands expose only bounded finite stderr diagnostics", async () => {
  const error = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stderr.write('TLS handshake failed; token=private-canary'); process.exit(17)",
    ],
    { timeoutMs: 2_000 },
  ).then(
    () => assert.fail("expected the child command to fail"),
    (failure) => failure,
  );
  assert.equal(error.code, "COMMAND_FAILED");
  assert.deepEqual(error.safeDiagnostic, {
    exitCode: 17,
    signal: null,
    stderrClass: "TLS_FAILURE",
    stderrSha256: createHash("sha256")
      .update("TLS handshake failed; token=private-canary")
      .digest("hex"),
    stderrBytes: Buffer.byteLength(
      "TLS handshake failed; token=private-canary",
    ),
    stderrTruncated: false,
  });
  assert.equal(
    JSON.stringify(error.safeDiagnostic).includes("private-canary"),
    false,
  );

  const protocolFailure = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stderr.write('copy error: stream error: stream ID 1; PROTOCOL_ERROR; received from peer'); process.exit(17)",
    ],
    { timeoutMs: 2_000 },
  ).then(
    () => assert.fail("expected the protocol failure command to fail"),
    (failure) => failure,
  );
  assert.equal(protocolFailure.code, "COMMAND_FAILED");
  assert.equal(protocolFailure.safeDiagnostic.stderrClass, "HTTP_FAILURE");
  assert.equal(
    JSON.stringify(protocolFailure.safeDiagnostic).includes("PROTOCOL_ERROR"),
    false,
  );

  const stderrPrefix = "x".repeat(8192);
  const oversized = await runCommand(
    process.execPath,
    ["-e", "process.stderr.write('x'.repeat(9000)); process.exit(17)"],
    { timeoutMs: 2_000 },
  ).then(
    () => assert.fail("expected the oversized stderr command to fail"),
    (failure) => failure,
  );
  assert.equal(oversized.safeDiagnostic.stderrBytes, 8192);
  assert.equal(oversized.safeDiagnostic.stderrTruncated, true);
  assert.equal(
    oversized.safeDiagnostic.stderrSha256,
    createHash("sha256").update(stderrPrefix).digest("hex"),
  );

  const multibyteOutput = "é".repeat(5_000);
  const multibytePrefix = Buffer.from(multibyteOutput).subarray(0, 8192);
  const multibyte = await runCommand(
    process.execPath,
    ["-e", "process.stderr.write('é'.repeat(5000)); process.exit(17)"],
    { timeoutMs: 2_000 },
  ).then(
    () => assert.fail("expected the multibyte stderr command to fail"),
    (failure) => failure,
  );
  assert.equal(multibyte.safeDiagnostic.stderrBytes, 8192);
  assert.equal(multibyte.safeDiagnostic.stderrTruncated, true);
  assert.equal(
    multibyte.safeDiagnostic.stderrSha256,
    createHash("sha256").update(multibytePrefix).digest("hex"),
  );
});

void test("G12 image inspection treats only an exact daemon not-found as absence", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "g12-image-inspect-command-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dockerPath = join(temp, "docker");
  const reference = `ghcr.io/example/image@sha256:${"a".repeat(64)}`;
  await writeFile(
    dockerPath,
    `#!/bin/sh\nprintf '%s\\n' 'Error response from daemon: No such image: ${reference}' >&2\nexit 1\n`,
  );
  await chmod(dockerPath, 0o700);
  const args = ["image", "inspect", "--format", "{{.Id}}", reference];
  await assert.rejects(
    runCommand("docker", args, {
      env: { PATH: temp, HOME: temp },
    }),
    { code: "IMAGE_NOT_FOUND" },
  );
  await writeFile(
    dockerPath,
    "#!/bin/sh\nprintf '%s\\n' 'Cannot connect to the Docker daemon' >&2\nexit 1\n",
  );
  await chmod(dockerPath, 0o700);
  await assert.rejects(
    runCommand("docker", args, {
      env: { PATH: temp, HOME: temp },
    }),
    { code: "COMMAND_FAILED" },
  );
});

void test("G12 candidate index checks retain tracked flags beyond the old output boundary", async (t) => {
  const candidateRoot = await mkdtemp(join(tmpdir(), "g12-index-flags-"));
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));
  const trackedDirectory = join(candidateRoot, "many-files");
  await mkdir(trackedDirectory);
  for (let index = 0; index < 1_000; index += 1) {
    await writeFile(
      join(
        trackedDirectory,
        `flag-${String(index).padStart(4, "0")}-${"x".repeat(64)}.txt`,
      ),
      "fixture\n",
    );
  }
  const lastTrackedFlagFile = "many-files/zz-last-listed-flag.txt";
  await writeFile(join(candidateRoot, lastTrackedFlagFile), "fixture\n");
  execFileSync("git", ["init", "--quiet"], { cwd: candidateRoot });
  execFileSync("git", ["add", "many-files"], { cwd: candidateRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=G12 Test",
      "-c",
      "user.email=g12-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "index flags fixture",
    ],
    { cwd: candidateRoot },
  );
  const list = execFileSync("git", ["ls-files", "-v", "-z"], {
    cwd: candidateRoot,
  });
  assert.ok(list.length > 64 * 1024);
  assert.equal(await hasHiddenIndexFlags(candidateRoot), false);
  execFileSync(
    "git",
    ["update-index", "--assume-unchanged", lastTrackedFlagFile],
    { cwd: candidateRoot },
  );
  assert.equal(await hasHiddenIndexFlags(candidateRoot), true);
  execFileSync(
    "git",
    ["update-index", "--no-assume-unchanged", lastTrackedFlagFile],
    { cwd: candidateRoot },
  );
  assert.equal(await hasHiddenIndexFlags(candidateRoot), false);
});

void test("G12 Git output cap rejects overflow even when child can otherwise finish", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "g12-git-output-cap-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bin = join(temp, "bin");
  await mkdir(bin);
  const fakeGit = join(bin, "git");
  await writeFile(
    fakeGit,
    `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(9 * 1024 * 1024), () => process.exit(0));\n`,
  );
  await chmod(fakeGit, 0o700);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${originalPath ?? "/usr/bin:/bin"}`;
    await assert.rejects(git(temp, "list"), { code: "GIT_OUTPUT_TOO_LARGE" });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

void test("G12 verifies BuildKit nested OCI index and platform-manifest attestation", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "g12-oci-attestation-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { createHash } = await import("node:crypto");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const layerBytes = Buffer.from("synthetic OCI layer bytes");
  const layerDigest = `sha256:${hash(layerBytes)}`;
  const configBytes = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [layerDigest] },
    }),
  );
  const configDigest = `sha256:${hash(configBytes)}`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "fixture", digest: { sha256: "" } }],
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        externalParameters: { configSource: { path: "Dockerfile" } },
      },
      runDetails: {
        metadata: { buildkit_completeness: { resolvedDependencies: false } },
      },
    },
  };
  const imageManifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest, size: configBytes.length },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: layerDigest,
          size: layerBytes.length,
        },
      ],
    }),
  );
  const imageManifestDigest = `sha256:${hash(imageManifestBytes)}`;
  statement.subject[0].digest.sha256 = imageManifestDigest.slice(7);
  const statementBytes = Buffer.from(JSON.stringify(statement));
  const statementDigest = `sha256:${hash(statementBytes)}`;
  const attestationManifest = {
    schemaVersion: 2,
    artifactType: "application/vnd.docker.attestation.manifest.v1+json",
    layers: [
      {
        mediaType: "application/vnd.in-toto+json",
        digest: statementDigest,
        size: statementBytes.length,
        annotations: { "in-toto.io/predicate-type": statement.predicateType },
      },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(attestationManifest));
  const nestedIndexBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: imageManifestDigest,
          size: imageManifestBytes.length,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${hash(manifestBytes)}`,
          size: manifestBytes.length,
          platform: { os: "unknown", architecture: "unknown" },
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": imageManifestDigest,
          },
        },
      ],
    }),
  );
  const actualIndexDigest = `sha256:${hash(nestedIndexBytes)}`;
  const root = join(temp, "oci");
  await mkdir(join(root, "blobs/sha256"), { recursive: true });
  await writeFile(
    join(root, "blobs/sha256", configDigest.slice(7)),
    configBytes,
  );
  await writeFile(join(root, "blobs/sha256", layerDigest.slice(7)), layerBytes);
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.index.v1+json",
          digest: actualIndexDigest,
          size: nestedIndexBytes.length,
          annotations: { "org.opencontainers.image.ref.name": "latest" },
        },
      ],
    }),
  );
  await writeFile(
    join(root, "blobs/sha256", actualIndexDigest.slice(7)),
    nestedIndexBytes,
  );
  await writeFile(
    join(root, "blobs/sha256", imageManifestDigest.slice(7)),
    imageManifestBytes,
  );
  await writeFile(
    join(root, "blobs/sha256", hash(manifestBytes)),
    manifestBytes,
  );
  await writeFile(
    join(root, "blobs/sha256", statementDigest.slice(7)),
    statementBytes,
  );
  assert.deepEqual(
    Object.keys(
      JSON.parse(await readFile(join(root, "index.json"), "utf8")),
    ).sort(),
    ["manifests", "schemaVersion"],
  );
  assert.equal(
    (
      await verifyOciAttestation({
        service: "orders",
        layout: root,
        manifestDigest: actualIndexDigest,
        candidateSha,
      })
    ).imageId,
    configDigest,
  );
  assert.equal(
    (
      await verifyOciAttestation({
        service: "orders",
        layout: root,
        manifestDigest: actualIndexDigest,
        candidateSha,
      })
    ).attestationSha256,
    hash(statementBytes),
  );
  assert.deepEqual(
    (
      await verifyOciAttestation({
        service: "orders",
        layout: root,
        manifestDigest: actualIndexDigest,
        candidateSha,
      })
    ).dockerArchiveManifest,
    {
      Config: `blobs/sha256/${configDigest.slice(7)}`,
      Layers: [`blobs/sha256/${layerDigest.slice(7)}`],
    },
  );
  const configPath = join(root, "blobs/sha256", configDigest.slice(7));
  const layerPath = join(root, "blobs/sha256", layerDigest.slice(7));
  await rm(configPath);
  await assert.rejects(
    verifyOciAttestation({
      service: "orders",
      layout: root,
      manifestDigest: actualIndexDigest,
      candidateSha,
    }),
    { code: "OCI_IMAGE_CONFIG_BLOB_INVALID" },
  );
  await writeFile(configPath, configBytes);
  await writeFile(layerPath, Buffer.from("tampered OCI layer bytes"));
  await assert.rejects(
    verifyOciAttestation({
      service: "orders",
      layout: root,
      manifestDigest: actualIndexDigest,
      candidateSha,
    }),
    { code: "OCI_IMAGE_LAYER_BLOB_INVALID" },
  );
  await writeFile(layerPath, layerBytes);
  await writeFile(
    join(root, "blobs/sha256", statementDigest.slice(7)),
    Buffer.from("{}"),
  );
  await assert.rejects(
    verifyOciAttestation({
      service: "orders",
      layout: root,
      manifestDigest: actualIndexDigest,
      candidateSha,
    }),
    { code: "OCI_ATTESTATION_BLOB_INVALID" },
  );
});

void test("G12 flags every HIGH or CRITICAL finding", () => {
  assert.deepEqual(
    inspectFindings({
      Results: [
        {
          Vulnerabilities: [
            { Severity: "HIGH" },
            { Severity: "CRITICAL" },
            { Severity: "LOW" },
          ],
        },
      ],
    }),
    { high: 1, critical: 1 },
  );
  assert.throws(
    () =>
      inspectFindings({ Results: [{ Vulnerabilities: { Severity: "HIGH" } }] }),
    { code: "VULNERABILITY_REPORT_INVALID" },
  );
});

void test("G12 compares only Trivy package components and binds image SBOMs", () => {
  const packageRef = "pkg:generic/coffee@1.0.0";
  const extraRef = "pkg:generic/extra@2.0.0";
  const report = {
    bomFormat: "CycloneDX",
    components: [
      { type: "library", name: "coffee", version: "1.0.0", purl: packageRef },
      { type: "library", name: "coffee", version: "1.0.0", purl: packageRef },
      { type: "operating-system", name: "debian", version: "12.15" },
      { type: "file", name: "pnpm-lock.yaml" },
    ],
    metadata: {
      component: {
        properties: [
          { name: "aquasecurity:trivy:ImageID", value: imageDigest },
        ],
      },
    },
  };
  assert.doesNotThrow(() =>
    assertSbomPackageInventory(
      report,
      new Set([`purl:${packageRef}`]),
      imageDigest,
    ),
  );
  assert.throws(
    () =>
      assertSbomPackageInventory(
        report,
        new Set([`purl:${packageRef}`, `purl:${extraRef}`]),
        imageDigest,
      ),
    { code: "SBOM_PACKAGE_INVENTORY_MISMATCH" },
  );
  assert.throws(
    () =>
      assertSbomPackageInventory(
        {
          ...report,
          components: [
            {
              type: "library",
              name: "other",
              version: "1.0.0",
              purl: extraRef,
            },
          ],
        },
        new Set([`purl:${packageRef}`]),
        imageDigest,
      ),
    { code: "SBOM_PACKAGE_INVENTORY_MISMATCH" },
  );
  assert.throws(
    () =>
      assertSbomPackageInventory(
        { ...report, metadata: { component: { properties: [] } } },
        new Set([`purl:${packageRef}`]),
        imageDigest,
      ),
    { code: "SBOM_IMAGE_ID_MISMATCH" },
  );
});

void test("G12 requires fresh, internally ordered vulnerability database metadata", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const fresh = {
    Version: 2,
    UpdatedAt: "2026-10-24T00:00:00Z",
    DownloadedAt: "2026-10-24T01:00:00Z",
    NextUpdate: "2026-10-25T00:00:00Z",
  };
  assert.equal(validateDatabaseMetadata(fresh, now).version, 2);
  assert.throws(
    () =>
      validateDatabaseMetadata(
        { ...fresh, UpdatedAt: "2026-10-22T00:00:00Z" },
        now,
      ),
    { code: "VULNERABILITY_DB_STALE_OR_INVALID" },
  );
  assert.throws(
    () =>
      validateDatabaseMetadata(
        { ...fresh, NextUpdate: "2026-10-24T11:59:59Z" },
        now,
      ),
    { code: "VULNERABILITY_DB_STALE_OR_INVALID" },
  );
});

void test("G12 scanner arguments constrain the input and include lockfile dev dependencies", () => {
  const args = trivyArgs({
    network: "none",
    cacheDir: "/private/cache",
    outputDir: "/evidence/artifacts",
    scannerImage: "ghcr.io/aquasecurity/trivy@sha256:pin",
    command: ["image", "--input", "/scan/image.tar"],
    imageTar: { path: "/private/one-image.tar" },
    reportName: "orders.vulnerabilities.json",
  });
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--cpus=2"));
  assert.ok(args.includes("--memory=2048m"));
  assert.ok(args.includes("--read-only"));
  assert.equal(
    args[args.indexOf("--user") + 1],
    `${process.getuid()}:${process.getgid()}`,
  );
  assert.equal(args[args.indexOf("--env") + 1], "TMPDIR=/cache");
  assert.ok(
    args.includes(
      "type=bind,src=/private/one-image.tar,dst=/scan/image.tar,readonly",
    ),
  );
  assert.ok(!args.some((argument) => argument.includes("docker.sock")));
  const manifestArgs = trivyArgs({
    network: "none",
    cacheDir: "/private/cache",
    outputDir: "/evidence/artifacts",
    scannerImage: "ghcr.io/aquasecurity/trivy@sha256:pin",
    command: ["fs", "/input"],
    inputDir: "/private/manifest",
  });
  assert.equal(manifestArgs.includes("--env"), false);
  const fsCommand = trivyScanCommand("fs", "json");
  assert.ok(fsCommand.includes("--include-dev-deps"));
  assert.ok(fsCommand.includes("--skip-db-update"));
  assert.ok(fsCommand.includes("--list-all-pkgs"));
  assert.ok(!trivyScanCommand("image", "json").includes("--include-dev-deps"));
  assert.deepEqual(trivyScanCommand("image", "json", "/scan/image").slice(-2), [
    "--input",
    "/scan/image",
  ]);
  const layoutArgs = trivyArgs({
    network: "none",
    cacheDir: "/private/cache",
    outputDir: "/evidence/artifacts",
    scannerImage: "scanner@sha256:pin",
    command: trivyScanCommand("image", "json", "/scan/image"),
    imageTar: { path: "/private/oci-layout", layout: true },
  });
  assert.ok(
    layoutArgs.includes(
      "type=bind,src=/private/oci-layout,dst=/scan/image,readonly",
    ),
  );
  const conversionArgs = trivyArgs({
    network: "none",
    cacheDir: "/private/conversion-cache",
    outputDir: "/private/conversion-output",
    scannerImage: "scanner@sha256:pin",
    command: [
      "convert",
      "--format",
      "cyclonedx",
      "--output",
      "/out/orders.sbom.cdx.json",
      "/scan/report.json",
    ],
    reportInput: "/evidence/artifacts/orders.vulnerabilities.json",
  });
  assert.ok(
    conversionArgs.includes(
      "type=bind,src=/evidence/artifacts/orders.vulnerabilities.json,dst=/scan/report.json,readonly",
    ),
  );
  assert.ok(
    conversionArgs.includes(
      "type=bind,src=/private/conversion-output,dst=/out",
    ),
  );
  const conversionMounts = conversionArgs.flatMap((argument, index) =>
    argument === "--mount" ? [conversionArgs[index + 1]] : [],
  );
  assert.deepEqual(conversionMounts, [
    "type=bind,src=/private/conversion-cache,dst=/cache",
    "type=bind,src=/private/conversion-output,dst=/out",
    "type=bind,src=/evidence/artifacts/orders.vulnerabilities.json,dst=/scan/report.json,readonly",
  ]);
  assert.equal(
    conversionMounts.some((mount) => mount.includes("/private/cache")),
    false,
  );
  assert.ok(conversionArgs.includes("--cache-dir"));
  assert.ok(conversionArgs.includes("/cache"));
  for (const scanOnlyFlag of [
    "--disable-telemetry",
    "--no-progress",
    "--parallel",
  ])
    assert.ok(!conversionArgs.includes(scanOnlyFlag), scanOnlyFlag);
  assert.ok(conversionArgs.includes("none"));
});

void test("G12 builds product images, records pinned upstream identity, and fails on findings or tampered OCI proof", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "g12-synthetic-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const candidateRoot = join(temp, "candidate");
  const evidenceDir = join(temp, "evidence");
  const gateDir = join(evidenceDir, "gates", "G12_SUPPLY_CHAIN");
  const gateArtifactsDir = join(gateDir, "artifacts");
  const outputDir = join(gateArtifactsDir, "supply-chain");
  const contextPath = join(evidenceDir, "context.json");
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(gateArtifactsDir, { recursive: true });
  const runnerResultBytes = Buffer.from('{"runnerOwned":true}\n');
  const runnerLogBytes = Buffer.from("runner-owned gate log\n");
  await writeFile(join(gateDir, "result.json"), runnerResultBytes);
  await writeFile(join(gateDir, "stdout.log"), runnerLogBytes);
  await writeFile(join(gateDir, "stderr.log"), runnerLogBytes);
  await writeFile(
    join(gateArtifactsDir, "preexisting.json"),
    runnerResultBytes,
  );
  await mkdir(join(candidateRoot, "config"), { recursive: true });
  await mkdir(join(candidateRoot, "apps"), { recursive: true });
  await mkdir(join(candidateRoot, "packages/synthetic"), { recursive: true });
  await mkdir(join(candidateRoot, "tools"), { recursive: true });
  await mkdir(join(candidateRoot, "apps/edge-nginx"), { recursive: true });
  for (const file of [
    "config/platform.yaml",
    "config/toolchain-versions.json",
  ]) {
    await writeFile(
      join(candidateRoot, file),
      await readFile(new URL(`../../${file}`, import.meta.url)),
    );
  }
  const lockfile = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  await writeFile(join(candidateRoot, "pnpm-lock.yaml"), lockfile);
  await writeFile(join(candidateRoot, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(
    join(candidateRoot, "package.json"),
    JSON.stringify({ name: "synthetic-candidate", private: true }),
  );
  await writeFile(
    join(candidateRoot, "packages/synthetic/package.json"),
    JSON.stringify({ name: "synthetic-package", version: "1.0.0" }),
  );
  const toolchainFixture = JSON.parse(
    await readFile(
      join(candidateRoot, "config/toolchain-versions.json"),
      "utf8",
    ),
  );
  for (const name of ["grafana", "loki", "prometheus", "tempo"])
    toolchainFixture[`${name}Image`] =
      `registry.example/${name}:1@sha256:${createHash("sha256").update(name).digest("hex")}`;
  const kafkaPlatformDigest = `sha256:${"d".repeat(64)}`;
  const kafkaBaseIndexBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: kafkaPlatformDigest,
          size: 128,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    }),
  );
  const nodeBaseIndexBytes = Buffer.from(
    kafkaBaseIndexBytes
      .toString()
      .replace(kafkaPlatformDigest, `sha256:${"e".repeat(64)}`),
  );
  toolchainFixture.nodeImage = `node:26.8.1-alpine@sha256:${createHash("sha256").update(nodeBaseIndexBytes).digest("hex")}`;
  toolchainFixture.kafkaImage = `apache/kafka:4.3.2@sha256:${createHash(
    "sha256",
  )
    .update(kafkaBaseIndexBytes)
    .digest("hex")}`;
  await writeFile(
    join(candidateRoot, "config/toolchain-versions.json"),
    `${JSON.stringify(toolchainFixture, null, 2)}\n`,
  );
  await writeFile(
    join(candidateRoot, "compose.yaml"),
    await readFile(new URL("../../compose.yaml", import.meta.url), "utf8"),
  );
  await writeFile(
    join(candidateRoot, "tools/docker-build.mjs"),
    "// synthetic tracked build entry\n",
  );
  await writeFile(
    join(candidateRoot, "tools/executable-check.sh"),
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(join(candidateRoot, "tools/executable-check.sh"), 0o755);
  await writeFile(
    join(candidateRoot, "apps/edge-nginx/Dockerfile"),
    "FROM scratch\n",
  );
  await writeFile(join(candidateRoot, "Dockerfile"), "FROM scratch\n");
  for (const path of [
    "config/platform.yaml",
    "config/toolchain-versions.json",
    "pnpm-lock.yaml",
    "Dockerfile",
  ])
    await chmod(join(candidateRoot, path), 0o644);
  execFileSync("git", ["init", "--quiet"], { cwd: candidateRoot });
  execFileSync(
    "git",
    [
      "add",
      "config/platform.yaml",
      "config/toolchain-versions.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "packages/synthetic/package.json",
      "compose.yaml",
      "tools/docker-build.mjs",
      "tools/executable-check.sh",
      "apps/edge-nginx/Dockerfile",
      "Dockerfile",
    ],
    { cwd: candidateRoot },
  );
  execFileSync(
    "git",
    [
      "-c",
      "user.name=G12 Test",
      "-c",
      "user.email=g12-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "synthetic candidate",
    ],
    { cwd: candidateRoot },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: candidateRoot,
    encoding: "utf8",
  }).trim();
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: candidateRoot,
    encoding: "utf8",
  }).trim();
  const hash = async (path) =>
    (await readFile(join(candidateRoot, path))).toString();
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const layerSource = join(temp, "oci-layer-source");
  await mkdir(layerSource);
  await writeFile(join(layerSource, "layer.txt"), "synthetic G12 OCI layer\n");
  const ociLayerBytes = execFileSync(
    "tar",
    [
      "--format=ustar",
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      "-",
      "-C",
      layerSource,
      ".",
    ],
    { encoding: null },
  );
  const ociLayerDiffId = `sha256:${sha(ociLayerBytes)}`;
  const ociLayerDigest = `sha256:${sha(ociLayerBytes)}`;
  const ociConfigBytes = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {},
      rootfs: { type: "layers", diff_ids: [ociLayerDiffId] },
      history: [{ created_by: "synthetic G12 OCI fixture" }],
    }),
  );
  const configDigest = `sha256:${sha(ociConfigBytes)}`;
  const configBytes = Buffer.from(await hash("config/platform.yaml"));
  const toolchainBytes = Buffer.from(
    await hash("config/toolchain-versions.json"),
  );
  const lockBytes = Buffer.from(await hash("pnpm-lock.yaml"));
  const toolchain = JSON.parse(toolchainBytes.toString("utf8"));
  const kafkaBaseMaterial = parseKafkaBaseIndex(
    toolchain.kafkaImage,
    kafkaBaseIndexBytes,
  );
  const storageHelperBaseMaterial = {
    sourceRef: toolchain.nodeImage,
    platformManifestDigest: `sha256:${"e".repeat(64)}`,
    indexArtifact: {
      path: "artifacts/storage-helper-base-index.json",
      sha256: sha(nodeBaseIndexBytes),
      sizeBytes: nodeBaseIndexBytes.length,
    },
  };
  const scannerReference =
    "ghcr.io/aquasecurity/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c";
  const pinnedRefs = new Set([
    toolchain.otelCollectorImage,
    toolchain.grafanaImage,
    toolchain.lokiImage,
    toolchain.prometheusImage,
    toolchain.tempoImage,
    scannerReference,
  ]);
  const runId = "20261024T120000Z-abcdef0";
  const context = {
    schemaVersion: 1,
    candidateSha,
    baseConfigSha256: sha(configBytes),
    runId,
    checkoutDir: candidateRoot,
    sourceRepoRoot: temp,
    acceptedBaseCommit: null,
    startedAtUtc: "2026-10-24T12:00:00Z",
    evidenceDir,
    githubSnapshotPath: null,
    resources: {
      composeProject: `coffee-launch-${runId.toLowerCase()}`,
      kafkaPrefix: runId,
    },
  };
  const environment = {
    runId,
    dirty: false,
    sourceSha: candidateSha,
    candidateSha,
    capturedAt: "2026-10-24T12:00:00Z",
    timezone: "UTC",
    platform: "linux",
    arch: "x64",
    osRelease: "synthetic",
    cpuCount: 2,
    memoryBytes: 1024,
    node: "v26.8.1",
    pnpm: "11.24.0",
    treeSha,
    nodeImageDigest: null,
    toolVersions: {},
    configSha256: sha(configBytes),
    encryptedSecretsSha256: null,
    toolchainVersionsSha256: sha(toolchainBytes),
    lockfileSha256: sha(lockBytes),
    imageDigests: null,
    resources: context.resources,
    candidatePath: candidateRoot,
  };
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  await writeFile(
    join(evidenceDir, "environment.json"),
    `${JSON.stringify(environment, null, 2)}\n`,
    { mode: 0o600 },
  );
  const validateSyntheticContext = async (path) => {
    assert.equal(path, contextPath);
    const loaded = JSON.parse(await readFile(path, "utf8"));
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(Object.hasOwn(loaded, "environment"), false);
    return { context: loaded, candidateRoot, evidenceDir };
  };
  const validCompose = await readFile(join(candidateRoot, "compose.yaml"));
  const commitCompose = async (bytes) => {
    await writeFile(join(candidateRoot, "compose.yaml"), bytes);
    execFileSync("git", ["add", "compose.yaml"], { cwd: candidateRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=G12 Test",
        "-c",
        "user.email=g12-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "synthetic compose contract",
      ],
      { cwd: candidateRoot },
    );
    context.candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: candidateRoot,
      encoding: "utf8",
    }).trim();
    environment.candidateSha = context.candidateSha;
    environment.sourceSha = context.candidateSha;
    environment.treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: candidateRoot,
      encoding: "utf8",
    }).trim();
    await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);
    await writeFile(
      join(evidenceDir, "environment.json"),
      `${JSON.stringify(environment, null, 2)}\n`,
    );
  };
  const invalidComposeCases = [
    {
      name: "unpinned upstream image",
      compose: validCompose
        .toString()
        .replace(
          "image: coffee-platform-kafka:verified-artifact-required",
          `image: ${toolchainFixture.kafkaImage}`,
        ),
    },
    {
      name: "pull policy permits upstream resolution",
      compose: validCompose
        .toString()
        .replace("pull_policy: never", "pull_policy: always"),
    },
    {
      name: "Compose can build Kafka outside the scanner",
      compose: validCompose
        .toString()
        .replace("pull_policy: never", "pull_policy: never\n    build: {}"),
    },
  ];
  for (const [index, scenario] of invalidComposeCases.entries()) {
    assert.notEqual(scenario.compose, validCompose.toString(), scenario.name);
    await commitCompose(Buffer.from(scenario.compose));
    let unexpectedCommands = 0;
    const invalidDeclaration = await runSecurityScan({
      contextFile: contextPath,
      outputDir: join(gateArtifactsDir, `invalid-kafka-compose-${index}`),
      validateContext: validateSyntheticContext,
      run: async () => {
        unexpectedCommands += 1;
        throw new Error("must not execute after invalid Compose declaration");
      },
      lockPath: join(temp, `invalid-kafka-compose-${index}.lock`),
    });
    assert.equal(
      invalidDeclaration.code,
      "KAFKA_SERVICE_DECLARATION_INVALID",
      scenario.name,
    );
    assert.equal(unexpectedCommands, 0, scenario.name);
  }
  await commitCompose(validCompose);
  let scanCache;
  let imageExports = 0;
  let productBuilds = 0;
  let upstreamPulls = 0;
  let imageRemovals = 0;
  const flowEvents = [];
  let lastProductLayoutPath;
  let lastUpstreamTarPath;
  const builtTags = new Set();
  const builtServices = new Set();
  const pulledRefs = new Set();
  const productOciExpectations = new Map();
  const trivyVulnerabilityModes = [];
  let reportWrites = 0;
  let analysisRuns = 0;
  let conversionRuns = 0;
  let fakeError;
  let findingService = RUNTIME_NAMES[0];
  let highFinding = false;
  let criticalFinding = false;
  let tamperOci = false;
  const now = Date.parse("2026-10-24T12:00:00Z");
  const imageIdsByRef = new Map();
  const scannedImageIds = new Map();
  const trivyRunNetworks = [];
  const trivyRunProfiles = [];
  const trivyRunTimeouts = [];
  const conversionCacheDirs = new Set();
  const imageIdForReference = (reference) =>
    `sha256:${sha(Buffer.from(reference))}`;
  let fakeNow = now;
  let buildAdvanceMs = 0;
  let scanAdvanceMs = 0;
  let databaseAdvanceMs = 0;
  let databaseTtlMs = 24 * 60 * 60 * 1_000;
  let tamperDbOnFirstScan = false;
  let tamperDbDuringVulnerabilityScan = false;
  let dbTampered = false;
  let nextRunBehavior = {};
  let deadClientContainerId;
  let deadClientContainerName;
  let unwitnessedContainerCandidate;
  let failContainerRemoval = false;
  let failDatabaseDownload = null;
  let failScanReport = null;
  let omitConvertedPackage = false;
  let failImageInputRemoval = false;
  let mismatchDigestReference = null;
  let failPullReference = null;
  let failPullLeavesImage = false;
  let failImageRemovalReference = null;
  let replaceImageOnFirstScanReference = null;
  let foreignAliasOnFirstScanReference = null;
  const replacedImageIds = new Map();
  const imageRmTargets = [];
  let containerSequence = 0;
  let containerRmCalls = 0;
  const containerRmObservations = [];
  const fakeContainers = new Map();
  const freshDb = () =>
    JSON.stringify({
      Version: 1,
      UpdatedAt: "2026-10-24T00:00:00Z",
      DownloadedAt: new Date(fakeNow).toISOString(),
      NextUpdate: new Date(fakeNow + databaseTtlMs).toISOString(),
    });
  const fakeRun = async (
    command,
    args,
    { capture = false, timeoutMs } = {},
  ) => {
    let launchedContainer;
    let keepContainer = false;
    try {
      if (
        command === "docker" &&
        args[0] === "run" &&
        args.includes("--name")
      ) {
        const name = args[args.indexOf("--name") + 1];
        const cidfile = args[args.indexOf("--cidfile") + 1];
        const labels = Object.fromEntries(
          args.flatMap((value, index) =>
            value === "--label" ? [args[index + 1].split("=")] : [],
          ),
        );
        const behavior = nextRunBehavior;
        const triggerDeath =
          behavior.clientDies &&
          (!behavior.onlyScan || args.includes("--output"));
        if (triggerDeath) nextRunBehavior = {};
        containerSequence += 1;
        launchedContainer = {
          id: String(containerSequence).padStart(64, "0"),
          name,
          imageId: imageIdsByRef.get(scannerReference) ?? configDigest,
          imageRef:
            "ghcr.io/aquasecurity/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c",
          owner:
            (triggerDeath ? behavior.owner : undefined) ??
            labels["io.coffeeorderplatform.g12.owner"],
          runId: labels["io.coffeeorderplatform.g12.run-id"],
          nonce: labels["io.coffeeorderplatform.g12.nonce"],
          cidfile,
          cachePath: scanCache,
        };
        if (!triggerDeath || !behavior.neverVisible) {
          fakeContainers.set(name, launchedContainer);
          await writeFile(cidfile, `${launchedContainer.id}\n`);
        }
        if (triggerDeath) {
          keepContainer = true;
          deadClientContainerId = launchedContainer.id;
          deadClientContainerName = launchedContainer.name;
          if (behavior.neverVisible)
            unwitnessedContainerCandidate = launchedContainer;
          throw Object.assign(
            new Error(
              "synthetic client exited while daemon container remained",
            ),
            { code: "COMMAND_TIMEOUT" },
          );
        }
      }
      if (command === "docker" && args[0] === "container" && args[1] === "ls") {
        const filter = args[args.indexOf("--filter") + 1];
        const rows = [...fakeContainers.values()].filter((container) =>
          filter.startsWith("name=")
            ? container.name.includes(filter.slice(5))
            : container.id.includes(filter.slice(3)),
        );
        return rows
          .map((container) => `${container.id}|${container.name}`)
          .join("\n");
      }
      if (
        command === "docker" &&
        args[0] === "container" &&
        args[1] === "inspect"
      ) {
        assert.ok(!args.at(-2).includes(".Config.Env"));
        const id = args.at(-1);
        const container = [...fakeContainers.values()].find(
          (value) => value.id === id || value.name === id,
        );
        if (!container)
          throw Object.assign(new Error("container absent"), {
            code: "COMMAND_FAILED",
          });
        return `${container.id}|/${container.name}|${container.imageId}|${container.imageRef}|${container.owner}|${container.runId}|${container.nonce}`;
      }
      if (command === "docker" && args[0] === "container" && args[1] === "rm") {
        containerRmCalls += 1;
        const id = args.at(-1);
        const container = [...fakeContainers.values()].find(
          (value) => value.id === id,
        );
        assert.ok(container, "container rm must target a tracked container ID");
        const cacheStat = container.cachePath
          ? await lstat(container.cachePath).catch(() => null)
          : null;
        containerRmObservations.push({
          id,
          name: container.name,
          cachePath: container.cachePath,
          cacheExists: Boolean(cacheStat?.isDirectory()),
        });
        if (failContainerRemoval)
          throw Object.assign(new Error("synthetic rm failure"), {
            code: "COMMAND_FAILED",
          });
        for (const [name, container] of fakeContainers)
          if (container.id === id) fakeContainers.delete(name);
        return;
      }
      if (command === "docker" && args[0] === "buildx" && args[1] === "build") {
        assert.equal(args[2], "--builder");
        assert.equal(args[3], "coffee-platform-mtu");
        assert.ok(
          args.includes("--allow") &&
            args[args.indexOf("--allow") + 1] === "network.host",
        );
        assert.ok(args.includes("--provenance=mode=min"));
        assert.ok(
          args.includes("--platform") &&
            args[args.indexOf("--platform") + 1] === "linux/amd64",
        );
        assert.equal(args.filter((value) => value === "--output").length, 1);
        const tag = args[args.indexOf("-t") + 1];
        const service = tag
          .replace(/^coffee-g12-[0-9a-f]{12}-/u, "")
          .replace(/:latest$/u, "");
        if (lastProductLayoutPath) {
          await assert.rejects(lstat(lastProductLayoutPath), {
            code: "ENOENT",
          });
          lastProductLayoutPath = undefined;
        }
        flowEvents.push(`build:${service}`);
        const sourceContext = args.at(-1);
        assert.notEqual(sourceContext, candidateRoot);
        assert.equal(
          await readFile(join(sourceContext, "pnpm-lock.yaml"), "utf8"),
          lockfile,
        );
        assert.equal(
          (await lstat(join(sourceContext, "package.json"))).mode & 0o777,
          0o644,
        );
        assert.equal(
          (await lstat(join(sourceContext, "tools/executable-check.sh"))).mode &
            0o777,
          0o755,
        );
        if (service === "edge-nginx") {
          assert.deepEqual(
            args.slice(args.indexOf("--file"), args.indexOf("--file") + 2),
            ["--file", "apps/edge-nginx/Dockerfile"],
          );
          assert.deepEqual(
            args.slice(args.indexOf("--target"), args.indexOf("--target") + 2),
            ["--target", "edge-nginx"],
          );
        } else if (service === "storage-helper") {
          assert.deepEqual(
            args.slice(
              args.indexOf("--build-arg"),
              args.indexOf("--build-arg") + 2,
            ),
            ["--build-arg", `NODE_IMAGE=${toolchain.nodeImage}`],
          );
          assert.deepEqual(
            args.slice(args.indexOf("--target"), args.indexOf("--target") + 2),
            ["--target", "storage-helper"],
          );
        } else if (service === "kafka") {
          const buildArgs = args.flatMap((value, index) =>
            value === "--build-arg" ? [args[index + 1]] : [],
          );
          assert.ok(buildArgs.includes(`KAFKA_IMAGE=${toolchain.kafkaImage}`));
          assert.ok(!buildArgs.some((value) => value.startsWith("RUNTIME=")));
          assert.deepEqual(
            args.slice(args.indexOf("--target"), args.indexOf("--target") + 2),
            ["--target", "kafka"],
          );
        } else {
          assert.deepEqual(
            args.slice(
              args.indexOf("--build-arg"),
              args.indexOf("--build-arg") + 2,
            ),
            ["--build-arg", `RUNTIME=${service}`],
          );
          const buildArgs = args.flatMap((value, index) =>
            value === "--build-arg" ? [args[index + 1]] : [],
          );
          assert.ok(
            !buildArgs.some((value) => value.startsWith("KAFKA_IMAGE=")),
          );
          assert.deepEqual(
            args.slice(args.indexOf("--target"), args.indexOf("--target") + 2),
            ["--target", "runtime"],
          );
        }
        builtServices.add(service);
        const metadataPath = args[args.indexOf("--metadata-file") + 1];
        const ociLayout = args
          .find((value) => value.startsWith("type=oci,tar=false,dest="))
          .slice("type=oci,tar=false,dest=".length);
        lastProductLayoutPath = ociLayout;
        const imageManifestBytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            config: { digest: configDigest, size: ociConfigBytes.length },
            layers: [
              {
                mediaType: "application/vnd.oci.image.layer.v1.tar",
                digest: ociLayerDigest,
                size: ociLayerBytes.length,
              },
            ],
          }),
        );
        const imageManifestDigest = `sha256:${sha(imageManifestBytes)}`;
        const metadata = {
          "image.name": `${service}:latest`,
          "containerimage.digest": "",
          "containerimage.descriptor": {},
          "buildx.build.ref": "synthetic/builder/123",
          "buildx.build.provenance": {
            buildType:
              "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
            builder: { id: "synthetic" },
            invocation: { configSource: { path: "Dockerfile" } },
          },
        };
        const statement = {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            {
              name: `pkg:docker/${service}@latest?platform=linux%2Famd64`,
              digest: { sha256: imageManifestDigest.slice(7) },
            },
          ],
          predicate: {
            buildDefinition: {
              buildType:
                "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
              externalParameters: { configSource: { path: "Dockerfile" } },
              resolvedDependencies:
                service === "kafka"
                  ? [
                      {
                        uri: `pkg:docker/apache/kafka@4.3.2?digest=sha256:${kafkaBaseMaterial.indexArtifact.sha256}&platform=linux%2Famd64`,
                        digest: {
                          sha256: kafkaBaseMaterial.indexArtifact.sha256,
                        },
                      },
                    ]
                  : service === "storage-helper"
                    ? [
                        {
                          uri: `pkg:docker/node@26.8.1-alpine?digest=sha256:${storageHelperBaseMaterial.indexArtifact.sha256}&platform=linux%2Famd64`,
                          digest: {
                            sha256:
                              storageHelperBaseMaterial.indexArtifact.sha256,
                          },
                        },
                      ]
                    : [],
            },
            runDetails: {
              metadata: {
                buildkit_completeness: { resolvedDependencies: false },
              },
            },
          },
        };
        const statementBytes = Buffer.from(JSON.stringify(statement));
        const statementDigest = `sha256:${sha(statementBytes)}`;
        const attestationManifest = {
          schemaVersion: 2,
          artifactType: "application/vnd.docker.attestation.manifest.v1+json",
          layers: [
            {
              mediaType: "application/vnd.in-toto+json",
              digest: statementDigest,
              size: statementBytes.length,
              annotations: {
                "in-toto.io/predicate-type": statement.predicateType,
              },
            },
          ],
        };
        const attestationBytes = Buffer.from(
          JSON.stringify(attestationManifest),
        );
        const attestationDigest = `sha256:${sha(attestationBytes)}`;
        const nestedIndexBytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests: [
              {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: imageManifestDigest,
                size: imageManifestBytes.length,
                platform: { os: "linux", architecture: "amd64" },
              },
              {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: attestationDigest,
                size: attestationBytes.length,
                platform: { os: "unknown", architecture: "unknown" },
                annotations: {
                  "vnd.docker.reference.type": "attestation-manifest",
                  "vnd.docker.reference.digest": imageManifestDigest,
                },
              },
            ],
          }),
        );
        const imageIndexDigest = `sha256:${sha(nestedIndexBytes)}`;
        metadata["containerimage.digest"] = imageIndexDigest;
        metadata["containerimage.descriptor"] = {
          mediaType: "application/vnd.oci.image.index.v1+json",
          digest: imageIndexDigest,
          size: nestedIndexBytes.length,
        };
        await writeFile(metadataPath, JSON.stringify(metadata));
        await mkdir(join(ociLayout, "blobs/sha256"), { recursive: true });
        await writeFile(
          join(ociLayout, "index.json"),
          JSON.stringify({
            schemaVersion: 2,
            manifests: [
              {
                mediaType: "application/vnd.oci.image.index.v1+json",
                digest: imageIndexDigest,
                size: nestedIndexBytes.length,
                annotations: { "org.opencontainers.image.ref.name": "latest" },
              },
            ],
          }),
        );
        await writeFile(
          join(ociLayout, "blobs/sha256", imageIndexDigest.slice(7)),
          nestedIndexBytes,
        );
        await writeFile(
          join(ociLayout, "blobs/sha256", imageManifestDigest.slice(7)),
          imageManifestBytes,
        );
        await writeFile(
          join(ociLayout, "blobs/sha256", configDigest.slice(7)),
          ociConfigBytes,
        );
        await writeFile(
          join(ociLayout, "blobs/sha256", ociLayerDigest.slice(7)),
          ociLayerBytes,
        );
        await writeFile(
          join(ociLayout, "blobs/sha256", attestationDigest.slice(7)),
          attestationBytes,
        );
        await writeFile(
          join(ociLayout, "blobs/sha256", statementDigest.slice(7)),
          tamperOci ? Buffer.from("{}") : statementBytes,
        );
        productOciExpectations.set(service, {
          layout: ociLayout,
          tag,
          indexDigest: imageIndexDigest,
          indexBytes: nestedIndexBytes,
          manifestDigest: imageManifestDigest,
          manifestBytes: imageManifestBytes,
        });
        productBuilds += 1;
        builtTags.add(tag);
        fakeNow += buildAdvanceMs;
        assert.ok(service);
        return;
      }
      if (command === "tar") {
        const output = execFileSync(command, args, { encoding: null });
        return output;
      }
      assert.equal(command, "docker");
      assert.ok(
        !args.some((argument) => String(argument).includes("docker.sock")),
      );
      if (args[0] === "run") {
        const conversion = args.includes("convert");
        const databaseDownload = args.includes("--download-db-only")
          ? "vulnerability-database"
          : args.includes("--download-java-db-only")
            ? "java-database"
            : args.includes("--version")
              ? "version"
              : conversion
                ? "conversion"
                : args.includes("--input")
                  ? "image-scan"
                  : "manifest-scan";
        const networkIndex = args.indexOf("--network");
        const userIndex = args.indexOf("--user");
        const envIndex = args.indexOf("--env");
        const env = args.flatMap((argument, index) =>
          argument === "--env" ? [args[index + 1]] : [],
        );
        trivyRunNetworks.push({
          kind: databaseDownload,
          network: args[networkIndex + 1],
        });
        trivyRunTimeouts.push({ kind: databaseDownload, timeoutMs });
        trivyRunProfiles.push({
          kind: databaseDownload,
          user: userIndex < 0 ? null : args[userIndex + 1],
          tmpdir: envIndex < 0 ? null : args[envIndex + 1],
          env,
        });
      }
      if (
        args[0] === "buildx" &&
        args[1] === "imagetools" &&
        args[2] === "inspect" &&
        args[3] === "--raw"
      ) {
        if (args[4] === toolchain.kafkaImage)
          return kafkaBaseIndexBytes.toString("utf8");
        assert.equal(args[4], toolchain.nodeImage);
        return nodeBaseIndexBytes.toString("utf8");
      }
      if (args[0] === "buildx" && args[1] === "inspect") return;
      if (args[0] === "network" && args[1] === "inspect") return;
      if (args[0] === "image" && args[1] === "inspect") {
        if (args.includes("{{json .RepoDigests}}")) {
          const ref = args.at(-1).replace(/:[^/@]+@/u, "@");
          return JSON.stringify(
            args.at(-1) === mismatchDigestReference ? [] : [ref],
          );
        }
        if (
          args.at(-1).startsWith("coffee-g12-") &&
          !builtTags.has(args.at(-1))
        )
          return "";
        if (pinnedRefs.has(args.at(-1))) {
          if (!pulledRefs.has(args.at(-1)))
            throw Object.assign(new Error("IMAGE_NOT_FOUND"), {
              code: "IMAGE_NOT_FOUND",
            });
          return (
            replacedImageIds.get(args.at(-1)) ??
            imageIdsByRef.get(args.at(-1)) ??
            configDigest
          );
        }
        const imageById = [...imageIdsByRef.values()].find(
          (imageId) => imageId === args.at(-1),
        );
        if (imageById) {
          if (
            ![...pulledRefs].some(
              (reference) =>
                (imageIdsByRef.get(reference) ??
                  imageIdForReference(reference)) === imageById,
            )
          )
            throw Object.assign(new Error("IMAGE_NOT_FOUND"), {
              code: "IMAGE_NOT_FOUND",
            });
          return imageById;
        }
        return configDigest;
      }
      if (args[0] === "pull") {
        assert.ok(pinnedRefs.has(args[1]));
        upstreamPulls += 1;
        if (args[1] === failPullReference) {
          if (failPullLeavesImage) {
            pulledRefs.add(args[1]);
            imageIdsByRef.set(args[1], imageIdForReference(args[1]));
          }
          throw Object.assign(new Error("synthetic pull failed"), {
            code: "COMMAND_FAILED",
          });
        }
        pulledRefs.add(args[1]);
        imageIdsByRef.set(args[1], imageIdForReference(args[1]));
        return;
      }
      if (args[0] === "image" && args[1] === "rm") {
        imageRemovals += 1;
        imageRmTargets.push(args.at(-1));
        const matchingRefs = [...pulledRefs].filter(
          (reference) => imageIdsByRef.get(reference) === args.at(-1),
        );
        if (matchingRefs.length !== 1)
          throw Object.assign(new Error("image has other references"), {
            code: "COMMAND_FAILED",
          });
        if (matchingRefs[0] === failImageRemovalReference)
          throw Object.assign(new Error("synthetic image rm failure"), {
            code: "COMMAND_FAILED",
          });
        if (args[2].startsWith("coffee-g12-")) builtTags.delete(args[2]);
        pulledRefs.delete(matchingRefs[0]);
        return;
      }
      if (args[0] === "run" && args.includes("--version"))
        return "Version: 0.76.1\n";
      if (
        args[0] === "run" &&
        (args.includes("--download-db-only") ||
          args.includes("--download-java-db-only"))
      ) {
        flowEvents.push(
          args.includes("--download-db-only")
            ? "database:vulnerability"
            : "database:java",
        );
        assert.equal(
          args[args.indexOf("--network") + 1],
          "coffee_platform_build_mtu",
        );
        const cacheMount = args.find((argument) =>
          String(argument).includes("dst=/cache"),
        );
        scanCache = String(cacheMount).match(/src=([^,]+)/u)?.[1];
        assert.ok(scanCache);
        if (
          failDatabaseDownload &&
          args.includes(failDatabaseDownload.argument)
        ) {
          failDatabaseDownload = null;
          throw Object.assign(
            new Error("synthetic TLS failure; token=private-canary"),
            {
              code: "COMMAND_FAILED",
              safeDiagnostic: {
                exitCode: 17,
                signal: null,
                stderrClass: "TLS_FAILURE",
                stderrSha256: createHash("sha256")
                  .update("synthetic TLS failure; token=private-canary")
                  .digest("hex"),
                stderrBytes: Buffer.byteLength(
                  "synthetic TLS failure; token=private-canary",
                ),
                stderrTruncated: false,
              },
            },
          );
        }
        await mkdir(join(scanCache, "db"), { recursive: true });
        await mkdir(join(scanCache, "java-db"), { recursive: true });
        await writeFile(join(scanCache, "db/metadata.json"), freshDb());
        await writeFile(
          join(scanCache, "db/trivy.db"),
          "synthetic-vulnerability-db",
        );
        await writeFile(join(scanCache, "java-db/metadata.json"), freshDb());
        await writeFile(
          join(scanCache, "java-db/trivy-java.db"),
          "synthetic-java-database",
        );
        fakeNow += databaseAdvanceMs;
        return capture ? "" : undefined;
      }
      if (args[0] === "image" && args[1] === "save") {
        assert.match(args[2], /^sha256:[0-9a-f]{64}$/u);
        if (lastProductLayoutPath) {
          await assert.rejects(lstat(lastProductLayoutPath), {
            code: "ENOENT",
          });
          lastProductLayoutPath = undefined;
        }
        if (lastUpstreamTarPath) {
          await assert.rejects(lstat(lastUpstreamTarPath), {
            code: "ENOENT",
          });
          lastUpstreamTarPath = undefined;
        }
        const service = args[4]
          .split("/")
          .at(-1)
          .replace(/\.tar$/u, "");
        flowEvents.push(`save:${service}`);
        lastUpstreamTarPath = args[4];
        scannedImageIds.set(service, args[2]);
        await writeFile(args[4], "synthetic-image-tar");
        imageExports += 1;
        return;
      }
      if (args[0] === "run") {
        const conversion = args.includes("convert");
        const report = args[args.indexOf("--output") + 1].replace("/out/", "");
        if (report.startsWith("lockfile.")) flowEvents.push("manifest-report");
        else flowEvents.push(`image-report:${report}`);
        if (report === failScanReport) {
          failScanReport = null;
          throw Object.assign(
            new Error("synthetic image scan failed; token=private-canary"),
            {
              code: "COMMAND_FAILED",
              safeDiagnostic: {
                exitCode: 23,
                signal: null,
                stderrClass: "TLS_FAILURE",
                stderrSha256: createHash("sha256")
                  .update("synthetic image scan failed; token=private-canary")
                  .digest("hex"),
                stderrBytes: Buffer.byteLength(
                  "synthetic image scan failed; token=private-canary",
                ),
                stderrTruncated: false,
              },
            },
          );
        }
        const outputMount = args.find((argument) =>
          String(argument).includes("dst=/out"),
        );
        const outputRoot = String(outputMount).match(/src=([^,]+)/u)?.[1];
        assert.ok(outputRoot);
        if (conversion) {
          conversionRuns += 1;
          const cacheMount = args.find((argument) =>
            String(argument).includes("dst=/cache"),
          );
          const conversionCache = String(cacheMount).match(/src=([^,]+)/u)?.[1];
          assert.ok(conversionCache);
          assert.notEqual(conversionCache, scanCache);
          assert.deepEqual(await readdir(conversionCache), []);
          conversionCacheDirs.add(conversionCache);
          const mounts = args.flatMap((argument, index) =>
            argument === "--mount" ? [args[index + 1]] : [],
          );
          assert.equal(mounts.length, 3);
          assert.equal(
            mounts.some((mount) => mount.includes("docker.sock")),
            false,
          );
          assert.equal(
            mounts.some((mount) => mount.includes(scanCache)),
            false,
          );
          assert.equal(
            mounts
              .find((mount) => mount.includes("dst=/scan/report.json"))
              ?.endsWith(",readonly"),
            true,
          );
          assert.deepEqual(
            args.slice(args.indexOf("--format"), args.indexOf("--format") + 2),
            ["--format", "cyclonedx"],
          );
          assert.ok(!args.includes("--scanners"));
          const inputMount = args.find((argument) =>
            String(argument).includes("dst=/scan/report.json"),
          );
          assert.ok(inputMount?.endsWith(",readonly"));
          const inputPath = String(inputMount).match(/src=([^,]+)/u)?.[1];
          assert.ok(!inputPath.startsWith(`${outputRoot}/`));
          const sourceReport = JSON.parse(await readFile(inputPath, "utf8"));
          const components = sourceReport.Results.flatMap((result) =>
            (result.Packages ?? []).map((pkg) => ({
              type: "library",
              name: pkg.Name,
              version: pkg.Version,
              purl: pkg.Identifier.PURL,
            })),
          );
          components.push(
            { type: "operating-system", name: "debian", version: "12.15" },
            { type: "file", name: "pnpm-lock.yaml" },
          );
          if (
            omitConvertedPackage &&
            report.startsWith(`${RUNTIME_NAMES[0]}.`)
          ) {
            const missingPackage = components.findIndex((component) =>
              component.name.startsWith("synthetic-extra-"),
            );
            assert.notEqual(missingPackage, -1);
            components.splice(missingPackage, 1);
            omitConvertedPackage = false;
          }
          await writeFile(
            join(outputRoot, report),
            JSON.stringify({
              bomFormat: "CycloneDX",
              components,
              metadata: {
                component: {
                  properties: sourceReport.Metadata?.ImageID
                    ? [
                        {
                          name: "aquasecurity:trivy:ImageID",
                          value: sourceReport.Metadata.ImageID,
                        },
                      ]
                    : [],
                },
              },
            }),
          );
        } else {
          analysisRuns += 1;
          const service = report.slice(0, report.indexOf("."));
          if (["kafka", "storage-helper"].includes(service)) {
            const expectedOci = productOciExpectations.get(service);
            assert.ok(expectedOci, `${service} OCI fixture exists before scan`);
            const imageMount = args
              .flatMap((argument, index) =>
                argument === "--mount" ? [args[index + 1]] : [],
              )
              .find((mount) => mount.includes("dst=/scan/image"));
            const imageLayout = String(imageMount).match(/src=([^,]+)/u)?.[1];
            assert.equal(imageLayout, expectedOci.layout);
            const compatibilityManifestPath = join(
              imageLayout,
              "manifest.json",
            );
            const compatibilityManifestBytes = await readFile(
              compatibilityManifestPath,
            );
            const compatibilityManifest = JSON.parse(
              compatibilityManifestBytes.toString("utf8"),
            );
            assert.deepEqual(compatibilityManifest, [
              {
                Config: `blobs/sha256/${configDigest.slice(7)}`,
                RepoTags: [expectedOci.tag],
                Layers: [`blobs/sha256/${ociLayerDigest.slice(7)}`],
              },
            ]);
            assert.equal(
              (await stat(compatibilityManifestPath)).mode & 0o777,
              0o600,
            );
            assert.deepEqual(
              await readFile(
                join(
                  imageLayout,
                  `blobs/sha256/${expectedOci.indexDigest.slice(7)}`,
                ),
              ),
              expectedOci.indexBytes,
            );
            assert.deepEqual(
              await readFile(
                join(
                  imageLayout,
                  `blobs/sha256/${expectedOci.manifestDigest.slice(7)}`,
                ),
              ),
              expectedOci.manifestBytes,
            );
            assert.equal(sha(ociConfigBytes), configDigest.slice(7));
            assert.equal(sha(ociLayerBytes), ociLayerDigest.slice(7));
          }
          const vulnerabilities = [];
          if (report === `${findingService}.vulnerabilities.json`) {
            if (highFinding) vulnerabilities.push({ Severity: "HIGH" });
            if (criticalFinding) vulnerabilities.push({ Severity: "CRITICAL" });
          }
          const packageRow = {
            Name: `synthetic-${service}`,
            Version: "1.0.0",
            Identifier: { PURL: `pkg:generic/${service}@1.0.0` },
            Licenses: ["MIT"],
            DependsOn: [],
            Layer: { DiffID: imageDigest },
          };
          const packages = [
            packageRow,
            { ...packageRow },
            {
              ...packageRow,
              Name: `synthetic-extra-${service}`,
              Version: "2.0.0",
              Identifier: { PURL: `pkg:generic/extra-${service}@2.0.0` },
            },
          ];
          const reportPath = join(outputRoot, report);
          await writeFile(
            reportPath,
            JSON.stringify({
              Results: [
                { Packages: packages, Vulnerabilities: vulnerabilities },
              ],
              Metadata: report.startsWith("lockfile.")
                ? {}
                : { ImageID: scannedImageIds.get(service) ?? configDigest },
            }),
          );
          if (report.endsWith(".vulnerabilities.json")) {
            await chmod(reportPath, 0o644);
            trivyVulnerabilityModes.push((await stat(reportPath)).mode & 0o777);
          }
          if (
            tamperDbDuringVulnerabilityScan &&
            report === `${RUNTIME_NAMES[0]}.vulnerabilities.json`
          ) {
            await writeFile(
              join(scanCache, "db/trivy.db"),
              "xynthetic-vulnerability-db",
            );
            dbTampered = true;
            tamperDbDuringVulnerabilityScan = false;
          }
        }
        reportWrites += 1;
        if (
          tamperDbOnFirstScan &&
          !dbTampered &&
          report === "tempo.sbom.cdx.json"
        ) {
          await writeFile(
            join(scanCache, "db/trivy.db"),
            "xynthetic-vulnerability-db",
          );
          dbTampered = true;
        }
        if (
          replaceImageOnFirstScanReference &&
          report === "otel-collector.sbom.cdx.json"
        ) {
          replacedImageIds.set(
            replaceImageOnFirstScanReference,
            `sha256:${"d".repeat(64)}`,
          );
          replaceImageOnFirstScanReference = null;
        }
        if (
          foreignAliasOnFirstScanReference &&
          report === "otel-collector.sbom.cdx.json"
        ) {
          const alias = "foreign.example/shared-image:latest";
          imageIdsByRef.set(
            alias,
            imageIdsByRef.get(foreignAliasOnFirstScanReference),
          );
          pulledRefs.add(alias);
          foreignAliasOnFirstScanReference = null;
        }
        fakeNow += scanAdvanceMs;
        return;
      }
      assert.fail(
        `unexpected synthetic command shape: ${args.slice(0, 4).join(" ")}`,
      );
    } catch (error) {
      fakeError = error;
      throw error;
    } finally {
      if (launchedContainer && !keepContainer)
        fakeContainers.delete(launchedContainer.name);
    }
  };
  const removeImageInput = async (path, options) => {
    if (failImageInputRemoval && path.endsWith(`${RUNTIME_NAMES[0]}.oci`)) {
      failImageInputRemoval = false;
      throw Object.assign(new Error("synthetic image input removal failure"), {
        code: "EACCES",
      });
    }
    return rm(path, options);
  };
  const initialFlowStart = flowEvents.length;
  const initialTimeoutStart = trivyRunTimeouts.length;
  databaseAdvanceMs = 5 * 60_000;
  const result = await runSecurityScan({
    contextFile: contextPath,
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner.lock"),
  });
  databaseAdvanceMs = 0;
  assert.equal(
    result.status,
    "PASS",
    `${result.code} ${fakeError?.message ?? ""} ${fakeError?.stack ?? ""}`,
  );
  assert.equal(result.code, "G12_SCAN_CLEAN");
  assert.deepEqual(trivyRunNetworks.slice(0, 2), [
    { kind: "version", network: "none" },
    { kind: "vulnerability-database", network: "coffee_platform_build_mtu" },
  ]);
  assert.deepEqual(
    trivyRunNetworks.filter((run) => run.kind === "java-database"),
    [{ kind: "java-database", network: "coffee_platform_build_mtu" }],
  );
  assert.deepEqual(
    trivyRunTimeouts
      .slice(initialTimeoutStart)
      .filter(({ kind }) =>
        ["vulnerability-database", "java-database"].includes(kind),
      ),
    [
      { kind: "vulnerability-database", timeoutMs: 30 * 60_000 },
      { kind: "java-database", timeoutMs: 25 * 60_000 },
    ],
  );
  assert.ok(
    trivyRunTimeouts
      .filter(
        ({ kind }) =>
          !["vulnerability-database", "java-database"].includes(kind),
      )
      .every(({ timeoutMs }) => timeoutMs === undefined),
  );
  assert.deepEqual(
    trivyRunProfiles.filter((run) =>
      ["vulnerability-database", "java-database"].includes(run.kind),
    ),
    [
      {
        kind: "vulnerability-database",
        user: `${process.getuid()}:${process.getgid()}`,
        tmpdir: "TMPDIR=/cache",
        env: ["TMPDIR=/cache", "GODEBUG=http2client=0"],
      },
      {
        kind: "java-database",
        user: `${process.getuid()}:${process.getgid()}`,
        tmpdir: "TMPDIR=/cache",
        env: ["TMPDIR=/cache", "GODEBUG=http2client=0"],
      },
    ],
  );
  assert.ok(
    trivyRunProfiles
      .filter((run) =>
        ["version", "manifest-scan", "image-scan"].includes(run.kind),
      )
      .every((run) => run.user === `${process.getuid()}:${process.getgid()}`),
  );
  assert.ok(
    trivyRunProfiles
      .filter(
        (run) =>
          !["vulnerability-database", "java-database"].includes(run.kind),
      )
      .every((run) => !run.env.includes("GODEBUG=http2client=0")),
  );
  assert.ok(
    trivyRunProfiles
      .filter((run) => run.kind === "version")
      .every((run) => run.tmpdir === null),
  );
  assert.ok(
    trivyRunProfiles
      .filter((run) => run.kind === "manifest-scan")
      .every((run) => run.tmpdir === null),
  );
  assert.ok(
    trivyRunProfiles
      .filter((run) => run.kind === "image-scan")
      .every((run) => run.tmpdir === "TMPDIR=/cache"),
  );
  assert.ok(
    trivyRunNetworks
      .filter((run) => ["manifest-scan", "image-scan"].includes(run.kind))
      .every((run) => run.network === "none"),
  );
  assert.equal(
    trivyRunNetworks.filter((run) => run.kind === "conversion").length,
    23,
  );
  assert.ok(
    trivyRunNetworks
      .filter((run) => run.kind === "conversion")
      .every((run) => run.network === "none"),
  );
  assert.equal(result.reports.length, 46);
  assert.equal(trivyVulnerabilityModes.length, 23);
  assert.ok(trivyVulnerabilityModes.every((mode) => mode === 0o644));
  for (const report of result.reports) {
    const reportPath = join(outputDir, "artifacts", report.path);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600, report.path);
    assert.equal(sha(await readFile(reportPath)), report.sha256, report.path);
  }
  assert.equal(reportWrites, 46);
  assert.equal(analysisRuns, 23);
  assert.equal(conversionRuns, 23);
  assert.equal(conversionCacheDirs.size, 23);
  assert.deepEqual(
    result.databases.map(({ name }) => name),
    ["db", "java-db"],
  );
  const initialFlow = flowEvents.slice(initialFlowStart);
  const firstProductBuild = initialFlow.findIndex((event) =>
    event.startsWith("build:"),
  );
  assert.ok(initialFlow.indexOf("database:vulnerability") < firstProductBuild);
  assert.ok(initialFlow.indexOf("database:java") < firstProductBuild);
  assert.ok(initialFlow.indexOf("manifest-report") < firstProductBuild);
  const productBuildEvents = initialFlow.filter((event) =>
    event.startsWith("build:"),
  );
  for (const event of productBuildEvents) {
    const service = event.slice("build:".length);
    const buildIndex = initialFlow.indexOf(event);
    const nextProductBuild = initialFlow.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > buildIndex && candidate.startsWith("build:"),
    );
    const boundary =
      nextProductBuild >= 0 ? nextProductBuild : initialFlow.length;
    const sbomIndex = initialFlow.indexOf(
      `image-report:${service}.sbom.cdx.json`,
    );
    const vulnerabilityIndex = initialFlow.indexOf(
      `image-report:${service}.vulnerabilities.json`,
    );
    assert.ok(
      buildIndex < vulnerabilityIndex && vulnerabilityIndex < sbomIndex,
    );
    assert.ok(sbomIndex < boundary);
  }
  for (const service of [
    "otel-collector",
    "grafana",
    "loki",
    "prometheus",
    "tempo",
  ]) {
    const saveIndex = initialFlow.indexOf(`save:${service}`);
    const nextSave = initialFlow.findIndex(
      (event, index) => index > saveIndex && event.startsWith("save:"),
    );
    const boundary = nextSave >= 0 ? nextSave : initialFlow.length;
    const sbomIndex = initialFlow.indexOf(
      `image-report:${service}.sbom.cdx.json`,
    );
    const vulnerabilityIndex = initialFlow.indexOf(
      `image-report:${service}.vulnerabilities.json`,
    );
    assert.ok(saveIndex < vulnerabilityIndex && vulnerabilityIndex < sbomIndex);
    assert.ok(sbomIndex < boundary);
  }
  assert.equal(lastProductLayoutPath, undefined);
  await assert.rejects(lstat(lastUpstreamTarPath), { code: "ENOENT" });
  assert.equal(imageExports, 5);
  assert.equal(productBuilds, 17);
  assert.deepEqual(
    [...builtServices].sort((a, b) => a.localeCompare(b, "en")),
    [...RUNTIME_NAMES, "storage-helper", "edge-nginx", "kafka"].sort((a, b) =>
      a.localeCompare(b, "en"),
    ),
  );
  assert.equal(upstreamPulls, 6);
  assert.equal(imageRemovals, 6);
  assert.equal(
    imageRmTargets.every((target) => /^sha256:[0-9a-f]{64}$/u.test(target)),
    true,
  );
  assert.equal(result.imageCleanup.length, 6);
  assert.ok(
    result.imageCleanup.every(
      (image) =>
        /^sha256:[0-9a-f]{64}$/u.test(image.expectedImageId) &&
        image.observedImageId === null &&
        image.action === "remove-image-id" &&
        image.outcome === "absent-after-removal",
    ),
  );
  assert.equal(result.findings.high + result.findings.critical, 0);
  assert.deepEqual(await readdir(outputDir), ["artifacts", "result.json"]);
  assert.ok(
    (await readdir(join(outputDir, "artifacts"))).includes("checksums.json"),
  );
  const savedResult = await readFile(
    join(outputDir, "result.json"),
    "utf8",
  ).then(JSON.parse);
  assert.equal(savedResult.code, "G12_SCAN_CLEAN");
  assert.equal(savedResult.provenance.status, "PASS");
  assert.deepEqual(Object.keys(savedResult.kafka).sort(), [
    "imageId",
    "importTag",
    "manifestDigest",
    "ociArtifactPath",
    "ociArtifactSha256",
    "path",
    "receiptSha256",
  ]);
  const storageReceiptPath = join(
    outputDir,
    "artifacts/storage-helper-receipt.json",
  );
  const storageReceiptBytes = await readFile(storageReceiptPath);
  const storageReceipt = JSON.parse(storageReceiptBytes);
  const storageArchive = await readFile(
    join(outputDir, "artifacts/storage-helper.oci.tar"),
  );
  const verifiedStorage = await loadVerifiedGateImage({
    target: "storage-helper",
    contextFile: contextPath,
    validateContext: validateSyntheticContext,
    loadImage: false,
  });
  assert.equal(verifiedStorage.imageId, storageReceipt.imageId);
  assert.equal(verifiedStorage.receiptSha256, sha(storageReceiptBytes));
  assert.equal(storageReceipt.baseImage, toolchain.nodeImage);
  assert.deepEqual(storageReceipt.baseMaterial, storageHelperBaseMaterial);
  assert.equal(
    storageReceipt.buildInputBinding.invocation.target,
    "storage-helper",
  );
  const badReceiptBytes = Buffer.from(
    JSON.stringify({ ...storageReceipt, baseImage: toolchain.kafkaImage }),
  );
  const resultPath = join(outputDir, "result.json");
  const resultBytes = await readFile(resultPath);
  await writeFile(storageReceiptPath, badReceiptBytes);
  await writeFile(
    resultPath,
    JSON.stringify({
      ...savedResult,
      storageHelper: {
        ...savedResult.storageHelper,
        receiptSha256: sha(badReceiptBytes),
      },
    }),
  );
  await assert.rejects(
    loadVerifiedGateImage({
      target: "storage-helper",
      contextFile: contextPath,
      validateContext: validateSyntheticContext,
      loadImage: false,
    }),
    /G12_KAFKA_RECEIPT_INVALID/u,
  );
  await writeFile(storageReceiptPath, storageReceiptBytes);
  await writeFile(resultPath, resultBytes);
  const kafkaReceiptBytes = await readFile(
    join(outputDir, "artifacts/kafka-receipt.json"),
  );
  const kafkaReceipt = JSON.parse(kafkaReceiptBytes);
  const kafkaArchive = await readFile(
    join(outputDir, "artifacts/kafka.oci.tar"),
  );
  assert.equal(sha(kafkaReceiptBytes), savedResult.kafka.receiptSha256);
  assert.equal(sha(kafkaArchive), kafkaReceipt.ociArtifact.sha256);
  assert.equal(kafkaReceipt.ociArtifact.sizeBytes, kafkaArchive.length);
  const verifiedKafka = await loadVerifiedGateImage({
    target: "kafka",
    contextFile: contextPath,
    validateContext: validateSyntheticContext,
    loadImage: false,
  });
  assert.equal(verifiedKafka.imageId, kafkaReceipt.imageId);
  assert.equal(verifiedKafka.receiptSha256, savedResult.kafka.receiptSha256);
  assert.equal(kafkaReceipt.target, "kafka");
  assert.equal(kafkaReceipt.baseImage, toolchain.kafkaImage);
  assert.deepEqual(kafkaReceipt.baseMaterial, kafkaBaseMaterial);
  assert.deepEqual(
    Object.keys(kafkaReceipt).sort(),
    [
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
    ].sort(),
  );
  const verifyClassicArchive = async (service, archiveBytes, receipt) => {
    const manifestBytes = execFileSync(
      "tar",
      [
        "-xOf",
        join(outputDir, "artifacts", `${service}.oci.tar`),
        "./manifest.json",
      ],
      { encoding: null },
    );
    assert.deepEqual(JSON.parse(manifestBytes.toString("utf8")), [
      {
        Config: `blobs/sha256/${configDigest.slice(7)}`,
        RepoTags: [
          `coffee-g12-${sha(Buffer.from(runId)).slice(0, 12)}-${service}:latest`,
        ],
        Layers: [`blobs/sha256/${ociLayerDigest.slice(7)}`],
      },
    ]);
    assert.equal(
      sha(
        execFileSync(
          "tar",
          [
            "-xOf",
            join(outputDir, "artifacts", `${service}.oci.tar`),
            `./blobs/sha256/${configDigest.slice(7)}`,
          ],
          { encoding: null },
        ),
      ),
      configDigest.slice(7),
    );
    assert.equal(
      sha(
        execFileSync(
          "tar",
          [
            "-xOf",
            join(outputDir, "artifacts", `${service}.oci.tar`),
            `./blobs/sha256/${ociLayerDigest.slice(7)}`,
          ],
          { encoding: null },
        ),
      ),
      ociLayerDigest.slice(7),
    );
    assert.match(receipt.ociArtifact.layoutTreeSha256, /^[0-9a-f]{64}$/u);
    assert.ok(receipt.ociArtifact.layoutBytes > manifestBytes.length);
    assert.equal(sha(archiveBytes), receipt.ociArtifact.sha256);
  };
  await verifyClassicArchive("kafka", kafkaArchive, kafkaReceipt);
  await verifyClassicArchive("storage-helper", storageArchive, storageReceipt);
  assert.deepEqual(
    await readFile(join(outputDir, "artifacts/storage-helper-base-index.json")),
    nodeBaseIndexBytes,
  );
  assert.equal(
    (
      await readFile(join(outputDir, "artifacts/kafka-base-index.json"))
    ).toString(),
    kafkaBaseIndexBytes.toString(),
  );
  assert.match(savedResult.databases[0].contentSha256, /^[0-9a-f]{64}$/u);
  assert.match(savedResult.databases[1].contentSha256, /^[0-9a-f]{64}$/u);
  assert.ok(
    savedResult.databases.every((database) => database.contentBytes > 0),
  );
  assert.equal(
    savedResult.provenance.buildInputBinding.sourceKind,
    "git-archive-local-context",
  );
  assert.equal(savedResult.provenance.images.length, 22);
  assert.deepEqual(
    savedResult.provenance.images.find((image) => image.service === "kafka")
      .baseMaterial,
    kafkaBaseMaterial,
  );
  const checksumInventory = JSON.parse(
    await readFile(join(outputDir, "artifacts/checksums.json"), "utf8"),
  );
  assert.equal(checksumInventory.length, 52);
  assert.ok(
    checksumInventory.some(
      (entry) =>
        entry.path === "artifacts/kafka-base-index.json" &&
        entry.sha256 === kafkaBaseMaterial.indexArtifact.sha256,
    ),
  );
  assert.equal(
    savedResult.provenance.buildInputBinding.buildkitMaterialsCompleteness,
    "INCOMPLETE_LOCAL_CONTEXT",
  );
  assert.match(
    savedResult.provenance.buildInputBinding.archiveSha256,
    /^[0-9a-f]{64}$/u,
  );
  assert.equal(savedResult.provenance.buildInputBinding.sourceTreeSha, treeSha);
  assert.match(
    savedResult.provenance.buildInputBinding.extractedTreeSha256,
    /^[0-9a-f]{64}$/u,
  );
  assert.deepEqual(
    savedResult.provenance.images
      .filter((image) => image.identityStatus)
      .map((image) => [image.service, image.identityStatus]),
    ["otel-collector", "grafana", "loki", "prometheus", "tempo"].map((name) => [
      name,
      "PINNED_DIGEST_VERIFIED",
    ]),
  );
  assert.deepEqual(
    savedResult.provenance.images
      .filter((image) => image.identityStatus)
      .map((image) => image.sourceReference),
    [
      toolchain.otelCollectorImage,
      toolchain.grafanaImage,
      toolchain.lokiImage,
      toolchain.prometheusImage,
      toolchain.tempoImage,
    ],
  );
  assert.deepEqual(
    await readFile(join(gateDir, "result.json")),
    runnerResultBytes,
  );
  assert.deepEqual(await readFile(join(gateDir, "stdout.log")), runnerLogBytes);
  assert.deepEqual(await readFile(join(gateDir, "stderr.log")), runnerLogBytes);
  assert.deepEqual(
    await readFile(join(gateArtifactsDir, "preexisting.json")),
    runnerResultBytes,
  );
  assert.ok(scanCache);
  await assert.rejects(readFile(scanCache), { code: "ENOENT" });

  fakeNow = now;
  mismatchDigestReference = toolchain.lokiImage;
  const mismatchedBackend = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-upstream-digest-mismatch"),
    clock: () => now,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-upstream-digest-mismatch.lock"),
  });
  assert.equal(mismatchedBackend.status, "FAIL");
  assert.equal(mismatchedBackend.code, "UPSTREAM_IMAGE_DIGEST_INVALID");
  assert.equal(mismatchedBackend.kafka, null);
  assert.equal(
    mismatchedBackend.provenance.images.some(
      (image) => image.service === "loki",
    ),
    false,
  );
  mismatchDigestReference = null;

  fakeNow = now;
  databaseAdvanceMs = 30 * 60_000;
  const exhaustedTimeoutStart = trivyRunTimeouts.length;
  const exhaustedDatabaseStart = trivyRunNetworks.filter((run) =>
    ["vulnerability-database", "java-database"].includes(run.kind),
  ).length;
  const exhaustedResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-db-budget-exhausted"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-db-budget-exhausted.lock"),
  });
  databaseAdvanceMs = 0;
  fakeNow = now;
  assert.equal(exhaustedResult.status, "FAIL");
  assert.equal(exhaustedResult.code, "COMMAND_TIMEOUT");
  assert.equal(exhaustedResult.failure.code, "COMMAND_TIMEOUT");
  assert.equal(exhaustedResult.failure.diagnostic.substage, "java-db");
  assert.equal(exhaustedResult.failure.diagnostic.exitCode, null);
  assert.equal(exhaustedResult.failure.diagnostic.signal, null);
  assert.equal(exhaustedResult.failure.diagnostic.stderrClass, "UNCLASSIFIED");
  assert.deepEqual(
    trivyRunTimeouts
      .slice(exhaustedTimeoutStart)
      .filter(({ kind }) =>
        ["vulnerability-database", "java-database"].includes(kind),
      ),
    [{ kind: "vulnerability-database", timeoutMs: 30 * 60_000 }],
  );
  assert.equal(
    trivyRunNetworks.filter((run) =>
      ["vulnerability-database", "java-database"].includes(run.kind),
    ).length - exhaustedDatabaseStart,
    1,
  );
  assert.deepEqual(exhaustedResult.cleanupFailures, []);
  const exhaustedOutputDir = join(
    gateArtifactsDir,
    "supply-chain-db-budget-exhausted",
  );
  assert.equal(
    JSON.parse(await readFile(join(exhaustedOutputDir, "result.json"), "utf8"))
      .code,
    "COMMAND_TIMEOUT",
  );
  await assert.rejects(lstat(scanCache), { code: "ENOENT" });
  await assert.rejects(lstat(join(temp, "scanner-db-budget-exhausted.lock")), {
    code: "ENOENT",
  });

  failPullReference = toolchain.otelCollectorImage;
  const removalsBeforePullFailure = imageRmTargets.length;
  const failedPullResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-pull-failure"),
    clock: () => now,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-pull-failure.lock"),
  });
  assert.equal(failedPullResult.status, "FAIL");
  assert.deepEqual(failedPullResult.failure, {
    code: "COMMAND_FAILED",
    stage: "upstream-image-load",
  });
  assert.equal(failedPullResult.code, "COMMAND_FAILED");
  assert.deepEqual(failedPullResult.cleanupFailures, []);
  assert.equal(failedPullResult.reports.length, 36);
  assert.equal(failedPullResult.provenance.status, "PARTIAL");
  assert.equal(
    failedPullResult.provenance.images.filter((image) => !image.identityStatus)
      .length,
    17,
  );
  assert.equal(imageRmTargets.length, removalsBeforePullFailure + 1);
  assert.deepEqual(
    failedPullResult.imageCleanup.filter(
      (image) => image.reference === toolchain.otelCollectorImage,
    ),
    [
      {
        reference: toolchain.otelCollectorImage,
        expectedImageId: null,
        observedImageId: null,
        action: "inspect-reference",
        outcome: "already-absent",
      },
    ],
  );
  const failedPullReceipt = await readFile(
    join(gateArtifactsDir, "supply-chain-pull-failure", "result.json"),
    "utf8",
  );
  assert.equal(failedPullReceipt.includes("synthetic pull failed"), false);
  failPullReference = null;

  failPullReference = toolchain.otelCollectorImage;
  failPullLeavesImage = true;
  const removalsBeforePartialPullFailure = imageRmTargets.length;
  const partialPullResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-partial-pull-failure"),
    clock: () => now,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-partial-pull-failure.lock"),
  });
  assert.equal(partialPullResult.status, "FAIL");
  assert.deepEqual(partialPullResult.failure, {
    code: "COMMAND_FAILED",
    stage: "upstream-image-load",
  });
  assert.deepEqual(partialPullResult.cleanupFailures, [
    { code: "IMAGE_OWNERSHIP_UNCONFIRMED", stage: "image-cleanup" },
  ]);
  assert.equal(imageRmTargets.length, removalsBeforePartialPullFailure + 1);
  assert.deepEqual(
    partialPullResult.imageCleanup.filter(
      (image) => image.reference === toolchain.otelCollectorImage,
    ),
    [
      {
        reference: toolchain.otelCollectorImage,
        expectedImageId: null,
        observedImageId: imageIdForReference(toolchain.otelCollectorImage),
        action: "retain",
        outcome: "ownership-unconfirmed",
      },
    ],
  );
  assert.equal(pulledRefs.has(toolchain.otelCollectorImage), true);
  const partialPullReceipt = await readFile(
    join(gateArtifactsDir, "supply-chain-partial-pull-failure", "result.json"),
    "utf8",
  ).then(JSON.parse);
  assert.equal(partialPullReceipt.failure.code, "COMMAND_FAILED");
  assert.equal(
    partialPullReceipt.cleanupFailures[0].code,
    "IMAGE_OWNERSHIP_UNCONFIRMED",
  );
  assert.deepEqual(
    partialPullReceipt.imageCleanup.find(
      (image) => image.reference === toolchain.otelCollectorImage,
    ),
    {
      reference: toolchain.otelCollectorImage,
      expectedImageId: null,
      observedImageId: imageIdForReference(toolchain.otelCollectorImage),
      action: "retain",
      outcome: "ownership-unconfirmed",
    },
  );
  pulledRefs.delete(toolchain.otelCollectorImage);
  failPullLeavesImage = false;
  failPullReference = null;

  fakeNow = now;
  buildAdvanceMs = 30_000;
  scanAdvanceMs = 60_000;
  databaseTtlMs = 2 * 60_000;
  const expiringDatabaseResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-expiring-db"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-expiring-db.lock"),
  });
  assert.equal(fakeNow >= now + databaseTtlMs, true);
  assert.equal(expiringDatabaseResult.status, "FAIL");
  assert.equal(
    expiringDatabaseResult.code,
    "VULNERABILITY_DB_STALE_OR_INVALID",
  );
  buildAdvanceMs = 0;
  scanAdvanceMs = 0;
  databaseTtlMs = 24 * 60 * 60 * 1_000;
  fakeNow = now;

  tamperDbDuringVulnerabilityScan = true;
  dbTampered = false;
  const immediateScanTamper = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-db-changed-during-scan"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-db-changed-during-scan.lock"),
  });
  assert.equal(immediateScanTamper.status, "FAIL");
  assert.equal(immediateScanTamper.code, "VULNERABILITY_DB_CHANGED");
  assert.deepEqual(immediateScanTamper.failure, {
    code: "VULNERABILITY_DB_CHANGED",
    stage: "image-scan",
  });
  assert.equal(dbTampered, true);

  tamperDbOnFirstScan = true;
  dbTampered = false;
  failImageRemovalReference = scannerReference;
  replaceImageOnFirstScanReference = toolchain.otelCollectorImage;
  foreignAliasOnFirstScanReference = scannerReference;
  const changedDatabaseRmStart = imageRmTargets.length;
  const changedDatabaseResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-db-changed"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-db-changed.lock"),
  });
  assert.equal(changedDatabaseResult.status, "FAIL");
  assert.equal(changedDatabaseResult.code, "VULNERABILITY_DB_CHANGED");
  assert.deepEqual(changedDatabaseResult.failure, {
    code: "VULNERABILITY_DB_CHANGED",
    stage: "vulnerability-db-final-check",
  });
  assert.deepEqual(
    changedDatabaseResult.cleanupFailures
      .map(({ code }) => code)
      .sort((left, right) => left.localeCompare(right, "en")),
    ["IMAGE_CLEANUP_FAILED", "IMAGE_OWNERSHIP_CHANGED"],
  );
  assert.equal(changedDatabaseResult.provenance.status, "PARTIAL");
  assert.equal(changedDatabaseResult.provenance.images.length, 22);
  const changedDatabaseRmTargets = imageRmTargets.slice(changedDatabaseRmStart);
  assert.ok(
    changedDatabaseRmTargets.every((target) =>
      /^sha256:[0-9a-f]{64}$/u.test(target),
    ),
  );
  assert.equal(
    changedDatabaseRmTargets.includes(
      imageIdForReference(toolchain.otelCollectorImage),
    ),
    false,
  );
  assert.equal(
    changedDatabaseRmTargets.includes(toolchain.otelCollectorImage),
    false,
  );
  assert.ok(
    changedDatabaseRmTargets.includes(imageIdForReference(scannerReference)),
  );
  const scannerCleanup = changedDatabaseResult.imageCleanup.find(
    (image) => image.reference === scannerReference,
  );
  assert.deepEqual(scannerCleanup, {
    reference: scannerReference,
    expectedImageId: imageIdForReference(scannerReference),
    observedImageId: imageIdForReference(scannerReference),
    action: "remove-image-id",
    outcome: "retained",
  });
  assert.equal(pulledRefs.has(toolchain.otelCollectorImage), true);
  assert.equal(pulledRefs.has(scannerReference), true);
  assert.equal(pulledRefs.has("foreign.example/shared-image:latest"), true);
  pulledRefs.delete(toolchain.otelCollectorImage);
  pulledRefs.delete(scannerReference);
  pulledRefs.delete("foreign.example/shared-image:latest");
  imageIdsByRef.delete("foreign.example/shared-image:latest");
  replacedImageIds.clear();
  failImageRemovalReference = null;
  assert.match(
    changedDatabaseResult.databases[0].contentSha256,
    /^[0-9a-f]{64}$/u,
  );

  highFinding = true;
  findingService = "grafana";
  tamperDbOnFirstScan = false;
  fakeNow = now;
  const highResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-high"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-high.lock"),
  });
  assert.equal(highResult.status, "FAIL");
  assert.equal(highResult.code, "HIGH_OR_CRITICAL_FINDINGS");
  assert.equal(highResult.findings.high, 1);
  assert.equal(highResult.kafka, null);
  findingService = RUNTIME_NAMES[0];

  omitConvertedPackage = true;
  const incompleteSbomResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-incomplete-sbom"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-incomplete-sbom.lock"),
  });
  assert.equal(incompleteSbomResult.status, "FAIL");
  assert.equal(incompleteSbomResult.code, "SBOM_PACKAGE_INVENTORY_MISMATCH");
  assert.equal(incompleteSbomResult.reports.length, 3);
  assert.equal(incompleteSbomResult.findings.high, 1);

  criticalFinding = true;
  failScanReport = `${RUNTIME_NAMES[1]}.sbom.cdx.json`;
  const partialFindingResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-partial-findings"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-partial-findings.lock"),
  });
  assert.equal(partialFindingResult.status, "FAIL");
  assert.equal(partialFindingResult.code, "COMMAND_FAILED");
  assert.equal(partialFindingResult.reports.length, 5);
  assert.deepEqual(partialFindingResult.findings, { high: 1, critical: 1 });
  assert.equal(partialFindingResult.provenance.status, "PARTIAL");
  const partialFindingReceipt = JSON.parse(
    await readFile(
      join(gateArtifactsDir, "supply-chain-partial-findings", "result.json"),
      "utf8",
    ),
  );
  assert.equal(partialFindingReceipt.status, "FAIL");
  assert.equal(partialFindingReceipt.reports.length, 5);
  assert.deepEqual(partialFindingReceipt.findings, {
    high: 1,
    critical: 1,
  });

  highFinding = false;
  criticalFinding = false;
  tamperOci = true;
  const tamperedResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-tampered"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-tampered.lock"),
  });
  assert.equal(tamperedResult.status, "FAIL");
  assert.equal(tamperedResult.code, "OCI_ATTESTATION_BLOB_INVALID");

  tamperOci = false;
  fakeNow = now;
  nextRunBehavior = { clientDies: true, onlyScan: true };
  const beforeOwnedCleanup = containerRmCalls;
  const timedOutResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-client-timeout"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-client-timeout.lock"),
  });
  assert.equal(timedOutResult.status, "FAIL");
  assert.equal(timedOutResult.code, "COMMAND_TIMEOUT");
  assert.equal(containerRmCalls, beforeOwnedCleanup + 1);
  const timedOutCleanup = containerRmObservations.filter(
    (observation) => observation.id === deadClientContainerId,
  );
  assert.equal(timedOutCleanup.length, 1);
  assert.equal(timedOutCleanup[0].name, deadClientContainerName);
  assert.equal(timedOutCleanup[0].cachePath, scanCache);
  assert.equal(timedOutCleanup[0].cacheExists, true);
  assert.equal(fakeContainers.size, 0);
  const timeoutReceipt = await readFile(
    join(gateArtifactsDir, "supply-chain-client-timeout", "result.json"),
    "utf8",
  );
  assert.equal(timeoutReceipt.includes("containerId"), false);
  assert.equal(timeoutReceipt.includes("synthetic client exited"), false);
  assert.equal(timeoutReceipt.includes(deadClientContainerId), false);

  nextRunBehavior = { clientDies: true, onlyScan: true, neverVisible: true };
  const beforeUnwitnessedCleanup = containerRmCalls;
  const beforeUnwitnessedImageCleanup = imageRemovals;
  const unwitnessedLock = join(temp, "scanner-unwitnessed-container.lock");
  let unwitnessedSequence = 0;
  const unwitnessedResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-unwitnessed-container"),
    clock: () => fakeNow,
    nonceFactory: () =>
      `90000000-0000-4000-8000-${String(++unwitnessedSequence).padStart(12, "0")}`,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: unwitnessedLock,
  });
  assert.equal(unwitnessedResult.status, "FAIL");
  assert.equal(unwitnessedResult.code, "COMMAND_TIMEOUT");
  assert.deepEqual(unwitnessedResult.failure, {
    code: "COMMAND_TIMEOUT",
    stage: "manifest-scan",
  });
  assert.deepEqual(unwitnessedResult.cleanupFailures, [
    { code: "CONTAINER_CLEANUP_FAILED", stage: "container-cleanup" },
  ]);
  assert.equal(containerRmCalls, beforeUnwitnessedCleanup);
  assert.equal(imageRemovals, beforeUnwitnessedImageCleanup);
  const unwitnessedContainer = [...fakeContainers.values()].find((container) =>
    container.nonce?.startsWith("90000000-0000-4000-8000-"),
  );
  assert.equal(unwitnessedContainer, undefined);
  assert.ok(unwitnessedContainerCandidate);
  assert.equal(
    containerRmObservations.some(
      (observation) => observation.id === unwitnessedContainerCandidate.id,
    ),
    false,
  );
  assert.equal(unwitnessedContainerCandidate.name, deadClientContainerName);
  const retainedUnwitnessedRoot = dirname(
    dirname(unwitnessedContainerCandidate.cidfile),
  );
  const retainedUnwitnessedCache = join(retainedUnwitnessedRoot, "cache");
  await assert.rejects(lstat(unwitnessedContainerCandidate.cidfile), {
    code: "ENOENT",
  });
  assert.equal((await lstat(retainedUnwitnessedRoot)).isDirectory(), true);
  assert.equal((await lstat(retainedUnwitnessedCache)).isDirectory(), true);
  assert.equal((await lstat(unwitnessedLock)).isFile(), true);
  await rm(retainedUnwitnessedRoot, { recursive: true, force: true });
  await rm(unwitnessedLock, { force: true });

  let mismatchSequence = 0;
  nextRunBehavior = { clientDies: true, onlyScan: true, owner: "FOREIGN" };
  const beforeMismatchRemoval = containerRmCalls;
  const mismatchResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-ownership-mismatch"),
    clock: () => fakeNow,
    nonceFactory: () =>
      `90000000-0000-4000-8000-${String(++mismatchSequence).padStart(12, "0")}`,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-ownership-mismatch.lock"),
  });
  assert.equal(mismatchResult.status, "FAIL");
  assert.equal(mismatchResult.code, "CONTAINER_OWNERSHIP_MISMATCH");
  assert.deepEqual(mismatchResult.failure, {
    code: "CONTAINER_OWNERSHIP_MISMATCH",
    stage: "manifest-scan",
  });
  assert.deepEqual(mismatchResult.cleanupFailures, [
    { code: "CONTAINER_CLEANUP_FAILED", stage: "container-cleanup" },
  ]);
  assert.equal(containerRmCalls, beforeMismatchRemoval);
  const mismatchedContainer = [...fakeContainers.values()].find(
    (container) => container.owner === "FOREIGN",
  );
  assert.ok(mismatchedContainer);
  const mismatchTemp = dirname(dirname(mismatchedContainer.cidfile));
  fakeContainers.delete(mismatchedContainer.name);
  await rm(mismatchTemp, { recursive: true, force: true });
  await rm(join(temp, "scanner-ownership-mismatch.lock"), { force: true });

  nextRunBehavior = { clientDies: true, onlyScan: true };
  failContainerRemoval = true;
  const beforeFailedRemoval = containerRmCalls;
  const failedCleanupResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-cleanup-failure"),
    clock: () => fakeNow,
    nonceFactory: () =>
      `90000000-0000-4000-8000-${String(++mismatchSequence).padStart(12, "0")}`,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-cleanup-failure.lock"),
  });
  assert.equal(failedCleanupResult.status, "FAIL");
  assert.equal(failedCleanupResult.code, "COMMAND_TIMEOUT");
  assert.deepEqual(failedCleanupResult.failure, {
    code: "COMMAND_TIMEOUT",
    stage: "manifest-scan",
  });
  assert.deepEqual(failedCleanupResult.cleanupFailures, [
    { code: "CONTAINER_CLEANUP_FAILED", stage: "container-cleanup" },
  ]);
  assert.equal(containerRmCalls, beforeFailedRemoval + 1);
  const retainedContainer = [...fakeContainers.values()][0];
  assert.ok(retainedContainer);
  const retainedTemp = dirname(dirname(retainedContainer.cidfile));
  const failedCleanupObservation = containerRmObservations.filter(
    (observation) => observation.id === retainedContainer.id,
  );
  assert.equal(failedCleanupObservation.length, 1);
  assert.equal(failedCleanupObservation[0].name, retainedContainer.name);
  assert.equal(
    failedCleanupObservation[0].cachePath,
    retainedContainer.cachePath,
  );
  assert.equal(failedCleanupObservation[0].cacheExists, true);
  assert.equal(retainedContainer.cachePath, join(retainedTemp, "cache"));
  assert.equal((await lstat(retainedTemp)).isDirectory(), true);
  assert.equal((await lstat(retainedContainer.cachePath)).isDirectory(), true);
  const failedCleanupLock = join(temp, "scanner-cleanup-failure.lock");
  assert.equal((await lstat(failedCleanupLock)).isFile(), true);
  fakeContainers.delete(retainedContainer.name);
  await rm(retainedTemp, { recursive: true, force: true });
  await rm(failedCleanupLock, { force: true });
  failContainerRemoval = false;

  const collisionNonce = "90000000-0000-4000-8000-000000000003";
  const collisionName = `coffee-g12-${collisionNonce}`;
  const collision = {
    id: "f".repeat(64),
    name: collisionName,
    imageId: configDigest,
    imageRef: "foreign:image",
    owner: "FOREIGN",
    runId: "foreign",
    nonce: "foreign",
  };
  fakeContainers.set(collisionName, collision);
  const beforeCollisionRemoval = containerRmCalls;
  const collisionResult = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-name-collision"),
    clock: () => fakeNow,
    nonceFactory: () => collisionNonce,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    lockPath: join(temp, "scanner-name-collision.lock"),
  });
  assert.equal(collisionResult.status, "FAIL");
  assert.equal(collisionResult.code, "CONTAINER_NAME_COLLISION");
  assert.equal(containerRmCalls, beforeCollisionRemoval);
  assert.equal(fakeContainers.get(collisionName), collision);
  fakeContainers.delete(collisionName);

  for (const scenario of [
    { argument: "--download-db-only", substage: "vulnerability-db" },
    { argument: "--download-java-db-only", substage: "java-db" },
  ]) {
    failDatabaseDownload = scenario;
    const output = join(
      gateArtifactsDir,
      `supply-chain-${scenario.substage}-failure`,
    );
    const lockPath = join(temp, `scanner-${scenario.substage}-failure.lock`);
    const failedDatabaseResult = await runSecurityScan({
      contextFile: contextPath,
      outputDir: output,
      clock: () => fakeNow,
      validateContext: validateSyntheticContext,
      run: fakeRun,
      statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
      lockPath,
    });
    assert.equal(failedDatabaseResult.code, "COMMAND_FAILED");
    assert.deepEqual(failedDatabaseResult.failure, {
      code: "COMMAND_FAILED",
      stage: "vulnerability-database",
      diagnostic: {
        substage: scenario.substage,
        exitCode: 17,
        signal: null,
        stderrClass: "TLS_FAILURE",
      },
    });
    assert.deepEqual(failedDatabaseResult.cleanupFailures, []);
    assert.equal(fakeContainers.size, 0);
    await assert.rejects(lstat(scanCache), { code: "ENOENT" });
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
    const failureReceipt = await readFile(join(output, "result.json"), "utf8");
    assert.equal(failureReceipt.includes("private-canary"), false);
    assert.equal(failureReceipt.includes("synthetic TLS failure"), false);
  }

  failScanReport = `${RUNTIME_NAMES[0]}.sbom.cdx.json`;
  failImageInputRemoval = true;
  const buildsBeforeImageScanFailure = productBuilds;
  const imageScanFailure = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-image-scan-failure"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    removeImageInput,
    lockPath: join(temp, "scanner-image-scan-failure.lock"),
  });
  assert.equal(imageScanFailure.status, "FAIL");
  assert.equal(imageScanFailure.code, "COMMAND_FAILED");
  assert.deepEqual(imageScanFailure.failure, {
    code: "COMMAND_FAILED",
    stage: "image-scan",
    diagnostic: {
      target: RUNTIME_NAMES[0],
      format: "cyclonedx",
      exitCode: 23,
      signal: null,
      stderrClass: "TLS_FAILURE",
      stderrSha256: createHash("sha256")
        .update("synthetic image scan failed; token=private-canary")
        .digest("hex"),
      stderrBytes: Buffer.byteLength(
        "synthetic image scan failed; token=private-canary",
      ),
      stderrTruncated: false,
    },
  });
  assert.deepEqual(imageScanFailure.cleanupFailures, [
    { code: "TEMP_CLEANUP_FAILED", stage: "temporary-cleanup" },
  ]);
  assert.equal(productBuilds, buildsBeforeImageScanFailure + 1);
  await assert.rejects(lstat(lastProductLayoutPath), { code: "ENOENT" });
  assert.equal(imageScanFailure.provenance.status, "PARTIAL");
  assert.equal(imageScanFailure.reports.length, 3);
  const imageScanFailureReceipt = await readFile(
    join(gateArtifactsDir, "supply-chain-image-scan-failure", "result.json"),
    "utf8",
  );
  assert.equal(imageScanFailureReceipt.includes("private-canary"), false);
  assert.equal(
    imageScanFailureReceipt.includes("synthetic image scan failed"),
    false,
  );

  failImageInputRemoval = true;
  const buildsBeforeImageCleanupFailure = productBuilds;
  const imageCleanupFailure = await runSecurityScan({
    contextFile: contextPath,
    outputDir: join(gateArtifactsDir, "supply-chain-image-cleanup-failure"),
    clock: () => fakeNow,
    validateContext: validateSyntheticContext,
    run: fakeRun,
    statfsFn: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
    removeImageInput,
    lockPath: join(temp, "scanner-image-cleanup-failure.lock"),
  });
  assert.equal(imageCleanupFailure.status, "FAIL");
  assert.equal(imageCleanupFailure.code, "TEMP_CLEANUP_FAILED");
  assert.deepEqual(imageCleanupFailure.failure, {
    code: "TEMP_CLEANUP_FAILED",
    stage: "temporary-cleanup",
  });
  assert.deepEqual(imageCleanupFailure.cleanupFailures, [
    { code: "TEMP_CLEANUP_FAILED", stage: "temporary-cleanup" },
  ]);
  assert.equal(productBuilds, buildsBeforeImageCleanupFailure + 1);
  assert.equal(imageCleanupFailure.reports.length, 4);
  assert.equal(imageCleanupFailure.provenance.status, "PARTIAL");
});
