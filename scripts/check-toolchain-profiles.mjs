#!/usr/bin/env node
/**
 * Compare the authoritative TypeScript + Effect diagnostics build in its
 * canonical (parallel) mode with the explicit --singleThreaded mode.
 *
 * Each profile is built in an independent temporary clean workspace. The
 * repository checkout, node_modules, dist and tsbuildinfo are never modified.
 */
import {cp, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_NAMES = Object.freeze({parallel: [], singleThreaded: ['--singleThreaded']});
const EFFECT_TSGO_VERSION = '0.39.0';

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', env: {...process.env, NO_UPDATE_NOTIFIER: '1'}});
  if (result.error) fail('TOOLCHAIN-PROFILE', `${command}: ${result.error.message}`);
  return {status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

async function copyCleanWorkspace(root) {
  const workspace = await mkdtemp(join(tmpdir(), 'coffee-toolchain-profile-'));
  await cp(root, workspace, {
    recursive: true,
    filter(source) {
      const path = relative(root, source).replaceAll('\\', '/');
      if (!path) return true;
      if (path === '.git' || path.startsWith('.git/')) return false;
      if (path === 'node_modules' || path.startsWith('node_modules/')) return false;
      if (path.endsWith('.tsbuildinfo') || /(?:^|\/)dist(?:\/|$)/.test(path)) return false;
      return true;
    },
  });
  const install = run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], workspace);
  if (install.status !== 0) {
    fail('TOOLCHAIN-PROFILE', `frozen install failed in temporary workspace:\n${install.stdout}\n${install.stderr}`.trim());
  }
  const patch = run('pnpm', ['exec', 'effect-tsgo', 'patch', '--typescript', '--no-oxlint'], workspace);
  if (patch.status !== 0) {
    fail('TOOLCHAIN-PROFILE', `Effect TS-Go ${EFFECT_TSGO_VERSION} patch failed in temporary workspace:\n${patch.stdout}\n${patch.stderr}`.trim());
  }
  return workspace;
}

async function walk(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

async function snapshotOutputs(root) {
  const files = (await Promise.all(['apps', 'packages'].map((name) => walk(join(root, name)))))
    .flat()
    .filter((path) => /(?:^|\/)dist\//.test(relative(root, path).replaceAll('\\', '/')))
    .sort((left, right) => left.localeCompare(right));
  const artifacts = [];
  const declarations = [];
  for (const path of files) {
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const digest = sha256(await readFile(path));
    const item = {path: relativePath, sha256: digest};
    artifacts.push(item);
    if (relativePath.endsWith('.d.ts')) declarations.push(item);
  }
  const digestSnapshot = (items) => sha256(items.map((item) => `${item.path}\0${item.sha256}\n`).join(''));
  return {
    artifacts,
    artifactsSha256: digestSnapshot(artifacts),
    declarations,
    declarationsSha256: digestSnapshot(declarations),
  };
}

function normalizedDiagnostics(result, workspace) {
  return `${result.stdout}\n${result.stderr}`.replaceAll(workspace, '<workspace>').replaceAll('\\', '/');
}

async function runProfile(root, name, args) {
  const workspace = await copyCleanWorkspace(root);
  try {
    const result = run('pnpm', ['exec', 'tsc', '-b', '--pretty', 'false', ...args], workspace);
    const diagnostics = normalizedDiagnostics(result, workspace);
    if (result.status !== 0) fail('TOOLCHAIN-PROFILE', `${name} compiler profile failed:\n${diagnostics}`.trim());
    const outputs = await snapshotOutputs(workspace);
    return {
      command: `pnpm exec effect-tsgo patch --typescript --no-oxlint && pnpm exec tsc -b --pretty false${args.length ? ` ${args.join(' ')}` : ''}`,
      exitCode: result.status,
      diagnostics,
      diagnosticsSha256: sha256(diagnostics),
      artifacts: outputs.artifacts,
      artifactsSha256: outputs.artifactsSha256,
      declarations: outputs.declarations,
      declarationsSha256: outputs.declarationsSha256,
      name,
    };
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
}

function parseArguments(argv) {
  const rootIndex = argv.indexOf('--root');
  const evidenceIndex = argv.indexOf('--write-evidence');
  return {
    root: rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1]),
    evidence: evidenceIndex === -1 ? null : resolve(argv[evidenceIndex + 1]),
  };
}

export async function checkToolchainProfiles(root = REPO_ROOT) {
  const resolvedRoot = resolve(root);
  const profiles = {};
  for (const [name, args] of Object.entries(PROFILE_NAMES)) profiles[name] = await runProfile(resolvedRoot, name, args);
  const parallel = profiles.parallel;
  const singleThreaded = profiles.singleThreaded;
  const parity = {
    exitCode: parallel.exitCode === singleThreaded.exitCode,
    diagnostics: parallel.diagnostics === singleThreaded.diagnostics,
    declarations: JSON.stringify(parallel.declarations) === JSON.stringify(singleThreaded.declarations),
    artifacts: JSON.stringify(parallel.artifacts) === JSON.stringify(singleThreaded.artifacts),
  };
  if (Object.values(parity).some((value) => !value)) {
    fail('TOOLCHAIN-PROFILE-PARITY', `parallel and singleThreaded profiles differ: ${JSON.stringify(parity)}`);
  }
  return {
    schemaVersion: 2,
    authority: {
      node: '26.8.1',
      typescript: '7.0.2',
      effectTsgo: EFFECT_TSGO_VERSION,
      compiler: 'typescript@7.0.2-patched-by-effect-tsgo@0.39.0',
      compilerLanes: 1,
      effectDiagnostics: 'enabled',
    },
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, {
      command: profile.command,
      exitCode: profile.exitCode,
      diagnosticsSha256: profile.diagnosticsSha256,
      declarationsSha256: profile.declarationsSha256,
      artifactsSha256: profile.artifactsSha256,
      artifactCount: profile.artifacts.length,
      declarationCount: profile.declarations.length,
    }])),
    parity,
    result: 'passed',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const {root, evidence} = parseArguments(process.argv.slice(2));
    const report = await checkToolchainProfiles(root);
    if (evidence) await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`toolchain profiles: passed (TS7 + Effect diagnostics parallel == singleThreaded, ${report.profiles.parallel.artifactCount} artifacts)`);
  } catch (error) {
    console.error(`toolchain profiles: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
