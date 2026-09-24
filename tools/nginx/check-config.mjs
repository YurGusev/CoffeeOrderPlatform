import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(new URL('../..', import.meta.url).pathname);
const configPath = resolve(root, 'apps/edge-nginx/generated/nginx.conf');
const fixturePath = resolve(root, 'tests/nginx/fixtures/profile.json');
const tempConfig = resolve(root, 'apps/edge-nginx/generated/.check-nginx.conf');
const tempFixture = resolve(root, 'tests/nginx/fixtures/.invalid-profile.json');
const run = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

const regen = run(['tools/nginx/generate-config.mjs', '--fixture', 'tests/nginx/fixtures/profile.json', '--output', 'apps/edge-nginx/generated/.check-nginx.conf']);
assert.equal(regen.status, 0, regen.stderr);
try {
  const [generated, repeated] = await Promise.all([readFile(configPath, 'utf8'), readFile(tempConfig, 'utf8')]);
  assert.equal(repeated, generated, 'generator output must be byte-identical');
  assert.match(generated, /^error_log \/dev\/null;$/m, 'raw request-bearing error logs must not reach Collector');
  assert.ok(generated.includes('map "$edge_auth_status:$edge_actor_context:$edge_auth_correlation" $api_auth_target { default http://127.0.0.1:18080; ~^204:[^:]+:[^:]+$ https://api_public; }'));
  assert.match(generated, /auth_request_set \$edge_auth_correlation \$upstream_http_x_correlation_id;/);
  assert.equal((generated.match(/location = \/api\/client-v1\/customers/g) ?? []).length, 1);
  assert.match(generated, /location = \/api\/client-v1\/customers \{\s+limit_except GET POST/);
  assert.match(generated, /location ~ \^\/api\/client-v1\/orders\/\[A-Za-z0-9_-\]\+\/items\/\[A-Za-z0-9_-\]\+\$ \{\s+limit_except DELETE PUT/);
  assert.match(generated, /proxy_request_buffering off;/);
  assert.match(generated, /proxy_next_upstream off;/);
  assert.match(generated, /proxy_cache off;/);
  assert.match(generated, /proxy_pass_request_headers off;/);
  assert.match(generated, /map \$http_cookie \$edge_login_cookie \{[^\n]*__Host-coffee-login=/);
  assert.match(generated, /location = \/auth\/callback \{[^\n]*proxy_set_header Cookie \$edge_login_cookie;/);
  assert.match(generated, /location = \/_edge\/authorize \{ internal;/);
  assert.match(generated, /location \^~ \/app\//);
  assert.doesNotMatch(generated, /location \^~ \/api\/ \{[^}]*proxy_pass/s);

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  fixture.upstreams.edge.host = 'edge.fixture.invalid; include /etc/passwd;';
  await writeFile(tempFixture, JSON.stringify(fixture));
  const injection = run(['tools/nginx/generate-config.mjs', '--fixture', 'tests/nginx/fixtures/.invalid-profile.json', '--output', 'apps/edge-nginx/generated/.invalid.conf']);
  assert.notEqual(injection.status, 0, 'newline/directive injection must be rejected');
  assert.match(injection.stderr, /invalid nginxTransport/);

  const activeConfig = run(['tools/nginx/generate-config.mjs', '--output', 'apps/edge-nginx/generated/.active.conf']);
  assert.notEqual(activeConfig.status, 0, 'active config must remain unavailable until #162 adds the profile');
  assert.match(activeConfig.stderr, /config\/platform.yaml has no nginxTransport profile yet/);

  const registry = JSON.parse(await readFile(resolve(root, 'config/toolchain-versions.json'), 'utf8'));
  const moduleCheck = spawnSync('docker', ['run', '--rm', '--entrypoint', 'nginx', registry.nginxImage, '-V'], { encoding: 'utf8' });
  const nginxVersion = `${moduleCheck.stdout}${moduleCheck.stderr}`;
  assert.equal(moduleCheck.status, 0, nginxVersion);
  assert.match(nginxVersion, /--with-http_auth_request_module/);
  console.log('nginx config check: deterministic generation, fixture schema/injection rejection, active-source boundary, W1 routes, and pinned auth_request module passed');
} finally {
  await Promise.all([rm(tempConfig, { force: true }), rm(tempFixture, { force: true }), rm(resolve(root, 'apps/edge-nginx/generated/.invalid.conf'), { force: true }), rm(resolve(root, 'apps/edge-nginx/generated/.active.conf'), { force: true })]);
}
