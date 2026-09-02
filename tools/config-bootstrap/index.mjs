#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {chmod, mkdir, unlink, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPlatformConfig, ConfigError, loadEncryptedSecrets, loadPlatformConfig} from '../../scripts/config-lib.mjs';
import {load as parseYaml, dump as dumpYaml} from 'js-yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCATOR_ENV = new Set(['COFFEE_CONFIG_FILE', 'COFFEE_RUNTIME_SECRETS_FILE']);
const BOOTSTRAP_LOCATOR_ENV = new Set([...LOCATOR_ENV, 'SOPS_AGE_KEY_FILE']);

function fail(rule, message) {
  throw new ConfigError(rule, message);
}

function assertLocatorEnv(env, bootstrap) {
  const allowed = bootstrap ? BOOTSTRAP_LOCATOR_ENV : LOCATOR_ENV;
  for (const key of Object.keys(env)) {
    if ((key.startsWith('COFFEE_') || key.startsWith('SOPS_')) && !allowed.has(key)) {
      fail('CONFIG-ENV-OVERRIDE', `${key}: only configuration locator variables are allowed`);
    }
  }
}

function secretValueAt(environment, ref) {
  const [root, ...parts] = ref.split('.');
  let current = environment[root];
  for (const part of parts) current = current?.[part];
  return current;
}

function setSecretAt(target, ref, value) {
  const parts = ref.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function decryptInMemory(secretPath, env) {
  const binary = 'sops';
  try {
    return parseYaml(execFileSync(binary, ['--decrypt', secretPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8'), {json: true});
  } catch (error) {
    fail('CONFIG-SOPS-MAC', `cannot decrypt ${secretPath}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function assertPlainSecretDocument(encrypted, decrypted) {
  if (decrypted?.schemaVersion !== 1 || !decrypted?.environments || decrypted?.sops !== undefined) {
    fail('CONFIG-SOPS-PLAINTEXT', 'decrypted document has invalid metadata');
  }
  for (const environment of ['development', 'staging', 'production']) {
    if (!decrypted.environments[environment]) fail('CONFIG-SOPS-PLAINTEXT', `${environment}: decrypted environment is missing`);
  }
  const encryptedPaths = [];
  const collect = (value, path) => {
    if (path[0] === 'sops' || path.at(-1) === 'username') return;
    if (typeof value === 'string') encryptedPaths.push(path);
    else if (Array.isArray(value)) value.forEach((child, index) => collect(child, [...path, String(index)]));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => collect(child, [...path, key]));
  };
  collect(encrypted, []);
  for (const path of encryptedPaths) {
    let current = decrypted;
    for (const part of path) current = current?.[part];
    if (typeof current !== 'string' || current.length === 0 || current.startsWith('ENC[')) {
      fail('CONFIG-SOPS-PLAINTEXT', `${path.join('.')}: decrypted secret is missing`);
    }
  }
  return decrypted;
}

export async function materializeRuntimeSecrets({root = REPO_ROOT, runtime, outputDir = '/run/secrets', env = process.env} = {}) {
  if (!runtime || typeof runtime !== 'string') fail('CONFIG-RUNTIME', 'runtime is required');
  assertLocatorEnv(env, true);
  const secretPath = join(root, 'secrets/platform.secrets.sops.yaml');
  const configPath = env.COFFEE_CONFIG_FILE ? resolve(env.COFFEE_CONFIG_FILE) : join(root, 'config/platform.yaml');
  const config = await loadPlatformConfig(root, configPath);
  if (!config.services[runtime]) fail('CONFIG-RUNTIME', `${runtime}: unknown runtime`);
  const encrypted = await loadEncryptedSecrets(root);
  const decrypted = assertPlainSecretDocument(encrypted, decryptInMemory(secretPath, env));
  const environment = decrypted.environments[config.environment];
  const refs = config.services[runtime].secretRefs;
  const scoped = {};
  for (const ref of refs) {
    const value = secretValueAt(environment, ref);
    if (value === undefined) fail('CONFIG-SECRET-REF', `${runtime}.${ref}: secret does not exist`);
    setSecretAt(scoped, ref, value);
  }
  const destination = env.COFFEE_RUNTIME_SECRETS_FILE ?? join(outputDir, 'coffee-platform.yaml');
  await mkdir(dirname(destination), {recursive: true, mode: 0o700});
  const materialized = dumpYaml({schemaVersion: 1, environment: config.environment, runtime, secrets: scoped}, {noRefs: true, lineWidth: 120});
  await writeFile(destination, materialized, {encoding: 'utf8', mode: 0o400});
  await chmod(destination, 0o400);
  return {path: destination, runtime, secretRefs: [...refs]};
}

export async function loadRuntimeConfig({root = REPO_ROOT, runtime, env = process.env} = {}) {
  if (!runtime || typeof runtime !== 'string') fail('CONFIG-RUNTIME', 'runtime is required');
  assertLocatorEnv(env, false);
  const configPath = env.COFFEE_CONFIG_FILE ? resolve(env.COFFEE_CONFIG_FILE) : join(root, 'config/platform.yaml');
  const config = await loadPlatformConfig(root, configPath);
  if (!config.services[runtime]) fail('CONFIG-RUNTIME', `${runtime}: unknown runtime`);
  return config.services[runtime];
}

export async function removeMaterializedSecrets(path) {
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function checkBootstrap(root = REPO_ROOT) {
  assertLocatorEnv(process.env, true);
  await checkPlatformConfig(root);
  return {role: 'config-bootstrap', lifecycle: 'init-only', listener: false, longRunning: false};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPO_ROOT;
  const runtimeIndex = process.argv.indexOf('--runtime');
  const runtime = runtimeIndex >= 0 ? process.argv[runtimeIndex + 1] : undefined;
  try {
    if (!runtime) {
      await checkBootstrap(root);
      console.log('config-bootstrap: config and encrypted secret checks passed');
    } else {
      const result = await materializeRuntimeSecrets({runtime, root});
      console.log(`config-bootstrap: materialized ${result.runtime} (${result.path})`);
    }
  } catch (error) {
    console.error(`config-bootstrap: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
