#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTED_DEPENDENCY_CRUISER = '18.2.0';
const FORBIDDEN_ROOTS = ['packages/domain', 'packages/models', 'packages/shared-business'];

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
    ...await walk(join(root, 'apps')),
    ...await walk(join(root, 'packages')),
  ].filter((path) => path.endsWith('package.json'));
  for (const path of files) {
    const json = JSON.parse(await readFile(path, 'utf8'));
    const dependencies = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string') continue;
      if (value.includes('/apps/') || value.startsWith('file:../apps') || value.startsWith('link:../apps')) {
        fail('BOUND-IMPORT', `${path} declares runtime implementation dependency ${name} -> ${value}`);
      }
      if (name.startsWith('@coffee/') && !name.startsWith('@coffee/contracts/') && !name.startsWith('@coffee/platform-')) {
        fail('BOUND-IMPORT', `${path} declares forbidden shared business package ${name}`);
      }
    }
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

  const command = process.env.DEPENDENCY_CRUISER_BIN;
  const executable = command || 'npx';
  const prefix = command ? [] : ['--yes', `dependency-cruiser@${ACCEPTED_DEPENDENCY_CRUISER}`];
  const result = spawnSync(executable, [...prefix, '--config', configPath, '--output-type', 'json', ...sourceFiles], {
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
      if (target.startsWith('@coffee/') && !target.startsWith('@coffee/contracts/') && !target.startsWith('@coffee/platform-')) {
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
