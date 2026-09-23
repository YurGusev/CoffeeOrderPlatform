#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
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
  '@coffee-platform/ui',
]);

function isAllowedPlatformPackage(name) {
  const root = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
  return ALLOWED_PLATFORM_PACKAGES.has(name) || ALLOWED_PLATFORM_PACKAGES.has(root) || root.startsWith("@coffee-platform/contracts-") || root.startsWith("@coffee-platform/generated-");
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
    const dependencies = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies, ...json.optionalDependencies };
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string') continue;
      if (value.includes('/apps/') || value.startsWith('file:../apps') || value.startsWith('link:../apps')) {
        fail('BOUND-IMPORT', `${path} declares runtime implementation dependency ${name} -> ${value}`);
      }
      if (name.startsWith('@coffee-platform/') && !isAllowedPlatformPackage(name)) {
        fail('BOUND-IMPORT', `${path} declares forbidden shared business package ${name}`);
      }
      if (name.toLowerCase() === 'axios') fail('ARCH-FORBIDDEN-HTTP', `${path} declares forbidden Axios dependency`);
      if (path === join(root, 'apps/aroma-gateway/package.json') && ALTERNATE_PROVIDER_HTTP_MODULE_RE.test(name)) {
        fail('ARCH-TYPED-PROVIDER-HTTP', `${path} declares alternate provider HTTP client ${name}; use native fetch/Undici`);
      }
      if (GENERIC_RETRY_DEPENDENCY_RE.test(name)) fail('ARCH-GENERIC-RETRY', `${path} declares forbidden generic retry dependency ${name}`);
      if (name === 'zod' || name.startsWith('zod/')) fail('ARCH-FORBIDDEN-SCHEMA', `${path} declares forbidden Zod schema mirror`);
      if (/^(?:@radix-ui\/|@base-ui\/|lucide-react$|class-variance-authority$)/.test(name)) {
        fail('ARCH-FORBIDDEN-UI-DEPENDENCY', `${path} declares forbidden UI dependency ${name}`);
      }
      if (/^(?:@?[^/]+\/)?(?:ffi(?:-napi)?|sqlite3?|better-sqlite3|vfs|virtual-fs|virtual_fs|memfs)$/i.test(name)) {
        fail('ARCH-FORBIDDEN-NATIVE', `${path} declares forbidden FFI/SQLite/VFS dependency ${name}`);
      }
    }
  }
}

const GENERIC_RETRY_DEPENDENCY_RE = /(?:^|[/_-])(?:async-retry|cockatiel|exponential-backoff|fetch-retry|p-retry|promise-retry|retry-as-promised)(?:$|[/_-])/i;
const LITERAL_POSTGRES_URL_RE = /["'`](?:postgres(?:ql)?:\/\/)/i;
const GENERIC_RETRY_WRAPPER_RE = /(?<![.\w])(?:doRetry|executeWithRetry|performRetry|retry|retryAsync|retryOperation|retryWithBackoff|runWithRetry|withRetry)\s*(?:<[^;\n]*?>\s*)?\(/;
const AROMA_GATEWAY_SOURCE_RE = /(?:^|\/)apps\/aroma-gateway\//;
const TYPED_PROVIDER_HTTP_CLIENT_RE = /(?:^|\/)apps\/aroma-gateway\/src\/infrastructure\/provider\/http-client\.(?:cts|mts|ts)$/;
const ALTERNATE_PROVIDER_HTTP_MODULE_RE = /^(?:node-fetch|cross-fetch|got|ky|superagent)(?:\/|$)/i;
const GENERIC_PROVIDER_HTTP_MODULE_RE = /^(?:@fastify\/http-proxy|http-proxy|node:(?:http|http2|https|net|tls)|(?:http|http2|https|net|tls)|undici|node-fetch|cross-fetch|got|ky|superagent)(?:\/|$)/i;
const GENERIC_PROVIDER_PROXY_RE = /(?<![.\w])(?:forward(?:Request|Response)?|passThrough|proxy)\s*(?:<[^;\n]*?>\s*)?(?:=|\()/i;
const MODULE_SPECIFIER_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function moduleSpecifiers(source) {
  return [...source.matchAll(MODULE_SPECIFIER_RE)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter(Boolean);
}

function isTypeScriptSource(path) {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) && !/(?:[\\/])(dist|node_modules|provenance)(?:[\\/])/.test(path);
}

async function collectSourceFiles(root) {
  return (await Promise.all(['apps', 'packages'].map((target) => walk(join(root, target)))))
    .flat()
    .filter(isTypeScriptSource);
}

function sourceLabel(path, root) {
  return relative(root, path).replaceAll('\\', '/');
}

function sourceCandidates(candidate) {
  const normalized = resolve(candidate);
  const withoutRuntimeExtension = normalized.replace(/\.(?:mjs|cjs|js|jsx)$/, '');
  const bases = [...new Set([normalized, withoutRuntimeExtension])];
  return bases.flatMap((base) => [base, ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))]);
}

function resolveSourceCandidate(candidate, files) {
  return sourceCandidates(candidate).find((path) => files.has(path));
}

function packageNameForSpecifier(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function resolveGraphImport(fromPath, specifier, files, workspacePackages) {
  if (specifier.startsWith('.')) {
    return resolveSourceCandidate(join(dirname(fromPath), specifier), files);
  }
  const packageName = packageNameForSpecifier(specifier);
  const packageRoot = workspacePackages.get(packageName);
  if (!packageRoot) return undefined;
  const subpath = specifier.slice(packageName.length).replace(/^\/+/, '');
  const candidate = subpath ? join(packageRoot, 'src', subpath) : join(packageRoot, 'src', 'index');
  return resolveSourceCandidate(candidate, files);
}

function graphFromEntries(entries, root, workspacePackages = new Map()) {
  const modules = new Map(entries.map(({ path, source }) => {
    const absolutePath = resolve(root, path);
    return [absolutePath, { path: absolutePath, source, imports: [], edges: [] }];
  }));
  const files = new Set(modules.keys());
  for (const module of modules.values()) {
    module.imports = [...new Set(moduleSpecifiers(module.source))];
    module.edges = module.imports.map((specifier) => ({
      specifier,
      target: resolveGraphImport(module.path, specifier, files, workspacePackages),
    }));
  }
  return { modules, root, workspacePackages };
}

async function workspacePackageRoots(root) {
  const packageFiles = [join(root, 'package.json'), ...await walk(join(root, 'apps')), ...await walk(join(root, 'packages'))]
    .filter((path) => path.endsWith('package.json') && existsSync(path));
  const packages = new Map();
  for (const path of packageFiles) {
    const document = JSON.parse(await readFile(path, 'utf8'));
    if (typeof document.name === 'string') packages.set(document.name, dirname(path));
  }
  return packages;
}

function isPathUnder(label, prefix) {
  return label === prefix || label.startsWith(`${prefix}/`);
}

function appRuntimeFor(label) {
  const match = label.match(/^apps\/([^/]+)\//);
  return match?.[1];
}

function isBrowserLabel(label) {
  return label.startsWith('apps/web/src/browser/');
}

function isServerLabel(label) {
  return /^apps\/(?!web\/)[^/]+\//.test(label);
}

function isUiLabel(label) {
  return label.startsWith('packages/platform-ui/src/');
}

function isNodeSpecifier(specifier) {
  return specifier.startsWith('node:') || /^(?:assert|buffer|child_process|crypto|fs|http|https|net|os|path|stream|url|util|worker_threads)$/.test(specifier);
}

function isUiTransportSpecifier(specifier) {
  return specifier.startsWith('@tanstack/') || specifier === 'effect' || specifier.startsWith('@effect/');
}

function isForbiddenUiTarget(label) {
  return label.startsWith('apps/') || isPathUnder(label, 'packages/platform-runtime') || isPathUnder(label, 'packages/contracts') || isPathUnder(label, 'packages/generated');
}

function checkGraphContext(graph, roots, context) {
  const queue = [...roots];
  const visited = new Set();
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const module = graph.modules.get(path);
    if (!module) continue;
    const label = sourceLabel(path, graph.root);
    for (const edge of module.edges) {
      const targetLabel = edge.target ? sourceLabel(edge.target, graph.root) : undefined;
      if (context.kind === 'browser') {
        if (edge.coreModule || isNodeSpecifier(edge.specifier) || edge.specifier === '@coffee-platform/runtime') {
          fail('BOUND-BROWSER-NODE', `${label} -> ${edge.specifier}: browser graph reaches Node/runtime module`);
        }
        if (targetLabel && (targetLabel === 'apps/web/src/main.ts' || (targetLabel.startsWith('apps/') && !targetLabel.startsWith('apps/web/')) || isPathUnder(targetLabel, 'packages/platform-runtime'))) {
          fail('BOUND-BROWSER-NODE', `${label} -> ${targetLabel}: browser graph reaches Node/server source`);
        }
      }
      if (context.kind === 'server' && (edge.specifier === '@coffee-platform/ui' || (targetLabel && isUiLabel(targetLabel)))) {
        fail('BOUND-SERVER-UI', `${label} -> ${edge.specifier || targetLabel}: server graph reaches browser UI package`);
      }
      if (context.kind === 'ui') {
        if (edge.coreModule || isNodeSpecifier(edge.specifier)) fail('BOUND-UI-NODE', `${label} -> ${edge.specifier}: UI graph reaches Node module`);
        if (isUiTransportSpecifier(edge.specifier)) fail('BOUND-UI-QUERY', `${label} -> ${edge.specifier}: UI graph reaches transport/state library`);
        if (edge.specifier === '@coffee-platform/runtime' || (targetLabel && isForbiddenUiTarget(targetLabel))) {
          fail('BOUND-UI-RUNTIME', `${label} -> ${edge.specifier || targetLabel}: UI graph reaches runtime/business source`);
        }
      }
      if (context.kind === 'app' && edge.specifier.startsWith('@coffee-platform/') && !isAllowedPlatformPackage(edge.specifier)) {
        fail('BOUND-IMPORT', `${label} -> ${edge.specifier}: only versioned contracts and platform technical packages are allowed`);
      }
      if (context.kind === 'app' && targetLabel) {
        const targetRuntime = appRuntimeFor(targetLabel);
        if (targetRuntime && targetRuntime !== context.runtime) fail('BOUND-IMPORT', `${label} -> ${targetLabel}: runtime implementation boundary crossed transitively`);
        if (/^packages\/(domain|models|shared-business)(\/|$)/.test(targetLabel)) fail('BOUND-IMPORT', `${label} -> ${targetLabel}: shared business package forbidden transitively`);
      }
      if (edge.target) queue.push(edge.target);
    }
  }
}

function checkTransitiveBoundaries(graph) {
  const browserRoots = [...graph.modules.keys()].filter((path) => isBrowserLabel(sourceLabel(path, graph.root)));
  const serverRoots = [...graph.modules.keys()].filter((path) => isServerLabel(sourceLabel(path, graph.root)));
  const uiRoots = [...graph.modules.keys()].filter((path) => isUiLabel(sourceLabel(path, graph.root)));
  const appRoots = [...graph.modules.keys()].filter((path) => appRuntimeFor(sourceLabel(path, graph.root)));
  checkGraphContext(graph, browserRoots, { kind: 'browser' });
  checkGraphContext(graph, serverRoots, { kind: 'server' });
  checkGraphContext(graph, uiRoots, { kind: 'ui' });
  for (const runtime of new Set(appRoots.map((path) => appRuntimeFor(sourceLabel(path, graph.root)))) ) {
    checkGraphContext(graph, appRoots.filter((path) => appRuntimeFor(sourceLabel(path, graph.root)) === runtime), { kind: 'app', runtime });
  }
}

function dependencyCruiserSourceGraph(result, root, sourceFiles, workspacePackages) {
  const files = new Set(sourceFiles);
  const modules = new Map();
  for (const dependencyModule of result.modules ?? []) {
    if (typeof dependencyModule.source !== 'string') continue;
    const path = resolve(root, dependencyModule.source);
    if (!files.has(path)) continue;
    modules.set(path, { path, imports: [], edges: [] });
  }

  for (const dependencyModule of result.modules ?? []) {
    if (typeof dependencyModule.source !== 'string') continue;
    const path = resolve(root, dependencyModule.source);
    const module = modules.get(path);
    if (!module) continue;
    for (const dependency of dependencyModule.dependencies ?? []) {
      const specifier = dependency.module;
      if (typeof specifier !== 'string' || specifier === '✖') continue;
      let target;
      if (!dependency.couldNotResolve && typeof dependency.resolved === 'string' && /^(?:apps|packages)\//.test(dependency.resolved)) {
        target = resolveSourceCandidate(resolve(root, dependency.resolved), files);
      }
      target ??= resolveGraphImport(path, specifier, files, workspacePackages);
      module.imports.push(specifier);
      module.edges.push({ coreModule: dependency.coreModule === true, specifier, target });
    }
  }
  return { modules, root, workspacePackages };
}

export function checkTransitiveSourceGraph(entries, options = {}) {
  checkTransitiveBoundaries(graphFromEntries(entries, options.root ?? '/repo', options.workspacePackages ?? new Map()));
}

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
  const isUiPackage = label.includes('/packages/platform-ui/');
  const isBrowserSource = label.includes('/apps/web/src/browser/');
  if (/(?:^|\/)apps\//.test(label) && LITERAL_POSTGRES_URL_RE.test(source)) {
    fail('ARCH-POSTGRES-URL', `${label}: literal PostgreSQL connection URL is forbidden in app source; use scoped platform configuration`);
  }
  if (AROMA_GATEWAY_SOURCE_RE.test(label) && !TYPED_PROVIDER_HTTP_CLIENT_RE.test(label)) {
    if (/(?<![.\w])(?:globalThis\s*\.\s*)?fetch\s*\(/.test(source)) {
      fail('ARCH-TYPED-PROVIDER-HTTP', `${label}: provider HTTP fetch must stay inside the typed provider http-client`);
    }
    if (GENERIC_PROVIDER_PROXY_RE.test(source)) {
      fail('ARCH-TYPED-PROVIDER-HTTP', `${label}: generic provider proxy/forwarder is forbidden outside the typed provider http-client`);
    }
  }
  if (AROMA_GATEWAY_SOURCE_RE.test(label) && GENERIC_RETRY_WRAPPER_RE.test(source)) {
    fail('ARCH-GENERIC-RETRY', `${label}: generic retry wrapper is forbidden; retry ownership must remain explicit and bounded`);
  }
  if (/\b(?:new\s+Date\s*\(|Date\s*\.\s*(?:now|parse|UTC)\s*\()/m.test(source)) {
    fail('ARCH-TEMPORAL', `${label}: mutable Date API is forbidden; use Temporal`);
  }
  for (const moduleName of moduleSpecifiers(source)) {
    if (AROMA_GATEWAY_SOURCE_RE.test(label) && ALTERNATE_PROVIDER_HTTP_MODULE_RE.test(moduleName)) {
      fail('ARCH-TYPED-PROVIDER-HTTP', `${label}: alternate provider HTTP client ${moduleName} is forbidden; use native fetch/Undici`);
    }
    if (AROMA_GATEWAY_SOURCE_RE.test(label) && !TYPED_PROVIDER_HTTP_CLIENT_RE.test(label) && GENERIC_PROVIDER_HTTP_MODULE_RE.test(moduleName)) {
      fail('ARCH-TYPED-PROVIDER-HTTP', `${label}: generic provider HTTP module ${moduleName} is forbidden outside the typed provider http-client`);
    }
    if (isUiPackage && /^(?:@radix-ui\/|@base-ui\/|lucide-react$|class-variance-authority$)/.test(moduleName)) {
      fail('ARCH-FORBIDDEN-UI-DEPENDENCY', `${label}: forbidden UI dependency ${moduleName}`);
    }
    if (isBrowserSource && (isNodeSpecifier(moduleName) || moduleName === '@coffee-platform/runtime')) {
      fail('BOUND-BROWSER-NODE', `${label}: browser source imports Node/runtime module ${moduleName}`);
    }
    if (label.endsWith('/apps/web/src/main.ts') && /(?:^|\/)browser(?:\/|$)/.test(moduleName)) {
      fail('BOUND-NODE-BROWSER', `${label}: Node entry imports browser source ${moduleName}`);
    }
    if (/(?:^|\/)apps\/(?!web\/)[^/]+\//.test(label) && (moduleName === "@coffee-platform/ui" || /packages\/platform-ui\//.test(moduleName))) {
      fail('BOUND-SERVER-UI', `${label}: server runtime imports browser UI package`);
    }
    if (isUiPackage && isNodeSpecifier(moduleName)) fail('BOUND-UI-NODE', `${label}: UI package imports Node module ${moduleName}`);
    if (isUiPackage && isUiTransportSpecifier(moduleName)) fail('BOUND-UI-QUERY', `${label}: UI package imports transport/state module ${moduleName}`);
    if (/contracts\/fixtures|fixtures\/.*\.json/.test(moduleName)) fail('BOUND-CONTRACT-FIXTURE', `${label}: production source imports contract fixture ${moduleName}`);
    const internalContract = /(?:^|[/@])(?:generated|contracts)-internal-v1(?:\/|$)/.test(moduleName);
    const browserContract = /(?:^|\/)apps\/web\//.test(label) && /^@coffee-platform\/contracts-(?:customer|catalog|pricing|orders|aroma)-v1$/.test(moduleName);
    if (/(?:^|\/)apps\/(?:web|api-public)\//.test(label) && (internalContract || browserContract)) {
      fail('BOUND-CONTRACT-AUDIENCE', `${label}: browser/public graph imports internal contract ${moduleName}`);
    }
    if (label.startsWith('apps/') && /^(?:@fastify\/swagger|@scalar\/)/.test(moduleName)) {
      fail('ARCH-RUNTIME-DOCS', `${label}: runtime Swagger/Scalar route is forbidden for launch`);
    }
    const databaseFoundation = /(?:^|\/)packages\/platform-database\//.test(label);
    const kafkaFoundation = /(?:^|\/)packages\/platform-kafka-runtime\//.test(label);
    if ((moduleName.startsWith('@confluentinc/kafka-javascript') || /platform-kafka-runtime\/(?:src|dist)\//.test(moduleName)) && !kafkaFoundation)
      fail('BOUND-KAFKA-CLIENT', `${label}: native Kafka client belongs to platform-kafka-runtime`);
    const ownerAdapter = /(?:^|\/)packages\/platform-(?:database|idempotency|migrations|inbox|outbox)\//.test(label) || /(?:^|\/)apps\/[^/]+\/(?:src\/)?(?:infrastructure|repositories)\//.test(label);
    if ((moduleName === 'pg' || moduleName.startsWith('pg/') || moduleName === 'pg-copy-streams') && !databaseFoundation)
      fail('BOUND-DB-CLIENT', `${label}: native PostgreSQL driver belongs to platform-database`);
    if (moduleName === '@coffee-platform/database/owner' && !ownerAdapter)
      fail('BOUND-DB-CLIENT', `${label}: SQL capabilities belong to owner infrastructure/repositories`);
    if (/platform-database\/(?:src|dist)\//.test(moduleName) && !databaseFoundation)
      fail('BOUND-DB-CLIENT', `${label}: private database implementation import is forbidden`);
    if (/^(?:effect|@effect\/)/.test(moduleName))
      fail('BOUND-DB-CLIENT', `${label}: Effect runtime is superseded by ADR-0025`);
    const kind = forbiddenModuleKind(moduleName);
    if (kind === 'axios') fail('ARCH-FORBIDDEN-HTTP', `${label}: Axios import ${moduleName} is forbidden; use native fetch/Undici`);
    if (kind === 'native') fail('ARCH-FORBIDDEN-NATIVE', `${label}: experimental FFI/SQLite/VFS import ${moduleName} is forbidden without an ADR allowlist`);
  }
  if (isUiPackage && /\bfetch\s*\(/m.test(source)) {
    fail('BOUND-UI-NETWORK', `${label}: UI package cannot perform network calls`);
  }
  if (/^\s*(?:const\s+[^=]+\s*=\s*)?require\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$]/m.test(source)) {
    fail('TS7-ESM', `${label}: CommonJS require/module.exports is forbidden`);
  }
  for (const moduleName of moduleSpecifiers(source).filter((specifier) => specifier.startsWith('.'))) {
    if (!moduleName.endsWith('.js') && !moduleName.endsWith('.css')) fail('TS7-ESM', `${label}: relative import ${moduleName} must use a .js runtime specifier`);
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
  const sourceFiles = await collectSourceFiles(root);
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

  const sourceFiles = (await collectSourceFiles(root))
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
  checkTransitiveBoundaries(
    dependencyCruiserSourceGraph(graph, root, sourceFilesAbsolute(root, sourceFiles), await workspacePackageRoots(root)),
  );
  return { skipped: false };
}

function sourceFilesAbsolute(root, sourceFiles) {
  return sourceFiles.map((path) => resolve(root, path));
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

export { checkStaticSource };

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
