import {appendFileSync} from "node:fs";
import pg from "pg";

const logPath = process.env.CUSTOMER_TEST_DB_ADAPTER_LOG_FILE;
if (logPath !== undefined && logPath.length > 0) {
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function observedQuery(query, ...args) {
    const text = typeof query === "string" ? query : query?.text;
    const command = typeof text === "string" ? /^\s*([A-Za-z]+)/u.exec(text)?.[1]?.toUpperCase() : undefined;
    if (command === "BEGIN" || command === "COMMIT" || command === "ROLLBACK") appendFileSync(logPath, `${command}\n`);
    return originalQuery.call(this, query, ...args);
  };
}
