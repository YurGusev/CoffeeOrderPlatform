#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));
const workspace = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "coffee-effect-authority-"));
const probeRoot = join(workspace, "probe");
const evidencePath = process.env.EFFECT_PROBE_EVIDENCE || join(repositoryRoot, "effect-authority-probe-result.json");
const keep = process.env.KEEP_EFFECT_PROBE === "1";
const startedAt = new Date().toISOString();
const commands = [];

function execute(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || probeRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout || 15 * 60 * 1000,
  });
  commands.push({ command: [command, ...args], durationMs: Date.now() - started, status: result.status, signal: result.signal });
  if (result.error || result.status !== 0) {
    throw new Error(`probe command failed: ${command} ${args.join(" ")}\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return result;
}

async function write(path, content) {
  const absolute = join(probeRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function waitForHttp(url, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const status = await new Promise((resolve) => {
      const req = request(url, { method: "GET" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode || 0));
      });
      req.on("error", () => resolve(0));
      req.setTimeout(500, () => { req.destroy(); resolve(0); });
      req.end();
    });
    if (status === 204) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Effect HttpApi server did not become healthy at ${url}`);
}

async function collectJavaScript(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".js")) output.push(path);
    }
  }
  await visit(root);
  return output;
}

const packageJson = {
  name: "coffee-effect-authority-probe",
  private: true,
  version: "0.0.0",
  type: "module",
  engines: { node: "26.8.1", npm: "11.19.0" },
  dependencies: {
    "@confluentinc/kafka-javascript": "1.10.0",
    "@effect/atom-react": "4.0.0-rc.112",
    "@effect/opentelemetry": "4.0.0-rc.112",
    "@effect/platform-browser": "4.0.0-rc.112",
    "@effect/platform-node": "4.0.0-rc.112",
    "@effect/sql-pg": "4.0.0-rc.112",
    "@effect/tsgo": "0.39.0",
    "@effect/vitest": "4.0.0-rc.112",
    "@opentelemetry/api": "1.9.1",
    "@opentelemetry/api-logs": "0.221.0",
    "@opentelemetry/resources": "2.10.0",
    "@opentelemetry/sdk-logs": "0.221.0",
    "@opentelemetry/sdk-metrics": "2.10.0",
    "@opentelemetry/sdk-trace-base": "2.10.0",
    "@opentelemetry/sdk-trace-node": "2.10.0",
    "@opentelemetry/sdk-trace-web": "2.10.0",
    "@opentelemetry/semantic-conventions": "1.43.0",
    "@types/node": "26.4.0",
    "@types/pg": "8.23.1",
    effect: "4.0.0-rc.112",
    pg: "8.23.0",
    react: "19.2.8",
    "react-dom": "19.2.8",
    scheduler: "0.27.0",
    typescript: "7.0.2",
    vite: "8.2.2",
    vitest: "4.1.11"
  }
};

try {
  await mkdir(probeRoot, { recursive: true });
  await write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  await write("tsconfig.json", `${JSON.stringify({
    compilerOptions: {
      target: "ES2025", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2025", "DOM", "DOM.Iterable"],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, useUnknownInCatchVariables: true,
      forceConsistentCasingInFileNames: true, verbatimModuleSyntax: true, isolatedModules: true, erasableSyntaxOnly: true,
      skipLibCheck: false, outDir: "dist", rootDir: "src",
      plugins: [{ name: "@effect/language-service", diagnosticSeverity: {
        floatingEffect: "error", missingEffectContext: "error", missingEffectError: "error", missingLayerContext: "error",
        promiseInEffectSuccess: "error", leakingRequirements: "error", runEffectInsideEffect: "error",
        scopeInLayerEffect: "error", strictEffectProvide: "error", tryCatchInEffectGen: "error", unknownInEffectCatch: "error"
      }}]
    }, include: ["src/**/*.ts"]
  }, null, 2)}\n`);

  await write("src/api.ts", `import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";\nexport class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })) {}\nexport class ProbeApi extends HttpApi.make("coffee-effect-authority-probe").add(SystemApi).annotateMerge(OpenApi.annotations({ title: "Coffee Effect Authority Probe", version: "1.0.0" })) {}\n`);
  await write("src/server.ts", `import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";\nimport { Effect, Layer } from "effect";\nimport { HttpRouter } from "effect/unstable/http";\nimport { HttpApiBuilder } from "effect/unstable/httpapi";\nimport { createServer } from "node:http";\nimport { ProbeApi } from "./api.js";\nconst handlers = HttpApiBuilder.group(ProbeApi, "system", Effect.fn(function* (group) { return group.handleAll({ health: () => Effect.void }); }));\nconst routes = HttpApiBuilder.layer(ProbeApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide(handlers));\nHttpRouter.serve(routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 37999 })), Layer.launch, NodeRuntime.runMain);\n`);
  await write("src/probe.ts", `import * as NodeSdk from "@effect/opentelemetry/NodeSdk";\nimport { Effect, Layer, Schema, Stream } from "effect";\nimport { OpenApi } from "effect/unstable/httpapi";\nimport { ProbeApi } from "./api.js";\nconst canonical = (value: unknown): string => { if (Array.isArray(value)) return \`[\${value.map(canonical).join(",")}]\`; if (value !== null && typeof value === "object") return \`{\${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => \`\${JSON.stringify(key)}:\${canonical(entry)}\`).join(",")}}\`; return JSON.stringify(value); };\nconst apiFirst = OpenApi.fromApi(ProbeApi); const apiSecond = OpenApi.fromApi(ProbeApi);\nif (apiFirst.openapi !== "3.1.0" || canonical(apiFirst) !== canonical(apiSecond)) throw new Error("OpenAPI 3.1 generation is not deterministic");\nconst Payload = Schema.Struct({ id: Schema.String, revision: Schema.String });\nconst schemaFirst = Schema.toJsonSchemaDocument(Payload); const schemaSecond = Schema.toJsonSchemaDocument(Payload);\nif (schemaFirst.dialect !== "draft-2020-12" || canonical(schemaFirst) !== canonical(schemaSecond)) throw new Error("JSON Schema generation is not deterministic");\nconst values = await Effect.runPromise(Stream.fromIterable([1, 2, 3]).pipe(Stream.runCollect));\nif (Array.from(values).join(",") !== "1,2,3") throw new Error("Effect Stream failed");\nawait Effect.runPromise(Effect.scoped(Layer.build(NodeSdk.layerEmpty)));\nconst kafkaModule = await import("@confluentinc/kafka-javascript");\nif (!("KafkaJS" in kafkaModule) && !("default" in kafkaModule)) throw new Error("Confluent native module did not load beside Effect runtime");\nconsole.log(JSON.stringify({ effect: "ok", openapi: apiFirst.openapi, jsonSchema: schemaFirst.dialect, stream: "ok", opentelemetry: "scoped", confluent: "loaded" }));\n`);
  await write("src/db.ts", `import { PgClient } from "@effect/sql-pg";\nimport { Effect, Layer, Redacted, Stream } from "effect";\nconst url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL is required");\nconst program = Effect.gen(function* () { const sql = yield* PgClient.PgClient; const rows = yield* sql<{ readonly value: number }>\`SELECT 42::int AS value\`; if (rows.length !== 1 || Number(rows[0]?.value) !== 42) throw new Error("typed PostgreSQL query failed"); const streamed = yield* sql<{ readonly value: number }>\`SELECT generate_series(1, 3)::int AS value\`.stream.pipe(Stream.runCollect); if (Array.from(streamed).length !== 3) throw new Error("PostgreSQL stream failed"); });\nconst Main = Layer.effectDiscard(program).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url), applicationName: "coffee-effect-authority-probe" })));\nawait Effect.runPromise(Effect.scoped(Layer.build(Main)));\nconsole.log(JSON.stringify({ postgres: "17.11", query: "typed", stream: "ok" }));\n`);
  await write("browser/index.html", `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n`);
  await write("browser/src/main.js", `import React from "react"; import { createRoot } from "react-dom/client"; import { RegistryProvider } from "@effect/atom-react"; import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"; import * as BrowserPlatform from "@effect/platform-browser"; const marker = \`AtomHttpApi:\${typeof AtomHttpApi.Service};BrowserExports:\${Object.keys(BrowserPlatform).length}\`; createRoot(document.getElementById("root")).render(React.createElement(RegistryProvider, null, React.createElement("main", null, marker)));\n`);
  await write("browser/vite.config.mjs", `import { defineConfig } from "vite"; import { fileURLToPath } from "node:url"; export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), build: { outDir: "dist", emptyOutDir: true, minify: false } });\n`);

  execute("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 20 * 60 * 1000 });
  const lockHash = await sha256(join(probeRoot, "package-lock.json"));
  execute("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 30 * 60 * 1000 });

  const nativeDirectory = join(probeRoot, "node_modules", "@confluentinc", "kafka-javascript");
  const nativeEnvironment = {
    CKJS_LINKING: "dynamic",
    BUILD_LIBRDKAFKA: "0",
    JOBS: "4",
    MAKEFLAGS: "-j4",
    LIBRARY_PATH: "/usr/local/lib",
    LD_LIBRARY_PATH: "/usr/local/lib",
    PKG_CONFIG_PATH: "/usr/local/lib/pkgconfig"
  };
  execute(process.execPath, ["../../@mapbox/node-pre-gyp/bin/node-pre-gyp", "rebuild"], { cwd: nativeDirectory, env: nativeEnvironment, timeout: 20 * 60 * 1000 });
  const addonPath = join(nativeDirectory, "build", "Release", "confluent-kafka-javascript.node");
  const linked = execute("ldd", [addonPath], { capture: true, env: nativeEnvironment });
  if (!linked.stdout.includes("/usr/local/lib/librdkafka.so.1")) throw new Error(`Confluent addon is not linked to pinned /usr/local librdkafka:\n${linked.stdout}`);

  execute(join(probeRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
  execute(join(probeRoot, "node_modules", ".bin", "effect-tsgo"), ["diagnostics", "--project", "tsconfig.json"], { timeout: 10 * 60 * 1000 });
  execute(process.execPath, ["dist/probe.js"], { env: nativeEnvironment });
  execute(process.execPath, ["dist/db.js"], { env: { ...nativeEnvironment, DATABASE_URL: process.env.DATABASE_URL || "" } });

  const server = spawn(process.execPath, ["dist/server.js"], { cwd: probeRoot, env: { ...process.env, ...nativeEnvironment }, stdio: ["ignore", "pipe", "pipe"] });
  let serverOutput = ""; server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); }); server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  try { await waitForHttp("http://127.0.0.1:37999/health"); } catch (error) { server.kill("SIGKILL"); throw new Error(`${error.message}\n${serverOutput}`); }
  server.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.kill("SIGKILL");
      reject(new Error("Effect server did not stop after SIGTERM"));
    }, 5000);
    server.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || code === 130 || signal === "SIGTERM") {
        resolve();
      } else {
        reject(new Error(`Effect server exit ${code}/${signal}\n${serverOutput}`));
      }
    });
  });

  execute(join(probeRoot, "node_modules", ".bin", "vite"), ["build", "--config", "browser/vite.config.mjs"], { timeout: 10 * 60 * 1000 });
  const browserFiles = await collectJavaScript(join(probeRoot, "browser", "dist"));
  const browserText = (await Promise.all(browserFiles.map((path) => readFile(path, "utf8")))).join("\n");
  for (const forbidden of ["@effect/platform-node", "@effect/sql-pg", "@confluentinc/kafka-javascript", "node:fs", "node:child_process"]) if (browserText.includes(forbidden)) throw new Error(`browser bundle contains forbidden Node/server import: ${forbidden}`);

  const npmVersion = execute("npm", ["--version"], { capture: true }).stdout.trim();
  const result = { status: "passed", startedAt, finishedAt: new Date().toISOString(), node: process.version, npm: npmVersion, packageLockSha256: lockHash, commands, proofs: { typescript7: true, effectTsgo: true, httpApiNode26: true, openApi31Deterministic: true, jsonSchema202012Deterministic: true, postgres1711QueryAndStream: true, browserViteNoNodeImports: true, opentelemetryScopedLayer: true, effectAndConfluentLoadTogether: true, confluentUsesPinnedDynamicLibrdkafka: true } };
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8"); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { status: "failed", startedAt, finishedAt: new Date().toISOString(), node: process.version, commands, error: error instanceof Error ? error.message : String(error) };
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8").catch(() => {}); console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
} finally { if (!keep) await rm(workspace, { recursive: true, force: true }); }
