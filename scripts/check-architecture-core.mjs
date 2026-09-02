#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEffectArchitecture } from './effect-architecture-policy.mjs';
import { checkEffectLegacyInventory } from './check-effect-legacy-inventory.mjs';

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

function isAllowedPlatformPackage(name) {
  return ALLOWED_PLATFORM_PACKAGES.has(name) || name.startsWith('@coffee-platform/contracts-');
}

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
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
    fail('ARCH-TIME', `${label}: mutable Date API is forbidden; use Effect Clock/DateTime`);
  }
  for (const match of source.matchAll(FORBIDDEN_MODULE_RE)) {
    const moduleName = match[1];
    const kind = forbiddenModuleKind(moduleName);
    if (kind === 'axios') fail('ARCH-FORBIDDEN-HTTP', `${label}: Axios import ${moduleName} is forbidden; use the approved Effect HTTP stack`);
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
}

async function checkStaticSources(root) {
  const sourceFiles = (await Promise.all(['apps', 'packages'].map((target) => walk(join(root, target)))))
    .flat()
    .filter((path) => /\.(?:ts|tsx|mts|cts)$/.test(path));
  for (const path of sourceFiles) checkStaticSource(path, await readFile(path, 'utf8'));
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
  if (existsSync(join(resolvedRoot, 'config/effect-legacy-inventory.json'))) {
    await checkEffectLegacyInventory(resolvedRoot);
  }
  await checkPackageDependencies(resolvedRoot);
  await checkStaticSources(resolvedRoot);
  await checkPermissionManifests(resolvedRoot);
  const effectPolicy = await checkEffectArchitecture(resolvedRoot, { policyRoot: SCRIPT_ROOT });
  const configPath = resolve(SCRIPT_ROOT, '.dependency-cruiser.cjs');
  if (!existsSync(configPath) || !(await stat(configPath)).isFile()) fail('BOUND-IMPORT', '.dependency-cruiser.cjs is missing');
  const dependencyCruiser = await runDependencyCruiser(resolvedRoot, configPath);
  return { ...dependencyCruiser, effectPolicy };
}

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  return index === -1 ? SCRIPT_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkArchitecture(parseRoot(process.argv.slice(2)));
    const effectSummary = `Effect policy ${result.effectPolicy.checked} files (${result.effectPolicy.legacyChecked} legacy)`;
    console.log(result.skipped
      ? `architecture: passed (${result.reason}; ${effectSummary})`
      : `architecture: passed with Dependency Cruiser ${ACCEPTED_DEPENDENCY_CRUISER}; ${effectSummary}`);
  } catch (error) {
    console.error(`architecture: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
