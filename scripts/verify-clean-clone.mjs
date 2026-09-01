#!/usr/bin/env node
/**
 * Reproducible post-clone gate. It rejects a dirty checkout, installs only
 * from the committed lockfile, runs the complete repository gate and then
 * proves that verification did not change tracked or untracked source files.
 */
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', NO_UPDATE_NOTIFIER: '1'},
  });
  if (result.error) fail('CLEAN-CLONE', `${command}: ${result.error.message}`);
  return {status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

function assertClean(root, phase) {
  const result = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  if (result.status !== 0) fail('CLEAN-CLONE', `git status failed during ${phase}:\n${result.stderr}`.trim());
  if (result.stdout.trim()) fail('CLEAN-CLONE', `checkout is not clean during ${phase}:\n${result.stdout}`.trim());
}

function assertRequiredFiles(root) {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', 'config/toolchain-versions.json', 'config/platform.yaml', 'compose.yaml']) {
    if (!existsSync(resolve(root, path))) fail('CLEAN-CLONE', `required file is missing: ${path}`);
  }
}

function parseArguments(argv) {
  const rootIndex = argv.indexOf('--root');
  return {
    root: rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1]),
    offline: argv.includes('--offline'),
  };
}

export function verifyCleanClone(root = REPO_ROOT, {offline = false} = {}) {
  const resolvedRoot = resolve(root);
  assertRequiredFiles(resolvedRoot);
  assertClean(resolvedRoot, 'before install');

  const install = run('pnpm', ['install', '--frozen-lockfile', ...(offline ? ['--offline'] : [])], resolvedRoot);
  if (install.status !== 0) fail('CLEAN-CLONE', `frozen install failed:\n${install.stdout}\n${install.stderr}`.trim());

  const checks = run('pnpm', ['check'], resolvedRoot);
  if (checks.status !== 0) fail('CLEAN-CLONE', `pnpm check failed:\n${checks.stdout}\n${checks.stderr}`.trim());

  const profiles = run('pnpm', ['profile:check'], resolvedRoot);
  if (profiles.status !== 0) fail('CLEAN-CLONE', `toolchain profile parity failed:\n${profiles.stdout}\n${profiles.stderr}`.trim());

  assertClean(resolvedRoot, 'after verification');
  return {install: 'passed', checks: 'passed', profiles: 'passed', clean: true};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const {root, offline} = parseArguments(process.argv.slice(2));
    const result = verifyCleanClone(root, {offline});
    console.log(`clean clone: passed (install, pnpm check, profile parity; clean after run=${result.clean})`);
  } catch (error) {
    console.error(`clean clone: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
