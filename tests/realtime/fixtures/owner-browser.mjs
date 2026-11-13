import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { chromium } from "playwright";
import {
  createRuntime,
  configuredRuntimeIdentity,
} from "../../../packages/platform-runtime/dist/index.js";
import { parsePlatformConfig } from "../../../packages/platform-config/dist/index.js";
import { createHttpClient } from "../../../packages/platform-http/dist/index.js";
import { parseServiceTransportMaterial } from "../../../packages/platform-security/dist/index.js";
import { OrderStore } from "../../../apps/orders-service/dist/infrastructure/database/order-store.js";
import { createOrdersSecurity } from "../../../apps/orders-service/dist/infrastructure/order-security.js";
import { createCustomerOrderInputClient } from "../../../apps/orders-service/dist/infrastructure/customer-client.js";
import { createPricingQuoteClient } from "../../../apps/orders-service/dist/infrastructure/pricing-client.js";
import { registerOrdersRoutes } from "../../../apps/orders-service/dist/http/index.js";
import {
  parse,
  runTransportFixture,
  bounded,
  scratchRoot,
} from "../soak.test.mjs";
import {
  THRESHOLDS,
  parseMetrics,
  metric,
  SSE_RETRY_MS,
  SSE_READY_TIMEOUT_MS,
} from "./protocol.mjs";
import {
  ROOT,
  docker,
  run,
  json,
  hash,
  redact,
  assertFixtureKafkaNamespaceBound,
} from "./setup.mjs";

const summary = (card) => ({
  orderRef: card.orderRef,
  version: card.version,
  projectionVersion: card.projectionVersion,
  aromaState: card.aroma.state,
  allowedActions: card.allowedActions,
});

/** Reuse the owned PostgreSQL, native transport composition and production browser. */
export async function proveOwnerBrowser(
  f,
  { baseline, change, finish, scenario = "positive" },
) {
  assert.ok(
    ["positive", "private-eof", "reauth"].includes(scenario),
    "owner browser scenario must be positive, explicit private-eof, or natural reauth",
  );
  assert.equal(typeof baseline, "function");
  assert.equal(typeof change, "function");
  assert.equal(typeof finish, "function");
  await mkdir(scratchRoot(), { recursive: true });
  const dir = join(
    await mkdtemp(join(scratchRoot(), "realtime-owner-browser-")),
    "transport",
  );
  const options = parse([
    "--smoke",
    "--profile",
    "reference-512",
    "--smoke-clients",
    "1",
    "--smoke-duration-ms",
    scenario === "reauth" ? "120000" : "45000",
    "--result-dir",
    dir,
  ]);
  if (f.launchIdentity)
    options.launchPath = {
      launchContextFile: process.env.COFFEE_LAUNCH_CONTEXT_FILE,
    };
  let nginxWitness, privateFraming, runtimeRelative, runtimeTransformedSha256;
  const result = await runTransportFixture(options, {
    startOwner: async ({ setup, network, registerOwner }) => {
      const fixture = JSON.parse(
        await readFile(join(setup.privateDir, "fixture.json"), "utf8"),
      );
      runtimeRelative = "apps/realtime-gateway/dist/runtime-composition.js";
      const runtimePath = join(setup.snapshot, runtimeRelative);
      const runtimeOriginal = await readFile(runtimePath);
      const runtimeOriginalSha256 = hash(runtimeOriginal);
      assert.equal(
        setup.manifest.compiled[runtimeRelative],
        runtimeOriginalSha256,
        "private EOF probe starts from the frozen compiled runtime",
      );
      if (scenario === "private-eof") {
        const originalMode = (await stat(runtimePath)).mode & 0o777;
        const source = runtimeOriginal.toString("utf8");
        const compositionAnchor =
          "export function createRealtimeComposition() {";
        const headerAnchor = `reply.raw.writeHead(200, {
                        "Content-Type": "text/event-stream; charset=utf-8",
                        "Cache-Control": "no-cache, no-transform",
                        Connection: "keep-alive",
                        "X-Accel-Buffering": "no",
                        "X-Correlation-ID": correlationId,
                    });
                    const streamSocket = reply.raw.socket;
                    reply.raw.once("finish", () => streamSocket?.end());`;
        assert.equal(
          source.split(compositionAnchor).length - 1,
          1,
          "compiled composition anchor must be unique",
        );
        assert.equal(
          source.split('app.get("/events", {').length - 1,
          1,
          "compiled /events route must be unique",
        );
        assert.equal(
          source.split(headerAnchor).length - 1,
          1,
          "compiled successful /events header anchor must be unique",
        );
        const transformed = source
          .replace(
            compositionAnchor,
            `${compositionAnchor}\n    let privateEofTriggered = false;`,
          )
          .replace(
            headerAnchor,
            `reply.raw.removeHeader("Transfer-Encoding");
                reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "close", "X-Accel-Buffering": "no", "X-Correlation-ID": correlationId });
                const streamSocket = reply.raw.socket;
                reply.raw.once("finish", () => streamSocket?.end());
                let invalidationWrites = 0;
                const originalWrite = reply.raw.write.bind(reply.raw);
                reply.raw.write = function(chunk, ...args) {
                    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof args[0] === "string" ? args[0] : "utf8");
                    if (bytes.includes(Buffer.from("event: resource-invalidated.v1\\n"))) invalidationWrites++;
                    if (privateEofTriggered || invalidationWrites !== 2) return originalWrite(chunk, ...args);
                    const text = bytes.toString("utf8");
                    if (!text.endsWith("\\n\\n")) throw new Error("PRIVATE_EOF_FRAME_NOT_COMPLETE");
                    privateEofTriggered = true;
                    const truncated = Buffer.from(text.slice(0, -1));
                    const callback = typeof args.at(-1) === "function" ? args.at(-1) : undefined;
                    if (callback === undefined) throw new Error("PRIVATE_EOF_WRITE_CALLBACK_REQUIRED");
                    let callbackDone = false, drainRequired = false, drainObserved = false, endCalled = false, writeReturnedKnown = false, writeReturned;
                    const finishTruncatedWrite = () => {
                        if (!writeReturnedKnown || !callbackDone || (drainRequired && !drainObserved) || endCalled) return;
                        reply.raw.end();
                        endCalled = true;
                        process.stdout.write("PRIVATE_EOF_PROBE " + JSON.stringify({ triggered: true, invalidationOrdinal: 2, removedBytes: 1, callbackDone, writeReturned, drainRequired, drainObserved, endCalled, socketDestroyCalled: false }) + "\\n");
                    };
                    const writeArgs = args.slice();
                    if (callback !== undefined) writeArgs[writeArgs.length - 1] = (...callbackArgs) => {
                        callbackDone = callbackArgs[0] == null;
                        callback(...callbackArgs);
                        finishTruncatedWrite();
                    };
                    const writable = originalWrite(truncated, ...writeArgs);
                    writeReturned=writable;writeReturnedKnown=true;
                    drainRequired = !writable;
                    if (!writable) reply.raw.once("drain", () => { drainObserved = true; finishTruncatedWrite(); });
                    finishTruncatedWrite();
                    return writable;
                };`,
          );
        assert.equal(
          transformed.split('reply.raw.removeHeader("Transfer-Encoding");')
            .length - 1,
          1,
          "private success route must remove upstream Transfer-Encoding",
        );
        assert.equal(
          transformed.split('"Connection": "close"').length - 1,
          1,
          "private success route must be close-delimited",
        );
        assert.equal(
          transformed.includes('"Connection": "keep-alive"'),
          false,
          "private success route must not retain keep-alive framing",
        );
        const transformedBytes = Buffer.from(transformed);
        runtimeTransformedSha256 = hash(transformedBytes);
        assert.notEqual(runtimeTransformedSha256, runtimeOriginalSha256);
        try {
          await chmod(runtimePath, 0o600);
          await writeFile(runtimePath, transformedBytes);
        } finally {
          await chmod(runtimePath, originalMode);
        }
        assert.equal(
          hash(await readFile(runtimePath)),
          runtimeTransformedSha256,
          "private EOF transform exact bytes",
        );
        assert.equal(
          (await stat(runtimePath)).mode & 0o777,
          originalMode,
          "private transform restores the compiled file mode",
        );
        privateFraming = {
          sourcePath: runtimeRelative,
          sourceManifestSha256: hash(
            await readFile(join(dir, "profile-manifest.json")),
          ),
          originalSha256: runtimeOriginalSha256,
          transformedSha256: runtimeTransformedSha256,
          originalMode,
          modeAfterTransform: (await stat(runtimePath)).mode & 0o777,
          originalBytes: runtimeOriginal.byteLength,
          transformedBytes: transformedBytes.byteLength,
          anchorCounts: { composition: 1, route: 1, successfulHeader: 1 },
          transformPolicy: {
            removeTransferEncoding: true,
            connection: "close",
            contentLengthAdded: false,
          },
          triggered: false,
        };
      }
      const gateway = JSON.parse(await docker("network", "inspect", network))[0]
        .IPAM.Config[0].Gateway;

      const nginxImage = `coffee-realtime-owner-browser:${options.runId}`;
      let app,
        client,
        attached = false,
        imageBuilt = false;
      const stop = async () => {
        const failures = [];
        for (const cleanup of [
          async () => {
            if (app) {
              const receipt =
                await app.runtimeController.closeRuntime("SIGTERM");
              assert.equal(receipt.status, "stopped");
              assert.equal(app.server.listening, false);
            }
          },
          async () => {
            await client?.close();
          },
          async () => {
            if (attached) {
              if (f.externalAttachment) {
                const { cleanupApprovedExternalPostgresAttachment } =
                  await import("../../../tools/compose-smoke.mjs");
                cleanupApprovedExternalPostgresAttachment(f.externalAttachment);
              } else
                await docker("network", "disconnect", network, f.container);
            }
          },
          async () => {
            if (imageBuilt) {
              await docker("image", "rm", nginxImage);
              assert.equal(
                (
                  await docker(
                    "image",
                    "ls",
                    "--filter",
                    `reference=${nginxImage}`,
                    "--format",
                    "{{.ID}}",
                  )
                ).trim(),
                "",
              );
            }
          },
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(failures, "owner fixture cleanup failed");
      };
      registerOwner({ stop });
      const connectionPath = join(setup.privateDir, "owner-publisher.json");
      const build = await run(
        "pnpm",
        [
          "image:build",
          "--target",
          "edge-nginx",
          "--tag",
          nginxImage,
          "--load",
          ".",
        ],
        { timeout: 600000, outputLimit: 64 * 1024 * 1024 },
      );
      imageBuilt = true;
      await writeFile(join(dir, "owner-nginx-build.log"), redact(build));
      const digest = (
        await docker("image", "inspect", "--format", "{{.Id}}", nginxImage)
      ).trim();
      await json(join(dir, "owner-nginx-image.json"), {
        image: nginxImage,
        digest,
        source: "canonical production edge-nginx target, current working tree",
      });
      nginxWitness = {
        image: nginxImage,
        digest,
        buildLogSha256: hash(redact(build)),
      };
      if (f.externalAttachment) {
        const { attachApprovedExternalPostgres } =
          await import("../../../tools/compose-smoke.mjs");
        attached = true;
        attachApprovedExternalPostgres(f.externalAttachment);
      } else {
        await docker(
          "network",
          "connect",
          "--alias",
          "postgres-orders",
          network,
          f.container,
        );
        attached = true;
      }
      await json(
        connectionPath,
        f.externalAttachment
          ? f.publisherConnection
          : { ...f.publisherConnection, host: "postgres-orders", port: 5432 },
        0o600,
      );

      const material = parseServiceTransportMaterial(
        JSON.stringify(fixture.materials["orders-service"]),
        setup.config.environment,
        "orders-service",
      );
      const keys = generateKeyPairSync("ed25519");
      const security = createOrdersSecurity({
        signingPrivateKey: keys.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        publicVerificationKeys: fixture.apiKeys,
      });
      const target = setup.config.services["orders-service"].outbound.find(
        (entry) => entry.startsWith("api-internal:"),
      );
      assert.ok(target);
      client = createHttpClient({
        origin: `https://${target}`,
        tls: {
          material,
          targetEnvironment: setup.config.environment,
          targetRuntime: "api-internal",
        },
        connections: 4,
        pipelining: 1,
      });
      const store = new OrderStore(f.core, { maxSnapshotAgeMs: 60000 });
      // Standalone real owner HTTP routes; the native relay has its own auxiliary runtime.
      app = await createRuntime({
        ...configuredRuntimeIdentity(
          parsePlatformConfig(setup.config),
          "orders-service",
        ),
        host: gateway,
        requiredDependencies: [],
        transport: {
          environment: setup.config.environment,
          runtime: "orders-service",
          mode: "mtls",
          material,
        },
      });
      registerOrdersRoutes(app, {
        verifyTransport: (request, caller) =>
          request.runtimeContext?.transportIdentity?.runtime === caller,
        verifyPublicDelegation: (token, operation, correlationId, signal) => {
          signal.throwIfAborted();
          return security.verifyPublicDelegation(
            token,
            operation,
            correlationId,
          );
        },
        signInternalDelegation: security.signInternalDelegation,
        owner: {
          store,
          customer: createCustomerOrderInputClient(client),
          pricing: createPricingQuoteClient(client),
        },
      });
      await app.runtimeController.start();
      return {
        host: gateway,
        nginxImage,
        driverArgs: f.externalAttachment
          ? [
              "--network",
              "coffee_postgres_data",
              "--env",
              "COFFEE_LAUNCH_CONTEXT_FILE=/run/coffee-launch/context.json",
            ]
          : [],
        stop,
      };
    },
    exercise: async ({ driver, broker, setup }) => {
      const command = async (action) =>
        (
          await run(
            "docker",
            [
              "exec",
              driver,
              "node",
              "tests/realtime/fixtures/owner-publisher.mjs",
              action,
            ],
            { timeout: 60000 },
          )
        ).trim();
      const gatewayMetrics = async () => {
        const script =
          "import {fixture,request} from './tests/realtime/fixtures/transport.mjs';const r=await request('realtime-gateway',fixture.config.services['realtime-gateway'].listen.port,'/metrics');if(r.status!==200)throw new Error('gateway metrics unavailable');process.stdout.write(r.body);";
        const output = await run(
          "docker",
          ["exec", driver, "node", "--input-type=module", "-e", script],
          { timeout: 10000, outputLimit: 65536 },
        );
        return metric(
          parseMetrics(output),
          /^coffee_realtime_auth_close_total$/u,
          "actual retained-actor auth closures",
        ).value;
      };
      const cookie = await command("login");
      const state = await baseline();
      const baselineCard = await f.card(state.orderRef);
      const originalRows = await f.read(
        "SELECT message_id,topic,partition_key,envelope FROM orders.outbox_messages WHERE message_type='RealtimeInvalidated.v1' AND aggregate_ref=$1 AND owner_version=$2",
        [state.orderRef, baselineCard.card_version],
      );
      assert.equal(originalRows.length, 1);
      const original = originalRows[0];
      const replayOriginal = async (record) => {
        const ack = JSON.parse(
          await run(
            "docker",
            [
              "exec",
              "--interactive",
              driver,
              "node",
              "tests/realtime/fixtures/owner-publisher.mjs",
              "replay-original",
            ],
            { timeout: 30000, input: JSON.stringify(record) },
          ),
        );
        assert.equal(ack.messageId, record.message_id);
        assert.equal(ack.topic, record.topic);
        const consumers =
          setup.config.services["realtime-gateway"].kafka.consumers;
        assert.equal(consumers.length, 1, "one configured realtime consumer");
        const target = assertFixtureKafkaNamespaceBound(
          setup.config,
          "realtime-gateway",
          setup.launchIdentity,
        );
        const logicalGroup = consumers[0].groupId;
        const group = target.groups[logicalGroup];
        assert.ok(group, "realtime consumer group has a derived target");
        const physicalTopic = target.topics[ack.topic];
        assert.ok(physicalTopic, "replayed topic has a derived target");
        return await bounded(
          async () => {
            const text = await run(
              "docker",
              [
                "exec",
                broker,
                "/opt/kafka/bin/kafka-consumer-groups.sh",
                "--bootstrap-server",
                "kafka:9092",
                "--command-config",
                "/etc/kafka/secrets/client.properties",
                "--describe",
                "--group",
                group,
              ],
              { timeout: 10000 },
            );
            const row = text
              .trim()
              .split("\n")
              .map((line) => line.trim().split(/\s+/u))
              .find(
                (parts) =>
                  parts[0] === group &&
                  parts[1] === physicalTopic &&
                  parts[2] === String(ack.partition),
              );
            if (
              !row ||
              !/^\d+$/u.test(row[3]) ||
              BigInt(row[3]) < BigInt(ack.offset) + 1n
            )
              return false;
            return {
              messageId: ack.messageId,
              ownerVersion: record.envelope.payload.ownerVersion,
              envelopeSha256: hash(JSON.stringify(record.envelope)),
              topic: ack.topic,
              partition: ack.partition,
              ackOffset: ack.offset,
              committedOffset: row[3],
            };
          },
          {
            timeout: 10000,
            label: "native receiver committed the exact replayed record",
          },
        );
      };
      const baselineRelay = JSON.parse(await command("relay"));
      let browser, context;
      const responses = [],
        pending = [],
        httpFailures = [],
        bodyFailures = [],
        eventRequests = [],
        eventResponses = [];
      try {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 1280, height: 900 },
        });
        await context.addCookies(
          cookie.split("; ").map((pair) => {
            const equal = pair.indexOf("=");
            assert.ok(equal > 0);
            return {
              name: pair.slice(0, equal),
              value: pair.slice(equal + 1),
              url: "https://localhost:8443/",
              secure: true,
              httpOnly: true,
              sameSite: "Lax",
            };
          }),
        );
        const page = await context.newPage();
        await page.addInitScript(() => {
          const Native = window.EventSource;
          window.__ownerProofFrames = [];
          window.__ownerProofConnections = [];
          window.__ownerProofSources = [];
          window.__ownerProofOwnerFetches = [];
          window.EventSource = class extends Native {
            constructor(...args) {
              super(...args);
              const sourceOrdinal = window.__ownerProofSources.length + 1;
              window.__ownerProofSources.push({ sourceOrdinal });
              this.addEventListener("open", () =>
                window.__ownerProofConnections.push({
                  sourceOrdinal,
                  at: performance.now(),
                }),
              );
              for (const event of [
                "stream-ready.v1",
                "stream-reset.v1",
                "resource-invalidated.v1",
              ])
                this.addEventListener(event, (message) =>
                  window.__ownerProofFrames.push({
                    sourceOrdinal,
                    event,
                    id: message.lastEventId,
                    data: JSON.parse(message.data),
                    at: performance.now(),
                  }),
                );
            }
          };
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (input, ...args) => {
            const url = new URL(
              typeof input === "string" ? input : input.url,
              location.href,
            );
            if (url.pathname.startsWith("/api/client-v1/orders/")) {
              const lastInvalidation = [...window.__ownerProofFrames]
                .reverse()
                .find((frame) => frame.event === "resource-invalidated.v1");
              window.__ownerProofOwnerFetches.push({
                lastInvalidationId: lastInvalidation?.id ?? null,
                connectionOpens: window.__ownerProofConnections.length,
                readyFrames: window.__ownerProofFrames.filter(
                  (frame) => frame.event === "stream-ready.v1",
                ).length,
                at: performance.now(),
              });
            }
            return nativeFetch(input, ...args);
          };
        });
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/events") {
            const entry = { lastEventId: null, headersAvailable: false };
            eventRequests.push(entry);
            entry.headersPending = request.allHeaders().then(
              (headers) => {
                entry.lastEventId = headers["last-event-id"] ?? null;
                entry.headersAvailable = true;
              },
              () => {},
            );
          }
        });
        page.on("response", (response) => {
          if (new URL(response.url()).pathname === "/events") {
            const entry = {
              status: response.status(),
              headers: null,
              headersAvailable: false,
            };
            eventResponses.push(entry);
            entry.headersPending = response.allHeaders().then(
              (headers) => {
                entry.headers = Object.fromEntries(
                  [
                    "content-type",
                    "cache-control",
                    "x-accel-buffering",
                    "connection",
                  ].map((name) => [name, headers[name] ?? null]),
                );
                entry.headersAvailable = true;
              },
              () => {},
            );
          }
        });
        const path = `/api/client-v1/orders/${state.orderRef}`;
        const captureOwnerResponse = (response) => {
          if (new URL(response.url()).pathname !== path) return;
          pending.push(
            (async () => {
              assert.equal(response.request().method(), "GET");
              if (response.status() !== 200) {
                httpFailures.push(response.status());
                return;
              }
              responses.push(summary(await response.json()));
            })().catch((error) => {
              if (bodyFailures.length < 8) bodyFailures.push(error);
            }),
          );
        };
        page.on("response", captureOwnerResponse);
        const drainResponses = async () => {
          await Promise.all(pending);
          assert.equal(bodyFailures.length, 0, "owner GET body read failed");
        };
        await page.goto(`https://localhost:8443/app/orders/${state.orderRef}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByText("Есть расхождение", { exact: true })
          .waitFor({ timeout: 20000 });
        await page.waitForFunction(
          () =>
            window.__ownerProofFrames.some(
              (frame) => frame.event === "stream-ready.v1",
            ),
          null,
          { timeout: 20000 },
        );
        await bounded(
          async () => (eventResponses.length > 0 ? eventResponses[0] : false),
          { timeout: 10000, interval: 50, label: "native /events response" },
        );
        await eventResponses[0]?.headersPending;
        assert.equal(
          eventResponses[0].headersAvailable,
          true,
          "complete public SSE response headers must be observable",
        );
        assert.equal(eventResponses[0].status, 200);
        assert.match(
          eventResponses[0].headers["content-type"] ?? "",
          /^text\/event-stream(?:;|$)/u,
        );
        assert.equal(
          eventResponses[0].headers["cache-control"],
          "no-cache, no-transform",
        );
        assert.equal(eventResponses[0].headers["x-accel-buffering"], "no");
        assert.equal(
          eventResponses[0].headers.connection,
          "keep-alive",
          "public HTTP/1.1 EventSource response remains persistent through the edge",
        );
        await drainResponses();
        assert.deepEqual(httpFailures, []);
        assert.ok(responses.length > 0);
        const before = responses.at(-1);
        assert.equal(before.aromaState, "OutOfSync");
        const beforeReads = responses.length;
        const observation = await change(state);
        const cardA = await f.card(state.orderRef);
        const rowsA = await f.read(
          "SELECT message_id,owner_version,state,topic,partition_key,envelope FROM orders.outbox_messages WHERE message_type='RealtimeInvalidated.v1' AND aggregate_ref=$1 AND owner_version=$2",
          [state.orderRef, cardA.card_version],
        );
        assert.equal(rowsA.length, 1);
        const ownerA = rowsA[0];
        assert.equal(ownerA.state, "Pending");
        const relayA = JSON.parse(await command("relay"));
        const publishedA = await f.read(
          "SELECT state FROM orders.outbox_messages WHERE message_id=$1",
          [ownerA.message_id],
        );
        assert.equal(publishedA[0].state, "Published");
        await page.waitForFunction(
          ({ id, version }) =>
            window.__ownerProofFrames.some(
              (frame) =>
                frame.event === "resource-invalidated.v1" &&
                frame.id === id &&
                frame.data.ownerVersion === version,
            ),
          { id: ownerA.message_id, version: ownerA.owner_version },
          { timeout: 20000 },
        );
        await page
          .getByText("Есть расхождение", { exact: true })
          .waitFor({ timeout: 20000 });
        await bounded(
          async () => {
            await drainResponses();
            return (
              responses.length > beforeReads &&
              responses.at(-1)?.projectionVersion === ownerA.owner_version
            );
          },
          {
            timeout: 10000,
            interval: 50,
            label: "real owner GET after observation invalidation A",
          },
        );
        assert.deepEqual(httpFailures, []);
        assert.ok(
          responses.length > beforeReads,
          "observation invalidation A must cause an owner GET",
        );
        const afterA = responses.at(-1);
        assert.equal(afterA.orderRef, state.orderRef);
        assert.equal(afterA.projectionVersion, ownerA.owner_version);
        assert.equal(afterA.version, before.version);
        assert.equal(afterA.aromaState, "OutOfSync");
        assert.ok(
          BigInt(afterA.projectionVersion) > BigInt(before.projectionVersion),
        );
        const readsBeforeB = responses.length;
        const terminalProof = await finish(state, observation);
        assert.equal(
          terminalProof.changed.payload.attemptState,
          "NoOpInSync",
          "B must be the real NoOpInSync proof event for observation A",
        );
        const cardB = await f.card(state.orderRef);
        const rowsB = await f.read(
          "SELECT message_id,owner_version,state,topic,partition_key,envelope FROM orders.outbox_messages WHERE message_type='RealtimeInvalidated.v1' AND aggregate_ref=$1 AND owner_version=$2",
          [state.orderRef, cardB.card_version],
        );
        assert.equal(rowsB.length, 1);
        const owner = rowsB[0];
        assert.equal(owner.state, "Pending");
        const relay = JSON.parse(await command("relay"));
        const published = await f.read(
          "SELECT state FROM orders.outbox_messages WHERE message_id=$1",
          [owner.message_id],
        );
        assert.equal(published[0].state, "Published");
        await page.waitForFunction(
          ({ id }) =>
            window.__ownerProofFrames.some(
              (frame) =>
                frame.event === "resource-invalidated.v1" && frame.id === id,
            ),
          { id: owner.message_id },
          { timeout: 20000 },
        );
        if (scenario === "private-eof") {
          await page.waitForFunction(
            () => window.__ownerProofConnections.length >= 2,
            null,
            { timeout: 20000 },
          );
          await page.waitForFunction(
            () =>
              window.__ownerProofFrames.filter(
                (frame) => frame.event === "stream-ready.v1",
              ).length >= 2,
            null,
            { timeout: 20000 },
          );
          await bounded(
            async () =>
              eventResponses.length >= 2 ? eventResponses[1] : false,
            {
              timeout: 10000,
              interval: 50,
              label: "native reconnect /events response",
            },
          );
          await eventResponses[1]?.headersPending;
          assert.equal(
            eventResponses[1].headersAvailable,
            true,
            "complete public reconnect headers must be observable",
          );
          assert.equal(eventResponses[1].status, 200);
          assert.match(
            eventResponses[1].headers["content-type"] ?? "",
            /^text\/event-stream(?:;|$)/u,
          );
          for (const response of eventResponses.slice(0, 2)) {
            assert.equal(
              response.headers["cache-control"],
              "no-cache, no-transform",
            );
            assert.equal(response.headers["x-accel-buffering"], "no");
            assert.equal(
              response.headers.connection,
              "keep-alive",
              "public HTTP/1.1 EventSource response remains persistent through the edge",
            );
          }
          await page
            .getByText("Синхронизировано", { exact: true })
            .waitFor({ timeout: 20000 });
          await drainResponses();
          assert.deepEqual(httpFailures, []);
          assert.ok(
            responses.length > readsBeforeB,
            "replayed terminal invalidation B must cause an owner GET",
          );
          const after = responses.at(-1);
          assert.equal(after.orderRef, state.orderRef);
          assert.equal(after.projectionVersion, owner.owner_version);
          assert.equal(after.version, before.version);
          assert.equal(after.aromaState, "InSync");
          assert.ok(
            BigInt(after.projectionVersion) > BigInt(afterA.projectionVersion),
          );
          await eventRequests[1]?.headersPending;
          const reconnectWitness = {
            ownerA: {
              messageId: ownerA.message_id,
              ownerVersion: ownerA.owner_version,
            },
            ownerB: {
              messageId: owner.message_id,
              ownerVersion: owner.owner_version,
            },
            eventRequests: eventRequests.map(
              ({ lastEventId, headersAvailable }, index) => ({
                index,
                lastEventId,
                headersAvailable,
              }),
            ),
            eventResponses: eventResponses
              .slice(0, 2)
              .map(({ status, headers, headersAvailable }) => ({
                status,
                headers,
                headersAvailable,
              })),
            frames: await page.evaluate(() =>
              window.__ownerProofFrames.map(({ event, id, data, at }) => ({
                event,
                id,
                ownerVersion: data.ownerVersion ?? null,
                at,
              })),
            ),
          };
          assert.equal(
            eventRequests[1]?.lastEventId,
            ownerA.message_id,
            `native reconnect must retain A as Last-Event-ID after incomplete B; witness=${JSON.stringify(reconnectWitness)}`,
          );
          const nativeSourceWitness = await page.evaluate(() => ({
            instances: window.__ownerProofSources.length,
            openSourceOrdinals: window.__ownerProofConnections
              .slice(0, 2)
              .map((connection) => connection.sourceOrdinal),
            invalidationFrames: window.__ownerProofFrames
              .filter((frame) => frame.event === "resource-invalidated.v1")
              .map((frame) => ({
                id: frame.id,
                sourceOrdinal: frame.sourceOrdinal,
              })),
          }));
          assert.equal(
            nativeSourceWitness.instances,
            1,
            `native retry must reuse one EventSource before restart; witness=${JSON.stringify(nativeSourceWitness)}`,
          );
          assert.deepEqual(
            nativeSourceWitness.openSourceOrdinals,
            [1, 1],
            `both native open events must belong to that EventSource; witness=${JSON.stringify(nativeSourceWitness)}`,
          );
          assert.deepEqual(
            nativeSourceWitness.invalidationFrames,
            [
              { id: ownerA.message_id, sourceOrdinal: 1 },
              { id: owner.message_id, sourceOrdinal: 1 },
            ],
            `A and B must be dispatched by that same EventSource; witness=${JSON.stringify(nativeSourceWitness)}`,
          );
          const ownerFetches = await page.evaluate(
            () => window.__ownerProofOwnerFetches,
          );
          assert.ok(
            ownerFetches.some(
              (fetch) =>
                fetch.lastInvalidationId === owner.message_id &&
                fetch.connectionOpens >= 2,
            ),
            "B may refetch the owner only after native EOF reconnect and B replay",
          );
          assert.equal(
            ownerFetches.some(
              (fetch) =>
                fetch.lastInvalidationId === owner.message_id &&
                fetch.connectionOpens < 2,
            ),
            false,
            "incomplete B must not dispatch/refetch before reconnect",
          );
          const proofMarker = await bounded(
            async () => {
              const logs = await docker(
                "logs",
                `${options.runId}-realtime-gateway`,
              );
              const matches = logs
                .split("\n")
                .filter((line) => line.startsWith("PRIVATE_EOF_PROBE "));
              if (matches.length === 0) return false;
              assert.equal(
                matches.length,
                1,
                "one-shot incomplete B frame fault must trigger exactly once",
              );
              return JSON.parse(matches[0].slice("PRIVATE_EOF_PROBE ".length));
            },
            {
              timeout: 10000,
              interval: 100,
              label: "one-shot private EOF fault receipt",
            },
          );
          assert.equal(proofMarker.triggered, true);
          assert.equal(proofMarker.invalidationOrdinal, 2);
          assert.equal(proofMarker.removedBytes, 1);
          assert.equal(proofMarker.callbackDone, true);
          assert.equal(proofMarker.endCalled, true);
          assert.equal(typeof proofMarker.writeReturned, "boolean");
          assert.equal(proofMarker.drainRequired, !proofMarker.writeReturned);
          assert.equal(proofMarker.socketDestroyCalled, false);
          assert.equal(
            proofMarker.drainObserved,
            proofMarker.drainRequired,
            "only a false write return requires and proves a subsequent drain",
          );
          privateFraming = {
            ...privateFraming,
            triggered: true,
            limits: {
              syntheticClients: 1,
              smokeDurationMs: options.smoke.durationMs,
              faultOrdinal: 2,
              removedBytes: 1,
              oneShot: true,
            },
            fault: proofMarker,
            ownerVersionA: ownerA.owner_version,
            ownerVersionB: owner.owner_version,
            lastEventIdOnReconnect: eventRequests[1].lastEventId,
            connections: eventRequests.length,
          };
        }
        await page
          .getByText("Синхронизировано", { exact: true })
          .waitFor({ timeout: 20000 });
        await bounded(
          async () => {
            await drainResponses();
            return (
              responses.length > readsBeforeB &&
              responses.at(-1)?.projectionVersion === owner.owner_version
            );
          },
          {
            timeout: 10000,
            interval: 50,
            label: "real owner GET after terminal invalidation B",
          },
        );
        assert.deepEqual(httpFailures, []);
        const after = responses.at(-1);
        assert.equal(after.orderRef, state.orderRef);
        assert.equal(after.projectionVersion, owner.owner_version);
        assert.equal(after.version, before.version);
        assert.equal(after.aromaState, "InSync");
        assert.ok(
          BigInt(after.projectionVersion) > BigInt(afterA.projectionVersion),
        );
        const semanticBCardBefore = {
          version: after.version,
          projectionVersion: after.projectionVersion,
          aromaState: after.aromaState,
        };
        let acceptedAfterReauth = after;
        let reauth;
        if (scenario === "reauth") {
          const actorTtlMs =
              setup.manifest.authExpiry.actorMaxTtlSeconds * 1000,
            authCheckMs =
              setup.config.services["realtime-gateway"].realtime.authCheckMs;
          assert.equal(
            setup.manifest.authExpiry.actorMaxTtlSeconds,
            60,
            "fixture must retain the production actor TTL",
          );
          assert.equal(
            setup.manifest.authExpiry.sessionTtlMs,
            900000,
            "fixture browser session must outlive the natural actor expiry",
          );
          const authCloseBefore = await gatewayMetrics(),
            readyBefore = await page.evaluate(
              () =>
                window.__ownerProofFrames.filter(
                  (frame) => frame.event === "stream-ready.v1",
                ).length,
            ),
            connectionsBefore = await page.evaluate(
              () => window.__ownerProofConnections.length,
            ),
            ownerReadsBefore = responses.length,
            cardBeforeReauth = await f.card(state.orderRef),
            outboxBeforeReauth = await f.read(
              "SELECT message_id,state,owner_version FROM orders.outbox_messages ORDER BY message_id",
            );
          assert.equal(readyBefore, 1);
          assert.equal(connectionsBefore, 1);
          const recoveryDeadlineMs = Math.min(
            120000,
            actorTtlMs +
              authCheckMs +
              SSE_RETRY_MS +
              SSE_READY_TIMEOUT_MS +
              5000,
          );
          const recoveryStartedAt = performance.now();
          let authCloseAfter;
          await bounded(
            async () => {
              authCloseAfter = await gatewayMetrics();
              assert.ok(
                authCloseAfter - authCloseBefore <= 1,
                "only the browser actor expiry may close this stream",
              );
              const browser = await page.evaluate(() => ({
                ready: window.__ownerProofFrames.filter(
                  (frame) => frame.event === "stream-ready.v1",
                ).length,
                connections: window.__ownerProofConnections.length,
                sources: window.__ownerProofSources.length,
              }));
              return authCloseAfter === authCloseBefore + 1 &&
                browser.ready >= 2 &&
                browser.connections >= 2 &&
                eventRequests.length >= 2 &&
                eventResponses.length >= 2
                ? browser
                : false;
            },
            {
              timeout: recoveryDeadlineMs,
              interval: 250,
              label:
                "natural actor TTL auth close and native EventSource recovery",
            },
          );
          assert.equal(
            eventRequests.length,
            2,
            "one natural auth close must cause exactly one native reconnect request",
          );
          assert.equal(
            eventResponses.length,
            2,
            "the reconnect must receive exactly one fresh Edge admission response",
          );
          await eventRequests[1]?.headersPending;
          await eventResponses[1]?.headersPending;
          assert.equal(
            eventRequests[1]?.headersAvailable,
            true,
            "native EventSource must issue a fresh authenticated /events request",
          );
          assert.equal(
            eventRequests[1]?.lastEventId,
            owner.message_id,
            "native reconnect must retain the current owner invalidation cursor",
          );
          assert.equal(
            eventResponses[1]?.status,
            200,
            "Edge must admit the reconnect with fresh authorization",
          );
          assert.match(
            eventResponses[1].headers?.["content-type"] ?? "",
            /^text\/event-stream(?:;|$)/u,
          );
          assert.equal(
            eventResponses[1].headers?.["cache-control"],
            "no-cache, no-transform",
          );
          assert.equal(eventResponses[1].headers?.["x-accel-buffering"], "no");
          await page
            .getByText("Есть расхождение", { exact: true })
            .waitFor({ timeout: SSE_READY_TIMEOUT_MS });
          await bounded(
            async () => {
              await drainResponses();
              return responses.length > ownerReadsBefore ? true : false;
            },
            {
              timeout: SSE_READY_TIMEOUT_MS,
              interval: 50,
              label: "owner GET after recovered stream-ready",
            },
          );
          const afterReauth = responses.at(-1),
            reauthFetches = await page.evaluate(() =>
              window.__ownerProofOwnerFetches.filter(
                (fetch) => fetch.connectionOpens >= 2 && fetch.readyFrames >= 2,
              ),
            );
          assert.ok(
            reauthFetches.length > 0,
            "recovered stream-ready must trigger a real owner GET",
          );
          assert.equal(
            await page
              .getByText(
                "Одинаковая версия представления содержит разные данные",
                { exact: true },
              )
              .count(),
            0,
            "read-time freshness change must not leave a fatal protocol barrier",
          );
          assert.equal(afterReauth.orderRef, state.orderRef);
          assert.equal(afterReauth.aromaState, "OutOfSync");
          assert.equal(
            afterReauth.version,
            semanticBCardBefore.version,
            "reauth owner GET must preserve the business version",
          );
          assert.equal(
            afterReauth.projectionVersion,
            semanticBCardBefore.projectionVersion,
            "read-time freshness expiry must preserve the persisted projection version",
          );
          acceptedAfterReauth = afterReauth;
          assert.deepEqual(
            await f.card(state.orderRef),
            cardBeforeReauth,
            "natural reauth and owner GET must not mutate the owner Card",
          );
          assert.deepEqual(
            await f.read(
              "SELECT message_id,state,owner_version FROM orders.outbox_messages ORDER BY message_id",
            ),
            outboxBeforeReauth,
            "natural reauth must not create or rewrite business Outbox facts",
          );
          const native = await page.evaluate(() => ({
            instances: window.__ownerProofSources.length,
            connections: window.__ownerProofConnections.length,
            openSourceOrdinals: window.__ownerProofConnections.map(
              (connection) => connection.sourceOrdinal,
            ),
            readyFrames: window.__ownerProofFrames.filter(
              (frame) => frame.event === "stream-ready.v1",
            ).length,
          }));
          assert.equal(
            native.instances,
            1,
            "natural reauth must reuse the existing native EventSource",
          );
          assert.ok(native.connections >= 2);
          assert.ok(native.readyFrames >= 2);
          reauth = {
            actorTtlMs,
            authCheckMs,
            sessionTtlMs: setup.manifest.authExpiry.sessionTtlMs,
            authCloseBefore,
            authCloseAfter,
            authCloseDelta: authCloseAfter - authCloseBefore,
            recoveryElapsedMs: performance.now() - recoveryStartedAt,
            connectionsBefore,
            connectionsAfter: native.connections,
            readyBefore,
            readyAfter: native.readyFrames,
            eventRequestCount: eventRequests.length,
            eventResponseCount: eventResponses.length,
            reconnect: {
              status: eventResponses[1].status,
              lastEventId: eventRequests[1].lastEventId,
            },
            nativeEventSourceInstances: native.instances,
            ownerReadsBefore: ownerReadsBefore,
            ownerReadsAfter: responses.length,
            semanticBCardBefore,
            lateCardAfter: {
              version: afterReauth.version,
              projectionVersion: afterReauth.projectionVersion,
              aromaState: afterReauth.aromaState,
            },
            ownerFetchAfterReady: reauthFetches.at(-1),
          };
        }
        const nativeSourceWitness = await page.evaluate(() => ({
          instances: window.__ownerProofSources.length,
          openSourceOrdinals: window.__ownerProofConnections.map(
            (connection) => connection.sourceOrdinal,
          ),
          invalidationFrames: window.__ownerProofFrames
            .filter((frame) => frame.event === "resource-invalidated.v1")
            .map((frame) => ({
              id: frame.id,
              sourceOrdinal: frame.sourceOrdinal,
            })),
        }));
        assert.equal(
          nativeSourceWitness.instances,
          1,
          "one operator tab retains one native EventSource during material owner changes",
        );
        const ownerFetches = await page.evaluate(
          () => window.__ownerProofOwnerFetches,
        );
        const frames = await page.evaluate(() => window.__ownerProofFrames);
        const frame = frames.find((frame) => frame.id === owner.message_id);
        assert.ok(frame);
        assert.equal(frame.data.subjectRef, state.orderRef);
        assert.equal(frame.data.reason, "AromaStateChanged");
        const ownerAFrame = frames.find(
          (candidate) => candidate.id === ownerA.message_id,
        );
        assert.ok(ownerAFrame);
        const replayReady = frames
          .map((entry, index) => ({ entry, index }))
          .filter(
            ({ entry, index }) =>
              index >
                frames.findIndex(
                  (candidate) => candidate.id === ownerA.message_id,
                ) && entry.event === "stream-ready.v1",
          );
        const replayBIndex = frames.findIndex(
          (candidate) => candidate.id === owner.message_id,
        );
        if (scenario === "private-eof")
          assert.ok(
            replayReady.length > 0 && replayBIndex < replayReady[0].index,
            "retained B replay must precede stream-ready after native reconnect",
          );
        assert.deepEqual(Object.keys(frame.data).sort(), [
          "correlationId",
          "ownerVersion",
          "reason",
          "subjectRef",
          "subjectType",
        ]);
        const unchangedCard = await f.card(state.orderRef),
          unchangedOutbox = await f.read(
            "SELECT message_id,state,owner_version FROM orders.outbox_messages ORDER BY message_id",
          );
        const readsBeforeDuplicate = responses.length,
          duplicate = await replayOriginal(owner);
        await page.waitForTimeout(THRESHOLDS.eventLatencyP95Ms);
        await drainResponses();
        assert.equal(
          responses.length,
          readsBeforeDuplicate,
          "broker-confirmed duplicate must not trigger another owner GET",
        );
        const restartId = `owner-restart-${owner.message_id}`;
        await json(join(dir, "control-request.json"), {
          id: restartId,
          action: "restart",
        });
        const restart = await bounded(
          async () => {
            const receipt = JSON.parse(
              await readFile(join(dir, "control-response.json"), "utf8").catch(
                (error) => {
                  if (error.code === "ENOENT") return "{}";
                  throw error;
                },
              ),
            );
            if (receipt.id !== restartId) return false;
            assert.equal(receipt.ok, true, receipt.error);
            return receipt;
          },
          {
            timeout: THRESHOLDS.shutdownMs + 5000,
            label: "actual realtime graceful restart",
          },
        );
        await page.waitForFunction(
          () =>
            window.__ownerProofFrames.some(
              (frame) => frame.event === "stream-reset.v1",
            ),
          null,
          { timeout: 13000 },
        );
        await bounded(
          async () => {
            await drainResponses();
            return (
              responses.length > readsBeforeDuplicate &&
              responses.at(-1).projectionVersion ===
                acceptedAfterReauth.projectionVersion
            );
          },
          { timeout: 10000, label: "native reset refetches the real owner" },
        );
        const readsAfterReset = responses.length;
        const currentReplay = await replayOriginal(owner);

        const stale = await replayOriginal(original);
        await page.waitForTimeout(THRESHOLDS.eventLatencyP95Ms);
        await drainResponses();
        assert.deepEqual(httpFailures, []);
        assert.equal(
          responses.length,
          readsAfterReset,
          "equal/stale replay after reset must not cause another GET",
        );
        assert.deepEqual(
          await f.card(state.orderRef),
          unchangedCard,
          "replay/reset/GET must not mutate the owner Card",
        );
        assert.deepEqual(
          await f.read(
            "SELECT message_id,state,owner_version FROM orders.outbox_messages ORDER BY message_id",
          ),
          unchangedOutbox,
          "negative transport replay must not rewrite owner Outbox",
        );
        assert.equal(responses.at(-1).version, acceptedAfterReauth.version);
        assert.equal(
          responses.at(-1).projectionVersion,
          acceptedAfterReauth.projectionVersion,
        );
        assert.equal(
          responses.at(-1).aromaState,
          acceptedAfterReauth.aromaState,
        );
        await page.screenshot({
          path: join(dir, "owner-browser-after.png"),
          fullPage: true,
        });
        const sources = {};
        for (const source of [
          "tests/orders/aroma-preparation-live.test.mjs",
          "tests/realtime/soak.test.mjs",
          "tests/realtime/fixtures/owner-browser.mjs",
          "tests/realtime/fixtures/owner-publisher.mjs",
          "apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts",
          "apps/orders-service/src/infrastructure/database/order-store.ts",
          "apps/orders-service/src/http/index.ts",
          "apps/orders-service/src/infrastructure/order-security.ts",
        ])
          sources[source] = hash(await readFile(join(ROOT, source)));
        const resetFrames = (
          await page.evaluate(() => window.__ownerProofFrames)
        ).filter((candidate) => candidate.event === "stream-reset.v1");
        await context.close();
        context = undefined;
        page.off("response", captureOwnerResponse);
        await browser.close();
        browser = undefined;
        await drainResponses();
        const sourceAfter = {};
        for (const [path, expected] of Object.entries(setup.manifest.sources)) {
          const actual = hash(await readFile(join(setup.snapshot, path)));
          sourceAfter[path] = actual;
          assert.equal(
            actual,
            expected,
            `owner browser source snapshot drift: ${path}`,
          );
        }
        const compiledAfter = {};
        for (const [path, expected] of Object.entries(
          setup.manifest.compiled,
        )) {
          const actual = hash(await readFile(join(setup.snapshot, path)));
          compiledAfter[path] = actual;
          assert.equal(
            actual,
            scenario === "private-eof" && path === runtimeRelative
              ? runtimeTransformedSha256
              : expected,
            `owner browser compiled snapshot drift: ${path}`,
          );
        }
        sources[runtimeRelative] = compiledAfter[runtimeRelative];
        const proof = {
          verified: true,
          launchProof: false,
          boundary:
            "Existing f.observe()/f.proof() helpers supplied source-event inputs A and NoOpInSync B through the actual owner Inbox; persisted owner Outbox invalidations were relayed. B was truncated before the SSE blank-line delimiter; native EventSource reconnected with Last-Event-ID A, replayed B before ready, and read the real InSync owner. Plus duplicate/stale/restart/reset; not capacity or production proof.",
          before,
          afterA,
          after,
          semanticBCardBefore,
          lateCardAfter:
            scenario === "reauth"
              ? {
                  version: acceptedAfterReauth.version,
                  projectionVersion: acceptedAfterReauth.projectionVersion,
                  aromaState: acceptedAfterReauth.aromaState,
                }
              : undefined,
          eventResponsePolicy: eventResponses
            .slice(
              0,
              scenario === "private-eof" ? 2 : scenario === "reauth" ? 3 : 1,
            )
            .map((response) => ({
              status: response.status,
              ...response.headers,
            })),
          nativeSourceWitness,
          reauth,
          ownerA: {
            ownerVersion: ownerA.owner_version,
            messageId: ownerA.message_id,
            envelopeSha256: hash(JSON.stringify(ownerA.envelope)),
          },
          owner: {
            ownerVersion: owner.owner_version,
            messageId: owner.message_id,
            envelopeSha256: hash(JSON.stringify(owner.envelope)),
          },
          terminalProof: {
            messageId: terminalProof.changed.messageId,
            attemptState: terminalProof.changed.payload.attemptState,
            envelopeSha256: hash(JSON.stringify(terminalProof.changed)),
          },
          ownerFetches,
          privateFraming,
          ownerReads: responses.length,
          frame,
          baselineRelay,
          relayA,
          relay,
          duplicate,
          restart,
          currentReplay,
          stale,
          resetFrames,
          noExtraMutation: true,
          nginx: nginxWitness,
          sources,
        };
        proof.scenario = scenario;
        proof.compiledIntegrity = {
          before: setup.manifest.compiled,
          after: compiledAfter,
          unchanged: scenario !== "private-eof",
        };
        proof.sourceIntegrity = {
          before: setup.manifest.sources,
          after: sourceAfter,
          unchanged: true,
        };
        if (scenario === "positive") {
          assert.equal(privateFraming, undefined);
          proof.boundary =
            "Unmodified frozen compiled transport; one native EventSource observes material owner A/B through real Inbox, persisted Outbox, native Kafka relay, nginx and served SPA/owner GET. Includes duplicate/stale/restart/reset, not capacity, VK/Agent/LLM or production proof.";
        }
        if (scenario === "reauth")
          proof.boundary =
            "Unmodified frozen compiled transport; one native EventSource receives natural 60s actor expiry, causal gateway auth-close, fresh Edge authorization and stream-ready, then re-reads the real owner Card as freshness-derived OutOfSync at the same business and projection versions. No session refresh or business mutation; not capacity or production proof.";
        await json(join(dir, "owner-browser-proof.json"), proof);
        return proof;
      } finally {
        await context?.close();
        await browser?.close();
      }
    },
  });
  assert.equal(result.error, null, JSON.stringify(result.error));
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.ownerBrowser?.verified, true);
  assert.equal(result.ownerBrowser.scenario, scenario);
  assert.equal(
    result.ownerBrowser.compiledIntegrity.unchanged,
    scenario !== "private-eof",
  );
  if (scenario === "private-eof")
    assert.equal(result.ownerBrowser.privateFraming.triggered, true);
  if (scenario === "reauth")
    assert.equal(result.ownerBrowser.reauth.authCloseDelta, 1);
  assert.equal(result.launchProof, false);
  console.log(
    JSON.stringify({
      ownerBrowserVerified: true,
      launchProof: false,
      artifact: join(dir, "owner-browser-proof.json"),
      cleanupVerified: result.cleanupVerified,
    }),
  );
  return result;
}

// Registered only by the browser parent; ordinary recovery does not select
// these cases. Старое имя читается один релиз.
if (
  process.env.COFFEE_OWNER_BROWSER === "1" ||
  process.env.COFFEE_G15_OWNER_BROWSER === "1"
) {
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  const { validateLaunchContext } =
    await import("../../../verification/launch/v1/report.mjs");
  const { context, evidenceDir } = await validateLaunchContext(contextPath);
  const launchIdentity = {
    schemaVersion: context.schemaVersion,
    runId: context.runId,
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
  };
  const { fixture, product, mapping } =
    await import("../../observability/orders-fixture.mjs");
  for (const scenario of ["positive", "private-eof", "reauth"])
    void test(
      `preparation owner realtime vertical through served browser ${scenario}`,
      { timeout: 900000 },
      async () => {
        const result = await fixture(
          async (f) =>
            await proveOwnerBrowser(f, {
              scenario,
              baseline: async () => {
                const p = product();
                await f.deliver(mapping(p));
                const order = await f.seed([p]);
                await f.deliver(order.confirmed);
                const observation = await f.observe();
                await f.deliver(observation.changed);
                return { orderRef: order.order, observation };
              },
              change: async () => {
                const observation = await f.observe();
                await f.deliver(observation.changed);
                return observation;
              },
              finish: async (_state, observation) => {
                const proof = await f.proof(observation);
                await f.deliver(proof.changed);
                return proof;
              },
            }),
          { launchIdentity, launchContextFile: contextPath },
        );
        const manifestBytes = await readFile(
          join(result.artifacts, "profile-manifest.json"),
        );
        const cleanupBytes = await readFile(
          join(result.artifacts, "cleanup.json"),
        );
        const proofBytes = await readFile(
          join(result.artifacts, "owner-browser-proof.json"),
        );
        const receipt = {
          launchIdentity,
          manifest: manifestBytes.toString("utf8"),
          cleanup: cleanupBytes.toString("utf8"),
          externalCleanup: result.cleanup,
          proof: proofBytes.toString("utf8"),
          manifestSha256: hash(manifestBytes),
          cleanupSha256: hash(cleanupBytes),
          proofSha256: hash(proofBytes),
        };
        const path = join(
          evidenceDir,
          "gates/browser/artifacts",
          `owner-${scenario}.json`,
        );
        await writeFile(path, `${JSON.stringify(receipt)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      },
    );
}
