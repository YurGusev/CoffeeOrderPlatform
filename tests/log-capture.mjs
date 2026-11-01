import fs from "node:fs";

// Pino пишет в fd 1 напрямую, минуя process.stdout.write.
export function captureStdoutLogs(t) {
  const chunks = [];
  const originalWrite = fs.write;
  t.mock.method(fs, "write", function (fd, chunk, ...args) {
    const result = Reflect.apply(originalWrite, this, [fd, chunk, ...args]);
    if (fd === 1 && typeof chunk === "string") chunks.push(chunk);
    return result;
  });
  return {
    chunks,
    async waitForRecord(predicate, startIndex = 0) {
      const deadline = Date.now() + 5_000;
      do {
        const text = chunks.slice(startIndex).join("");
        for (const line of text.split("\n").slice(0, -1)) {
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (predicate(record)) return text;
        }
        if (Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      throw new Error("missing correlated stdout log record");
    },
  };
}
