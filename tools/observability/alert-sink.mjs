import { appendFile, mkdir, rename, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export function createAlertSink({ outputPath, maxBytes, maxFiles }) {
  if (
    typeof outputPath !== "string" ||
    !outputPath ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1
  )
    throw new Error("invalid alert sink configuration");
  let pending = Promise.resolve();
  const writeEvents = async (records) => {
    const text =
      records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error("alert batch exceeds file limit");
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const current = await stat(outputPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if ((current?.size ?? 0) + bytes > maxBytes) {
      for (let index = maxFiles - 1; index > 0; index--) {
        const source = index === 1 ? outputPath : `${outputPath}.${index - 1}`;
        await rename(source, `${outputPath}.${index}`).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      if (maxFiles === 1) await truncate(outputPath, 0);
    }
    await appendFile(outputPath, text, { mode: 0o600 });
  };
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/alerts") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) {
        response.writeHead(413).end();
        return;
      }
    }
    let events;
    try {
      const event = JSON.parse(raw);
      if (
        !Array.isArray(event.alerts) ||
        event.alerts.length === 0 ||
        event.alerts.length > 32 ||
        event.alerts.some(
          (alert) =>
            !["firing", "resolved"].includes(alert.status) ||
            typeof alert.fingerprint !== "string" ||
            !/^[a-f0-9]{16}$/u.test(alert.fingerprint) ||
            typeof alert.startsAt !== "string" ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(
              alert.startsAt,
            ) ||
            typeof alert.labels?.alertname !== "string" ||
            !/^(?:g14-v1-(?:service-not-ready(?:-synthetic)?|consumer-lag|outbox-oldest-age|unknown-outcome|sse-drop-rate|disk-watermark)|DatasourceNoData|DatasourceError)$/u.test(
              alert.labels.alertname,
            ),
        )
      )
        throw new Error("invalid event");
      const receivedAt = new Date().toISOString();
      events = event.alerts.map((alert) => ({
        status: alert.status,
        episodeId: `${alert.fingerprint}:${alert.startsAt}`,
        name: alert.labels.alertname,
        receivedAt,
      }));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const write = pending.then(() => writeEvents(events));
    pending = write.catch(() => {});
    try {
      await write;
      response.writeHead(200).end("ok");
    } catch {
      response.writeHead(500).end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw new Error("usage: alert-sink.mjs <path> <maxSizeMiB> <maxFiles>");
  const server = createAlertSink({
    outputPath: args[0],
    maxBytes: Number(args[1]) * 1024 * 1024,
    maxFiles: Number(args[2]),
  });
  server.listen(9091, "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
