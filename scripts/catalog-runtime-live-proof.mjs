import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  catalogBatchBytes,
  catalogBatchHash,
  catalogContentHash,
} from "../packages/contracts/aroma-v1/dist/index.js";

const root = resolve(import.meta.dirname, "..");
async function certificates(directory) {
  const command = (args) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  command([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=catalog-local-proof-ca",
    "-days",
    "1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  const caPem = await readFile(join(directory, "ca.crt"), "utf8");
  const result = {};
  for (const name of ["api-internal", "catalog-supplier-sync"]) {
    await writeFile(
      join(directory, `${name}.ext`),
      `subjectAltName=URI:spiffe://coffee-platform/development/${name}\nextendedKeyUsage=serverAuth,clientAuth\n`,
    );
    command([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
    ]);
    command([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      `${name}.ext`,
    ]);
    result[name] = {
      caPem,
      keyPem: await readFile(join(directory, `${name}.key`), "utf8"),
      certPem: await readFile(join(directory, `${name}.crt`), "utf8"),
    };
  }
  return result;
}
async function until(probe, description) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`timeout: ${description}`);
}
function child(input, children) {
  const process = fork(join(root, "tests/catalog/runtime-child.mjs"), [], {
    cwd: root,
    execArgv: ["--experimental-test-module-mocks"],
    silent: true,
  });
  children.push(process);
  let output = "";
  process.stdout.on("data", (value) => {
    output = (output + value).slice(-16000);
  });
  process.stderr.on("data", (value) => {
    output = (output + value).slice(-16000);
  });
  const exited = new Promise((resolveExit) =>
    process.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  const booted = Promise.race([
    once(process, "message").then(([message]) => message),
    exited.then((result) => {
      throw new Error(
        `runtime child exited: ${JSON.stringify(result)} ${output}`,
      );
    }),
  ]);
  process.send(input);
  return { process, booted, exited, output: () => output };
}

export async function proveProcessRestart({
  adminClient,
  port,
  runtimePassword,
  databaseName,
}) {
  const probeRoot = join(root, ".omh/probes");
  await mkdir(probeRoot, { recursive: true });
  const directory = await mkdtemp(join(probeRoot, "catalog-runtime-"));
  const children = [];
  let server;
  let lockHeld = false;
  try {
    const material = await certificates(directory);
    const leaf = material["api-internal"];
    let firstRef;
    let nextRef;
    let requests = 0;
    let oldStateBeforeExport;
    let handlerError;
    server = createServer(
      {
        key: leaf.keyPem,
        cert: leaf.certPem,
        ca: leaf.caPem,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
      (request, response) => {
        void (async () => {
          assert.equal(request.socket.authorized, true);
          assert.match(
            request.socket.getPeerCertificate().subjectaltname,
            /catalog-supplier-sync/u,
          );
          assert.equal(request.url, "/api/internal-v1/aroma/catalog-exports");
          assert.equal(request.method, "POST");
          assert.equal(request.headers.accept, "application/x-ndjson");
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requests++;
          const snapshotRef = body.snapshotRef;
          if (requests === 1) firstRef = snapshotRef;
          else {
            nextRef = snapshotRef;
            oldStateBeforeExport = (
              await adminClient.query(
                "SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
                [firstRef],
              )
            ).rows[0]?.state;
            assert.equal(
              oldStateBeforeExport,
              "Rejected",
              "recovery must finish before new HTTP export",
            );
          }
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          const send = (value) => response.write(JSON.stringify(value) + "\n");
          send({
            streamVersion: "1",
            recordType: "snapshot-started",
            snapshotRef,
            supplierRef: body.supplierRef,
            providerSnapshotRef: `fixture-${requests}`,
            startedAt: "2026-09-21T00:00:00Z",
          });
          if (requests === 1) {
            const items = [
              {
                sourceProductKeyHash: "a".repeat(64),
                sourceVariantKeyHash: "b".repeat(64),
                sourceOfferKeyHash: "c".repeat(64),
                displayName: "restart fixture",
                unit: "piece",
                supplierUnitMinor: "10",
                currency: "RUB",
                availability: "Available",
                imageUrl: null,
                sourceIdentityScheme: "hmac-sha256-v1",
              },
            ];
            send({
              streamVersion: "1",
              recordType: "snapshot-batch",
              snapshotRef,
              batchNumber: 0,
              offerCount: 1,
              uncompressedBytes: catalogBatchBytes(items),
              batchHash: catalogBatchHash(items),
              previousBatchHash: null,
              items,
            });
            // Deliberately keep the real HTTP stream open past a durable batch.
          } else {
            send({
              streamVersion: "1",
              recordType: "snapshot-completed",
              snapshotRef,
              batchCount: 0,
              productCount: 0,
              variantCount: 0,
              offerCount: 0,
              contentHash: catalogContentHash([]),
              completedAt: "2026-09-21T01:00:00Z",
            });
            response.end();
          }
        })().catch((error) => {
          handlerError = error;
          response.destroy();
        });
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const input = {
      apiPort: server.address().port,
      material: material["catalog-supplier-sync"],
      database: {
        database: databaseName,
        allowedDatabase: databaseName,
        host: "127.0.0.1",
        port,
        user: "coffee_catalog_import_rw",
        password: runtimePassword,
        ssl: false,
        shutdownGraceMs: 40000,
        pool: {
          max: 2,
          checkoutTimeoutMs: 2000,
          lockTimeoutMs: 5000,
          interactiveStatementTimeoutMs: 10000,
          backgroundStatementTimeoutMs: 10000,
          terminalTimeoutMs: 3000,
          transactionTimeoutMs: 20000,
          idleTimeoutMs: 30000,
          maxLifetimeMs: 1800000,
        },
      },
    };
    const first = child(input, children);
    const bootA = await first.booted;
    await until(async () => {
      if (handlerError) throw handlerError;
      if (!firstRef) return false;
      const row = (
        await adminClient.query(
          "SELECT state,next_batch_number FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
          [firstRef],
        )
      ).rows[0];
      return row?.state === "Receiving" && row.next_batch_number === 1;
    }, `first durable batch; ${first.output()}`);
    first.process.kill("SIGKILL");
    const killed = await first.exited;
    assert.equal(killed.signal, "SIGKILL");
    await adminClient.query("BEGIN");
    lockHeld = true;
    await adminClient.query(
      "SELECT snapshot_ref FROM catalog.supplier_snapshots WHERE snapshot_ref=$1 FOR UPDATE",
      [firstRef],
    );
    const second = child(input, children);
    const bootB = await second.booted;
    const startupReadyStatus = (
      await fetch(`http://127.0.0.1:${bootB.port}/health/ready`)
    ).status;
    assert.equal(startupReadyStatus, 503);
    assert.equal(requests, 1, "blocked recovery must not start HTTP export");
    await adminClient.query("ROLLBACK");
    lockHeld = false;
    await until(async () => {
      if (handlerError) throw handlerError;
      if (!nextRef) return false;
      return (
        (
          await adminClient.query(
            "SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
            [nextRef],
          )
        ).rows[0]?.state === "Received"
      );
    }, `second Received; ${second.output()}`);
    const recoveredReadyStatus = (
      await fetch(`http://127.0.0.1:${bootB.port}/health/ready`)
    ).status;
    assert.equal(recoveredReadyStatus, 200);
    const metrics = await (
      await fetch(`http://127.0.0.1:${bootB.port}/metrics`)
    ).text();
    assert.match(
      metrics,
      /coffee_catalog_import_results_total\{outcome="success"\} 1/u,
    );
    second.process.kill("SIGTERM");
    assert.equal((await second.exited).code, 0);
    return {
      processKilled: killed.signal,
      firstPid: bootA.pid,
      secondPid: bootB.pid,
      newSnapshotRef: firstRef !== nextRef,
      oldStateBeforeExport,
      newState: "Received",
      startupReadyStatus,
      recoveredReadyStatus,
      transport: "real-mtls-internal-client",
    };
  } finally {
    if (lockHeld) await adminClient.query("ROLLBACK");
    for (const process of children)
      if (process.exitCode === null && process.signalCode === null) {
        process.kill("SIGKILL");
        await once(process, "exit");
      }
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    await rm(directory, { recursive: true, force: true });
  }
}
