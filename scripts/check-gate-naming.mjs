#!/usr/bin/env node
/**
 * Проверка конвенции имён гейтов запуска.
 *
 * Гейты адресуются стабильным slug (`supply_chain`), а не номером позиции.
 * Номер — это позиция в matrix.yaml, он вычисляется при выводе отчёта и не
 * попадает в идентификаторы, env-переменные, коды ошибок, имена файлов и
 * комментарии. Иначе вставка гейта в середину матрицы переименовывает
 * публичные контракты.
 *
 * Снимок существующих нарушений хранится в scripts/gate-naming-baseline.json.
 * CI падает только на новых записях; этапы миграции удаляют записи из снимка,
 * пока он не станет пустым.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/gate-naming-baseline.json");
const GATE_NUMBER = String.raw`G[0-2][0-9]`;

const SCANNED_ROOTS = Object.freeze([
  "apps",
  "config",
  "docs",
  "packages",
  "scripts",
  "tests",
  "tools",
  "verification",
]);

// Текстовые расширения, в которых номер гейта не является данными прогона.
const SCANNED_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

// Исторические артефакты и канонические roots фиксируют прошлые байты и
// переписыванию не подлежат.
const EXCLUDED_PATHS = Object.freeze([
  "docs/reports/",
  "evidence/",
  "scripts/gate-naming-baseline.json",
  "docs/launch/22_GATE_NAMING.md",
  // Снимок прототипа: base64-строки не являются именами гейтов.
  "docs/frontend/prototypes/",
  // Конвенция и её проверочный тест содержат номера как контрпримеры.
  "tests/architecture/gate-naming.test.mjs",
]);

const RULES = Object.freeze([
  {
    kind: "identifier",
    // camelCase, PascalCase и SCREAMING_SNAKE с номером гейта внутри.
    pattern: new RegExp(
      String.raw`\b[A-Za-z][A-Za-z0-9_]*${GATE_NUMBER}[A-Za-z0-9_]*\b`,
      "gu",
    ),
  },
  {
    kind: "environment",
    pattern: new RegExp(
      String.raw`\b[A-Z][A-Z0-9_]*${GATE_NUMBER}[A-Z0-9_]*\b`,
      "gu",
    ),
  },
  {
    kind: "error-code",
    pattern: new RegExp(
      String.raw`\b[A-Z][A-Z0-9]*-${GATE_NUMBER}-[A-Z0-9-]+`,
      "gu",
    ),
  },
]);

// Комментарий — только маркер в начале строки и только в кодовых файлах:
// заголовки markdown и строковые литералы не являются комментариями.
const BARE_GATE = new RegExp(String.raw`\b${GATE_NUMBER}\b`, "gu");
// Строки, обязанные совпадать с неизменяемым историческим evidence, помечаются
// явным маркером и конвенцию не нарушают.
const HISTORICAL_MARKER = "gate-naming: allow-historical";
const COMMENT_PREFIX = /^\s*(?:\/\/|\/\*|\*|#)/u;
const COMMENT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".yaml",
  ".yml",
  ".sql",
]);
// Хеши и base64-строки не являются именами гейтов: у них нет ни одного
// разделителя слова и длина заметно больше осмысленного имени.
const HEX_TOKEN = /^[0-9a-f]{16,}$/u;
const BASE64_TOKEN = /^[A-Za-z0-9+/=]{20,}$/u;
const MAX_SYMBOL_LENGTH = 64;
const MAX_WORD_PARTS = 6;

// Одно слово даёт одну-две части при разбиении по регистру и разделителям;
// случайная base64-строка — много частей с цифрами.
export function isOpaqueToken(match) {
  if (match.length > MAX_SYMBOL_LENGTH) return true;
  if (HEX_TOKEN.test(match)) return true;
  if (!BASE64_TOKEN.test(match)) return false;
  const parts = match.split(/(?=[A-Z])|_/u).filter(Boolean);
  return parts.length > MAX_WORD_PARTS;
}
const COMMENT_GATE = new RegExp(String.raw`\b${GATE_NUMBER}\b`, "gu");
// PostgreSQL-версия в именах пакетов не является номером гейта.
const ALLOWED_TOKENS = new Set(["pg16", "pg17", "pg18", "_OTHER"]);
const BASELINE_VERSION = 1;

function isExcluded(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  return EXCLUDED_PATHS.some((prefix) => normalized.startsWith(prefix));
}

function isScanned(relativePath) {
  if (isExcluded(relativePath)) return false;
  if (!SCANNED_EXTENSIONS.has(extname(relativePath))) return false;
  return SCANNED_ROOTS.some(
    (root) => relativePath === root || relativePath.startsWith(`${root}${sep}`),
  );
}

function trackedFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(output.split("\0").filter(Boolean))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function lineOf(source, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1)
    if (source.charCodeAt(position) === 10) line += 1;
  return line;
}

export function violationsInSource(relativePath, source) {
  const path = relativePath.split(sep).join("/");
  const found = new Map();
  const add = (kind, line, match) => {
    found.set(`${kind}|${line}|${match}`, { kind, path, line, match });
  };
  const lines = source.split("\n");
  const historical = new Set(
    lines
      .map((text, index) => (text.includes(HISTORICAL_MARKER) ? index + 1 : 0))
      .filter(Boolean),
  );
  for (const hit of source.matchAll(BARE_GATE)) {
    if (ALLOWED_TOKENS.has(hit[0])) continue;
    if (historical.has(lineOf(source, hit.index))) continue;
    add("gate-number", lineOf(source, hit.index), hit[0]);
  }
  for (const rule of RULES)
    for (const hit of source.matchAll(rule.pattern)) {
      if (ALLOWED_TOKENS.has(hit[0])) continue;
      {
        if (rule.kind === "error-code" || !isOpaqueToken(hit[0]))
          add(rule.kind, lineOf(source, hit.index), hit[0]);
      }
    }
  if (COMMENT_EXTENSIONS.has(extname(path)))
    source.split("\n").forEach((text, index) => {
      if (!COMMENT_PREFIX.test(text)) return;
      for (const hit of text.matchAll(COMMENT_GATE))
        add("comment", index + 1, hit[0]);
    });
  return [...found.values()];
}

const PATH_GATE = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9])[A-Za-z0-9._-]*?${GATE_NUMBER}`,
  "u",
);

export function pathViolation(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  if (!PATH_GATE.test(normalized)) return null;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const hit =
    new RegExp(String.raw`\b${GATE_NUMBER}\b`, "u").exec(name) ??
    name.match(new RegExp(GATE_NUMBER, "u"));
  return {
    kind: "path",
    path: normalized,
    line: 0,
    match: hit ? hit[0] : name,
  };
}

async function collectViolations() {
  const violations = [];
  for (const relativePath of trackedFiles()) {
    if (!isScanned(relativePath)) continue;
    const fromPath = pathViolation(relativePath);
    if (fromPath) violations.push(fromPath);
    const source = await readFile(join(REPO_ROOT, relativePath), "utf8").catch(
      () => null,
    );
    if (source === null) continue;
    violations.push(...violationsInSource(relativePath, source));
  }
  return violations.sort(
    (a, b) =>
      a.path.localeCompare(b.path, "en") ||
      a.kind.localeCompare(b.kind, "en") ||
      a.match.localeCompare(b.match, "en"),
  );
}

function baselineKey(violation) {
  return [violation.path, violation.kind, violation.match].join("|");
}

function baselineFile(violations) {
  return {
    version: BASELINE_VERSION,
    note:
      "Снимок существующих нарушений конвенции имён гейтов. Каждый этап " +
      "миграции удаляет свои записи; пустой снимок означает полное " +
      "соответствие конвенции.",
    entries: [...new Set(violations.map(baselineKey))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  };
}

async function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const parsed = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  return new Set(parsed.entries ?? []);
}

function reportNewViolations(violations) {
  const byPath = new Map();
  for (const violation of violations) {
    const list = byPath.get(violation.path) ?? [];
    list.push(violation);
    byPath.set(violation.path, list);
  }
  for (const [path, list] of byPath) {
    console.error(`${path}:`);
    for (const { line, kind, match } of list)
      console.error(`  ${line}: [${kind}] ${match}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const violations = await collectViolations();

  if (args.includes("--write-baseline")) {
    await writeFile(
      BASELINE_PATH,
      `${JSON.stringify(baselineFile(violations), null, 2)}\n`,
    );
    console.log(
      `gate naming baseline: ${violations.length} записей в ${relative(REPO_ROOT, BASELINE_PATH)}`,
    );
  } else {
    const baseline = await readBaseline();
    const known = violations.filter((violation) =>
      baseline.has(baselineKey(violation)),
    ).length;
    const fresh = violations.filter(
      (violation) => !baseline.has(baselineKey(violation)),
    );
    if (fresh.length > 0) {
      console.error("Нарушения конвенции имён гейтов (номер вместо slug):");
      reportNewViolations(fresh);
      console.error(
        `\nНовых записей: ${fresh.length}. Допустимых в снимке: ${known} из ${baseline.size}.`,
      );
      console.error(
        "Используйте стабильный slug гейта. Снимок обновляйте только при " +
          "сокращении: node scripts/check-gate-naming.mjs --write-baseline",
      );
      process.exitCode = 1;
    } else {
      console.log(
        `gate naming: новых нарушений нет (в снимке ${known} из ${baseline.size})`,
      );
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
