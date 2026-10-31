import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(new URL("../..", import.meta.url).pathname);
const configPath = resolve(root, "apps/edge-nginx/generated/nginx.conf");
const fixturePath = resolve(root, "tests/nginx/fixtures/profile.json");
const checkOutput = `apps/edge-nginx/generated/.check-nginx-${process.pid}.conf`;
const invalidOutput = `apps/edge-nginx/generated/.invalid-${process.pid}.conf`;
const activeOutput = `apps/edge-nginx/generated/.active-${process.pid}.conf`;
const invalidFixture = `tests/nginx/fixtures/.invalid-profile-${process.pid}.json`;
const tempConfig = resolve(root, checkOutput);
const tempFixture = resolve(root, invalidFixture);
const run = (args) =>
  spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });

try {
  const regen = run([
    "tools/nginx/generate-config.mjs",
    "--config",
    "config/platform.yaml",
    "--output",
    checkOutput,
  ]);
  assert.equal(regen.status, 0, regen.stderr);
  const [generated, repeated] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(tempConfig, "utf8"),
  ]);
  assert.equal(repeated, generated, "generator output must be byte-identical");
  assert.match(
    generated,
    /^worker_processes 1;$/m,
    "reference nginx worker count must come from the platform profile",
  );
  assert.match(
    generated,
    /^error_log \/dev\/null;$/m,
    "raw request-bearing error logs must not reach Collector",
  );
  assert.ok(
    generated.includes(
      'map "$edge_auth_status:$edge_actor_context:$edge_auth_correlation" $api_auth_target { default http://127.0.0.1:18080; ~^204:[^:]+:[^:]+$ https://api_public; }',
    ),
  );
  assert.match(
    generated,
    /auth_request_set \$edge_auth_correlation \$upstream_http_x_correlation_id;/,
  );
  assert.ok(
    generated.includes(
      'map $http_traceparent $edge_traceparent { default ""; "~^(?!ff)[a-f0-9]{2}-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-[a-f0-9]{2}$" $http_traceparent; }',
    ),
  );
  assert.ok(
    generated.includes(
      'map $edge_auth_correlation $edge_safe_auth_correlation { default ""; "~^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$" $edge_auth_correlation; }',
    ),
  );
  assert.match(generated, /"duration_seconds":\$request_time/);
  assert.match(generated, /"request_completion":"\$request_completion"/);
  assert.match(
    generated,
    /server \{ listen 8081; server_name edge-nginx; location = \/nginx_status \{ stub_status; access_log off; \} location \/ \{ return 404; \} \}/,
  );
  assert.match(generated, /location = \/health\/ready \{ return 404; \}/);
  assert.match(generated, /location = \/metrics \{ return 404; \}/);
  assert.match(generated, /proxy_set_header traceparent \$edge_traceparent;/);
  assert.doesNotMatch(
    generated,
    /proxy_set_header traceparent \$http_traceparent;/,
  );
  assert.equal(
    (generated.match(/location = \/api\/client-v1\/customers/g) ?? []).length,
    1,
  );
  assert.match(
    generated,
    /location = \/api\/client-v1\/customers \{\s+limit_except GET POST/,
  );
  assert.match(
    generated,
    /location ~ \^\/api\/client-v1\/orders\/\[A-Za-z0-9_-\]\+\/items\/\[A-Za-z0-9_-\]\+\$ \{\s+limit_except DELETE PUT/,
  );
  assert.match(generated, /proxy_request_buffering off;/);
  assert.match(generated, /proxy_next_upstream off;/);
  assert.match(generated, /proxy_cache off;/);
  assert.match(
    generated,
    /request_pool_size 2048;/u,
    "request allocation granularity must come from the checked platform profile",
  );
  const eventsLocation =
    generated.match(/location = \/events \{[\s\S]*?\n    \}/u)?.[0] ?? "";
  assert.match(
    eventsLocation,
    /proxy_pass_header X-Accel-Buffering;/u,
    "the served SSE surface must retain the receiver no-buffering header",
  );
  assert.equal(
    (generated.match(/proxy_pass_header X-Accel-Buffering;/gu) ?? []).length,
    1,
    "the SSE-only response header policy must not change other routes",
  );
  assert.match(generated, /proxy_pass_request_headers off;/);
  assert.match(
    generated,
    /map \$http_cookie \$edge_login_cookie \{[^\n]*__Host-coffee-login=/,
  );
  assert.match(
    generated,
    /location = \/auth\/callback \{[^\n]*proxy_set_header Cookie \$edge_login_cookie;/,
  );
  for (const route of [
    "/auth/session",
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
    "/_edge/authorize",
  ]) {
    const line = generated
      .split("\n")
      .find((entry) => entry.includes(`location = ${route} {`));
    assert.ok(
      line?.includes("proxy_connect_timeout 1s;") &&
        line.includes("proxy_read_timeout 1s;"),
      `${route}: configured auth transport timeouts must be enforced`,
    );
  }
  assert.match(generated, /location = \/_edge\/authorize \{ internal;/);
  assert.match(generated, /location \^~ \/app\//);
  assert.doesNotMatch(generated, /location \^~ \/api\/ \{[^}]*proxy_pass/s);

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  for (const value of [undefined, 0, 1.5, 3, "2; include /etc/passwd;"]) {
    await writeFile(
      tempFixture,
      JSON.stringify({
        ...fixture,
        limits: { ...fixture.limits, workerProcesses: value },
      }),
    );
    const rejected = run([
      "tools/nginx/generate-config.mjs",
      "--fixture",
      invalidFixture,
      "--output",
      invalidOutput,
    ]);
    assert.notEqual(
      rejected.status,
      0,
      "missing, unsupported or injected worker process count must be rejected",
    );
    assert.match(rejected.stderr, /invalid nginxTransport/);
  }
  for (const value of [
    undefined,
    0,
    1024,
    2048.5,
    4096,
    "2048; include /etc/passwd;",
  ]) {
    await writeFile(
      tempFixture,
      JSON.stringify({
        ...fixture,
        limits: { ...fixture.limits, requestPoolBytes: value },
      }),
    );
    const rejected = run([
      "tools/nginx/generate-config.mjs",
      "--fixture",
      invalidFixture,
      "--output",
      invalidOutput,
    ]);
    assert.notEqual(
      rejected.status,
      0,
      "missing, unchecked or injected request pool size must be rejected",
    );
    assert.match(rejected.stderr, /invalid nginxTransport/);
  }
  for (const [field, values] of [
    ["sessionCacheMiB", [0, 5, 1.5, "4; include /etc/passwd;"]],
    ["bufferBytes", [0, 4095, 16384, 4096.5, "4096; include /etc/passwd;"]],
  ])
    for (const value of values) {
      await writeFile(
        tempFixture,
        JSON.stringify({ ...fixture, tls: { ...fixture.tls, [field]: value } }),
      );
      const rejected = run([
        "tools/nginx/generate-config.mjs",
        "--fixture",
        invalidFixture,
        "--output",
        invalidOutput,
      ]);
      assert.notEqual(
        rejected.status,
        0,
        `unbounded or injected TLS ${field} must be rejected`,
      );
      assert.match(rejected.stderr, /invalid nginxTransport/);
    }
  fixture.upstreams.edge.host = "edge.fixture.invalid; include /etc/passwd;";
  await writeFile(tempFixture, JSON.stringify(fixture));
  const injection = run([
    "tools/nginx/generate-config.mjs",
    "--fixture",
    invalidFixture,
    "--output",
    invalidOutput,
  ]);
  assert.notEqual(
    injection.status,
    0,
    "newline/directive injection must be rejected",
  );
  assert.match(injection.stderr, /invalid nginxTransport/);

  const activeConfig = run([
    "tools/nginx/generate-config.mjs",
    "--output",
    activeOutput,
  ]);
  assert.equal(activeConfig.status, 0, activeConfig.stderr);
  assert.equal(
    await readFile(resolve(root, activeOutput), "utf8"),
    generated,
    "the default generator source must be the checked platform profile",
  );
  assert.match(generated, /upstream edge_gateway \{ server edge-gateway:4000;/);
  assert.match(generated, /server_name localhost;/);

  const registry = JSON.parse(
    await readFile(resolve(root, "config/toolchain-versions.json"), "utf8"),
  );
  const moduleCheck = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "nginx", registry.nginxImage, "-V"],
    { encoding: "utf8" },
  );
  const nginxVersion = `${moduleCheck.stdout}${moduleCheck.stderr}`;
  assert.equal(moduleCheck.status, 0, nginxVersion);
  assert.match(nginxVersion, /--with-http_auth_request_module/);
  console.log(
    "nginx config check: deterministic active platform generation, fixture injection rejection, W1 routes, and pinned auth_request module passed",
  );
} finally {
  await Promise.all([
    rm(tempConfig, { force: true }),
    rm(tempFixture, { force: true }),
    rm(resolve(root, invalidOutput), { force: true }),
    rm(resolve(root, activeOutput), { force: true }),
  ]);
}
