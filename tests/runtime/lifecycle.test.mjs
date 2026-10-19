import assert from "node:assert/strict";
import {chmod, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {request as httpRequest} from "node:http";
import {createServer as createHttpsServer, request as httpsRequest} from "node:https";
import {execFileSync, spawn} from "node:child_process";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";
import {context as otelContext, metrics, SpanStatusCode, trace} from "@opentelemetry/api";
import {createServer as createHttpServer} from "node:http";
import {load as parseYaml} from "js-yaml";
import {RUNTIME_NAMES, loadPlatformConfig} from "../../packages/platform-config/src/index.ts";
import {
  assertScopedSecrets,
  completeRuntimeRequestTelemetry,
  configuredRuntimeIdentity,
  createRuntime,
  RuntimeError,
  startConfiguredRuntime,
  startRuntime,
} from "../../packages/platform-runtime/src/index.ts";
import {createHttpClient} from "../../packages/platform-http/src/index.ts";
import {nowInstant} from "../../packages/platform-time/src/index.ts";
import {readRuntimeHealthStatuses, runRuntimeHealthcheck} from "../../packages/platform-runtime/src/healthcheck.ts";
import {parsePublicTlsMaterial, parseServiceTransportMaterial, verifyTransportPeer} from "../../packages/platform-security/src/index.ts";
import {checkInternalApiReady} from "../../apps/orders-service/src/infrastructure/internal-api-readiness.ts";
import {createTelemetryResource, telemetryDiagnostics} from "../../packages/platform-observability/dist/index.js";
import {createTelemetryResource as createSourceTelemetryResource} from "../../packages/platform-observability/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const health = {
  livePath: "/health/live",
  readyPath: "/health/ready",
  metricsPath: "/metrics",
  intervalMs: 5_000,
  timeoutMs: 1_000,
  startupGraceMs: 30_000,
  failureThreshold: 3,
  successThreshold: 1,
};

function identity(name, options = {}) {
  return {
    name,
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    ...options,
  };
}

async function startApp(options) {
  const app = await createRuntime(options);
  await app.runtimeController.start();
  return app;
}

function stopApp(app, signal = "SIGTERM") {
  return app.runtimeController.closeRuntime(signal);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function captureRuntimeSpans(t) {
  const getTracer = trace.getTracer.bind(trace);
  const spans = [];
  t.mock.method(trace, "getTracer", function (name, ...args) {
    const tracer = getTracer(name, ...args);
    if (name !== "coffee-platform.runtime") return tracer;
    return {...tracer, startSpan(spanName, options) {
      const span = {
        name: spanName,
        attributes: {...options?.attributes},
        ends: 0,
        spanContext: () => ({traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", spanId: "bbbbbbbbbbbbbbbb", traceFlags: 1}),
        setAttribute(key, value) { this.attributes[key] = value; },
        setStatus(status) { this.status = status; },
        end() { this.ends += 1; },
      };
      spans.push(span);
      return span;
    }};
  });
  return spans;
}

function addressOf(app) {
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

function closeClientRequest(request) {
  return new Promise((resolve) => {
    request.once("close", resolve);
    request.once("error", resolve);
    request.destroy();
  });
}

async function certificateAuthority(directory, name, subject) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-subj", subject, "-days", "1", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], {stdio: "ignore"});
  return {keyPath, certPath, certPem: await readFile(certPath, "utf8")};
}

async function signedCertificate(directory, name, subject, subjectAltName, authority, extendedKeyUsage = "serverAuth") {
  const keyPath = join(directory, `${name}.key`);
  const csrPath = join(directory, `${name}.csr`);
  const certPath = join(directory, `${name}.crt`);
  const extensionPath = join(directory, `${name}.ext`);
  const sanEntries = subjectAltName.split(",").map((value, index) => {
    const separator = value.indexOf(":");
    return `${value.slice(0, separator)}.${index + 1} = ${value.slice(separator + 1)}`;
  });
  await writeFile(extensionPath, ["[extensions]", "subjectAltName=@san", `extendedKeyUsage=${extendedKeyUsage}`, "[san]", ...sanEntries, ""].join("\n"), {encoding: "utf8", mode: 0o400});
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", subject], {stdio: "ignore"});
  execFileSync("openssl", ["x509", "-req", "-in", csrPath, "-CA", authority.certPath, "-CAkey", authority.keyPath, "-CAcreateserial", "-out", certPath, "-days", "1", "-sha256", "-extfile", extensionPath, "-extensions", "extensions"], {stdio: "ignore"});
  const [keyPem, certPem] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
  return {keyPem, certPem};
}

async function tlsMaterial(t, hostname = "edge.test", serviceRuntime = "edge-gateway") {
  const directory = await mkdtemp(join(tmpdir(), "coffee-runtime-tls-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const publicAuthority = await certificateAuthority(directory, "public-ca", "/CN=coffee-runtime-public-ca");
  const serviceAuthority = await certificateAuthority(directory, "service-ca", "/CN=coffee-runtime-service-ca");
  const wrongAuthority = await certificateAuthority(directory, "wrong-ca", "/CN=coffee-runtime-wrong-ca");
  const publicKey = await signedCertificate(directory, "public", `/CN=${hostname}`, `DNS:${hostname}`, publicAuthority);
  const serviceKey = await signedCertificate(directory, "service", `/CN=${serviceRuntime}`, `URI:spiffe://coffee-platform/development/${serviceRuntime},DNS:${serviceRuntime}`, serviceAuthority, "serverAuth,clientAuth");
  return {
    publicTls: parsePublicTlsMaterial(publicKey.keyPem, publicKey.certPem, hostname, publicAuthority.certPem),
    publicCaPath: publicAuthority.certPath,
    publicLeafCaPem: publicKey.certPem,
    wrongCaPem: wrongAuthority.certPem,
    serviceTls: parseServiceTransportMaterial(JSON.stringify({...serviceKey, caPem: serviceAuthority.certPem}), "development", serviceRuntime),
  };
}

function requestHttps(port, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({host: "127.0.0.1", port, path: "/public", ...options}, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

function runHealthcheckChild(environment) {
  const moduleUrl = new URL("../../packages/platform-runtime/src/healthcheck.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import {runRuntimeHealthcheck} from ${JSON.stringify(moduleUrl)}; const statuses = await runRuntimeHealthcheck(["/health/live"]); if (statuses[0] !== 200) process.exitCode = 1;`], {env: environment, stdio: ["ignore", "pipe", "pipe"]});
  let output = "";
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({code, signal, output}));
  });
}

void test("runtime continues valid W3C parent and async request context into a server span", async (t) => {
  let exportedSpans = "";
  let exportedMetrics = Buffer.alloc(0);
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.resume();
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.url === "/v1/traces") exportedSpans += body.toString();
      if (request.url === "/v1/metrics") exportedMetrics = Buffer.concat([exportedMetrics, body]);
      response.writeHead(200, {"content-type": "application/x-protobuf"});
      response.end();
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const collectorAddress = collector.address();
  assert.ok(collectorAddress && typeof collectorAddress === "object");
  const telemetry = createTelemetryResource({
    environment: "development",
    namespace: "coffee-platform", releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${collectorAddress.port}`, queueCapacity: 16, batchSize: 4, batchTimeoutMs: 10, exportTimeoutMs: 100},
    producer: {queueCapacity: 16, maxRecordBytes: 16384, batchSize: 4, batchIntervalMs: 60000, exportTimeoutMs: 100, diagnosticIntervalMs: 60000, flushTimeoutMs: 500},
  }, "otel-context-test", "test-token");
  const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const parentSpanId = "bbbbbbbbbbbbbbbb";
  let observed;
  const app = await createRuntime(identity("otel-context-test", {
    deadlineMs: 50,
    resources: [telemetry],
    configure: (instance) => {
      instance.get("/telemetry-deadline", async (request) => {
        await new Promise(resolve => request.runtimeContext.signal.addEventListener("abort", resolve, {once: true}));
        return {status: "aborted"};
      });
      instance.get("/otel", async (request) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        const active = trace.getSpan(otelContext.active())?.spanContext();
        observed = {active, correlationId: request.correlationContext?.correlationId};
        trace.getTracer("runtime-context-test").startActiveSpan("redaction-safe-marker-span", span => {
          span.setAttribute("safe.redaction.marker", "otel-redaction-record-retained");
          span.setAttribute("nested.credentials.secret", "otel-secret-canary");
          span.setAttribute("nested.customer.email", "otel-pii-canary");
          span.setAttribute("request.body", "otel-body-canary");
          span.setAttribute("http.request.header.authorization", "otel-header-canary");
          span.setAttribute("db.statement", "SELECT 'otel-sql-canary'");
          span.setAttribute("provider.response", "otel-provider-canary");
          span.addEvent("exception", {"exception.message": "otel-exception-canary", "exception.stacktrace": "otel-stack-canary"});
          span.end();
        });
        return {traceId: active?.traceId};
      });
    },
  }));
  await app.runtimeController.start();
  t.after(async () => {
    await app.runtimeController.closeRuntime("SIGTERM");
    await new Promise(resolve => collector.close(resolve));
  });
  const response = await app.inject({method: "GET", url: "/otel", headers: {
    traceparent: `01-${traceId}-${parentSpanId}-01`,
    "x-correlation-id": "11111111-1111-4111-8111-111111111111",
  }});
  assert.equal((await app.inject("/health/ready")).statusCode, 200);
  assert.equal((await app.inject("/missing")).statusCode, 404);
  assert.equal(response.statusCode, 200);
  assert.equal(observed.active.traceId, traceId);
  assert.notEqual(observed.active.spanId, parentSpanId);
  assert.equal(observed.correlationId, "11111111-1111-4111-8111-111111111111");
  assert.equal(response.json().traceId, traceId);
  await assert.rejects(fetch(`http://127.0.0.1:${addressOf(app).port}/telemetry-deadline`));
  await app.runtimeController.closeRuntime("SIGTERM");
  await new Promise(resolve => collector.close(resolve));
  assert.ok(exportedSpans.includes("redaction-safe-marker-span"), "the span carrying redaction canaries was exported");
  assert.ok(exportedSpans.includes("otel-redaction-record-retained"), "the safe marker from that span was exported");
  for (const canary of ["otel-secret-canary", "otel-pii-canary", "otel-body-canary", "otel-header-canary", "otel-sql-canary", "otel-provider-canary", "otel-exception-canary", "otel-stack-canary"])
    assert.equal(exportedSpans.includes(canary), false, `OTLP export excludes ${canary}`);
  for (const metric of ["runtime_http_requests_total", "runtime_http_request_duration_ms", "runtime_ready", "runtime_process_start_time_seconds", "telemetry_log_records_dropped_total", "telemetry_records_dropped_total", "telemetry_export_failures_total", "telemetry_shutdown_losses_total"])
    assert.ok(exportedMetrics.includes(Buffer.from(metric)), `OTLP export contains ${metric}`);
  for (const attribute of ["http.request.method", "http.route", "http.response.status_class", "/otel", "2xx", "4xx"])
    assert.ok(exportedMetrics.includes(Buffer.from(attribute)), `request metrics include ${attribute}`);
  for (const attribute of ["outcome", "deadline_exceeded", "other"])
    assert.ok(exportedMetrics.includes(Buffer.from(attribute)), `aborted request metrics include ${attribute}`);
});
void test("telemetry span queue drops at its configured bound and records exporter failures", async (t) => {
  const exportRequests = [];
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      exportRequests.push({path: request.url, body: Buffer.concat(chunks)});
      setTimeout(() => {response.writeHead(503); response.end();}, 25);
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  assert.ok(address && typeof address === "object");
  const telemetry = createTelemetryResource({
    environment: "development",
    namespace: "coffee-platform", releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${address.port}`},
    producer: {queueCapacity: 1, maxRecordBytes: 1024, batchSize: 1, batchIntervalMs: 60000, exportTimeoutMs: 100, diagnosticIntervalMs: 60000, flushTimeoutMs: 1000},
  }, "otel-bounds-test", "test-token");
  const warnings = [];
  t.mock.method(process, "emitWarning", (...args) => {warnings.push(args);});
  const before = telemetryDiagnostics();
  telemetry.start();
  const tracer = trace.getTracer("otel-bounds-test");
  for (let index = 0; index < 3; index++) tracer.startSpan(`bounded.${index}`).end();
  const oversized = tracer.startSpan("oversized");
  oversized.setAttribute("token", "span-warning-private-canary");
  oversized.setAttribute("safe_attribute", "x".repeat(2_000));
  oversized.end();
  await telemetry.stop(new AbortController().signal);
  await new Promise(resolve => collector.close(resolve));
  const after = telemetryDiagnostics();
  assert.ok(after.dropped >= before.dropped + 2);
  assert.ok(after.exportFailures >= before.exportFailures + 1);
  assert.equal(after.serializationRejected, before.serializationRejected + 1);
  assert.ok(after.queueOverflows >= before.queueOverflows + 2);
  assert.equal(warnings.length, 1, "span drops and the exporter failure share the configured diagnostic rate limit");
  assert.equal(warnings[0][1]?.code, "OTEL_SPAN_DROPPED");
  assert.equal(warnings.some(args => args.map(String).join(" ").includes("span-warning-private-canary")), false,
    "diagnostics never include dropped span attributes");
  assert.ok(exportRequests.length > 0);
  assert.equal(exportRequests.filter(request => request.path === "/v1/traces").length, 1,
    "only the single in-flight span batch is sent");
  assert.equal(exportRequests.every(request => request.path === "/v1/traces" || request.path === "/v1/metrics"), true,
    "telemetry exports only trace batches and metrics, never diagnostics as a separate payload");
  assert.equal(exportRequests.some(request => request.body.includes(Buffer.from("span-warning-private-canary"))), false,
    "dropped span contents are never exported");
  t.after(() => new Promise(resolve => collector.close(resolve)));
});

void test("telemetry forceFlush immediately drains the final partial span batch", async (t) => {
  const traceBatches = [];
  let firstTraceRequestStarted;
  const firstTraceStarted = new Promise(resolve => {firstTraceRequestStarted = resolve;});
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/v1/traces") {
        traceBatches.push(Buffer.concat(chunks));
        if (traceBatches.length === 1) {
          firstTraceRequestStarted();
          setTimeout(() => {response.writeHead(200, {"content-type": "application/x-protobuf"}); response.end();}, 50);
          return;
        }
      }
      response.writeHead(200, {"content-type": "application/x-protobuf"});
      response.end();
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  assert.ok(address && typeof address === "object");
  const telemetry = createSourceTelemetryResource({
    environment: "development", namespace: "coffee-platform", releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${address.port}`},
    producer: {queueCapacity: 8, maxRecordBytes: 16384, batchSize: 2, batchIntervalMs: 60_000, exportTimeoutMs: 1_000, diagnosticIntervalMs: 60_000, flushTimeoutMs: 300},
  }, "otel-flush-tail-test", "test-token");
  t.after(async () => {if (collector.listening) await new Promise(resolve => collector.close(resolve));});
  telemetry.start();
  const tracer = trace.getTracer("otel-flush-tail-test");
  for (let index = 0; index < 2; index++) tracer.startSpan(`flush.batch.${index}`).end();
  await firstTraceStarted;
  for (let index = 2; index < 5; index++) tracer.startSpan(`flush.batch.${index}`).end();
  await telemetry.stop(new AbortController().signal);
  await new Promise(resolve => collector.close(resolve));
  const exported = Buffer.concat(traceBatches);
  assert.equal(traceBatches.length, 3, "the multi-batch flush exports its partial tail immediately");
  for (let index = 0; index < 5; index++)
    assert.ok(exported.includes(Buffer.from(`flush.batch.${index}`)), `span ${index} was exported`);
});

void test("bounded Pino stdout queue reports drops without logging dropped content", async () => {
  const moduleUrl = new URL("../../packages/platform-observability/dist/index.js", import.meta.url).href;
  const script = `import {createPinoLogger,logRecordsDropped,telemetryDiagnostics} from ${JSON.stringify(moduleUrl)};
const warnings=[];process.on('warning',warning=>warnings.push({code:warning.code,message:warning.message}));
const logger=createPinoLogger({service:'pino-queue-proof'},16384,undefined,1,60000);
for(let index=0;index<512;index++)logger.info({sample:'pino-queue-private-canary'+'x'.repeat(14000)},'bounded Pino stdout queue proof');
setImmediate(()=>logger.flush(error=>{if(error){process.stderr.write('flush failed\\n');process.exitCode=1;return;}setImmediate(()=>process.stderr.write(JSON.stringify({dropped:logRecordsDropped(),queueOverflows:telemetryDiagnostics().queueOverflows,warnings})+'\\n'));}));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pause();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {stdout += chunk;});
  child.stderr.on("data", chunk => {stderr += chunk; if (stderr.includes("\n")) child.stdout.resume();});
  const timeout = setTimeout(() => child.stdout.resume(), 5000);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({code, signal}));
  });
  clearTimeout(timeout);
  assert.equal(result.code, 0, stderr);
  const summary = JSON.parse(stderr.trim().split("\n").at(-1));
  assert.ok(summary.dropped > 0, "the bounded async stdout queue drops records under pipe backpressure");
  assert.equal(summary.queueOverflows, summary.dropped, "every Pino queue drop increments the runtime overflow counter");
  assert.equal(summary.warnings.length, 1, "queue overflow emits one rate-limited warning");
  assert.equal(summary.warnings[0].code, "LOG_RECORD_DROPPED");
  assert.doesNotMatch(JSON.stringify(summary.warnings), /pino-queue-private-canary/u, "warning diagnostics exclude dropped log content");
  assert.ok(stdout.length < 512 * 16384, "the child stdout pipe was bounded while records were dropped");
});

void test("telemetry preserves a final diagnostic when bounded shutdown drops an in-flight span", async () => {
  const collector = createHttpServer((_request, response) => {
    response.writeHead(200, {"content-type": "application/x-protobuf", connection: "close"});
    response.end();
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  assert.ok(address && typeof address === "object");
  const telemetry = createTelemetryResource({
    environment: "development", namespace: "coffee-platform", releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${address.port}`},
    producer: {queueCapacity: 16, maxRecordBytes: 16384, batchSize: 16, batchIntervalMs: 60000, exportTimeoutMs: 1000, diagnosticIntervalMs: 60000, flushTimeoutMs: 1000},
  }, "otel-shutdown-loss-test", "test-token");
  const before = telemetryDiagnostics();
  telemetry.start();
  trace.getTracer("otel-shutdown-loss-test").startSpan("shutdown.loss.probe").end();
  const shutdown = new AbortController();
  shutdown.abort(new Error("bounded shutdown probe"));
  await telemetry.stop(shutdown.signal);
  await new Promise(resolve => collector.close(resolve));
  assert.equal(telemetryDiagnostics().shutdownLoss, before.shutdownLoss + 1);
});

void test("runtime owner metric bridge exports fixed gauges and counters while filtering unbounded attributes", async (t) => {
  const payloads = [];
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {payloads.push(Buffer.concat(chunks)); response.writeHead(200, {"content-type": "application/x-protobuf"}); response.end();});
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  assert.ok(address && typeof address === "object");
  const telemetry = createTelemetryResource({
    environment: "development",
    namespace: "coffee-platform", releaseDigest: "test", collector: {otlpEndpoint: `http://127.0.0.1:${address.port}`},
    producer: {queueCapacity: 16, maxRecordBytes: 16384, batchSize: 4, batchIntervalMs: 60000, exportTimeoutMs: 500, diagnosticIntervalMs: 60000, flushTimeoutMs: 1000},
  }, "otel-owner-metrics-test", "test-token", () => [
    "coffee_realtime_connections 3",
    "coffee_realtime_invalidation_dropped_total 2",
    "coffee_realtime_connections{entity=\"ord_metric_canary\"} 90",
    "coffee_aroma_mutation_calls_total{action=\"remove\"} 4",
    "coffee_aroma_mutation_calls_total{action=\"order_ref_canary\"} 90",
    "coffee_aroma_unknown_outcomes_current 2",
  ]);
  t.after(async () => {if (collector.listening) await new Promise(resolve => collector.close(resolve));});
  telemetry.start();
  metrics.getMeter("metric-attribute-view-test").createObservableGauge("metric.attribute.view.canary").addCallback(result => {
    result.observe(1, {entity: "metric_entity_canary", "orders.result": "success"});
  });
  await telemetry.stop(new AbortController().signal);
  await new Promise(resolve => collector.close(resolve));
  const payload = Buffer.concat(payloads);
  for (const name of ["coffee_realtime_connections", "coffee_realtime_invalidation_dropped_total", "coffee_aroma_mutation_calls_total", "coffee_aroma_unknown_outcomes_current", "metric.attribute.view.canary", "runtime_process_rss_bytes", "runtime_event_loop_delay_p95_ms", "runtime_process_start_time_seconds", "telemetry_log_records_dropped_total", "telemetry_records_dropped_total", "telemetry_export_failures_total", "telemetry_shutdown_losses_total"])
    assert.ok(payload.includes(Buffer.from(name)), `OTLP export contains ${name}`);
  for (const secret of ["ord_metric_canary", "order_ref_canary", "metric_entity_canary", "entity"])
    assert.equal(payload.includes(Buffer.from(secret)), false, `${secret} is excluded from OTLP`);
  assert.ok(payload.includes(Buffer.from("deployment.environment")) && payload.includes(Buffer.from("development")));
  assert.ok(payload.includes(Buffer.from("remove")) && payload.includes(Buffer.from("orders.result")));
});

void test("telemetry starts before business resources and flushes their stop-time metrics and spans last", async (t) => {
  const payloads = [];
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {payloads.push({path: request.url, body: Buffer.concat(chunks)}); response.writeHead(200, {"content-type": "application/x-protobuf"}); response.end();});
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  assert.ok(address && typeof address === "object");
  const telemetry = createTelemetryResource({
    environment: "development", namespace: "coffee-platform", releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${address.port}`},
    producer: {queueCapacity: 16, maxRecordBytes: 16384, batchSize: 4, batchIntervalMs: 60000, exportTimeoutMs: 500, diagnosticIntervalMs: 60000, flushTimeoutMs: 1000},
  }, "otel-resource-order-test", "test-token");
  const owner = {
    name: "business-start-probe",
    start() {metrics.getMeter("business-start-probe").createCounter("business.start.counter").add(1);},
    stop() {
      metrics.getMeter("business-stop-probe").createCounter("business.stop.counter").add(1);
      const span = trace.getTracer("business-stop-probe").startSpan("business.shutdown.flush.probe");
      span.end();
    },
    destroy() {},
  };
  t.after(async () => {if (collector.listening) await new Promise(resolve => collector.close(resolve));});
  const app = await startApp(identity("telemetry-order-test", {resources: [telemetry, owner]}));
  await stopApp(app);
  await new Promise(resolve => collector.close(resolve));
  assert.ok(payloads.some(({path, body}) => path === "/v1/metrics" && body.includes(Buffer.from("business.stop.counter"))));
  assert.ok(payloads.some(({path, body}) => path === "/v1/metrics" && body.includes(Buffer.from("business.start.counter"))));
  assert.ok(payloads.some(({path, body}) => path === "/v1/traces" && body.includes(Buffer.from("business.shutdown.flush.probe"))));
});

void test("SSE server span is exported at handshake while its stream stays open", async (t) => {
  let exportedSpans = Buffer.alloc(0);
  const collector = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {exportedSpans = Buffer.concat([exportedSpans, Buffer.concat(chunks)]); response.writeHead(200, {"content-type": "application/x-protobuf"}); response.end();});
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const collectorAddress = collector.address();
  assert.ok(collectorAddress && typeof collectorAddress === "object");
  const telemetry = createTelemetryResource({
    environment: "development", namespace: "coffee-platform", releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${collectorAddress.port}`},
    producer: {queueCapacity: 16, maxRecordBytes: 16384, batchSize: 1, batchIntervalMs: 60000, exportTimeoutMs: 500, diagnosticIntervalMs: 60000, flushTimeoutMs: 1000},
  }, "sse-span-handshake-test", "test-token");
  const app = await startApp(identity("sse-span-handshake-test", {
    resources: [telemetry],
    configure(instance) {
      instance.get("/events", (request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, {"Content-Type": "text/event-stream; charset=utf-8"});
        reply.raw.write("event: stream-ready.v1\n\n");
        completeRuntimeRequestTelemetry(request, 200);
      });
    },
  }));
  const port = addressOf(app).port;
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest({host: "127.0.0.1", port, path: "/events"}, incoming => resolve({request, incoming}));
    request.once("error", reject);
    request.end();
  });
  t.after(async () => {
    response.request.destroy();
    response.incoming.destroy();
    await stopApp(app);
    if (collector.listening) await new Promise(resolve => collector.close(resolve));
  });
  await waitFor(() => exportedSpans.includes(Buffer.from("HTTP GET")));
  assert.equal(response.incoming.complete, false, "the SSE response remains open after its request span is exported");
  response.request.destroy();
  response.incoming.destroy();
  await stopApp(app);
  await new Promise(resolve => collector.close(resolve));
});

void test("public Edge TLS accepts a browser client while internal TLS rejects a client without service identity", async (t) => {
  const material = await tlsMaterial(t);
  assert.notEqual(material.publicTls.certPem, material.serviceTls.certPem);
  assert.notEqual(material.publicTls.keyPem, material.serviceTls.keyPem);
  const publicApp = await createRuntime(identity("edge-public-test", {
    transport: {environment: "development", runtime: "edge-gateway", mode: "public-tls", material: material.serviceTls, publicTls: material.publicTls},
  }));
  publicApp.get("/public", async () => ({status: "ok"}));
  try {
    await publicApp.runtimeController.start();
    const publicPort = addressOf(publicApp).port;
    assert.equal(await requestHttps(publicPort, {ca: material.publicTls.caPem, servername: material.publicTls.hostname}), 200);
    await assert.rejects(requestHttps(publicPort, {ca: material.publicLeafCaPem, servername: material.publicTls.hostname}));
    await assert.rejects(requestHttps(publicPort, {ca: material.wrongCaPem, servername: material.publicTls.hostname}));
    await assert.rejects(requestHttps(publicPort, {ca: material.publicTls.caPem, servername: "wrong.edge.test"}));
  } finally {
    await stopApp(publicApp);
  }

  const internalApp = await createRuntime(identity("edge-internal-test", {
    transport: {environment: "development", runtime: "edge-gateway", mode: "mtls", material: material.serviceTls},
  }));
  internalApp.get("/public", async () => ({status: "ok"}));
  try {
    await internalApp.runtimeController.start();
    const internalPort = addressOf(internalApp).port;
    await assert.rejects(requestHttps(internalPort, {ca: material.serviceTls.certPem, servername: "edge-gateway"}));
  } finally {
    await stopApp(internalApp);
  }

  const apiPublicMaterial = await tlsMaterial(t, "edge.test", "api-public");
  const healthcheckSecretsDirectory = await mkdtemp(join(tmpdir(), "coffee-healthcheck-secrets-"));
  t.after(() => rm(healthcheckSecretsDirectory, {recursive: true, force: true}));
  const healthcheckSecretsPath = join(healthcheckSecretsDirectory, "api-public.yaml");
  await writeFile(healthcheckSecretsPath, `${JSON.stringify({
    schemaVersion: 1,
    environment: "development",
    runtime: "api-public",
    secrets: {security: {serviceTransportKeys: {"api-public": JSON.stringify({
      keyPem: apiPublicMaterial.serviceTls.keyPem,
      certPem: apiPublicMaterial.serviceTls.certPem,
      caPem: apiPublicMaterial.serviceTls.caPem,
    })}}},
  })}\n`);
  await chmod(healthcheckSecretsPath, 0o400);
  const apiPublicApp = await createRuntime(identity("api-public-healthcheck", {
    transport: {environment: "development", runtime: "api-public", mode: "mtls", material: apiPublicMaterial.serviceTls},
    requiredDependencies: ["database"],
    readinessChecks: [{name: "database", check: async () => false}],
  }));
  try {
    await apiPublicApp.runtimeController.start();
    const healthcheckEnvironment = {
      COFFEE_CONFIG_FILE: join(root, "config/platform.yaml"),
      COFFEE_RUNTIME_SECRETS_FILE: healthcheckSecretsPath,
      RUNTIME_NAME: "api-public",
      PORT: String(addressOf(apiPublicApp).port),
    };
    const client = createHttpClient({
      origin: `https://127.0.0.1:${addressOf(apiPublicApp).port}`,
      tls: {material: apiPublicMaterial.serviceTls, targetEnvironment: "development", targetRuntime: "api-public"},
    });
    try {
      const response = await client.fetch("/health/live");
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } finally {
      await client.close();
    }
    assert.deepEqual(await readRuntimeHealthStatuses(["/health/ready"], healthcheckEnvironment), [503]);
    await assert.rejects(runRuntimeHealthcheck(["/health/ready"], healthcheckEnvironment), /runtime healthcheck failed: 503/);
  } finally {
    await stopApp(apiPublicApp);
  }
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

void test("configured private Edge startup requires mTLS and validates its service hostname", async (t) => {
  const hostname = "edge-gateway";
  const material = await tlsMaterial(t, hostname);
  const directory = await mkdtemp(join(tmpdir(), "coffee-configured-edge-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const port = await freePort();
  const source = await readFile(join(root, "config/platform.yaml"), "utf8");
  const configPath = join(directory, "platform.yaml");
  await writeFile(configPath, source.replace("listen: {host: 0.0.0.0, port: 4000}", `listen: {host: 0.0.0.0, port: ${port}}`));
  const config = await loadPlatformConfig(configPath, (text) => parseYaml(text, {json: true}));
  assert.equal(config.services["edge-gateway"].transportMode, "mtls");
  const secrets = {};
  for (const ref of [...config.services["edge-gateway"].secretRefs, ...config.services["edge-gateway"].optionalSecretRefs]) {
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      current[segment] ??= {};
      current = current[segment];
    }
    current[segments.at(-1)] = ref === "edge.tlsCaBundle"
      ? material.publicTls.caPem
      : ref === "security.serviceTransportKeys.edge-gateway"
          ? JSON.stringify({keyPem: material.serviceTls.keyPem, certPem: material.serviceTls.certPem, caPem: material.serviceTls.caPem})
          : "test-secret";
  }
  const secretsPath = join(directory, "edge-gateway.yaml");
  await writeFile(secretsPath, `${JSON.stringify({schemaVersion: 1, environment: config.environment, runtime: "edge-gateway", secrets})}\n`);
  await chmod(secretsPath, 0o400);
  const previousConfig = process.env.COFFEE_CONFIG_FILE;
  const previousSecrets = process.env.COFFEE_RUNTIME_SECRETS_FILE;
  let app;
  process.env.COFFEE_CONFIG_FILE = configPath;
  process.env.COFFEE_RUNTIME_SECRETS_FILE = secretsPath;
  try {
    app = await startConfiguredRuntime("edge-gateway");
    const peer = {path: "/health/live", ca: material.serviceTls.caPem, cert: material.serviceTls.certPem, key: material.serviceTls.keyPem, servername: hostname};
    assert.equal(await requestHttps(port, peer), 200);
    await assert.rejects(requestHttps(port, {path: "/health/live", ca: material.serviceTls.caPem, servername: hostname}));
    await assert.rejects(requestHttps(port, {...peer, ca: material.wrongCaPem}));
    await assert.rejects(requestHttps(port, {...peer, servername: "wrong.edge.test"}));
    assert.deepEqual(await runRuntimeHealthcheck(["/health/live"], {
      COFFEE_CONFIG_FILE: configPath,
      COFFEE_RUNTIME_SECRETS_FILE: secretsPath,
      RUNTIME_NAME: "edge-gateway",
      PORT: String(port),
    }), [200]);
    const withoutOptionalCa = JSON.parse(JSON.stringify({schemaVersion: 1, environment: config.environment, runtime: "edge-gateway", secrets}));
    delete withoutOptionalCa.secrets.edge.tlsCaBundle;
    const withoutOptionalCaPath = join(directory, "edge-gateway-without-public-ca.yaml");
    await writeFile(withoutOptionalCaPath, `${JSON.stringify(withoutOptionalCa)}\n`);
    await chmod(withoutOptionalCaPath, 0o400);
    const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COFFEE_") && !key.startsWith("SOPS_")));
    childEnvironment.COFFEE_CONFIG_FILE = configPath;
    childEnvironment.COFFEE_RUNTIME_SECRETS_FILE = withoutOptionalCaPath;
    childEnvironment.RUNTIME_NAME = "edge-gateway";
    childEnvironment.PORT = String(port);
    const noBundleResult = await runHealthcheckChild(childEnvironment);
    assert.equal(noBundleResult.code, 0, noBundleResult.output);
    assert.equal(noBundleResult.signal, null);
  } finally {
    await app?.runtimeController.closeRuntime("SIGTERM").catch(() => {});
    if (previousConfig === undefined) delete process.env.COFFEE_CONFIG_FILE;
    else process.env.COFFEE_CONFIG_FILE = previousConfig;
    if (previousSecrets === undefined) delete process.env.COFFEE_RUNTIME_SECRETS_FILE;
    else process.env.COFFEE_RUNTIME_SECRETS_FILE = previousSecrets;
  }
});

async function requestJson(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {host: "127.0.0.1", port, path, ...options},
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({response, body}));
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function waitForChildExit(child, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("child did not exit before timeout"));
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => finish(resolve, {code, signal}));
  });
}

void test("Fastify close drains in-flight work before completing", async () => {
  const app = await createRuntime(identity("lifecycle-test"));
  let release;
  let entered = false;
  app.get("/inflight", async () => {
    entered = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "completed"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = fetch(`http://127.0.0.1:${port}/inflight`, {
    headers: {connection: "close"},
  });
  await waitFor(() => entered);
  let closed = false;
  const closing = stopApp(app).then((result) => {
    closed = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  release();
  const response = await request;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {status: "completed"});
  assert.deepEqual(await closing, {status: "stopped", pending: []});
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("health endpoints expose live and ready states", async () => {
  const app = await startApp(identity("health-test"));
  const live = await app.inject("/health/live");
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), {status: "live", runtime: "health-test"});
  const ready = await app.inject("/health/ready");
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(await stopApp(app), {status: "stopped", pending: []});
});

void test("readiness checks fail closed, recover, and expose correlation context", async (t) => {
  const spans = captureRuntimeSpans(t);
  let dependencyReady = false;
  const logs = [];
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const app = await createRuntime(identity("readiness-test", {
    health: {...health, timeoutMs: 100},
    requiredDependencies: ["database"],
    readinessChecks: [{name: "database", check: async () => dependencyReady}],
  }));
  app.log.warn = (fields, message) => logs.push({fields, message});
  app.get("/context", async (request) => ({
    requestCorrelationId: request.correlationContext?.correlationId,
    deadlineUtc: request.runtimeContext?.deadlineUtc,
  }));
  app.get("/client-error", async (_request, reply) => reply.code(404).send());
  app.post("/malformed-json", async () => ({status: "handler must not run"}));
  app.get("/server-error", async () => { throw new Error("synthetic server failure"); });
  await app.runtimeController.start();
  const notReady = await app.inject({
    method: "GET",
    url: "/health/ready",
    headers: {"x-correlation-id": correlationId},
  });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(spans[0].status, {code: SpanStatusCode.ERROR});
  assert.deepEqual(notReady.json(), {status: "not-ready", runtime: "readiness-test"});
  assert.deepEqual(logs, [{fields: {event: "runtime.readiness.failed", dependency: "database", reason: "NotReady"}, message: "runtime readiness failed"}]);
  dependencyReady = true;
  const ready = await app.inject({
    method: "GET",
    url: "/health/ready",
    headers: {"x-correlation-id": correlationId, traceparent},
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(spans[1].status, undefined);
  assert.equal(logs.length, 1);
  assert.equal(ready.headers["x-correlation-id"], correlationId);
  assert.equal(ready.headers.traceparent, traceparent);
  const context = await app.inject({
    method: "GET",
    url: "/context",
    headers: {"x-correlation-id": correlationId, traceparent},
  });
  const clientError = await app.inject("/client-error");
  assert.equal(clientError.statusCode, 404);
  assert.equal(spans.at(-1).status, undefined);
  const malformedJson = await app.inject({method: "POST", url: "/malformed-json", headers: {"content-type": "application/json"}, payload: "{"});
  assert.equal(malformedJson.statusCode, 400);
  assert.equal(spans.at(-1).status, undefined);
  const serverError = await app.inject("/server-error");
  assert.equal(serverError.statusCode, 500);
  assert.deepEqual(spans.at(-1).status, {code: SpanStatusCode.ERROR});
  assert.equal(context.json().requestCorrelationId, correlationId);
  assert.match(context.json().deadlineUtc, /^\d{4}-\d{2}-\d{2}T/);
  const invalid = await app.inject({
    method: "GET",
    url: "/context",
    headers: {"x-correlation-id": "invalid", traceparent: "invalid"},
  });
  assert.match(invalid.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
  assert.equal(invalid.headers.traceparent, undefined);
  await stopApp(app);
});

void test("automatic request logs carry validated correlation fields", async () => {
  const runtimePath = new URL("../../packages/platform-runtime/src/index.ts", import.meta.url).href;
  const script = `
    import {createRuntime} from ${JSON.stringify(runtimePath)};
    const app = await createRuntime({name: "request-log-correlation-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 100});
    app.get("/log-context", async (request) => {
      request.log.info("handler correlation probe");
      return {ok: true};
    });
    await app.runtimeController.start();
    await app.inject({method: "GET", url: "/log-context", headers: {
      "x-correlation-id": "11111111-1111-4111-8111-111111111111",
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    }});
    const invalid = await app.inject({method: "GET", url: "/log-context", headers: {
      "x-correlation-id": "invalid",
      traceparent: "invalid",
    }});
    process.stderr.write(JSON.stringify({fallbackCorrelationId: invalid.headers["x-correlation-id"]}) + "\\n");
    await app.runtimeController.closeRuntime("SIGTERM");
    await new Promise((resolve) => app.log.flush(resolve));
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({code, signal}));
  });
  assert.equal(exit.code, 0, stderr);
  const fallbackCorrelationId = JSON.parse(stderr.trim()).fallbackCorrelationId;
  const records = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const message of ["incoming request", "request completed", "handler correlation probe"]) {
    const eventRecords = records.filter((record) => record.runtime === "request-log-correlation-test" && record.msg === message);
    const valid = eventRecords.find((record) => record.correlationId === "11111111-1111-4111-8111-111111111111");
    assert.ok(valid, `${message} includes valid correlation ID`);
    assert.equal(valid.traceparent, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    const invalid = eventRecords.find((record) => record.correlationId === fallbackCorrelationId);
    assert.ok(invalid, `${message} includes generated fallback correlation ID`);
    assert.equal(Object.hasOwn(invalid, "traceparent"), false, `${message} omits invalid traceparent`);
  }
});

void test("shutdown resources stop once in reverse order and repeated close is idempotent", async () => {
  const calls = [];
  const resource = (name) => ({
    name,
    start: async () => { calls.push(`start:${name}`); },
    stop: async () => { calls.push(`stop:${name}`); },
    destroy: () => { calls.push(`destroy:${name}`); },
  });
  const app = await startApp(identity("shutdown-test", {
    resources: [resource("database"), resource("worker")],
  }));
  const first = stopApp(app, "SIGTERM");
  const second = stopApp(app, "SIGINT");
  assert.strictEqual(first, second);
  assert.deepEqual(await first, {status: "stopped", pending: []});
  assert.deepEqual(calls, ["start:database", "start:worker", "stop:worker", "stop:database"]);
  assert.equal(app.runtimeController.phase(), "stopped");
  assert.strictEqual(await app.runtimeController.whenStopped, await first);
});

void test("phase transition rejects invalid edges and keeps repeated transition harmless", async () => {
  const app = await createRuntime(identity("phase-test"));
  assert.equal(app.runtimeController.phase(), "starting");
  assert.throws(() => app.runtimeController.transition("stopped"), (error) =>
    error instanceof RuntimeError && error.code === "RUNTIME_INVALID_TRANSITION");
  await app.runtimeController.start();
  assert.equal(app.runtimeController.phase(), "running");
  app.runtimeController.transition("draining");
  app.runtimeController.transition("draining");
  assert.equal(app.runtimeController.phase(), "draining");
  const result = await stopApp(app);
  assert.deepEqual(result, {status: "stopped", pending: []});
  assert.throws(() => app.runtimeController.transition("running"), /RUNTIME_INVALID_TRANSITION/);
});

void test("liveness stays live while draining and readiness fails closed", async () => {
  const gate = Promise.withResolvers();
  let entered = 0;
  const app = await startApp(identity("draining-test", {
    configure: (server) => {
      server.addHook("onRequest", async () => {
        entered += 1;
        await gate.promise;
      });
    },
  }));
  const {port} = addressOf(app);
  const live = requestJson(port, "/health/live");
  const ready = requestJson(port, "/health/ready");
  await waitFor(() => entered === 2);
  const closing = stopApp(app);
  assert.equal(app.runtimeController.phase(), "draining");
  gate.resolve();
  assert.equal((await live).response.statusCode, 200);
  assert.equal((await ready).response.statusCode, 503);
  assert.deepEqual(await closing, {status: "stopped", pending: []});
  assert.equal(app.server.listening, false);
  await assert.rejects(requestJson(port, "/health/ready", {agent: false}), {code: "ECONNREFUSED"});
  assert.throws(() => app.runtimeController.start(), /RUNTIME_INVALID_TRANSITION/);
});

void test("premature GET response disconnect aborts the request signal", async () => {
  let entered = false;
  let rawRequest;
  let release;
  let signal;
  const app = await createRuntime(identity("disconnect-get-test", {deadlineMs: 2_000}));
  app.get("/slow", async (request) => {
    rawRequest = request.raw;
    signal = request.runtimeContext.signal;
    entered = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "completed"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({host: "127.0.0.1", port, path: "/slow"});
  request.end();
  await waitFor(() => entered);
  assert.equal(rawRequest.complete, true);
  await closeClientRequest(request);
  await waitFor(() => signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_CLIENT_DISCONNECTED");
  release();
  await stopApp(app);
});

void test("non-cooperative handler stays tracked after disconnect and forces fail-stop", async (t) => {
  const spans = captureRuntimeSpans(t);
  let entered = false;
  let signal;
  const app = await createRuntime(identity("non-cooperative-test", {deadlineMs: 2_000, shutdownGraceMs: 40}));
  app.get("/blackhole", async (request) => {
    signal = request.runtimeContext.signal;
    entered = true;
    await new Promise(() => {});
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({host: "127.0.0.1", port, path: "/blackhole"});
  request.end();
  await waitFor(() => entered);
  await closeClientRequest(request);
  await waitFor(() => signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_CLIENT_DISCONNECTED");
  await waitFor(() => spans[0]?.ends === 1);
  assert.equal(spans[0].ends, 1);
  assert.equal(spans[0].attributes.outcome, "client_aborted");
  assert.equal(spans[0].attributes["http.response.status_code"], undefined);
  assert.deepEqual(spans[0].status, {code: SpanStatusCode.ERROR});
  const result = await stopApp(app);
  assert.equal(result.status, "fail-stop");
  assert.deepEqual(result.pending, ["handlers"]);
  assert.equal(app.runtimeController.phase(), "stopped");
  assert.equal(app.server.listening, false);
});

void test("request deadline finishes telemetry for a non-cooperative handler", async (t) => {
  const spans = captureRuntimeSpans(t);
  let signal;
  const app = await createRuntime(identity("deadline-blackhole-test", {deadlineMs: 30, shutdownGraceMs: 40}));
  app.get("/blackhole", async (request) => {
    signal = request.runtimeContext.signal;
    await new Promise(() => {});
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/blackhole`));
  await waitFor(() => signal?.aborted && spans[0]?.ends === 1);
  assert.equal(signal.reason.code, "RUNTIME_REQUEST_DEADLINE");
  assert.equal(spans[0].ends, 1);
  assert.equal(spans[0].attributes.outcome, "deadline_exceeded");
  assert.equal(spans[0].attributes["http.response.status_code"], undefined);
  assert.deepEqual(spans[0].status, {code: SpanStatusCode.ERROR});
  assert.equal((await stopApp(app)).status, "fail-stop");
});

void test("runtime server spans bound unrecognized HTTP methods", async (t) => {
  const spans = captureRuntimeSpans(t);
  const app = await createRuntime(identity("unrecognized-method-test"));
  t.after(() => stopApp(app));
  app.route({method: "TRACE", url: "/trace", handler: async () => ({status: "ok"})});
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const {response} = await requestJson(port, "/trace", {method: "TRACE"});
  assert.equal(response.statusCode, 200);
  assert.equal(spans[0].name, "HTTP _OTHER");
  assert.equal(spans[0].attributes["http.request.method"], "_OTHER");
  assert.equal(spans[0].ends, 1);
});

void test("partial POST input disconnects before the request is complete", async () => {
  let signal;
  const app = await createRuntime(identity("disconnect-post-test", {deadlineMs: 2_000}));
  app.post("/partial", async () => ({status: "unexpected"}));
  app.addHook("onRequest", (request) => {
    if (request.routeOptions.url === "/partial") signal = request.runtimeContext.signal;
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/partial",
    method: "POST",
    headers: {"content-type": "application/json", "content-length": 10},
  });
  request.write("{}");
  await waitFor(() => signal !== undefined);
  await closeClientRequest(request);
  await waitFor(() => signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_CLIENT_DISCONNECTED");
  await stopApp(app);
});

void test("normal finished response does not abort and clears the deadline timer", async () => {
  let signal;
  const app = await createRuntime(identity("normal-response-test", {deadlineMs: 30}));
  app.get("/fast", async (request) => {
    signal = request.runtimeContext.signal;
    assert.match(request.runtimeContext.deadlineUtc, /^\d{4}-\d{2}-\d{2}T/);
    return {status: "ok"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const result = await requestJson(port, "/fast");
  assert.equal(result.response.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal.aborted, false);
  await stopApp(app);
});

void test("request deadline aborts a cooperative handler and destroys its response", async () => {
  let signal;
  const app = await createRuntime(identity("deadline-test", {deadlineMs: 30}));
  app.get("/deadline", async (request) => {
    signal = request.runtimeContext.signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
    return {status: "never-sent"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/deadline`));
  await waitFor(() => signal !== undefined && signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_REQUEST_DEADLINE");
  await stopApp(app);
});

void test("durable acceptance survives disconnect and idempotency replay does not repeat the effect", async () => {
  const ledger = new Map();
  const effects = [];
  let accepted = false;
  let release;
  let signal;
  const app = await createRuntime(identity("durable-accept-test", {deadlineMs: 2_000}));
  app.post("/command", async (request) => {
    signal = request.runtimeContext.signal;
    const key = request.headers["idempotency-key"];
    const completed = ledger.get(key);
    if (completed !== undefined) return {status: "replay", effect: completed};
    effects.push(key);
    ledger.set(key, "committed");
    request.runtimeContext.acceptDurable();
    accepted = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "accepted", effect: "committed"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const first = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/command",
    method: "POST",
    headers: {"content-type": "application/json", "content-length": 2, "idempotency-key": "command-1"},
  });
  first.end("{}");
  await waitFor(() => accepted);
  await closeClientRequest(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
  release();
  const replay = await requestJson(port, "/command", {
    method: "POST",
    headers: {"content-type": "application/json", "content-length": 2, "idempotency-key": "command-1"},
    body: "{}",
  });
  assert.equal(replay.response.statusCode, 200);
  assert.deepEqual(JSON.parse(replay.body), {status: "replay", effect: "committed"});
  assert.deepEqual(effects, ["command-1"]);
  await stopApp(app);
});

void test("startup failure stops acquired resources in reverse order", async () => {
  const calls = [];
  const resources = [
    {name: "first", start: () => { calls.push("start:first"); }, stop: () => { calls.push("stop:first"); }, destroy: () => { calls.push("destroy:first"); }},
    {name: "second", start: () => { calls.push("start:second"); throw new Error("startup boom"); }, stop: () => { calls.push("stop:second"); }, destroy: () => { calls.push("destroy:second"); }},
  ];
  const app = await createRuntime(identity("startup-failure-test", {resources}));
  await assert.rejects(app.runtimeController.start(), /startup boom/);
  assert.deepEqual(calls, ["start:first", "start:second", "stop:second", "stop:first"]);
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("startup blackhole times out, cleans acquired resources, and skips later resources", async () => {
  const calls = [];
  let firstDestroyed = 0;
  let secondStarted = false;
  const app = await createRuntime(identity("startup-blackhole-test", {
    health: {...health, startupGraceMs: 30},
    shutdownGraceMs: 40,
    resources: [
      {
        name: "first",
        start: () => new Promise(() => {}),
        stop: () => { calls.push("stop:first"); },
        destroy: () => { firstDestroyed += 1; },
      },
      {
        name: "second",
        start: () => { secondStarted = true; },
        stop: () => { calls.push("stop:second"); },
        destroy: () => { calls.push("destroy:second"); },
      },
    ],
  }));
  const started = performance.now();
  await assert.rejects(app.runtimeController.start(), (error) => error?.code === "RUNTIME_STARTUP_DEADLINE");
  assert.ok(performance.now() - started < 500);
  assert.equal(secondStarted, false);
  assert.deepEqual(calls, ["stop:first"]);
  assert.equal(firstDestroyed, 1);
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("blackhole shutdown aborts requests, destroys resources, and closes the listener", async () => {
  let destroyed = 0;
  let requestSignal;
  let entered = false;
  let requestComplete = false;
  const app = await createRuntime(identity("blackhole-test", {
    shutdownGraceMs: 40,
    resources: [{
      name: "inflight-owner",
      stop: () => {},
      destroy: () => { destroyed += 1; },
    }],
  }));
  app.get("/open", async (request) => {
    requestSignal = request.runtimeContext.signal;
    requestComplete = request.raw.complete;
    entered = true;
    await new Promise((resolve) => requestSignal.addEventListener("abort", resolve, {once: true}));
    return {status: "aborted"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({host: "127.0.0.1", port, path: "/open"});
  const requestClosed = new Promise((resolve) => {
    request.once("close", resolve);
    request.once("error", resolve);
  });
  request.end();
  await waitFor(() => entered);
  assert.equal(requestComplete, true);
  const started = performance.now();
  const result = await stopApp(app);
  await requestClosed;
  assert.ok(performance.now() - started < 500);
  assert.equal(result.status, "fail-stop");
  assert.deepEqual([...result.pending].sort((left, right) => left.localeCompare(right)), ["handlers", "requests", "server-close"]);
  assert.equal(destroyed, 1);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason.code, "RUNTIME_SHUTDOWN_DEADLINE");
  assert.equal(app.runtimeController.phase(), "stopped");
  assert.equal(app.server.listening, false);
  await new Promise((resolve) => {
    const reconnect = httpRequest({host: "127.0.0.1", port, path: "/health/live"});
    reconnect.once("error", (error) => {
      assert.equal(error.code, "ECONNREFUSED");
      resolve();
    });
    reconnect.end();
  });
});

void test("blackhole resource stop is bounded and force-destroyed", async () => {
  let stopStarted = false;
  let destroyed = 0;
  const app = await startApp(identity("blackhole-resource-test", {
    shutdownGraceMs: 40,
    resources: [{
      name: "blackhole",
      stop: () => {
        stopStarted = true;
        return new Promise(() => {});
      },
      destroy: () => { destroyed += 1; },
    }],
  }));
  const started = performance.now();
  const result = await stopApp(app);
  assert.ok(performance.now() - started < 500, "resource stop must return within the bounded shutdown allowance");
  assert.equal(stopStarted, true);
  assert.equal(result.status, "fail-stop");
  assert.deepEqual(result.pending, ["server-close", "stop:blackhole"]);
  assert.equal(destroyed, 1);
  assert.equal(app.server.listening, false);
});

void test("readiness blackhole is bounded and does not start new probes while pending", async () => {
  let probes = 0;
  let checkSignal;
  const logs = [];
  const app = await startApp(identity("readiness-blackhole-test", {
    health: {...health, timeoutMs: 30},
    requiredDependencies: ["database"],
    readinessChecks: [{
      name: "database",
      check: (signal) => {
        probes += 1;
        checkSignal = signal;
        return new Promise(() => {});
      },
    }],
  }));
  app.log.warn = (fields, message) => logs.push({fields, message});
  const started = performance.now();
  const first = await app.inject("/health/ready");
  assert.ok(performance.now() - started < 500, "readiness blackhole must return within the bounded probe allowance");
  assert.equal(first.statusCode, 503);
  assert.equal(probes, 1);
  assert.equal(checkSignal.aborted, true);
  assert.equal(checkSignal.reason.code, "RUNTIME_READINESS_DEADLINE");
  assert.deepEqual(logs, [{fields:{event:"runtime.readiness.failed",dependency:"database",reason:"RuntimeError",code:"RUNTIME_READINESS_DEADLINE"},message:"runtime readiness failed"}]);
  assert.equal("message" in logs[0].fields, false);
  const second = await app.inject("/health/ready");
  assert.equal(second.statusCode, 503);
  assert.equal(probes, 1);
  const stopped = await stopApp(app);
  assert.equal(stopped.status, "fail-stop");
  assert.deepEqual(stopped.pending, ["readiness:database"]);
  assert.equal(app.server.listening, false);
});

void test("Orders InternalApi readiness rejects wrong mTLS peer and cancels blackhole on deadline/shutdown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-orders-readiness-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const authority = await certificateAuthority(directory, "service-ca", "/CN=coffee-orders-test-ca");
  const issue = async (runtime) => {
    const leaf = await signedCertificate(directory, runtime, `/CN=${runtime}`,
      `URI:spiffe://coffee-platform/development/${runtime},DNS:${runtime}`, authority, "serverAuth,clientAuth");
    return parseServiceTransportMaterial(JSON.stringify({...leaf, caPem: authority.certPem}), "development", runtime);
  };
  const [orders, internal, wrongPeer] = await Promise.all([
    issue("orders-service"), issue("api-internal"), issue("customer-service"),
  ]);
  let blackhole = false;
  let readyRequests = 0;
  let wrongRequests = 0;
  let canceledResponses = 0;
  const server = (material, onRequest) => createHttpsServer({
    key: material.keyPem, cert: material.certPem, ca: material.caPem,
    requestCert: true, rejectUnauthorized: true,
  }, (request, response) => {
    verifyTransportPeer(request.socket.getPeerCertificate(), "development", "orders-service");
    onRequest(request, response);
  });
  const internalServer = server(internal, (_request, response) => {
    readyRequests += 1;
    if (blackhole) {
      response.once("close", () => { canceledResponses += 1; });
      return;
    }
    response.writeHead(200).end();
  });
  const wrongServer = server(wrongPeer, (_request, response) => {
    wrongRequests += 1;
    response.writeHead(200).end();
  });
  const listen = async (listener) => {
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    return listener.address().port;
  };
  const [port, wrongPort] = await Promise.all([listen(internalServer), listen(wrongServer)]);
  const scopedClient = (targetPort) => createHttpClient({
    origin: `https://127.0.0.1:${targetPort}`,
    tls: {material: orders, targetEnvironment: "development", targetRuntime: "api-internal"},
    connections: 1,
  });
  const internalClient = scopedClient(port);
  const rejectedClient = scopedClient(wrongPort);
  let activeClient = rejectedClient;
  const signals = [];
  let app;
  try {
    app = await startApp(identity("orders-service", {
      health: {...health, timeoutMs: 150},
      readinessChecks: [{name: "orders-internal-api", check: signal => {
        signals.push(signal);
        return checkInternalApiReady(activeClient, signal);
      }}],
    }));
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.equal(wrongRequests, 0, "valid CA with wrong service identity must not reach HTTP");
    activeClient = internalClient;
    assert.equal((await app.inject("/health/ready")).statusCode, 200);

    blackhole = true;
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.equal(signals.at(-1).reason.code, "RUNTIME_READINESS_DEADLINE");
    await waitFor(() => canceledResponses === 1);
    blackhole = false;
    assert.equal((await app.inject("/health/ready")).statusCode, 200);

    blackhole = true;
    const inFlight = app.inject("/health/ready");
    await waitFor(() => readyRequests === 4);
    const stop = app.runtimeController.closeRuntime("SIGTERM");
    assert.equal((await inFlight).statusCode, 503);
    assert.equal(signals.at(-1).reason.code, "RUNTIME_DRAINING");
    assert.deepEqual(await stop, {status: "stopped", pending: []});
    await waitFor(() => canceledResponses === 2);
  } finally {
    await app?.runtimeController.closeRuntime("SIGTERM");
    await Promise.allSettled([internalClient.close(), rejectedClient.close()]);
    for (const listener of [internalServer, wrongServer]) {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  }
});

void test("AROMA worker compositions preserve consumer bindings and fail readiness on an unavailable DB", async t => {
  const {createDatabase}=await import("../../packages/platform-database/dist/index.js");
  const config=await loadPlatformConfig(join(root,"config/platform.yaml"),parseYaml);
  for(const [runtime,factory] of [["aroma-observer","createAromaObserverComposition"],["aroma-convergence","createAromaConvergenceComposition"],["orders-aroma-preparation","createAromaPreparationComposition"]]){
    const tls=runtime==="orders-aroma-preparation"?undefined:await tlsMaterial(t,"edge.test",runtime);
    const module=await import(`../../apps/${runtime}/dist/runtime-composition.js`);
    const composition=module[factory]();
    const database=createDatabase({owner:runtime,database:"coffee_platform_orders",allowedDatabase:"coffee_platform_orders",host:"127.0.0.1",port:9,
      user:"synthetic-unavailable",password:"synthetic-not-production",ssl:false,pool:config.services[runtime].dbPool,shutdownGraceMs:40000});
    const bindings=new Map();const errors=[];let relayDone;let usedSignal;
    const relayed=new Promise(resolve=>{relayDone=resolve;});
    const kafka={bind:(groupId,binding)=>bindings.set(groupId,binding),relay:async(_outbox,db,signal)=>{
      assert.strictEqual(db,database);usedSignal=signal;relayDone();}};
    const processSignal=new AbortController();const resource=composition.resources[0];
    try{
      await composition.configure({log:{error:entry=>errors.push(entry)}},processSignal.signal,database,kafka,
        {config,secrets:tls===undefined?{}:{security:{serviceTransportKeys:{[runtime]:JSON.stringify({keyPem:tls.serviceTls.keyPem,certPem:tls.serviceTls.certPem,caPem:tls.serviceTls.caPem})}}}});
      assert.deepEqual([...bindings.keys()],config.services[runtime].kafka.consumers.map(entry=>entry.groupId));
      if(runtime==="aroma-convergence"){
        const rejection=new Error("revoked before wake");const signal=AbortSignal.abort(rejection);
        await assert.rejects(bindings.values().next().value.handle({},null,{},signal),error=>error===rejection);
      }
      await resource.start(processSignal.signal);await relayed;
      assert.equal(composition.readinessChecks[0].check(),false);
      assert.equal(errors.length,1);assert.equal(errors[0].reason,"DatabaseTransactionError");
      if(runtime==="aroma-observer"){assert.equal(errors[0].code,"DB_CONNECTION_LOST");assert.equal(errors[0].sqlState,undefined);assert.deepEqual(Object.keys(errors[0]).sort(),["code","event","reason"]);}
      if(runtime==="orders-aroma-preparation"){
        assert.equal(errors[0].stage,"recover");assert.equal(errors[0].code,"DB_CONNECTION_LOST");assert.equal(errors[0].sqlState,undefined);
        assert.deepEqual(Object.keys(errors[0]).sort(),["code","event","reason","stage"]);
      }
      assert.ok(!JSON.stringify(errors).includes("synthetic-not-production"));
    }finally{await resource.stop(AbortSignal.timeout(5000));resource.destroy();database.resource.destroy();}
    assert.equal(usedSignal.aborted,true);assert.equal(composition.readinessChecks[0].check(),false);
  }
});

void test("concurrency admission cap keeps health endpoints available", async () => {
  let entered = false;
  let release;
  const app = await createRuntime(identity("concurrency-test", {concurrency: 1}));
  app.get("/busy", async () => {
    entered = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "done"};
  });
  app.get("/second", async () => ({status: "unexpected"}));
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const first = fetch(`http://127.0.0.1:${port}/busy`);
  await waitFor(() => entered);
  const second = await fetch(`http://127.0.0.1:${port}/second`);
  assert.equal(second.status, 503);
  assert.equal((await app.inject("/health/live")).statusCode, 200);
  assert.equal((await app.inject("/health/ready")).statusCode, 200);
  release();
  assert.equal((await first).status, 200);
  await stopApp(app);
});

void test("known deadline profile aborts and unknown profile is rejected", async () => {
  const unknown = await createRuntime(identity("unknown-profile-test", {
    deadlineProfiles: {defaultMs: 1_000, fastMs: 30},
  }));
  assert.throws(() => unknown.get("/unknown", {
    config: {runtimeDeadlineProfile: "missing"},
  }, async () => ({status: "unexpected"})), /RUNTIME_UNKNOWN_DEADLINE_PROFILE/);
  await stopApp(unknown);

  let signal;
  const app = await createRuntime(identity("known-profile-test", {
    deadlineMs: 1_000,
    deadlineProfiles: {defaultMs: 1_000, fastMs: 30},
  }));
  app.get("/fast", {
    config: {runtimeDeadlineProfile: "fastMs"},
  }, async (request) => {
    signal = request.runtimeContext.signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
    return {status: "never-sent"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/fast`));
  await waitFor(() => signal !== undefined && signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_REQUEST_DEADLINE");
  await stopApp(app);
});

void test("startRuntime removes its process signal listeners after normal stop", async () => {
  const before = {
    term: process.listenerCount("SIGTERM"),
    int: process.listenerCount("SIGINT"),
  };
  const app = await startRuntime(identity("signal-cleanup-test"));
  assert.equal(process.listenerCount("SIGTERM"), before.term + 1);
  assert.equal(process.listenerCount("SIGINT"), before.int + 1);
  assert.deepEqual(await stopApp(app), {status: "stopped", pending: []});
  await waitFor(() => process.listenerCount("SIGTERM") === before.term && process.listenerCount("SIGINT") === before.int);
});

void test("all 14 configured Node roots use one real listen/controller lifecycle and dependency matrix", async () => {
  const config = await loadPlatformConfig(join(root, "config/platform.yaml"), (text) => parseYaml(text, {json: true}));
  const serverCount = () => process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
  await waitFor(() => serverCount() === 0);
  const serversBefore = serverCount();
  const signalsBefore = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  const startRoot = async (options) => {
    const app = await startRuntime({...options, host: "127.0.0.1", port: 0});
    assert.equal(serverCount(), serversBefore + 1, `${options.name}: exactly one TCP server`);
    assert.equal(process.listenerCount("SIGTERM"), signalsBefore[0] + 1, options.name);
    assert.equal(process.listenerCount("SIGINT"), signalsBefore[1] + 1, options.name);
    return app;
  };
  const stopRoot = async (app) => {
    assert.deepEqual(await stopApp(app), {status: "stopped", pending: []});
    await waitFor(() => serverCount() === serversBefore);
    assert.equal(process.listenerCount("SIGTERM"), signalsBefore[0]);
    assert.equal(process.listenerCount("SIGINT"), signalsBefore[1]);
  };
  const expectedDependencies = {
    "edge-gateway": [],
    "api-public": [],
    "api-internal": [],
    "customer-service": ["database"],
    "catalog-service": ["database"],
    "catalog-supplier-sync": ["database"],
    "catalog-activation-worker": ["database", "kafka"],
    "pricing-service": ["database"],
    "orders-service": ["database", "kafka"],
    "orders-aroma-preparation": ["database", "kafka"],
    "aroma-observer": ["database", "kafka"],
    "aroma-convergence": ["database", "kafka"],
    "aroma-gateway": ["database"],
    "realtime-gateway": ["kafka"],
  };
  assert.equal(RUNTIME_NAMES.length, 14);
  assert.equal(config.nginxTransport.listen, 8443);
  for (const name of RUNTIME_NAMES) {
    const base = configuredRuntimeIdentity(config, name);
    const required = expectedDependencies[name];
    assert.deepEqual(base.requiredDependencies, required, name);
    const missing = await startRoot(base);
    const missingReady = await missing.inject("/health/ready");
    assert.equal(missingReady.statusCode, required.length === 0 ? 200 : 503, name);
    const missingLive = await missing.inject("/health/live");
    assert.equal(missingLive.statusCode, 200, name);
    await stopRoot(missing);
    if (required.length === 0) continue;
    const state = new Map(required.map((dependency) => [dependency, true]));
    const checks = required.map((dependency) => ({name: dependency, check: () => state.get(dependency)}));
    const healthy = await startRoot({...base, readinessChecks: checks});
    assert.equal((await healthy.inject("/health/ready")).statusCode, 200, name);
    state.set(required[0], false);
    assert.equal((await healthy.inject("/health/ready")).statusCode, 503, name);
    await stopRoot(healthy);
  }
});

void test("configured realtime shutdown is bounded by 20s without changing other roots", async () => {
  const config = await loadPlatformConfig(join(root, "config/platform.yaml"), (text) => parseYaml(text, {json: true}));
  assert.equal(configuredRuntimeIdentity(config, "realtime-gateway").shutdownGraceMs, 20000);
  assert.equal(configuredRuntimeIdentity(config, "orders-service").shutdownGraceMs, config.platform.shutdownGraceMs);
  assert.equal(configuredRuntimeIdentity(config, "orders-service").telemetryLogDiagnosticIntervalMs, config.telemetry.producer.diagnosticIntervalMs);
});

void test("configured roots preserve null deadlines for api-internal and realtime-gateway", async () => {
  const config = await loadPlatformConfig(join(root, "config/platform.yaml"), (text) => parseYaml(text, {json: true}));
  for (const name of ["api-internal", "realtime-gateway"]) {
    const base = configuredRuntimeIdentity(config, name, {
      configure: (app) => {
        app.get("/context", async (request) => ({deadlineUtc: request.runtimeContext.deadlineUtc}));
      },
    });
    const app = await startApp({...base, port: 0});
    assert.deepEqual((await app.inject("/context")).json(), {deadlineUtc: null});
    await stopApp(app);
  }
});

void test("configured owner receives the runtime's single opaque database resource", async () => {
  const config = await loadPlatformConfig(join(root, "config/platform.yaml"), (text) => parseYaml(text, {json: true}));
  const runtime = "customer-service";
  const secrets = {};
  for (const ref of config.services[runtime].secretRefs) {
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      current[segment] ??= {};
      current = current[segment];
    }
    current[segments.at(-1)] = ref.startsWith("postgres.")
      ? {username: "coffee_customer_rw", password: "test-password"}
      : "test-secret";
  }
  const tempDir = await mkdtemp(join("/tmp", "coffee-runtime-owner-test-"));
  const secretPath = join(tempDir, "customer-service.yaml");
  await writeFile(secretPath, `${JSON.stringify({
    schemaVersion: 1,
    environment: config.environment,
    runtime,
    secrets,
  })}\n`);
  await chmod(secretPath, 0o400);
  const previousConfig = process.env.COFFEE_CONFIG_FILE;
  const previousSecrets = process.env.COFFEE_RUNTIME_SECRETS_FILE;
  process.env.COFFEE_CONFIG_FILE = join(root, "config/platform.yaml");
  process.env.COFFEE_RUNTIME_SECRETS_FILE = secretPath;
  let received;
  let destroyed = false;
  try {
    await assert.rejects(
      startConfiguredRuntime(runtime, {
        configure: (_app, _signal, database) => {
          received = database;
          const destroy = database.resource.destroy;
          database.resource.destroy = () => {
            destroyed = true;
            destroy();
          };
          throw new Error("stop before resource start");
        },
      }),
      /stop before resource start/,
    );
    assert.ok(received);
    assert.equal(received.resource.name, "database");
    assert.equal(received.readiness.name, "database");
    assert.equal(destroyed, true);
    assert.deepEqual(received.metrics(), {
      active: 0,
      idle: 0,
      waiting: 0,
      saturationTotal: 0,
      pending: 0,
    });
  } finally {
    if (previousConfig === undefined) delete process.env.COFFEE_CONFIG_FILE;
    else process.env.COFFEE_CONFIG_FILE = previousConfig;
    if (previousSecrets === undefined) delete process.env.COFFEE_RUNTIME_SECRETS_FILE;
    else process.env.COFFEE_RUNTIME_SECRETS_FILE = previousSecrets;
    await rm(tempDir, {recursive: true, force: true});
  }
});

void test("startRuntime removes signal listeners and repeated process signals perform one shutdown in a child", async () => {
  const runtimePath = join(root, "packages/platform-runtime/src/index.ts");
  const script = `
    import {startRuntime} from ${JSON.stringify(runtimePath)};
    const app = await startRuntime({
      name: "signal-child",
      host: "127.0.0.1",
      port: 0,
      shutdownGraceMs: 50,
      resources: [{
        name: "blackhole",
        stop: () => { console.log("stop-hook"); return new Promise(() => {}); },
        destroy: () => console.log("destroy-hook"),
      }],
    });
    console.log("ready");
    void app;
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not start: ${stderr}`)), 2_000);
      const onData = () => {
        if (stdout.includes("ready")) { clearTimeout(timer); child.stdout.removeListener("data", onData); resolve(); }
      };
      child.stdout.on("data", onData);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.kill("SIGINT");
    const exit = await waitForChildExit(child);
    assert.equal(exit.code, 1, stderr);
    assert.equal((stdout.match(/stop-hook/g) ?? []).length, 1, stdout);
    assert.equal((stdout.match(/destroy-hook/g) ?? []).length, 1, stdout);
    assert.equal((stdout.match(/runtime.shutdown"/g) ?? []).length, 1, stdout);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

void test("scoped secrets fail closed on foreign identity or missing refs", () => {
  const valid = {
    schemaVersion: 1,
    environment: "development",
    runtime: "customer-service",
    secrets: {postgres: {customer: {password: "redacted"}}},
  };
  assert.doesNotThrow(() => assertScopedSecrets(valid, "customer-service", "development", ["postgres.customer"]));
  assert.throws(() => assertScopedSecrets({...valid, runtime: "orders-service"}, "customer-service", "development", ["postgres.customer"]), /identity mismatch/);
  assert.throws(() => assertScopedSecrets(valid, "customer-service", "development", ["postgres.ordersService"]), /required ref postgres\.ordersService is missing/);
  assert.throws(() => assertScopedSecrets({...valid, unexpected: true}, "customer-service", "development", ["postgres.customer"]), /unknown or missing metadata key/);
});

void test("runtime metrics endpoint appends bounded composition metrics", async (t) => {
  const app = await createRuntime({name: "metrics-composition-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, metrics: () => ["aroma_gateway_safe_read_attempts_total 1"]});
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const response = await app.inject({method: "GET", url: "/metrics"});
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /runtime_admission_rejected_total 0/);
  for (const metric of ["runtime_event_loop_utilization", "runtime_event_loop_delay_p95_ms", "runtime_process_rss_bytes", "runtime_process_heap_used_bytes", "runtime_process_external_bytes", "runtime_process_array_buffers_bytes", "runtime_gc_pause_count_total", "runtime_gc_pause_total_ms"])
    assert.match(response.body, new RegExp(`^${metric} `, "m"));
  assert.match(response.body, /aroma_gateway_safe_read_attempts_total 1/);
});

void test("AROMA worker telemetry keeps span names and metric series bounded and redacted", async () => {
  const {trace} = await import("@opentelemetry/api");
  const original = trace.getTracer.bind(trace);
  const spans = [];
  trace.getTracer = () => ({startSpan: (name) => {
    const attributes = [];
    spans.push({name, attributes});
    return {setAttribute: (key, value) => attributes.push([key, value]), setStatus() {}, end() {}};
  }});
  try {
    const [{AromaPreparationTelemetry}, {AromaObserverTelemetry}, {AromaConvergenceTelemetry}] = await Promise.all([
      import("../../apps/orders-aroma-preparation/src/observability.ts"),
      import("../../apps/aroma-observer/src/observability.ts"),
      import("../../apps/aroma-convergence/src/observability.ts"),
    ]);
    const preparation = new AromaPreparationTelemetry();
    const observer = new AromaObserverTelemetry();
    const convergence = new AromaConvergenceTelemetry();
    const capturedAt = nowInstant().subtract({milliseconds: 1_000}).toString();
    preparation.desired("123", capturedAt);
    observer.observed(capturedAt);
    convergence.observed(capturedAt);
    await preparation.observe("orders.aroma_preparation.inbox", async () => {});
    await observer.observe("aroma.observer.provider.read", async () => {});
    await convergence.observe("aroma.convergence.provider.mutation", async () => {});
    await assert.rejects(preparation.observe("order_ref_secret", async () => {}), /Unsupported preparation span/);
    observer.result("observed");
    preparation.result("inbox", "order_ref_secret");
    observer.result("order_ref_secret");
    convergence.attempt("operation_ref_secret");
    convergence.attempt("unknown_outcome");
    convergence.blocker(2);
    convergence.mutation("remove");
    convergence.providerFailure();
    assert.equal(convergence.ready, false);
    convergence.providerSuccess();
    assert.equal(convergence.ready, true);
    const metrics = [...preparation.render(), ...observer.render(), ...convergence.render()].join("\n");
    assert.deepEqual(spans.map(({name}) => name), [
      "orders.aroma_preparation.inbox", "aroma.observer.provider.read", "aroma.convergence.provider.mutation",
    ]);
    assert.ok(spans.every(({attributes}) => attributes.length === 0));
    assert.doesNotMatch(metrics, /order_ref_secret|operation_ref_secret/);
    assert.match(metrics, /coffee_aroma_preparation_desired_revision 123/);
    const desiredAge = Number(metrics.match(/coffee_aroma_preparation_desired_age_ms (\d+)/)?.[1]);
    const observedAge = Number(metrics.match(/coffee_aroma_observed_age_ms (\d+)/)?.[1]);
    assert.ok(Number.isFinite(desiredAge) && Number.isFinite(observedAge));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(Number(preparation.render().at(-1)?.split(" ").at(-1)) > desiredAge);
    assert.ok(Number(observer.render().at(-1)?.split(" ").at(-1)) > observedAge);
    assert.match(metrics, /coffee_aroma_observation_results_total\{result="observed"\} 1/);
    assert.match(metrics, /coffee_aroma_unknown_outcomes_total 1/);
    assert.match(metrics, /coffee_aroma_blockers_total 2/);
    assert.match(metrics, /coffee_aroma_mutation_calls_total\{action="remove"\} 1/);
  } finally {trace.getTracer = original;}
});

void test("opt-in admission response is saturation-only and precedes handler; defaults and health stay unchanged", async (t) => {
  let release, entered = 0, calls = 0;
  const app = await createRuntime(identity("early-admission", {concurrency: 1,
    admissionResponse: (request, reply) => {
      calls++;
      if (request.routeOptions.url !== "/events") return false;
      reply.code(503).type("application/problem+json").header("Cache-Control", "no-store").send({code: "REALTIME_CAPACITY_EXCEEDED", correlationId: request.correlationContext.correlationId});
      return true;
    },
  }));
  app.get("/hold", async () => {entered++; await new Promise(resolve => {release = resolve;}); return "released";});
  app.get("/events", async () => {entered++; return "must not run";});
  await app.runtimeController.start(); t.after(() => stopApp(app));
  const held = app.inject({url:"/hold"}); void held.then(() => {});
  await waitFor(() => entered === 1);
  const saturated = await app.inject({url:"/events"});
  release(); await held;
  assert.equal(saturated.statusCode, 503); assert.equal(saturated.json().code,"REALTIME_CAPACITY_EXCEEDED");
  assert.equal(saturated.headers["content-type"],"application/problem+json; charset=utf-8");
  assert.equal(saturated.headers["cache-control"],"no-store");
  assert.equal(saturated.json().correlationId,saturated.headers["x-correlation-id"]);
  assert.doesNotMatch(saturated.body,/stream-ready|event-stream/); assert.equal(entered,1); assert.equal(calls,1);
  assert.equal((await app.inject({url:"/health/live"})).statusCode,200);
  assert.equal((await app.inject({url:"/events"})).statusCode,200);assert.equal(entered,2);
  app.runtimeController.transition("draining");
  const before = calls; const drain = await app.inject({url:"/events"});
  assert.equal(drain.statusCode,503);assert.equal(drain.body,"");assert.equal(calls,before);
});
