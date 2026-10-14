import https from 'node:https';
import { appendFile, readFile } from 'node:fs/promises';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

const dir = '/run/fixture-certs';
const [key, cert, ca] = await Promise.all(['server.key', 'server.crt', 'ca.crt'].map(name => readFile(`${dir}/${name}`)));
const [apiKey, apiCert] = await Promise.all(['api-server.key', 'api-server.crt'].map(name => readFile(`${dir}/${name}`)));
const signer = createPrivateKey(await readFile(`${dir}/assertion-private.pem`));
const events = process.env.REQUEST_LOG;
const services = [
  ['edge-gateway', 4000, 'edge'],
  ['api-public', 4050, 'api'],
  ['realtime-gateway', 4401, 'realtime'],
];
for (const [host, port, role] of services) {
  https.createServer({ key: role === 'api' ? apiKey : key, cert: role === 'api' ? apiCert : cert, ca, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const record = { host, role, method: req.method, url: req.url, headers: req.headers, body, authorized: req.socket.authorized, clientAltName: req.socket.getPeerCertificate().subjectaltname };
    await appendFile(events, `${JSON.stringify(record)}\n`);
    if (role === 'edge' && req.url === '/_edge/authorize') {
      const cookie = req.headers.cookie ?? '';
      const status = cookie.includes('__Host-coffee-session=allow') ? 204 : 401;
      if (status === 204) {
        const now = Math.floor(Date.now() / 1000);
        const correlationId = req.headers['x-request-id'];
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'issue162-fixture', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: 'edge-gateway', originalIssuer: 'edge-gateway', aud: req.headers['x-original-uri'] === '/events' ? 'realtime-gateway' : 'api-public', sub: 'cutover-actor', permissions: ['orders:draft:create'], operationId: 'createOrderDraft', correlationId, originalMethod: req.headers['x-original-method'], originalUri: req.headers['x-original-uri'], iat: now, exp: now + 60, jti: randomUUID() })).toString('base64url');
        const unsigned = `${header}.${payload}`;
        const assertion = `${unsigned}.${sign(null, Buffer.from(unsigned), signer).toString('base64url')}`;
        res.writeHead(status, { 'X-Actor-Context': assertion, 'X-Correlation-Id': correlationId });
      } else res.writeHead(status);
      res.end();
      return;
    }
    if (role === 'edge' && req.url === '/auth/session') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ actorRef: 'cutover-actor', expiresAt: '2099-01-01T00:00:00.000Z' }));
      return;
    }
    if (role === 'realtime' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: connected\ndata: cutover\n\n');
      const timer = setInterval(() => res.write('event: tick\ndata: alive\n\n'), 1000);
      res.on('close', async () => { clearInterval(timer); await appendFile(events, `${JSON.stringify({ role, type: 'disconnect', url: req.url })}\n`); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(record));
  }).listen(port, '0.0.0.0');
}
