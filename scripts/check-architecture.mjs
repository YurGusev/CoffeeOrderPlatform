#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTED_DEPENDENCY_CRUISER = '18.2.0';
const FORBIDDEN_ROOTS = ['packages/domain', 'packages/models', 'packages/shared-business'];
const ALLOWED_PLATFORM_PACKAGES = new Set([
  '@coffee-platform/config',
  '@coffee-platform/database',
  '@coffee-platform/idempotency',
  '@coffee-platform/inbox',
  '@coffee-platform/kafka-runtime',
  '@coffee-platform/migrations',
  '@coffee-platform/observability',
  '@coffee-platform/outbox',
  '@coffee-platform/platform-http',
  '@coffee-platform/platform-time',
  '@coffee-platform/runtime',
  '@coffee-platform/security',
  '@coffee-platform/testing',
]);

const EFFECT_UNSTABLE_ALLOWLIST = [
  'effect/unstable/http/',
  'effect/unstable/httpapi/',
  'effect/unstable/sql/',
  'effect/unstable/encoding/',
  'effect/unstable/reactivity/',
];

const EFFECT_OFFICIAL_PACKAGES = new Set([
  '@effect/platform-node',
  '@effect/platform-browser',
  '@effect/sql-pg',
  '@effect/opentelemetry',
  '@effect/atom-react',
  '@effect/vitest',
]);

const TEMPORARY_LEGACY_ALLOW_NEW_USAGE = false;

// This table is intentionally local and finite. Each entry is removed by its
// owner during #50-#54; an exact source line keeps allowNewUsage=false.
const TEMPORARY_LEGACY_INVENTORY = Object.freeze({
  'packages/platform-config/src/index.ts': {
    owner: 'issue-51',
    removalIssue: 'issue-51',
    rules: {'ARCH-EFFECT-PRIMARY': [{line: 256, text: 'export async function loadPlatformConfig'}]},
  },
  'packages/platform-database/src/index.ts': {
    owner: 'issue-52',
    removalIssue: 'issue-52',
    rules: {'ARCH-EFFECT-PRIMARY': [{line: 31, text: 'export async function withTransaction'}]},
  },
  'packages/platform-idempotency/src/index.ts': {
    owner: 'issue-53',
    removalIssue: 'issue-53',
    rules: {'ARCH-EFFECT-DURABILITY': [{line: 55, text: 'new Map<string, IdempotencyRecord<Response>>()'}]},
  },
  'packages/platform-inbox/src/index.ts': {
    owner: 'issue-53',
    removalIssue: 'issue-53',
    rules: {
      'ARCH-EFFECT-PRIMARY': [{line: 54, text: 'export async function consumeOnce'}],
      'ARCH-EFFECT-DURABILITY': [{line: 84, text: 'new Map<string, StoredInboxRecord>()'}],
    },
  },
  'packages/platform-kafka-runtime/src/index.ts': {
    owner: 'issue-53',
    removalIssue: 'issue-53',
    rules: {'ARCH-EFFECT-PRIMARY': [{line: 97, text: 'export async function processKafkaRecord'}]},
  },
  'packages/platform-migrations/src/index.ts': {
    owner: 'issue-52',
    removalIssue: 'issue-52',
    rules: {'ARCH-EFFECT-PRIMARY': [{line: 52, text: 'export async function applyMigrations'}]},
  },
  'packages/platform-outbox/src/index.ts': {
    owner: 'issue-53',
    removalIssue: 'issue-53',
    rules: {
      'ARCH-EFFECT-DURABILITY': [
        {line: 52, text: 'new Map<string, Stored>()'},
        {line: 53, text: 'new Map<string, string>()'},
      ],
    },
  },
  'packages/platform-runtime/src/index.ts': {
    owner: 'issue-51',
    removalIssue: 'issue-51',
    rules: {
      'ARCH-EFFECT-PRIMARY': [
        {line: 134, text: 'export async function createRuntime'},
        {line: 226, text: 'Promise.all('},
        {line: 285, text: 'Promise.race('},
        {line: 287, text: 'new Promise<never>'},
        {line: 307, text: 'export async function startRuntime'},
        {line: 327, text: 'export async function startConfiguredRuntime'},
      ],
    },
  },
  'packages/platform-testing/src/index.ts': {
    owner: 'issue-49',
    removalIssue: 'issue-49',
    rules: {
      'ARCH-EFFECT-PRIMARY': [
        {line: 34, text: 'new Promise<Result>'},
        {line: 45, text: 'export async function assertEventually'},
        {line: 50, text: 'new Promise<void>'},
        {line: 55, text: 'export async function assertRejectsCode'},
        {line: 50, text: 'setTimeout(resolve, intervalMs)'},
      ],
    },
  },
  'packages/platform-time/src/index.ts': {
    owner: 'issue-51',
    removalIssue: 'issue-51',
    rules: {'ARCH-EFFECT-PRIMARY': [{line: 15, text: 'Temporal.Now.instant()'}]},
  },
});

const EFFECT_PRIMARY_CHECKS = [
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\basync\s+function\b/g, message: 'async function is forbidden; use Effect.gen'},
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\bnew\s+Promise\b/g, message: 'new Promise is forbidden; use Effect'},
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\bPromise\.(?:all|race|allSettled)\s*\(/g, message: 'Promise combinators are forbidden; use Effect'},
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\b(?:setTimeout|setInterval)\s*\(/g, message: 'timers are forbidden; use Effect Schedule/Clock'},
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\b(?:new\s+)?AbortController\b/g, message: 'AbortController is forbidden; use Effect cancellation'},
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\bDate\.now\s*\(/g, message: 'Date.now is forbidden; use Effect Clock'},
  {rule: 'ARCH-EFFECT-PRIMARY', pattern: /\bTemporal\.Now\b/g, message: 'Temporal.Now is forbidden; use Effect Clock'},
];

const EFFECT_RUN_PATTERN = /\b(?:Effect\.run[A-Za-z0-9_$]*|Layer\.launch|ManagedRuntime\.make)\s*\(/g;
const EFFECT_PROVIDE_PATTERN = /\b(?:Effect\.provide|Layer\.[A-Za-z_$][\w$]*)\s*\(/g;
const EFFECT_FIBER_PATTERN = /\bEffect\.fork(?:Daemon)?\s*\(/g;
const EFFECT_DURABILITY_PATTERN = /\b(?:new\s+(?:Map|WeakMap|Ref|Queue|Cache)(?:<[^>\n]+>)?|(?:Ref|Queue|Cache)\.(?:make|unsafeMake|unbounded|bounded))\s*\(/g;
const EFFECT_RETRY_PATTERN = /\b(?:Effect\.(?:retry|repeat)|Schedule\.[A-Za-z_$][\w$]*|(?:retry|withRetry|retryMiddleware)\s*\()/g;
const IMPORT_SPECIFIER_PATTERN = /\b(?:from|import(?:\s*\()?)\s*["']([^"']+)["']/g;
const GENERATED_CONTRACT_PATTERN = /(?:^|[\\/])(?:dto|openapi|generated|sdk)(?:[.\\/]|$)/i;
const SQL_IMPORT_PATTERN = /^(?:node:)?pg(?:\/|$)/i;
const SENSITIVE_LAYER_PATH_PATTERN = /(?:^|[\\/])(?:domain|repository|repositories|db|database|infrastructure)(?:[\\/]|$)/i;
const DURABLE_SOURCE_PATTERN = /(?:idempotency|inbox|outbox|attempt|lease|fence|reservation|journal|durable|processed)/i;

function isAllowedPlatformPackage(name) {
  return ALLOWED_PLATFORM_PACKAGES.has(name) || name.startsWith('@coffee-platform/contracts-');
}

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

function lineNumber(source, index) {
  return source.slice(0, Math.max(0, index)).split('\n').length;
}

function failAt(rule, label, source, index, message) {
  fail(rule, `${label}:${lineNumber(source, index)} ${message}`);
}

function lineText(source, index) {
  const start = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

function isLegacyUsage(label, rule, source, index) {
  const entry = TEMPORARY_LEGACY_INVENTORY[label];
  if (entry === undefined) return false;
  const allowed = entry.rules[rule] ?? [];
  if (TEMPORARY_LEGACY_ALLOW_NEW_USAGE) return allowed.length > 0;
  const line = lineNumber(source, index);
  const text = lineText(source, index);
  return allowed.some((candidate) => {
    if (candidate.line !== line || !text.includes(candidate.text)) return false;
    const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
    const first = source.indexOf(candidate.text, lineStart);
    return first >= lineStart && first <= index && source.lastIndexOf(candidate.text, index) === first;
  });
}

function effectViolation(rule, label, source, index, message) {
  if (isLegacyUsage(label, rule, source, index)) return;
  failAt(rule, label, source, index, message);
}

function relativeLabel(root, path) {
  return posix.relative(resolve(root), resolve(path)).replaceAll('\\', '/');
}

function isProductionSource(label) {
  return /^(?:apps|packages)\/[^/]+\/src\//.test(label);
}

function isRunBoundaryAllowed(label) {
  return label.startsWith('tests/')
    || label.startsWith('tools/')
    || label.startsWith('scripts/')
    || /^apps\/[^/]+\/src\/main\.tsx?$/.test(label)
    || /^apps\/web\/src\/(?:main|runtime)\.tsx?$/.test(label);
}

function isProvideBoundaryAllowed(label) {
  return label.startsWith('tests/')
    || label.startsWith('tools/')
    || label.startsWith('scripts/')
    || /^apps\/[^/]+\/src\/main\.tsx?$/.test(label)
    || /^apps\/[^/]+\/src\/(?:.*\/)?layer\.tsx?$/.test(label)
    || /^packages\/platform-[^/]+\/src\/(?:.*\/)?layer\.tsx?$/.test(label);
}

function isAllowedEffectModule(moduleName) {
  if (moduleName === 'effect' || moduleName.startsWith('effect/')) {
    return !moduleName.startsWith('effect/unstable/')
      || EFFECT_UNSTABLE_ALLOWLIST.some((prefix) => moduleName.startsWith(prefix));
  }
  if ([...EFFECT_OFFICIAL_PACKAGES].some((name) => moduleName === name || moduleName.startsWith(`${name}/`))) return true;
  return !moduleName.startsWith('@effect/');
}

function isVersionedContractImport(moduleName) {
  return /^@coffee-platform\/contracts-[\w-]+-v\d+(?:\/|$)/.test(moduleName)
    || /^@coffee\/contracts\/[\w-]+-v\d+(?:\/|$)/.test(moduleName);
}

function importMatches(source) {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)];
}

function resolvedRelativeImport(label, moduleName) {
  if (!moduleName.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(label), moduleName)).replace(/\.(?:[cm]?js|tsx?)$/, '');
}

function checkSourceSyntax(label, source) {
  const delimiters = new Map([['{', '}'], ['(', ')'], ['[', ']']]);
  const closing = new Set(delimiters.values());
  const stack = [];
  let mode = 'code';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === 'line-comment') {
      if (char === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        mode = 'code';
        index += 1;
      }
      continue;
    }
    if (mode === 'template') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '`') mode = 'code';
      continue;
    }
    if (mode === 'string') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) mode = 'code';
      else if (char === '\n' || char === '\r') failAt('ARCH-EFFECT-PARSER', label, source, index, 'unterminated string literal');
      continue;
    }
    if (char === '/' && next === '/') {
      mode = 'line-comment';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'block-comment';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      mode = 'string';
      quote = char;
      escaped = false;
      continue;
    }
    if (char === '`') {
      mode = 'template';
      escaped = false;
      continue;
    }
    if (delimiters.has(char)) stack.push({expected: delimiters.get(char), index});
    else if (closing.has(char)) {
      const opening = stack.pop();
      if (opening === undefined || opening.expected !== char) failAt('ARCH-EFFECT-PARSER', label, source, index, 'unbalanced delimiter');
    }
  }
  if (mode !== 'code') failAt('ARCH-EFFECT-PARSER', label, source, source.length, 'unterminated comment or string literal');
  if (stack.length > 0) failAt('ARCH-EFFECT-PARSER', label, source, stack.at(-1).index, 'unbalanced delimiter');
}

function checkEffectPrimary(label, source) {
  if (!isProductionSource(label)) return;
  for (const {rule, pattern, message} of EFFECT_PRIMARY_CHECKS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      effectViolation(rule, label, source, match.index, message);
    }
  }
}

function checkEffectRunBoundary(label, source) {
  EFFECT_RUN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(EFFECT_RUN_PATTERN)) {
    if (!isRunBoundaryAllowed(label)) {
      effectViolation('ARCH-EFFECT-RUN-BOUNDARY', label, source, match.index, 'Effect execution may start only at a runtime/test/approved CLI boundary');
    }
  }
}

function checkEffectProvideBoundary(label, source) {
  EFFECT_PROVIDE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(EFFECT_PROVIDE_PATTERN)) {
    if (!isProvideBoundaryAllowed(label)) {
      effectViolation('ARCH-EFFECT-PROVIDE-BOUNDARY', label, source, match.index, 'Layer composition may occur only in layer/main/test boundaries');
    }
  }
}

function checkEffectModuleAllowlist(label, source) {
  for (const match of importMatches(source)) {
    const moduleName = match[1];
    if (moduleName.startsWith('effect/') || moduleName.startsWith('@effect/')) {
      if (!isAllowedEffectModule(moduleName)) {
        effectViolation('ARCH-EFFECT-MODULE-ALLOWLIST', label, source, match.index, `Effect module ${moduleName} is not in ADR-0024 allowlist`);
      }
    }
  }
}

function checkEffectOwnerLayer(label, source) {
  if (!/(?:^|\/)layer\.tsx?$/.test(label) && !/\bLayer\s*\./.test(source)) return;
  const sourceParts = label.split('/');
  const sourceRuntime = sourceParts[0] === 'apps' ? sourceParts[1] : undefined;
  for (const match of importMatches(source)) {
    const moduleName = match[1];
    const target = resolvedRelativeImport(label, moduleName);
    if (target !== null) {
      const targetParts = target.split('/');
      if (targetParts[0] === 'apps' && (sourceRuntime === undefined || targetParts[1] !== sourceRuntime)) {
        effectViolation('ARCH-EFFECT-OWNER-LAYER', label, source, match.index, `owner Layer crosses runtime boundary to ${target}`);
      }
      if (targetParts[0] === 'packages' && SENSITIVE_LAYER_PATH_PATTERN.test(target)) {
        effectViolation('ARCH-EFFECT-OWNER-LAYER', label, source, match.index, `owner Layer imports implementation path ${target}`);
      }
      if (targetParts[0] === 'packages'
        && !target.startsWith('packages/platform-')
        && !/packages\/contracts\/[^/]+-v\d+(?:\/|$)/.test(target)) {
        effectViolation('ARCH-EFFECT-OWNER-LAYER', label, source, match.index, `owner Layer import ${target} is not an approved contract/platform dependency`);
      }
      continue;
    }
    if (moduleName.startsWith('.') || moduleName.startsWith('node:')) {
      effectViolation('ARCH-EFFECT-OWNER-LAYER', label, source, match.index, `owner Layer import ${moduleName} is not an approved contract/platform dependency`);
      continue;
    }
    if (!isAllowedEffectModule(moduleName) && !isVersionedContractImport(moduleName) && !ALLOWED_PLATFORM_PACKAGES.has(moduleName)) {
      effectViolation('ARCH-EFFECT-OWNER-LAYER', label, source, match.index, `owner Layer import ${moduleName} is not an approved contract/platform dependency`);
    }
  }
}

function checkEffectDurability(label, source) {
  if (!isProductionSource(label) || !DURABLE_SOURCE_PATTERN.test(`${label}\n${source}`)) return;
  EFFECT_DURABILITY_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(EFFECT_DURABILITY_PATTERN)) {
    effectViolation('ARCH-EFFECT-DURABILITY', label, source, match.index, 'durable protocol state must use PostgreSQL/Kafka, not in-memory Effect state');
  }
}

function checkEffectUnsafeRetry(label, source) {
  if (!isProductionSource(label) || !/aroma/i.test(`${label}\n${source}`) || !/(?:gateway|convergence|cart|mutation|preparation)/i.test(`${label}\n${source}`)) return;
  EFFECT_RETRY_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(EFFECT_RETRY_PATTERN)) {
    effectViolation('ARCH-EFFECT-UNSAFE-RETRY', label, source, match.index, 'unsafe AROMA mutation must not use generic retry/repeat/Schedule');
  }
}

function checkEffectScopedFiber(label, source) {
  if (!isProductionSource(label)) return;
  EFFECT_FIBER_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(EFFECT_FIBER_PATTERN)) {
    effectViolation('ARCH-EFFECT-SCOPED-FIBER', label, source, match.index, 'background effects must use a Scope-owned forkScoped');
  }
}

function checkEffectContractAuthority(label, source) {
  if (!isProductionSource(label)) return;
  if (GENERATED_CONTRACT_PATTERN.test(label) || /\b(?:interface|type|class)\s+[A-Za-z_$][\w$]*(?:Dto|DTO|OpenApi|OpenAPI)\b/.test(source)) {
    effectViolation('ARCH-EFFECT-CONTRACT-AUTHORITY', label, source, 0, 'handwritten DTO/OpenAPI/generated source is not contract authority');
  }
  for (const match of importMatches(source)) {
    const moduleName = match[1];
    const target = resolvedRelativeImport(label, moduleName);
    if (label.startsWith('apps/web/') && target?.startsWith('apps/') && target.split('/')[1] !== 'web') {
      effectViolation('ARCH-EFFECT-CONTRACT-AUTHORITY', label, source, match.index, `web cannot import internal runtime source ${target}`);
    }
    if (label.startsWith('apps/web/') && /(?:internal|generated|openapi|dto|sdk)|^@hey-api(?:\/|$)|^openapi-(?:fetch|typescript)(?:\/|$)/i.test(moduleName)) {
      effectViolation('ARCH-EFFECT-CONTRACT-AUTHORITY', label, source, match.index, `web import ${moduleName} is not an Effect Schema/HttpApi contract`);
    }
    if (label.startsWith('apps/web/') && isVersionedContractImport(moduleName) && /internal/i.test(moduleName)) {
      effectViolation('ARCH-EFFECT-CONTRACT-AUTHORITY', label, source, match.index, `web cannot import internal contract ${moduleName}`);
    }
  }
}

function checkEffectSqlBoundary(label, source) {
  if (!isProductionSource(label)) return;
  for (const match of importMatches(source)) {
    const moduleName = match[1];
    if (SQL_IMPORT_PATTERN.test(moduleName) && !label.startsWith('packages/platform-database/src/')) {
      effectViolation('ARCH-EFFECT-SQL-BOUNDARY', label, source, match.index, `direct pg import ${moduleName} is allowed only in platform-database`);
    }
  }
  for (const pattern of [
    /\bSqlClient\.withTransaction\s*\(/g,
    /\b(?:row|record|result)\s+as\s+[A-Z][A-Za-z0-9_$]*(?:Row|Record)\b/g,
  ]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (!label.startsWith('packages/platform-database/src/')) {
        effectViolation('ARCH-EFFECT-SQL-BOUNDARY', label, source, match.index, 'SQL row/transaction boundary requires Effect SQL and Schema decoding');
      }
    }
  }
  const dynamicSql = /`[^`]*(?:select|insert|update|delete|from|into|join|table)\b[^`]*\$\{[^}]+\}[^`]*`/gis;
  for (const match of source.matchAll(dynamicSql)) {
    if (!label.startsWith('packages/platform-database/src/')) {
      effectViolation('ARCH-EFFECT-SQL-BOUNDARY', label, source, match.index, 'SQL identifiers must be validated by the platform adapter');
    }
  }
}

function checkEffectRules(label, source) {
  checkSourceSyntax(label, source);
  checkEffectPrimary(label, source);
  checkEffectRunBoundary(label, source);
  checkEffectProvideBoundary(label, source);
  checkEffectModuleAllowlist(label, source);
  checkEffectOwnerLayer(label, source);
  checkEffectDurability(label, source);
  checkEffectUnsafeRetry(label, source);
  checkEffectScopedFiber(label, source);
  checkEffectContractAuthority(label, source);
  checkEffectSqlBoundary(label, source);
}

async function walk(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

async function checkPackageDependencies(root) {
  const files = [
    join(root, 'package.json'),
    ...await walk(join(root, 'apps')),
    ...await walk(join(root, 'packages')),
  ].filter((path) => path.endsWith('package.json') && existsSync(path));
  for (const path of files) {
    const json = JSON.parse(await readFile(path, 'utf8'));
    const dependencies = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string') continue;
      if (value.includes('/apps/') || value.startsWith('file:../apps') || value.startsWith('link:../apps')) {
        fail('BOUND-IMPORT', `${path} declares runtime implementation dependency ${name} -> ${value}`);
      }
      if (name.startsWith('@coffee-platform/') && !isAllowedPlatformPackage(name)) {
        fail('BOUND-IMPORT', `${path} declares forbidden shared business package ${name}`);
      }
      if (name.toLowerCase() === 'axios') fail('ARCH-FORBIDDEN-HTTP', `${path} declares forbidden Axios dependency`);
      if (/^(?:@?[^/]+\/)?(?:ffi(?:-napi)?|sqlite3?|better-sqlite3|vfs|virtual-fs|virtual_fs|memfs)$/i.test(name)) {
        fail('ARCH-FORBIDDEN-NATIVE', `${path} declares forbidden FFI/SQLite/VFS dependency ${name}`);
      }
    }
  }
}

const FORBIDDEN_MODULE_RE = /\b(?:from|import|require)\b[^\n]*['"]([^'"]+)['"]/ig;
const RELATIVE_IMPORT_RE = /\b(?:from|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function forbiddenModuleKind(moduleName) {
  const normalized = moduleName.toLowerCase();
  if (normalized === 'axios' || normalized.startsWith('axios-') || normalized.includes('/axios')) return 'axios';
  if (/(?:^|[/:@_-])(?:sqlite|sqlite3|better-sqlite3|ffi|ffi-napi|vfs|virtual-fs|virtual_fs)(?:$|[/:@_.-])/.test(normalized)) return 'native';
  return null;
}

function findSwitchBody(source, openingBrace) {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }
  return source.slice(openingBrace + 1);
}

function checkStaticSource(path, source) {
  const label = path.replaceAll('\\', '/');
  if (/\b(?:new\s+Date\s*\(|Date\s*\.\s*(?:now|parse|UTC)\s*\()/m.test(source)) {
    fail('ARCH-TEMPORAL', `${label}: mutable Date API is forbidden; use Temporal`);
  }
  for (const match of source.matchAll(FORBIDDEN_MODULE_RE)) {
    const moduleName = match[1];
    const kind = forbiddenModuleKind(moduleName);
    if (kind === 'axios') fail('ARCH-FORBIDDEN-HTTP', `${label}: Axios import ${moduleName} is forbidden; use native fetch/Undici`);
    if (kind === 'native') fail('ARCH-FORBIDDEN-NATIVE', `${label}: experimental FFI/SQLite/VFS import ${moduleName} is forbidden without an ADR allowlist`);
  }
  if (/^\s*(?:const\s+[^=]+\s*=\s*)?require\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$]/m.test(source)) {
    fail('TS7-ESM', `${label}: CommonJS require/module.exports is forbidden`);
  }
  for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
    if (!match[1].endsWith('.js')) fail('TS7-ESM', `${label}: relative import ${match[1]} must use a .js runtime specifier`);
  }
  if (/\benum\s+[A-Za-z_$][\w$]*/m.test(source)) fail('TS7-ERASABLE', `${label}: enum is non-erasable syntax; use a literal union`);
  if (/(?:\bas\s+any\b|:\s*any\b|<any>)/m.test(source)) fail('TS7-UNSAFE-ANY', `${label}: explicit any is forbidden`);
  if (/\bas\s+[A-Z][A-Za-z0-9_$]*(?:Ref|Version)\b/m.test(source)) fail('TS7-BRAND-CAST', `${label}: direct identifier brand cast is forbidden; parse and validate at the boundary`);

  if (/\beval\s*\(|\bnew\s+Function\s*\(|\b(?:setTimeout|setInterval)\s*\(\s*["']/m.test(source)) {
    fail('TS7-EVAL', label + ': dynamic code execution is forbidden');
  }
  for (const match of source.matchAll(/\bswitch\s*\([^)]*\)\s*\{/g)) {
    const body = findSwitchBody(source, match.index + match[0].lastIndexOf('{'));
    if (!/\bdefault\s*:/.test(body)) fail('TS7-EXHAUSTIVE-SWITCH', `${label}: state switch must have an exhaustive default/never branch`);
  }
  if (/^\s*(?:Promise\.(?:resolve|reject)|[A-Za-z_$][\w$]*(?:Async|Promise))\s*\([^;]*\);\s*$/m.test(source)) {
    fail('TS7-PROMISE', `${label}: promise expression is not awaited, returned, or explicitly voided`);
  }
  if (/\bOrderVersion\b/.test(source) && /\bProjectionVersion\b/.test(source) && /===|!==|<=|>=|<|>/.test(source)) {
    fail('TS7-VERSION-MIX', `${label}: OrderVersion and ProjectionVersion cannot be compared or mixed`);
  }
  checkEffectRules(label, source);
}

async function checkStaticSources(root) {
  const sourceFiles = (await Promise.all(['apps', 'packages', 'scripts', 'tests'].map((target) => walk(join(root, target)))))
    .flat()
    .filter((path) => /\.(?:ts|tsx|mts|cts)$/.test(path))
    .filter((path) => !relativeLabel(root, path).startsWith('tests/architecture/fixtures/'));
  for (const path of sourceFiles) checkStaticSource(relativeLabel(root, path), await readFile(path, 'utf8'));
}

async function checkPermissionManifests(root) {
  const appEntries = existsSync(join(root, 'apps'))
    ? (await readdir(join(root, 'apps'), { withFileTypes: true })).filter((entry) => entry.isDirectory())
    : [];
  const candidates = ['permission-manifest.json', 'permissions.json', 'permission.json'];
  const centralRoot = join(root, 'config', 'permissions');
  const centralFiles = existsSync(centralRoot)
    ? (await readdir(centralRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.schema.json')).map((entry) => entry.name.slice(0, -5))
    : [];
  const appNames = new Set(appEntries.map((entry) => entry.name));
  const unknownCentral = centralFiles.filter((name) => !appNames.has(name));
  if (appEntries.length > 0 && unknownCentral.length) fail('ARCH-PERMISSION', `unknown central runtime permission manifest ${unknownCentral.join(', ')}`);
  const manifests = [];
  for (const entry of appEntries) {
    const appRoot = join(root, 'apps', entry.name);
    const paths = candidates.filter((name) => existsSync(join(appRoot, name))).map((name) => join(appRoot, name));
    if (paths.length > 1) fail('ARCH-PERMISSION', `apps/${entry.name}: multiple permission manifests`);
    if (paths.length === 1) {
      if (existsSync(join(centralRoot, `${entry.name}.json`))) fail('ARCH-PERMISSION', `apps/${entry.name}: duplicate local and central permission manifests`);
      manifests.push({ app: entry.name, path: paths[0] });
    } else {
      const centralPath = join(centralRoot, `${entry.name}.json`);
      if (existsSync(centralPath)) manifests.push({ app: entry.name, path: centralPath, central: true });
    }
  }
  // During the initial skeleton phase there is no permission inventory yet.
  // Once a manifest or platform config is materialized, every runtime must
  // carry the same explicit five capability classes.
  if (appEntries.length === 0 || (manifests.length === 0 && !existsSync(join(root, 'config/platform.yaml')))) return;
  if (manifests.length !== appEntries.length) {
    const missing = appEntries.filter((entry) => !manifests.some((item) => item.app === entry.name)).map((entry) => entry.name);
    fail('ARCH-PERMISSION', `runtime permission manifest missing for ${missing.join(', ')}`);
  }
  for (const {app, path} of manifests) {
    let document;
    try {
      document = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      fail('ARCH-PERMISSION', `apps/${app}: invalid permission manifest: ${error.message}`);
    }
    if (document.runtime !== app) fail('ARCH-PERMISSION', `apps/${app}: runtime identity must be ${app}`);
    if (document.schemaVersion !== 1) fail('ARCH-PERMISSION', `apps/${app}: schemaVersion must be 1`);
    const permissions = document.permissions ?? document;
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) fail('ARCH-PERMISSION', `apps/${app}: permissions object is required`);
    const arrayKey = (shortName, centralName) => Object.hasOwn(permissions, centralName) ? centralName : shortName;
    for (const [shortName, centralName] of [['net', 'allowNet'], ['fsRead', 'allowFsRead'], ['fsWrite', 'allowFsWrite']]) {
      const key = arrayKey(shortName, centralName);
      if (!Array.isArray(permissions[key]) || permissions[key].some((value) => typeof value !== 'string')) {
        fail('ARCH-PERMISSION', `apps/${app}: permissions.${key} must be an explicit string array`);
      }
    }
    for (const [shortName, centralName] of [['childProcess', 'allowChildProcess'], ['worker', 'allowWorker'], ['addon', 'allowAddons'], ['ffi', 'allowFfi']]) {
      const key = arrayKey(shortName, centralName);
      if (!Object.hasOwn(permissions, key) || typeof permissions[key] !== 'boolean') fail('ARCH-PERMISSION', `apps/${app}: permissions.${key} must be an explicit boolean`);
    }
    if (permissions.allowFfi === true) fail('ARCH-FORBIDDEN-NATIVE', `apps/${app}: FFI capability requires an explicit ADR allowlist`);
  }
}

async function runDependencyCruiser(root, configPath) {
  const targets = ['apps', 'packages'].filter((path) => existsSync(join(root, path)));
  if (targets.length === 0) return { skipped: true, reason: 'runtime roots are not materialized before issue #3' };

  const sourceFiles = (await Promise.all(targets.map((target) => walk(join(root, target)))))
    .flat()
    .filter((path) => /\.(?:ts|tsx|mts)$/.test(path))
    .map((path) => path.slice(root.length + 1));
  if (sourceFiles.length === 0) return { skipped: true, reason: 'no TypeScript sources are materialized' };

  const executable = resolve(SCRIPT_ROOT, 'node_modules/.bin/depcruise');
  const result = spawnSync(executable, ['--config', configPath, '--output-type', 'json', ...sourceFiles], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  });
  if (result.error) fail('BOUND-IMPORT', `Dependency Cruiser ${ACCEPTED_DEPENDENCY_CRUISER} unavailable: ${result.error.message}`);
  let graph;
  try {
    graph = JSON.parse(result.stdout);
  } catch {
    fail('BOUND-IMPORT', `${result.stdout}\n${result.stderr}`.trim() || 'Dependency Cruiser did not return an AST graph');
  }
  if (graph.summary?.error > 0) {
    const diagnostic = graph.summary.violations?.map((violation) => `${violation.rule.name} ${violation.from} -> ${violation.to}`).join('; ');
    fail('BOUND-IMPORT', diagnostic || 'Dependency Cruiser rejected the import graph');
  }
  for (const module of graph.modules || []) {
    if (!module.source.startsWith('apps/')) continue;
    const sourceRuntime = module.source.split('/')[1];
    for (const dependency of module.dependencies || []) {
      const target = dependency.resolved.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(module.source), dependency.resolved)).replace(/\.js$/, '.ts')
        : dependency.resolved;
      if (target.startsWith('apps/')) {
        const targetRuntime = target.split('/')[1];
        if (targetRuntime !== sourceRuntime) fail('BOUND-IMPORT', `${module.source} -> ${target}: runtime implementation boundary crossed`);
      }
      if (/^packages\/(domain|models|shared-business)(\/|$)/.test(target)) fail('BOUND-IMPORT', `${module.source} -> ${target}: shared business package forbidden`);
      if (target.startsWith('@coffee-platform/') && !isAllowedPlatformPackage(target)) {
        fail('BOUND-IMPORT', `${module.source} -> ${target}: only versioned contracts and platform technical packages are allowed`);
      }
    }
  }
  return { skipped: false };
}

export async function checkArchitecture(root = SCRIPT_ROOT) {
  const resolvedRoot = resolve(root);
  for (const path of FORBIDDEN_ROOTS) {
    if (existsSync(join(resolvedRoot, path))) fail('BOUND-IMPORT', `${path} is a forbidden shared business root`);
  }
  await checkPackageDependencies(resolvedRoot);
  await checkStaticSources(resolvedRoot);
  await checkPermissionManifests(resolvedRoot);
  const configPath = resolve(SCRIPT_ROOT, '.dependency-cruiser.cjs');
  if (!existsSync(configPath) || !(await stat(configPath)).isFile()) fail('BOUND-IMPORT', '.dependency-cruiser.cjs is missing');
  return await runDependencyCruiser(resolvedRoot, configPath);
}

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  return index === -1 ? SCRIPT_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkArchitecture(parseRoot(process.argv.slice(2)));
    console.log(result.skipped ? `architecture: passed (${result.reason})` : `architecture: passed with Dependency Cruiser ${ACCEPTED_DEPENDENCY_CRUISER}`);
  } catch (error) {
    console.error(`architecture: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
