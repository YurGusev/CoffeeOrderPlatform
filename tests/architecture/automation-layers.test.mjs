import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTOMATION_ROOTS = ["scripts", "tools", "verification"];

// Разрешённые направления между пятью модулями автоматизации запуска:
// verification → tools-observability → tools → tools-config-bootstrap → scripts.
// Проверяются только рёбра между этими пятью корнями; импорты в tests/, apps/,
// packages/ и node:* вне контура, а внутримодульные файловые циклы
// (например tools/observability/alerts ↔ generate) намеренно не проверяются.
const ALLOWED = Object.freeze({
  scripts: ["scripts"],
  "tools-config-bootstrap": ["scripts", "tools-config-bootstrap"],
  tools: ["scripts", "tools-config-bootstrap", "tools"],
  "tools-observability": [
    "scripts",
    "tools-config-bootstrap",
    "tools",
    "tools-observability",
  ],
  verification: [
    "scripts",
    "tools-config-bootstrap",
    "tools",
    "tools-observability",
    "verification",
  ],
});
const MODULES = Object.keys(ALLOWED);

function moduleOf(source) {
  if (source.startsWith("tools/observability/")) return "tools-observability";
  if (source.startsWith("tools/config-bootstrap/"))
    return "tools-config-bootstrap";
  if (source.startsWith("tools/")) return "tools";
  if (source.startsWith("scripts/")) return "scripts";
  if (source.startsWith("verification/")) return "verification";
  return null;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function dependencyLine(source, specifier) {
  for (const quote of ["'", '"', "`"]) {
    const index = source.indexOf(`${quote}${specifier}${quote}`);
    if (index >= 0) return lineOf(source, index);
  }
  const index = source.indexOf(specifier);
  return index >= 0 ? lineOf(source, index) : 0;
}

function cycleOf(edges) {
  const adjacency = new Map(MODULES.map((name) => [name, []]));
  for (const { from, to } of edges) adjacency.get(from).push(to);
  for (const targets of adjacency.values())
    targets.sort((left, right) => left.localeCompare(right));
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const connect = (node) => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node)) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target))
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1)
      components.push(
        component.sort((left, right) => left.localeCompare(right)),
      );
  };
  for (const name of MODULES) if (!indices.has(name)) connect(name);
  return components;
}

function analyze() {
  return cruise(AUTOMATION_ROOTS, {
    ruleSet: { forbidden: [] },
    doNotFollow: { path: "node_modules" },
  }).then(async ({ output }) => {
    const analysis = typeof output === "string" ? JSON.parse(output) : output;
    const violations = [];
    const unresolved = [];
    const moduleEdges = new Map();
    for (const entry of analysis.modules) {
      const from = moduleOf(entry.source);
      if (!from) continue;
      const sourceText = await readFile(join(REPO_ROOT, entry.source), "utf8");
      for (const dependency of entry.dependencies) {
        if (!dependency.resolved) {
          if (dependency.module.startsWith("."))
            unresolved.push({
              file: entry.source,
              line: dependencyLine(sourceText, dependency.module),
              specifier: dependency.module,
            });
          continue;
        }
        const to = moduleOf(dependency.resolved);
        if (!to || to === from) continue;
        moduleEdges.set(`${from} -> ${to}`, { from, to });
        if (!ALLOWED[from].includes(to))
          violations.push({
            file: entry.source,
            line: dependencyLine(sourceText, dependency.module),
            from,
            to,
            specifier: dependency.module,
          });
      }
    }
    violations.sort((left, right) =>
      `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
    );
    unresolved.sort((left, right) =>
      `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
    );
    return {
      violations,
      unresolved,
      cycles: cycleOf([...moduleEdges.values()]),
    };
  });
}

const analysis = analyze();

void test("модули автоматизации запуска не имеют восходящих импортов", async () => {
  const { violations, unresolved } = await analysis;
  assert.deepEqual(
    unresolved,
    [],
    `Неразрешённые относительные импорты в контуре автоматизации запуска:\n${unresolved
      .map((entry) => `${entry.file}:${entry.line} (${entry.specifier})`)
      .join("\n")}`,
  );
  assert.deepEqual(
    violations,
    [],
    `Восходящие импорты между модулями автоматизации запуска:\n${violations
      .map(
        (entry) =>
          `${entry.file}:${entry.line} ${entry.from} -> ${entry.to} (${entry.specifier})`,
      )
      .join("\n")}`,
  );
});

void test("модули автоматизации запуска не образуют циклов", async () => {
  const { cycles } = await analysis;
  assert.deepEqual(
    cycles,
    [],
    `Циклы между модулями автоматизации запуска:\n${cycles
      .map((component) => component.join(" <-> "))
      .join("\n")}`,
  );
});
