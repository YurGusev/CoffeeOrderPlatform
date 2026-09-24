import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkArchitecture, checkStaticSource, checkTransitiveSourceGraph } from "../../scripts/check-architecture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(root, "tests/architecture/fixtures/negative/frontend");

async function fixture(name) {
  return readFile(resolve(fixtureRoot, name), "utf8");
}

const cases = [
  ["browser-node.ts", "/repo/apps/web/src/browser/negative.ts", "BOUND-BROWSER-NODE"],
  ["node-browser.ts", "/repo/apps/web/src/main.ts", "BOUND-NODE-BROWSER"],
  ["ui-network.ts", "/repo/packages/platform-ui/src/negative.ts", "BOUND-UI-NETWORK"],
  ["server-ui.ts", "/repo/apps/api-public/src/negative.ts", "BOUND-SERVER-UI"],
];

for (const [name, virtualPath, rule] of cases) {
  const source = await fixture(name);
  assert.throws(() => checkStaticSource(virtualPath, source), new RegExp(rule));
}

const transitiveCases = [
  ["browser-transitive-root.ts", "browser-transitive-helper.ts", "/repo/apps/web/src/browser/root.ts", "/repo/apps/web/src/browser/helper.ts", "BOUND-BROWSER-NODE"],
  ["server-ui-relative-root.ts", "server-ui-relative-target.ts", "/repo/apps/api-public/src/root.ts", "/repo/packages/platform-ui/src/index.ts", "BOUND-SERVER-UI"],
  ["ui-node-transitive-root.ts", "ui-node-transitive-helper.ts", "/repo/packages/platform-ui/src/index.ts", "/repo/packages/platform-ui/src/helper.ts", "BOUND-UI-NODE"],
  ["ui-query-transitive-root.ts", "ui-query-transitive-helper.ts", "/repo/packages/platform-ui/src/index.ts", "/repo/packages/platform-ui/src/helper.ts", "BOUND-UI-QUERY"],
];

for (const [rootFixture, helperFixture, rootPath, helperPath, rule] of transitiveCases) {
  const entries = [
    { path: rootPath, source: await fixture(rootFixture) },
    { path: helperPath, source: await fixture(helperFixture) },
  ];
  assert.throws(() => checkTransitiveSourceGraph(entries, { root: "/repo" }), new RegExp(rule));
}

const appImport = [{ path: "/repo/apps/orders-service/src/root.ts", source: 'import "@coffee-platform/unknown-business";' }];
assert.throws(() => checkTransitiveSourceGraph(appImport, { root: "/repo" }), /BOUND-IMPORT/);

console.log(`frontend boundary fixtures: passed (${cases.length + transitiveCases.length + 1})`);

const fullCheckRoot = await mkdtemp(resolve(tmpdir(), "coffee-frontend-boundary-"));
try {
  const browserRoot = resolve(fullCheckRoot, "apps/web/src/browser");
  await mkdir(browserRoot, { recursive: true });
  await writeFile(resolve(browserRoot, "main.ts"), await fixture("browser-console-node-root.ts"));
  await writeFile(resolve(fullCheckRoot, "apps/web/src/helper.ts"), await fixture("browser-console-node-helper.ts"));
  await assert.rejects(checkArchitecture(fullCheckRoot), /BOUND-BROWSER-NODE/);
  console.log("frontend boundary full-check regression: passed");
} finally {
  await rm(fullCheckRoot, { recursive: true, force: true });
}
