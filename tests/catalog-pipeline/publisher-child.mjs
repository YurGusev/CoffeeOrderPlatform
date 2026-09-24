import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {createSqlOutboxStore, relayOutboxBatch} from "../../packages/platform-outbox/dist/index.js";

const {DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, LEASE_MS = "1200", LEASE_OWNER, HOLD_AFTER_RETURNED, BLOCK_SENDER} = process.env;
const message = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let releaseSender;
const senderGate = BLOCK_SENDER === "1" ? new Promise(resolve => {releaseSender = resolve;}) : Promise.resolve();
if (BLOCK_SENDER === "1") {
  let input = "";
  process.stdin.setEncoding("utf8").on("data", chunk => {
    input += chunk;
    if (input.includes("continue\n")) releaseSender();
  });
}
let database;
try {
  database = createDatabase({owner: LEASE_OWNER, database: DB_NAME,
    allowedDatabase: DB_NAME, host: "127.0.0.1", port: Number(DB_PORT), user: DB_USER,
    password: DB_PASSWORD, ssl: false, pool: {max: 2, checkoutTimeoutMs: 2_000,
      lockTimeoutMs: 20_000, interactiveStatementTimeoutMs: 5_000,
      backgroundStatementTimeoutMs: 15_000, terminalTimeoutMs: 3_000,
      transactionTimeoutMs: 25_000, idleTimeoutMs: 30_000, maxLifetimeMs: 1_800_000},
    shutdownGraceMs: 40_000});
  await database.resource.start(new AbortController().signal);
  const store = createSqlOutboxStore(database, {schema: "catalog"});
  let sentMessageId;
  const result = await relayOutboxBatch(store, database, async claim => {
    sentMessageId = claim.message.messageId;
    message({phase: "sender_ack", pid: process.pid, messageId: sentMessageId,
      note: "fake sender acknowledgement; not a real Kafka broker proof"});
    await senderGate;
    return {kind: "ack"};
  }, {nowMs: Date.now(), leaseOwner: LEASE_OWNER,
    policy: {leaseMs: Number(LEASE_MS), sendTimeoutMs: 60_000, maxInFlight: 1,
      retry: {baseMs: 100, maxMs: 1_000, maxAttempts: 3}}});
  message({phase: "relay_returned", pid: process.pid, messageId: sentMessageId ?? null, result});
  if (HOLD_AFTER_RETURNED === "1") await new Promise(() => {});
} catch (error) {
  message({phase: "error", pid: process.pid, message: error?.stack ?? String(error)});
  process.exitCode = 1;
} finally {
  if (database !== undefined) await database.resource.stop(AbortSignal.timeout(4_000)).catch(() => {});
}
