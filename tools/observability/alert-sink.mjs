import {appendFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createServer} from 'node:http';

const evidencePath = process.argv[2];
if (!evidencePath) throw new Error('alert evidence path is required');

await mkdir(dirname(evidencePath), {recursive: true, mode: 0o700});
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/alerts') {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 8192) {
      response.writeHead(413).end();
      return;
    }
  }
  try {
    const event = JSON.parse(raw);
    if (!['firing', 'resolved'].includes(event.status) || typeof event.episode_id !== 'string' || typeof event.name !== 'string') throw new Error('invalid event');
    await appendFile(evidencePath, `${JSON.stringify({status: event.status, episodeId: event.episode_id, name: event.name, receivedAt: new Date().toISOString()})}\n`, {mode: 0o600});
    response.writeHead(200).end('ok');
  } catch {
    response.writeHead(400).end();
  }
});
server.listen(9091, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
