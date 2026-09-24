import https from 'node:https';
import { appendFile, readFile } from 'node:fs/promises';

const dir = '/run/fixture-certs';
const [key, cert, ca] = await Promise.all(['server.key','server.crt','ca.crt'].map(name => readFile(`${dir}/${name}`)));
const events = process.env.REQUEST_LOG ?? '/run/fixture-certs/requests.jsonl';
async function start(port, role) {
  const server = https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const record = { role, method: req.method, url: req.url, headers: req.headers, body, clientAuthorized: req.socket.authorized };
    await appendFile(events, `${JSON.stringify(record)}\n`);
    if (role === 'edge' && req.url === '/_edge/authorize') {
      const mode = /(?:^|;\s*)__Host-coffee-session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const authorize = async (status, headers = {}) => {
        await appendFile(events, `${JSON.stringify({ role: 'edge-auth-response', status, actorContext: headers['X-Actor-Context'] ?? null, correlationId: headers['X-Correlation-Id'] ?? null })}\n`);
        res.writeHead(status, headers); res.end();
      };
      if (mode === 'forged200') { await authorize(200, { 'X-Actor-Context': 'forged-context', 'X-Correlation-Id': '123e4567-e89b-42d3-a456-426614174000' }); return; }
      if (mode === 'allow') { await authorize(204, { 'X-Actor-Context': 'fixture-actor-17', 'X-Correlation-Id': '123e4567-e89b-42d3-a456-426614174000' }); return; }
      if (mode === 'no-correlation') { await authorize(204, { 'X-Actor-Context': 'fixture-actor-17' }); return; }
      if (mode === 'empty204') { await authorize(204, { 'X-Correlation-Id': '123e4567-e89b-42d3-a456-426614174000' }); return; }
      if (mode === 'forbidden') { await authorize(403); return; }
      if (mode === 'infra') { await authorize(503); return; }
      await authorize(401); return;
    }
    if (role === 'edge' && req.url === '/auth/session') {
      if ((req.headers.cookie ?? '').includes('__Host-coffee-session=allow')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ actorRef: 'fixture-actor-17', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ type: 'about:blank', title: 'Authentication required', status: 401, code: 'AUTHENTICATION_REQUIRED' }));
      }
      return;
    }
    if (role === 'realtime' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: connected\ndata: first\n\n');
      const timer = setInterval(() => res.write('event: tick\ndata: alive\n\n'), 1500);
      res.on('close', async () => { clearInterval(timer); await appendFile(events, `${JSON.stringify({ role, type: 'disconnect', url: req.url })}\n`); });
      return;
    }
    if (role === 'api' && req.headers['idempotency-key'] === 'fixture-disconnect') { req.socket.destroy(); return; }
    const payload = JSON.stringify({ role, method: req.method, url: req.url, headers: req.headers, body, clientAuthorized: req.socket.authorized });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(payload);
  });
  server.listen(port, '0.0.0.0');
}
await Promise.all([[9443,'edge'],[9444,'api'],[9445,'realtime']].map(([port, role]) => start(port, role)));
