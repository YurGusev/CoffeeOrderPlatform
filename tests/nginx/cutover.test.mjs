import assert from 'node:assert/strict';
import { execFile, spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, chmod, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { generateKeyPairSync, verify as verifySignature, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.argv.includes('--web-served-proof')) {
  const { runServedProof } = await import('./fixtures/served-backend.mjs');
  await runServedProof();
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const suffix = `${process.pid}`;
const nginxImage = `coffee-edge-nginx:issue162-${suffix}`;
const backendImage = `coffee-edge-cutover-fixture:issue162-${suffix}`;
const network = `edge162-${suffix}`;
const hostPort = 24000 + (process.pid % 20000);
const scratch = await mkdtemp(join(tmpdir(), 'edge162-'));
const certDir = join(scratch, 'certs');
const activeConfig = join(scratch, 'nginx.conf');
const eventLog = join(scratch, 'requests.jsonl');
const created = [];
let nginxId;
let backendId;
let networkCreated = false;
const fixtureSigningKeys = generateKeyPairSync('ed25519');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const docker = (...args) => run('docker', args);
const checkNginx = () => docker('run', '--rm', '--network', network, '--user', '101:101', '--mount', `type=bind,src=${activeConfig},dst=/etc/nginx/nginx.conf,readonly`, '--mount', `type=bind,src=${certDir},dst=/run/secrets/edge-nginx,readonly`, '--entrypoint', 'nginx', nginxImage, '-t', '-c', '/etc/nginx/nginx.conf');
const startNginx = () => docker('run', '--detach', '--read-only', '--user', '101:101', '--network', network, '--publish', `127.0.0.1:${hostPort}:8443`, '--tmpfs', '/tmp:rw,noexec,nosuid,mode=1777', '--mount', `type=bind,src=${activeConfig},dst=/etc/nginx/nginx.conf`, '--mount', `type=bind,src=${certDir},dst=/run/secrets/edge-nginx,readonly`, nginxImage).trim();
const replaceNginx = async () => {
  const started = Date.now();
  await promisify(execFile)('docker', ['stop', '--time', '30', nginxId], { cwd: root });
  assert.ok(Date.now() - started < 32_000, 'old nginx workers must drain within the bounded stop interval');
  docker('rm', nginxId);
  nginxId = startNginx();
};
const openssl = (...args) => execFileSync('openssl', args, { cwd: certDir, stdio: 'ignore' });
const issue = (name, commonName, extension) => {
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${commonName}`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`);
  return extension;
};
const waitFor = async (condition, label, timeout = 10_000) => {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { if (await condition()) return; } catch (e) { error = e; }
    await delay(150);
  }
  throw new Error(`${label} timed out${error ? `: ${error.message}` : ''}`);
};
const request = (path, { port = hostPort, headers = {}, method = 'GET', timeout = 10_000 } = {}) => new Promise((resolveRequest, reject) => {
  const req = https.request({ hostname: '127.0.0.1', port, path, method, headers, ca: readFileSync(join(certDir, 'ca.crt')), servername: 'localhost', rejectUnauthorized: true, agent: false, timeout }, res => {
    const chunks = [];
    const peerFingerprint = res.socket.getPeerCertificate().fingerprint256;
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), peerFingerprint }));
  });
  req.on('timeout', () => req.destroy(new Error('request timeout')));
  req.on('error', error => reject(new Error(`${method} ${path} on ${port}: ${error.message}`)));
  req.end();
});
const streamFor = (path, headers, durationMs = 6_200) => new Promise((resolveStream, reject) => {
  const started = Date.now();
  let settled = false;
  let status;
  let body = '';
  const request = https.request({ hostname: '127.0.0.1', port: hostPort, path, headers, ca: readFileSync(join(certDir, 'ca.crt')), servername: 'localhost', rejectUnauthorized: true, agent: false }, response => {
    status = response.statusCode;
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolveStream({ status, body, elapsed: Date.now() - started }); } });
  });
  const timer = setTimeout(() => { settled = true; request.destroy(); resolveStream({ status, body, elapsed: Date.now() - started }); }, durationMs);
  request.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  request.end();
});
import { readFileSync } from 'node:fs';
try {
  await mkdir(certDir, { mode: 0o755 });
  await writeFile(eventLog, '');
  await writeFile(join(certDir, 'assertion-private.pem'), fixtureSigningKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
  await chmod(eventLog, 0o666);
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=issue162-cutover-ca', '-days', '2');
  await writeFile(join(certDir, 'server.ext'), [
    'subjectAltName=DNS:edge-gateway.development.svc.coffee-platform.internal,DNS:api-public.development.svc.coffee-platform.internal,DNS:realtime-gateway.development.svc.coffee-platform.internal',
    'extendedKeyUsage=serverAuth',
  ].join('\n') + '\n');
  issue('server', 'issue162-upstream', 'server.ext');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'api-ca.key', '-out', 'api-ca.crt', '-subj', '/CN=issue162-api-ca', '-days', '2');
  await writeFile(join(certDir, 'api-server.ext'), ['subjectAltName=DNS:api-public.development.svc.coffee-platform.internal', 'extendedKeyUsage=serverAuth'].join(String.fromCharCode(10)) + String.fromCharCode(10));
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'api-server.key', '-out', 'api-server.csr', '-subj', '/CN=api-public.development.svc.coffee-platform.internal');
  openssl('x509', '-req', '-in', 'api-server.csr', '-CA', 'api-ca.crt', '-CAkey', 'api-ca.key', '-CAcreateserial', '-out', 'api-server.crt', '-days', '2', '-extfile', 'api-server.ext');
  await writeFile(join(certDir, 'client.ext'), 'extendedKeyUsage=clientAuth\nsubjectAltName=URI:spiffe://coffee-platform/development/edge-nginx\n');
  issue('client', 'issue162-edge-nginx', 'client.ext');
  await writeFile(join(certDir, 'public.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  issue('public', 'localhost', 'public.ext');
  const publicLeaf = new X509Certificate(await readFile(join(certDir, 'public.crt')));
  assert.equal(Date.parse(publicLeaf.validTo) - Date.parse(publicLeaf.validFrom), 86_400_000, 'reference public leaf must be issued for 24 hours');
  for (const file of ['ca.crt', 'server.crt', 'server.key', 'client.crt', 'client.key', 'public.crt', 'public.key', 'api-server.crt', 'api-server.key']) await chmod(join(certDir, file), 0o644);
  await writeFile(join(certDir, 'upstream-ca.crt'), Buffer.concat([await readFile(join(certDir, 'ca.crt')), await readFile(join(certDir, 'api-ca.crt'))]));

  // Use the real active generator and its canonical source; only the ignored generated artifact is written.
  run(process.execPath, ['tools/nginx/generate-config.mjs', '--config', 'config/platform.yaml', '--output', 'apps/edge-nginx/generated/nginx.conf']);
  const generated = await readFile(join(root, 'apps/edge-nginx/generated/nginx.conf'), 'utf8');
  for (const expected of [
    'server edge-gateway:4000;', 'server api-public:4050;', 'server realtime-gateway:4401;',
    'edge-gateway.development.svc.coffee-platform.internal', 'api-public.development.svc.coffee-platform.internal',
    'realtime-gateway.development.svc.coffee-platform.internal', 'proxy_next_upstream off;',
  ]) assert.ok(generated.includes(expected), `active generated config is missing ${expected}`);
  const capacityTestConfig = generated.replace('limit_conn edge_sse_admission 512;', 'limit_conn edge_sse_admission 1;');
  assert.equal(capacityTestConfig === generated, false, 'test config lowers only SSE admission to exercise the generated capacity error path cheaply');
  assert.equal(generated.split('limit_conn edge_sse_admission 512;').length - 1, 1, 'test-only admission override has one exact generated anchor');
  await writeFile(activeConfig, capacityTestConfig);

  run('pnpm', ['image:build', '--target', 'edge-nginx', '--tag', nginxImage, '--load', '.']);
  docker('build', '--file', 'tests/nginx/fixtures/Dockerfile.cutover', '--tag', backendImage, 'tests/nginx/fixtures');
  docker('network', 'create', network);
  networkCreated = true;
  backendId = docker('run', '--detach', '--network', network, '--network-alias', 'edge-gateway', '--network-alias', 'api-public', '--network-alias', 'realtime-gateway', '--mount', `type=bind,src=${certDir},dst=/run/fixture-certs,readonly`, '--mount', `type=bind,src=${eventLog},dst=/run/requests.jsonl`, '--env', 'REQUEST_LOG=/run/requests.jsonl', backendImage).trim();
  checkNginx();
  nginxId = startNginx();
  await waitFor(async () => (await request('/health/live')).status === 200, 'nginx readiness');

  const denied = await request('/api/client-v1/orders/drafts', { method: 'POST' });
  assert.equal(denied.status, 401, 'unauthenticated mutation must not reach the API');
  const deniedEvents = await request('/events');
  assert.equal(deniedEvents.status, 401, 'SSE keeps the inherited authentication response');
  assert.equal(JSON.parse(deniedEvents.body).code, 'AUTHENTICATION_REQUIRED');
  const forbiddenEvents = await request('/events', { method: 'POST', headers: { cookie: '__Host-coffee-session=allow' } });
  assert.equal(forbiddenEvents.status, 403, 'SSE keeps the inherited forbidden response');
  assert.equal(JSON.parse(forbiddenEvents.body).code, 'AUTHORIZATION_FORBIDDEN');
  const accepted = await request('/api/client-v1/orders/drafts', { method: 'POST', headers: { cookie: '__Host-coffee-session=allow', 'idempotency-key': 'issue162-allowed' } });
  assert.equal(accepted.status, 200, 'signed 204 assertion must reach the synthetic API');
  const acceptedBody = JSON.parse(accepted.body);
  assert.equal(acceptedBody.host, 'api-public');
  const assertion = acceptedBody.headers['x-actor-context'];
  const [assertionHeader, assertionPayload, assertionSignature] = assertion.split('.');
  assert.equal(assertion.split('.').length, 3, 'Edge must return compact signed context');
  assert.ok(verifySignature(null, Buffer.from(`${assertionHeader}.${assertionPayload}`), fixtureSigningKeys.publicKey, Buffer.from(assertionSignature, 'base64url')), 'actor context must carry valid Ed25519 signature');
  const claims = JSON.parse(Buffer.from(assertionPayload, 'base64url').toString('utf8'));
  assert.equal(claims.iss, 'edge-gateway');
  assert.equal(claims.originalIssuer, 'edge-gateway');
  assert.equal(claims.aud, 'api-public');
  assert.equal(claims.sub, 'cutover-actor');
  assert.equal(claims.operationId, 'createOrderDraft');
  assert.equal(claims.originalMethod, 'POST');
  assert.equal(claims.originalUri, '/api/client-v1/orders/drafts');
  assert.ok(claims.iat <= Math.floor(Date.now() / 1000) && claims.exp > Math.floor(Date.now() / 1000));
  assert.equal(claims.correlationId, acceptedBody.headers['x-correlation-id']);
  assert.equal(acceptedBody.headers.cookie, undefined);
  assert.equal(acceptedBody.authorized, true, 'API upstream must authenticate nginx client certificate');
  assert.match(acceptedBody.clientAltName, /spiffe:\/\/coffee-platform\/development\/edge-nginx/);
  const acceptedNext = await request('/api/client-v1/orders/drafts', { method: 'POST', headers: { cookie: '__Host-coffee-session=allow-next', 'idempotency-key': 'issue162-allowed-next' } });
  assert.equal(acceptedNext.status, 200, 'a fresh authorization must be made for the next request on the pooled Edge connection');
  const acceptedNextBody = JSON.parse(acceptedNext.body);
  const nextAssertion = acceptedNextBody.headers['x-actor-context'];
  const [nextHeader, nextPayload, nextSignature] = nextAssertion.split('.');
  assert.ok(verifySignature(null, Buffer.from(`${nextHeader}.${nextPayload}`), fixtureSigningKeys.publicKey, Buffer.from(nextSignature, 'base64url')), 'second authorization carries a fresh signed assertion');
  const nextClaims = JSON.parse(Buffer.from(nextPayload, 'base64url').toString('utf8'));
  assert.equal(nextClaims.sub, 'cutover-actor-next');
  assert.notEqual(nextClaims.sub, claims.sub, 'the second response must not reuse a cached actor assertion');
  assert.notEqual(nextClaims.correlationId, claims.correlationId, 'the second authorization must use the new request correlation');
  assert.equal(nextClaims.correlationId, acceptedNextBody.headers['x-correlation-id']);
  const authRows = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.role === 'edge' && event.url === '/_edge/authorize' && ['allow', 'allow-next'].includes(/(?:^|;\s*)__Host-coffee-session=([^;]+)/.exec(event.headers.cookie ?? '')?.[1]));
  assert.equal(authRows.length, 2, 'each protected request reaches the authorizer');
  assert.equal(authRows[0].headers.connection, undefined, 'the auth request does not send a Connection header');
  assert.equal(authRows[1].headers.connection, undefined, 'the next auth request does not send a Connection header');
  assert.equal(authRows[0].upstreamSocketId, authRows[1].upstreamSocketId, 'the same Edge TLS connection serves both independent authorization requests');

  docker('stop', '--time', '2', backendId);
  const beforeBackendFailure = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line));
  const backendFailure = await request('/api/client-v1/orders/drafts', { method: 'POST', headers: { cookie: '__Host-coffee-session=allow-recovery', 'idempotency-key': 'issue162-auth-backend-down' }, timeout: 5_000 });
  assert.equal(backendFailure.status, 503, 'an unavailable auth subrequest maps to the authorizer-unavailable response');
  assert.match(backendFailure.headers['content-type'], /^application\/problem\+json/);
  const backendFailureProblem = JSON.parse(backendFailure.body);
  assert.equal(backendFailureProblem.status, backendFailure.status);
  assert.equal(backendFailureProblem.code, 'AUTHORIZER_UNAVAILABLE');
  assert.equal(backendFailureProblem.correlationId, backendFailure.headers['x-correlation-id']);
  const realtimeRowsBeforeAuthFailure = beforeBackendFailure.filter(event => event.role === 'realtime' && event.url === '/events' && !event.type).length;
  const realtimeAuthFailure = await request('/events', { headers: { cookie: '__Host-coffee-session=allow' }, timeout: 5_000 });
  assert.equal(realtimeAuthFailure.status, 503, 'an unavailable authorizer on /events keeps the typed auth failure');
  assert.match(realtimeAuthFailure.headers['content-type'], /^application\/problem\+json/);
  const realtimeAuthFailureProblem = JSON.parse(realtimeAuthFailure.body);
  assert.equal(realtimeAuthFailureProblem.status, 503);
  assert.equal(realtimeAuthFailureProblem.code, 'AUTHORIZER_UNAVAILABLE');
  assert.equal(realtimeAuthFailureProblem.correlationId, realtimeAuthFailure.headers['x-correlation-id']);
  assert.equal((await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line)).filter(event => event.role === 'realtime' && event.url === '/events' && !event.type).length, realtimeRowsBeforeAuthFailure, 'an auth failure never reaches the realtime upstream');
  const duringBackendFailure = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(duringBackendFailure.filter(event => event.role === 'api' && event.headers['idempotency-key'] === 'issue162-auth-backend-down').length, 0, 'authorization failure never reaches the business API');
  docker('start', backendId);
  let recoveredAuth;
  await waitFor(async () => {
    const response = await request('/api/client-v1/orders/drafts', { method: 'POST', headers: { cookie: '__Host-coffee-session=allow-recovery', 'idempotency-key': 'issue162-auth-backend-recovered' }, timeout: 3_000 });
    if(response.status===200){recoveredAuth=response;return true;}return false;
  }, 'Edge authorizer restart recovery');
  assert.equal(recoveredAuth.status, 200);
  const recoveredBody = JSON.parse(recoveredAuth.body);
  const recoveredAssertion = recoveredBody.headers['x-actor-context'];
  const [recoveredHeader, recoveredPayload, recoveredSignature] = recoveredAssertion.split('.');
  assert.ok(verifySignature(null, Buffer.from(`${recoveredHeader}.${recoveredPayload}`), fixtureSigningKeys.publicKey, Buffer.from(recoveredSignature, 'base64url')), 'restarted authorizer returns a new valid assertion');
  const recoveredClaims = JSON.parse(Buffer.from(recoveredPayload, 'base64url').toString('utf8'));
  assert.equal(recoveredClaims.sub, 'cutover-actor-recovery');
  assert.notEqual(recoveredClaims.correlationId, claims.correlationId);
  const afterRestartRows = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.role === 'edge' && event.url === '/_edge/authorize' && /(?:^|;\s*)__Host-coffee-session=allow-recovery(?:;|$)/.test(event.headers.cookie ?? ''));
  assert.ok(afterRestartRows.length >= 1);
  assert.notEqual(afterRestartRows.at(-1).upstreamSocketId, authRows[0].upstreamSocketId, 'restarted authorizer uses a fresh Edge TLS connection');
  assert.equal(beforeBackendFailure.filter(event => event.role === 'api' && event.headers['idempotency-key'] === 'issue162-auth-backend-down').length, 0);
  const realtimeBeforeCapacity = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line)).filter(event => event.role === 'realtime' && event.url === '/events' && !event.type).length;
  const admittedCapacityStream = streamFor('/events', { cookie: '__Host-coffee-session=allow' }, 1_500);
  await waitFor(async () => (await readFile(eventLog, 'utf8')).includes('"role":"realtime","method":"GET","url":"/events"'), 'first SSE stream consumes test admission slot');
  const capacityRejected = await request('/events', { headers: { cookie: '__Host-coffee-session=allow' } });
  assert.equal(capacityRejected.status, 503, 'SSE admission remains a typed 503');
  assert.match(capacityRejected.headers['content-type'], /^application\/problem\+json/);
  const capacityProblem = JSON.parse(capacityRejected.body);
  assert.equal(capacityProblem.status, 503);
  assert.equal(capacityProblem.code, 'REALTIME_CAPACITY_EXCEEDED');
  assert.equal(capacityProblem.correlationId, capacityRejected.headers['x-correlation-id']);
  const admittedStreamResult = await admittedCapacityStream;
  assert.equal(admittedStreamResult.status, 200, 'the admitted stream is unaffected by the rejected request');
  const realtimeAfterCapacity = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line)).filter(event => event.role === 'realtime' && event.url === '/events' && !event.type).length;
  assert.equal(realtimeAfterCapacity, realtimeBeforeCapacity + 1, 'only the admitted request reaches the realtime upstream');
  const sse = await streamFor('/events', { cookie: '__Host-coffee-session=allow', 'last-event-id': 'evt-162' });
  assert.equal(sse.status, 200);
  assert.ok(sse.elapsed > 5_000, `SSE remained open for ${sse.elapsed}ms`);
  assert.match(sse.body, /event: connected/);
  assert.match(sse.body, /event: tick/);
  await waitFor(async () => (await readFile(eventLog, 'utf8')).includes('"type":"disconnect"'), 'SSE upstream disconnect cleanup');
  const eventsBeforeRejection = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(eventsBeforeRejection.filter(e => e.role === 'api' && e.headers['idempotency-key'] === 'issue162-allowed').length, 1);
  assert.equal(eventsBeforeRejection.filter(e => e.role === 'api' && e.method === 'POST').length, 3);
  assert.equal(eventsBeforeRejection.filter(e => e.role === 'api' && e.headers['idempotency-key'] === 'issue162-allowed-next').length, 1);
  assert.equal(eventsBeforeRejection.filter(e => e.role === 'api' && e.headers['idempotency-key'] === 'issue162-auth-backend-down').length, 0);
  assert.equal(eventsBeforeRejection.filter(e => e.role === 'api' && e.headers['idempotency-key'] === 'issue162-auth-backend-recovered').length, 1);
  const sseEvents = eventsBeforeRejection.filter(e => e.role === 'realtime' && e.url === '/events' && !e.type);
  assert.equal(sseEvents.length, 2, 'each admitted SSE route reaches the realtime upstream exactly once');
  assert.ok(sseEvents.some(event => event.headers['last-event-id'] === 'evt-162'));
  assert.ok(sseEvents.every(event => event.authorized === true), 'realtime upstream must authenticate nginx client certificate');
  assert.ok(eventsBeforeRejection.some(e => e.role === 'realtime' && e.type === 'disconnect'), 'downstream close must release the SSE upstream');

  // A parallel active-config instance with withdrawn upstream trust models revoked certificate material.
  const deniedCa = join(scratch, 'denied-ca');
  await mkdir(deniedCa);
  for (const file of ['public.crt', 'public.key', 'client.crt', 'client.key']) await copyFile(join(certDir, file), join(deniedCa, file));
  await copyFile(join(certDir, 'ca.crt'), join(deniedCa, 'upstream-ca.crt'));
  const negativePort = hostPort + 1;
  const negativeId = docker('run', '--detach', '--read-only', '--user', '101:101', '--network', network, '--publish', `127.0.0.1:${negativePort}:8443`, '--tmpfs', '/tmp:rw,noexec,nosuid,mode=1777', '--mount', `type=bind,src=${activeConfig},dst=/etc/nginx/nginx.conf,readonly`, '--mount', `type=bind,src=${deniedCa},dst=/run/secrets/edge-nginx,readonly`, nginxImage).trim();
  created.push(negativeId);
  await waitFor(async () => docker('inspect', '--format', '{{.State.Running}}', negativeId).trim() === 'true', 'negative TLS fixture process');
  const negativeStart = Date.now();
  const rejected = await request('/api/client-v1/orders/drafts', { port: negativePort, method: 'POST', headers: { cookie: '__Host-coffee-session=allow', 'idempotency-key': 'issue162-revoked' }, timeout: 4_000 });
  assert.equal(rejected.status, 502, 'revoked/untrusted upstream material must fail closed');
  assert.match(rejected.headers['content-type'], /^application\/problem\+json/);
  assert.equal(JSON.parse(rejected.body).code, 'UPSTREAM_UNAVAILABLE');
  assert.ok(Date.now() - negativeStart < 6_000, 'trust-negative request must be bounded');
  await delay(150);
  const eventsAfterRejection = (await readFile(eventLog, 'utf8')).trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(eventsAfterRejection.filter(e => e.role === 'api' && e.headers['idempotency-key'] === 'issue162-revoked').length, 0, 'untrusted upstream certificate must send no business HTTP request');
  spawnSync('docker', ['rm', '-f', negativeId], { stdio: 'ignore' });
  created.splice(created.indexOf(negativeId), 1);

  // Restore trust, then prove bad reload is rejected while serving workers stay healthy.
  await waitFor(async () => (await request('/health/live')).status === 200, 'active nginx health after negative peer test');
  await writeFile(activeConfig, generated.replace('worker_processes 1;', 'worker_processes INVALID;'));
  const badTest = spawnSync('docker', ['exec', nginxId, 'nginx', '-t', '-c', '/etc/nginx/nginx.conf'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badTest.status, 0, 'invalid config must be rejected');
  const badReload = spawnSync('docker', ['exec', nginxId, 'nginx', '-s', 'reload', '-c', '/etc/nginx/nginx.conf'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badReload.status, 0, 'nginx reload must reject invalid active config');
  assert.match(badReload.stderr, /emerg.*worker_processes.*invalid value/i, 'rejected reload must expose the master parse error');
  await waitFor(async () => (await request('/health/live')).status === 200, 'health after rejected reload');
  await writeFile(activeConfig, generated);
  docker('exec', nginxId, 'nginx', '-s', 'reload', '-c', '/etc/nginx/nginx.conf');
  await waitFor(async () => (await request('/health/live')).status === 200, 'nginx recovery reload');
  const recovery = await request('/api/client-v1/orders/drafts', { method: 'POST', headers: { cookie: '__Host-coffee-session=allow', 'idempotency-key': 'issue162-recovered' } });
  assert.equal(recovery.status, 200, 'restored trust/config must recover without recreating nginx');

  // Certificate rotation and rollback use synthetic localhost leafs; validate the exact peer identity each time.
  const originalFingerprint = (await request('/health/live')).peerFingerprint;
  await copyFile(join(certDir, 'public.crt'), join(certDir, 'public-original.crt'));
  await copyFile(join(certDir, 'public.key'), join(certDir, 'public-original.key'));
  await writeFile(join(certDir, 'public-rotated.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'public-rotated.key', '-out', 'public-rotated.csr', '-subj', '/CN=localhost');
  openssl('x509', '-req', '-in', 'public-rotated.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'public-rotated.crt', '-days', '1', '-extfile', 'public-rotated.ext');
  const rotatedLeaf = new X509Certificate(await readFile(join(certDir, 'public-rotated.crt')));
  assert.equal(Date.parse(rotatedLeaf.validTo) - Date.parse(rotatedLeaf.validFrom), 86_400_000, 'rotated leaf must preserve the 24-hour lifetime');
  await copyFile(join(certDir, 'public-rotated.crt'), join(certDir, 'public.crt'));
  await copyFile(join(certDir, 'public-rotated.key'), join(certDir, 'public.key'));
  await chmod(join(certDir, 'public.crt'), 0o644);
  await chmod(join(certDir, 'public.key'), 0o644);
  const rotatedFingerprint = new X509Certificate(await readFile(join(certDir, 'public.crt'))).fingerprint256;
  assert.notEqual(rotatedFingerprint, originalFingerprint, 'rotation must issue a different leaf');
  checkNginx();
  const realtimeBeforeDrain = (await readFile(eventLog, 'utf8')).split('\n').filter(line => line.includes('"role":"realtime"') && !line.includes('"type":"disconnect"')).length;
  const drainingSse = streamFor('/events', {cookie: '__Host-coffee-session=allow'});
  await waitFor(async () => (await readFile(eventLog, 'utf8')).split('\n').filter(line => line.includes('"role":"realtime"') && !line.includes('"type":"disconnect"')).length > realtimeBeforeDrain, 'SSE admitted before bounded drain');
  await replaceNginx();
  const drained = await drainingSse;
  assert.equal(drained.status, 200);
  assert.ok(drained.elapsed > 5_000, `old nginx worker must drain the active SSE stream (${drained.elapsed}ms)`);
  await waitFor(async () => { try {
    const response = await request('/health/live');
    return response.status === 200 && response.peerFingerprint === rotatedFingerprint;
  } catch { return false; } }, 'rotated leaf served by nginx');
  await copyFile(join(certDir, 'public-original.crt'), join(certDir, 'public.crt'));
  await copyFile(join(certDir, 'public-original.key'), join(certDir, 'public.key'));
  checkNginx();
  await replaceNginx();
  await waitFor(async () => { const response = await request('/health/live'); if (response.status === 200 && response.peerFingerprint === originalFingerprint) return true; throw new Error(`peer=${response.peerFingerprint ?? 'none'} expected=${originalFingerprint}`); }, 'original leaf served after rollback');

  const finalEvents = (await readFile(eventLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(finalEvents.some(e => e.role === 'edge' && e.url === '/_edge/authorize' && e.authorized), 'synthetic authorizer received verified nginx mTLS');
  assert.ok(finalEvents.some(e => e.role === 'api' && e.headers['idempotency-key'] === 'issue162-recovered'), 'API resumed after rejected config and trust rollback');
  console.log(`PASS issue162 active cutover: real config/platform.yaml generator; exact upstreams and runtime DNS SANs; HTTPS + mutual TLS + signed Ed25519 204 assertion verified and forwarded; absent auth denied; >5s SSE and Last-Event-ID verified; withdrawn API issuer trust returns 502 with no API request; invalid nginx reload rejected with old workers healthy; valid reload recovers; TLS certificate rotation/rollback verified; no production secrets; nginx=${docker('image','inspect','--format','{{.Id}}',nginxImage).trim()}`);
} finally {
  if (nginxId) spawnSync('docker', ['rm', '-f', nginxId], { stdio: 'ignore' });
  if (backendId) spawnSync('docker', ['rm', '-f', backendId], { stdio: 'ignore' });
  for (const id of created) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  if (networkCreated) spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  spawnSync('docker', ['image', 'rm', '-f', nginxImage, backendImage], { stdio: 'ignore' });
  await rm(scratch, { recursive: true, force: true });
}
