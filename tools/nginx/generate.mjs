#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { load as loadYaml } from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PIN =
  "nginx:1.31.6-trixie@sha256:908dc23e643a1447dbfb2e189ed268bfde6a51a5bf9a34d3dd3440a24f58ccf7";
const METHODS = new Set(["get", "post", "put", "delete"]);
const must = (condition, message) => {
  if (!condition) throw new Error(message);
};

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (["--config", "--fixture", "--output"].includes(argv[i]))
      result[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  must(!(result.config && result.fixture), "choose --config or --fixture");
  return result;
}

async function getProfile(args, root) {
  if (args.fixture) {
    const path = resolve(root, args.fixture);
    must(
      path.startsWith(`${resolve(root, "tests/nginx/fixtures")}/`),
      "fixture must be under tests/nginx/fixtures",
    );
    return JSON.parse(await readFile(path, "utf8"));
  }
  const path = resolve(root, args.config ?? "config/platform.yaml");
  must(
    path === resolve(root, "config/platform.yaml"),
    "production profile source must be config/platform.yaml",
  );
  const config = loadYaml(await readFile(path, "utf8"), { json: true });
  must(
    config.nginxTransport,
    "config/platform.yaml has no nginxTransport profile yet; active integration belongs to #162",
  );
  return config.nginxTransport;
}

function validateProfile(profile, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  must(
    validate(profile),
    `invalid nginxTransport: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
  );
  for (const [name, value] of Object.entries(profile.upstreams)) {
    must(
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.host),
      `${name}: invalid host`,
    );
    must(
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.serverName),
      `${name}: invalid SNI`,
    );
  }
}

function nginxStatusPort(endpoint) {
  const url = new URL(endpoint);
  must(
    url.protocol === "http:" &&
      url.hostname === "edge-nginx" &&
      !url.username &&
      !url.password &&
      /^[1-9][0-9]{0,4}$/u.test(url.port) &&
      Number(url.port) <= 65535 &&
      url.pathname === "/nginx_status" &&
      !url.search &&
      !url.hash,
    "invalid private nginx status endpoint",
  );
  return Number(url.port);
}

export function readRoutes(spec) {
  const result = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!METHODS.has(method)) continue;
      must(
        /^[A-Za-z][A-Za-z0-9]+$/.test(operation.operationId ?? ""),
        `invalid operationId at ${method} ${path}`,
      );
      result.push({ path, method: method.toUpperCase() });
    }
  }
  const required = [
    "POST /api/client-v1/customers",
    "GET /api/client-v1/customers",
    "GET /api/client-v1/catalog/products",
    "POST /api/client-v1/pricing/quotes",
    "POST /api/client-v1/orders/drafts",
    "PUT /api/client-v1/orders/{orderRef}/items/{itemRef}",
    "DELETE /api/client-v1/orders/{orderRef}/items/{itemRef}",
    "POST /api/client-v1/orders/{orderRef}/commands/confirm",
    "POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation",
    "GET /api/client-v1/orders/{orderRef}",
    "GET /events",
  ].sort();
  must(
    JSON.stringify(result.map((x) => `${x.method} ${x.path}`).sort()) ===
      JSON.stringify(required),
    "OpenAPI W1 route inventory drift",
  );
  return result;
}

const problem = (status, code, title) =>
  `default_type application/problem+json; add_header Cache-Control no-store always; add_header X-Correlation-Id $request_id always; return ${status} '{"type":"about:blank","title":"${title}","status":${status},"code":"${code}","detail":"The edge transport rejected this request.","instance":"urn:coffee:edge:$request_id","correlationId":"$request_id","errors":[]}';`;
function routeBlock(route, profile) {
  const { upstreams: u, limits: l } = profile;
  const event = route.path === "/events";
  const name = event ? "realtime" : "apiPublic";
  const variable = event ? "$realtime_auth_target" : "$api_auth_target";
  const template = route.path
    .replaceAll("{orderRef}", "ORDERREF")
    .replaceAll("{itemRef}", "ITEMREF");
  const path = template
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("ORDERREF", "[A-Za-z0-9_-]+")
    .replaceAll("ITEMREF", "[A-Za-z0-9_-]+");
  const location = path.includes("[") ? `~ ^${path}$` : `= ${path}`;
  const methods = route.methods.sort().join(" ");
  const rejectImplicitHead = route.methods.includes("GET")
    ? "if ($request_method = HEAD) { return 405; }"
    : "";
  return `location ${location} {
      limit_except ${methods} { deny all; }
      ${rejectImplicitHead}
      limit_conn ${event ? `edge_sse_admission ${l.sseAdmissionConnections}` : `edge_api_admission ${l.apiAdmissionConnections}`};
      ${event ? "limit_conn_status 429;" : ""}
      if ($bad_idempotency_key) { return 400; }
      auth_request /_edge/authorize;
      auth_request_set $edge_auth_status $upstream_status;
      auth_request_set $edge_actor_context $upstream_http_x_actor_context;
      auth_request_set $edge_auth_correlation $upstream_http_x_correlation_id;
      proxy_pass ${variable};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_cache off;
      ${event ? `gzip off;\n      proxy_pass_header X-Accel-Buffering;` : ""}
      proxy_next_upstream off;
      proxy_connect_timeout ${l.apiConnectSeconds}s;
      proxy_read_timeout ${event ? l.sseReadSeconds : l.apiReadSeconds}s;
      proxy_send_timeout ${l.apiSendSeconds}s;
      proxy_ssl_name ${u[name].serverName};
      proxy_set_header Host ${u[name].serverName};
      proxy_set_header X-Actor-Context $edge_actor_context;
      ${event ? "proxy_set_header Last-Event-ID $http_last_event_id;" : ""}
      include /etc/nginx/snippets/upstream-tls.conf;
      include /etc/nginx/snippets/business-headers.conf;
    }`;
}

export function render(profile, routes, statusEndpoint) {
  const { tls, upstreams: u, limits: l } = profile;
  const statusPort = nginxStatusPort(statusEndpoint);
  must(
    statusPort !== profile.listen,
    "nginx status listener must not share the public TLS port",
  );
  must(l.sseAdmissionConnections <= 512, "SSE admission must not exceed 512");
  must(
    l.workerProcesses === 1 || l.workerProcesses === 2,
    "worker processes must be 1 or 2",
  );
  must(
    l.requestPoolBytes === 2048,
    "request pool allocation granularity must match the checked profile",
  );
  must(
    l.workerConnections >=
      2 * l.sseAdmissionConnections +
        l.apiAdmissionConnections +
        l.authAdmissionConnections +
        64,
    "worker slot budget must preserve SSE upstream/downstream and API/auth/health headroom",
  );
  const grouped = new Map();
  for (const route of routes) {
    const group = grouped.get(route.path) ?? { path: route.path, methods: [] };
    group.methods.push(route.method);
    grouped.set(route.path, group);
  }
  const blocks = [...grouped.values()]
    .map((route) => routeBlock(route, profile))
    .join("\n");
  const authTimeouts = `proxy_connect_timeout ${l.authConnectSeconds}s; proxy_read_timeout ${l.authReadSeconds}s;`;
  return `worker_processes ${l.workerProcesses};
error_log /dev/null;
pid /tmp/nginx.pid;
events { worker_connections ${l.workerConnections}; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  log_format edge_safe escape=json '{"method":"$request_method","status":$status,"request_id":"$request_id","correlation_id":"$edge_log_correlation","traceparent":"$edge_traceparent","route":"$edge_route","request_bytes":$request_length,"response_bytes":$bytes_sent,"duration_seconds":$request_time,"request_completion":"$request_completion"}';
  access_log /dev/stdout edge_safe;
  map $uri $edge_route { default "unmatched"; ~^/api/client-v1/customers$ "client.customers"; ~^/api/client-v1/catalog/products$ "client.catalog.products"; ~^/api/client-v1/pricing/quotes$ "client.pricing.quotes"; ~^/api/client-v1/orders/ "client.orders"; =/events "events"; =/auth/session "auth.session"; =/auth/login "auth.login"; =/auth/callback "auth.callback"; =/auth/logout "auth.logout"; }
  map $http_traceparent $edge_traceparent { default ""; "~^(?!ff)[a-f0-9]{2}-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-[a-f0-9]{2}$" $http_traceparent; }
  map $http_x_correlation_id $edge_client_correlation { default ""; "~^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$" $http_x_correlation_id; }
  map $edge_auth_correlation $edge_safe_auth_correlation { default ""; "~^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$" $edge_auth_correlation; }
  map $edge_safe_auth_correlation $edge_log_correlation { "" $request_id; default $edge_safe_auth_correlation; }
  absolute_redirect off;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  client_max_body_size ${l.bodyBytes};
  large_client_header_buffers 4 ${l.headerBytes};
  client_header_buffer_size 1k;
  map "$edge_auth_status:$edge_actor_context:$edge_auth_correlation" $api_auth_target { default http://127.0.0.1:18080; ~^204:[^:]+:[^:]+$ https://api_public; }
  map "$edge_auth_status:$edge_actor_context:$edge_auth_correlation" $realtime_auth_target { default http://127.0.0.1:18080; ~^204:[^:]+:[^:]+$ https://realtime_gateway; }
  map $http_cookie $edge_session_cookie { default ''; '~*(?:^|;\\s*)(?<edge_session_cookie_value>__Host-coffee-session=[^;]+)' $edge_session_cookie_value; }
  map $http_cookie $edge_csrf_cookie { default ''; '~*(?:^|;\\s*)(?<edge_csrf_cookie_value>__Host-coffee-csrf=[^;]+)' $edge_csrf_cookie_value; }
  map $http_cookie $edge_login_cookie { default ''; '~*(?:^|;\\s*)(?<edge_login_cookie_value>__Host-coffee-login=[^;]+)' $edge_login_cookie_value; }
  map "$edge_session_cookie|$edge_csrf_cookie" $edge_allowed_cookie { default ''; "~^([^|]+)\\|([^|]+)$" "$1; $2"; "~^([^|]+)\\|" "$1"; "~^\\|([^|]+)$" "$1"; }
  map $http_idempotency_key $bad_idempotency_key { ~, 1; default 0; }
  limit_conn_zone $server_name zone=edge_api_admission:1m;
  limit_conn_zone $server_name zone=edge_auth_admission:1m;
  limit_conn_zone $server_name zone=edge_sse_admission:1m;
  map $request_uri $edge_oversized_raw_target { '~^.{2049}' 1; default 0; }
  server_tokens off;
  upstream edge_gateway { server ${u.edge.host}:${u.edge.port}; keepalive 8; }
  upstream api_public { server ${u.apiPublic.host}:${u.apiPublic.port}; keepalive 16; }
  upstream realtime_gateway { zone realtime_tls_state 64k; server ${u.realtime.host}:${u.realtime.port}; }
  server { listen 127.0.0.1:18080; location / { ${problem(503, "AUTHORIZER_UNAVAILABLE", "Authorization unavailable")} } }
  server { listen ${statusPort}; server_name edge-nginx; location = /nginx_status { stub_status; access_log off; } location / { return 404; } }
  server {
    listen ${profile.listen} ssl;
    request_pool_size ${l.requestPoolBytes};
    server_name ${profile.publicHost};
    proxy_next_upstream off;
    proxy_cache off;
    ssl_certificate ${tls.publicCertificate};
    ssl_certificate_key ${tls.publicPrivateKey};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_buffer_size ${tls.bufferBytes};
    ssl_session_cache shared:coffee_public_tls:${tls.sessionCacheMiB}m;
    ssl_session_timeout ${tls.sessionTimeoutMinutes}m;
    root /usr/share/nginx/html;
    location = /health/live { if ($request_method != GET) { return 405; } access_log off; default_type text/plain; return 200 'ok'; }
    location = / { if ($request_method != GET) { return 405; } return 303 /app/customers; }
    location ^~ /app/ { limit_except GET HEAD { deny all; } try_files $uri $uri/ /index.html; add_header Cache-Control 'no-cache, no-store, must-revalidate' always; }
    location = /index.html { internal; default_type text/html; add_header Cache-Control 'no-cache, no-store, must-revalidate' always; }
    location ^~ /assets/ { limit_except GET HEAD { deny all; } try_files $uri =404; add_header Cache-Control 'public, max-age=31536000, immutable' always; }
    location = /auth/session { limit_except GET { deny all; } if ($request_method = HEAD) { return 405; } proxy_pass_request_headers off; proxy_pass https://edge_gateway/auth/session; ${authTimeouts} proxy_ssl_name ${u.edge.serverName}; proxy_set_header Host ${u.edge.serverName}; proxy_set_header Cookie $edge_allowed_cookie; proxy_set_header X-Request-Id $request_id; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-Host ${profile.publicHost}; proxy_set_header Authorization ''; proxy_set_header Cache-Control no-store; proxy_hide_header Cache-Control; add_header Cache-Control no-store always; include /etc/nginx/snippets/upstream-tls.conf; }
    location = /auth/login { limit_except GET { deny all; } if ($request_method = HEAD) { return 405; } proxy_pass_request_headers off; proxy_pass https://edge_gateway/auth/login; ${authTimeouts} proxy_ssl_name ${u.edge.serverName}; proxy_set_header Host ${u.edge.serverName}; proxy_set_header X-Request-Id $request_id; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-Host ${profile.publicHost}; include /etc/nginx/snippets/upstream-tls.conf; }
    location = /auth/callback { limit_except GET { deny all; } if ($request_method = HEAD) { return 405; } proxy_pass_request_headers off; proxy_pass https://edge_gateway/auth/callback; ${authTimeouts} proxy_ssl_name ${u.edge.serverName}; proxy_set_header Host ${u.edge.serverName}; proxy_set_header Cookie $edge_login_cookie; proxy_set_header X-Request-Id $request_id; include /etc/nginx/snippets/upstream-tls.conf; }
    location = /auth/logout { limit_except POST { deny all; } proxy_pass_request_headers off; proxy_pass https://edge_gateway/auth/logout; ${authTimeouts} proxy_ssl_name ${u.edge.serverName}; proxy_set_header Host ${u.edge.serverName}; proxy_set_header Cookie $edge_allowed_cookie; proxy_set_header Origin $http_origin; proxy_set_header X-CSRF-Token $http_x_csrf_token; proxy_set_header X-Request-Id $request_id; include /etc/nginx/snippets/upstream-tls.conf; }
    if ($edge_oversized_raw_target) { return 414; }
    location = /_edge/authorize { internal; limit_conn edge_auth_admission ${l.authAdmissionConnections}; proxy_pass https://edge_gateway/_edge/authorize; ${authTimeouts} proxy_ssl_name ${u.edge.serverName}; proxy_set_header Host ${u.edge.serverName}; proxy_pass_request_body off; proxy_set_header Content-Length ''; proxy_set_header X-Original-Method $request_method; proxy_set_header X-Original-URI $request_uri; proxy_set_header X-Request-Id $request_id; proxy_set_header X-Correlation-Id $edge_client_correlation; proxy_set_header traceparent $edge_traceparent; proxy_set_header Cookie $edge_allowed_cookie; proxy_set_header Origin $http_origin; proxy_set_header X-CSRF-Token $http_x_csrf_token; proxy_set_header Authorization ''; proxy_set_header X-Actor-Context ''; include /etc/nginx/snippets/upstream-tls.conf; }
    location = /health/ready { return 404; }
    location = /metrics { return 404; }
    location ^~ /api/internal-v1/ { ${problem(404, "ROUTE_NOT_FOUND", "Not found")} }
    location ^~ /api/agent-v1/ { ${problem(404, "ROUTE_NOT_FOUND", "Not found")} }
    location ~ ^/(?:api/provider|admin|vk|psp)(?:/|$) { return 404; }
    location ~ ^/auth/ { return 404; }
    ${blocks}
    location / { return 404; }
    error_page 429 = @realtime_capacity;
    error_page 401 = @auth_401;
    error_page 403 = @auth_403;
    error_page 500 = @auth_503;
    error_page 502 = @upstream_502;
    error_page 503 = @upstream_503;
    error_page 504 = @upstream_504;
    location @auth_401 { ${problem(401, "AUTHENTICATION_REQUIRED", "Authentication required")} }
    location @auth_403 { ${problem(403, "AUTHORIZATION_FORBIDDEN", "Forbidden")} }
    location @auth_503 { ${problem(503, "AUTHORIZER_UNAVAILABLE", "Authorization unavailable")} }
    location @upstream_502 { ${problem(502, "UPSTREAM_UNAVAILABLE", "Upstream unavailable")} }
    location @upstream_503 { ${problem(503, "UPSTREAM_UNAVAILABLE", "Upstream unavailable")} }
    location @realtime_capacity { ${problem(503, "REALTIME_CAPACITY_EXCEEDED", "Realtime capacity exceeded")} }
    location @upstream_504 { ${problem(504, "UPSTREAM_UNAVAILABLE", "Upstream unavailable")} }
  }
}
`;
}

export async function generate({
  args = parseArgs(process.argv.slice(2)),
  root = ROOT,
} = {}) {
  const [schema, spec, toolchain, platformConfig] = await Promise.all([
    readFile(resolve(root, "config/nginx-profile.schema.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(resolve(root, "contracts/openapi/client-v1.yaml"), "utf8").then(
      (text) => loadYaml(text, { json: true }),
    ),
    readFile(resolve(root, "config/toolchain-versions.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(resolve(root, "config/platform.yaml"), "utf8").then((text) =>
      loadYaml(text, { json: true }),
    ),
  ]);
  must(
    toolchain.nginxImage === PIN && toolchain.nginxVersion === "1.31.6",
    "nginx registry pin mismatch",
  );
  const profile = await getProfile(args, root);
  validateProfile(profile, schema);
  const text = render(
    profile,
    readRoutes(spec),
    platformConfig.telemetry?.nginxStatusEndpoint,
  );
  const output = resolve(
    root,
    args.output ?? "apps/edge-nginx/generated/nginx.conf",
  );
  must(
    output.startsWith(`${resolve(root, "apps/edge-nginx")}/`),
    "output must be under apps/edge-nginx",
  );
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o644 });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    output: relative(root, output),
    routes: 11,
    bytes: Buffer.byteLength(text),
    source: args.fixture ? "isolated-fixture" : "config/platform.yaml",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(`nginx config generated: ${JSON.stringify(await generate())}`);
  } catch (error) {
    console.error(`nginx config generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
