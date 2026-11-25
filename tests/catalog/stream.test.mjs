import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { trace } from "@opentelemetry/api";
import { DatabaseTransactionError } from "../../packages/platform-database/dist/index.js";
import { CatalogImportError } from "../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js";
import {
  catalogBatchBytes,
  catalogBatchHash,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readNdjson } from "../../apps/catalog-supplier-sync/dist/ndjson-reader.js";
import { createHourlyScheduler } from "../../apps/catalog-supplier-sync/dist/hourly-scheduler.js";
import { InternalCatalogClient } from "../../apps/catalog-supplier-sync/dist/internal-api-client.js";
import { runCatalogImport } from "../../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import {
  CatalogOutcomeUnknown,
  reconcileBatch,
  reconcileCompleted,
  reconcileCreate,
  reconcileRejected,
  reconcileStarted,
} from "../../apps/catalog-supplier-sync/dist/reconcile-imports.js";

const supplierRef = "sup_00000000000000000000000001";
const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBA";
const startedRecord = Object.freeze({
  streamVersion: "1",
  recordType: "snapshot-started",
  snapshotRef,
  supplierRef,
  providerSnapshotRef: "provider-stream-test",
  startedAt: "2026-09-20T00:00:00Z",
});
const completedRecord = Object.freeze({
  streamVersion: "1",
  recordType: "snapshot-completed",
  snapshotRef,
  batchCount: 0,
  productCount: 0,
  variantCount: 0,
  offerCount: 0,
  contentHash:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  completedAt: "2026-09-20T00:01:00Z",
});

function importStore(events) {
  const state = { state: "Created", failure_code: null };
  return Object.freeze({
    durable: state,
    create: async () => {
      events.push("create");
    },
    acceptStarted: async () => {
      events.push("started");
      state.state = "Receiving";
    },
    recordBatch: async () => {
      events.push("batch");
      return "stored";
    },
    complete: async () => {
      events.push("complete");
      state.state = "Received";
      return "stored";
    },
    reject: async (_ref, code) => {
      events.push(`reject:${code}`);
      state.state = "Rejected";
      state.failure_code = code;
    },
    getSnapshot: async () => null,
    listIncomplete: async () => [],
    verifyBatchReplay: async () => false,
    reconstructBatch: async () => [],
  });
}

const emptyBatch = Object.freeze({
  streamVersion: "1",
  recordType: "snapshot-batch",
  snapshotRef,
  batchNumber: 0,
  offerCount: 0,
  uncompressedBytes: catalogBatchBytes([]),
  batchHash: catalogBatchHash([]),
  previousBatchHash: null,
  items: [],
});
const importOptions = (store, records) => ({
  store,
  supplierRef,
  snapshotRef,
  signal: new AbortController().signal,
  context: { correlationId: "33333333-3333-4333-8333-333333333333" },
  exportCatalog: async function* () {
    yield* records;
  },
});

for (const [
  label,
  records,
  code,
] of /** @type {Array<[string, unknown[], string]>} */ ([
  ["schema", [{}], "INVALID_STREAM_SCHEMA"],
  ["batch before start", [emptyBatch], "INVALID_STREAM_SEQUENCE"],
  ["completed before start", [completedRecord], "INVALID_STREAM_SEQUENCE"],
  [
    "duplicate start",
    [startedRecord, startedRecord],
    "INVALID_STREAM_SEQUENCE",
  ],
  [
    "wrong supplier",
    [{ ...startedRecord, supplierRef: "sup_00000000000000000000000002" }],
    "INVALID_STREAM_SEQUENCE",
  ],
  [
    "wrong snapshot",
    [{ ...startedRecord, snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FBB" }],
    "INVALID_STREAM_SEQUENCE",
  ],
  [
    "gap",
    [startedRecord, { ...emptyBatch, batchNumber: 1 }],
    "BATCH_SEQUENCE_CONFLICT",
  ],
  [
    "terminal count",
    [startedRecord, { ...completedRecord, batchCount: 1 }],
    "TERMINAL_COUNT_MISMATCH",
  ],
  ["missing terminal", [startedRecord], "INVALID_STREAM_MISSING_TERMINAL"],
  [
    "second terminal",
    [startedRecord, completedRecord, completedRecord],
    "INVALID_STREAM_SEQUENCE",
  ],
])) {
  void test(`durable closed reason: ${label}`, async () => {
    const events = [];
    const store = importStore(events);
    await assert.rejects(
      () => runCatalogImport(importOptions(store, records)),
      (error) => error.code === code,
    );
    assert.deepEqual(store.durable, { state: "Rejected", failure_code: code });
    assert.equal(events.at(-1), `reject:${code}`);
    assert.equal(events.includes("complete"), false);
  });
}
for (const code of [
  "BATCH_CHAIN_CONFLICT",
  "SOURCE_IDENTITY_COLLISION",
  "TERMINAL_CONTENT_HASH_MISMATCH",
  "BATCH_DURABLE_HASH_MISMATCH",
  "BATCH_DURABLE_ORDINAL_MISMATCH",
  "BATCH_REPLAY_CONFLICT",
  "BATCH_BYTE_COUNT_MISMATCH",
]) {
  void test(`durable store reason: ${code}`, async () => {
    const events = [];
    const store = {
      ...importStore(events),
      recordBatch: async () => {
        throw new CatalogImportError(code);
      },
    };
    await assert.rejects(
      () => runCatalogImport(importOptions(store, [startedRecord, emptyBatch])),
      (error) => error.code === code,
    );
    const persisted =
      code === "BATCH_REPLAY_CONFLICT" ? "BATCH_HASH_CONFLICT" : code;
    assert.equal(events.at(-1), `reject:${persisted}`);
    assert.deepEqual(store.durable, {
      state: "Rejected",
      failure_code: persisted,
    });
    assert.equal(events.includes("complete"), false);
  });
}
for (const code of [
  "DB_CONNECTION_LOST",
  "DB_ROLLBACK_FAILED",
  "DB_QUERY_FAILED",
  "TRANSACTION_OUTCOME_UNKNOWN",
]) {
  void test(`uncertain database ${code} never writes terminal failure`, async () => {
    const events = [];
    const store = {
      ...importStore(events),
      recordBatch: async () => {
        throw new DatabaseTransactionError(code);
      },
      getSnapshot: async () => {
        throw new DatabaseTransactionError("DB_CONNECTION_LOST");
      },
      verifyBatchReplay: async () => {
        throw new DatabaseTransactionError("DB_CONNECTION_LOST");
      },
    };
    await assert.rejects(() =>
      runCatalogImport(importOptions(store, [startedRecord, emptyBatch])),
    );
    assert.equal(
      events.some((value) => value.startsWith("reject:")),
      false,
    );
  });
}
void test("unknown batch outcome stays unknown when its reconciliation transaction rolls back", async () => {
  const events = [];
  const store = {
    ...importStore(events),
    recordBatch: async () => {
      throw new DatabaseTransactionError("TRANSACTION_OUTCOME_UNKNOWN");
    },
    verifyBatchReplay: async () => {
      throw new CatalogImportError("IMPORT_DB_ROLLED_BACK");
    },
  };
  await assert.rejects(
    () => runCatalogImport(importOptions(store, [startedRecord, emptyBatch])),
    (error) =>
      error instanceof CatalogOutcomeUnknown && error.operation === "batch",
  );
  assert.equal(
    events.some((value) => value.startsWith("reject:")),
    false,
  );
});
void test("unknown error text and arbitrary code are never durable failure codes", async () => {
  for (const error of [
    new Error("BATCH_HASH_CONFLICT: password=secret"),
    Object.assign(new Error("SQL secret"), { code: "SECRET_PROVIDER_BODY" }),
  ]) {
    const events = [];
    const store = {
      ...importStore(events),
      recordBatch: async () => {
        throw error;
      },
    };
    await assert.rejects(() =>
      runCatalogImport(importOptions(store, [startedRecord, emptyBatch])),
    );
    assert.equal(events.at(-1), "reject:INVALID_STREAM");
  }
});
for (const code of [
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "INVALID_STREAM",
  "BATCH_HASH_CONFLICT",
  "SOURCE_IDENTITY_COLLISION",
]) {
  void test(`provider terminal contract code ${code} before started is preserved`, async () => {
    const events = [];
    await assert.rejects(() =>
      runCatalogImport(
        importOptions(importStore(events), [
          {
            streamVersion: "1",
            recordType: "snapshot-failed",
            snapshotRef,
            code,
            failedAt: "2026-09-20T00:01:00Z",
          },
        ]),
      ),
    );
    assert.deepEqual(events, ["create", `reject:${code}`]);
  });
}
void test("HTTP protocol failures persist bounded typed codes and cancel unread body", async () => {
  for (const [status, contentType, cancelRejects] of [
    [503, "application/problem+json", false],
    [200, "text/plain", false],
    [503, "application/problem+json", true],
    [200, "text/plain", true],
  ]) {
    const events = [];
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
        if (cancelRejects)
          return Promise.reject(new Error("private cancellation failure"));
      },
    });
    const client = new InternalCatalogClient({
      fetch: async () =>
        new Response(body, {
          status,
          headers: { "content-type": contentType },
        }),
    });
    await assert.rejects(() =>
      runCatalogImport({
        ...importOptions(importStore(events), []),
        exportCatalog: client.export.bind(client),
      }),
    );
    assert.equal(events.at(-1), "reject:HTTP_BEFORE_STARTED");
    assert.equal(cancelled, true);
  }
});

void test("response-body transport failure before started persists HTTP_BEFORE_STARTED", async () => {
  const events = [];
  const body = new ReadableStream({
    start(controller) {
      controller.error(
        new TypeError("terminated with private provider detail"),
      );
    },
  });
  const client = new InternalCatalogClient({
    fetch: async () =>
      new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
      }),
  });
  await assert.rejects(() =>
    runCatalogImport({
      ...importOptions(importStore(events), []),
      exportCatalog: client.export.bind(client),
    }),
  );
  assert.equal(events.at(-1), "reject:HTTP_BEFORE_STARTED");
});

void test("HTTP client exposes stable protocol codes without changing durable phase mapping", async () => {
  const client = new InternalCatalogClient({
    fetch: async () => new Response("private body", { status: 503 }),
  });
  await assert.rejects(
    async () => {
      for await (const record of client.export(
        { snapshotRef, supplierRef },
        { correlationId: "safe", signal: new AbortController().signal },
      ))
        assert.fail(JSON.stringify(record));
    },
    (error) => error.code === "CATALOG_EXPORT_HTTP_503",
  );
});

void test("known rollback needs a successful guarded reread before safe rejection", async () => {
  for (const available of [true, false]) {
    const events = [];
    const store = {
      ...importStore(events),
      recordBatch: async () => {
        throw new CatalogImportError("IMPORT_DB_ROLLED_BACK");
      },
      getSnapshot: async () => {
        if (!available)
          throw new DatabaseTransactionError("DB_CONNECTION_LOST");
        return { supplier_ref: supplierRef, state: "Receiving" };
      },
    };
    await assert.rejects(() =>
      runCatalogImport(importOptions(store, [startedRecord, emptyBatch])),
    );
    assert.equal(
      events.some((value) => value.startsWith("reject:")),
      available,
    );
    if (available) assert.equal(events.at(-1), "reject:IMPORT_DB_ROLLED_BACK");
  }
});
void test("unknown application error before started is not a transport failure", async () => {
  const events = [];
  await assert.rejects(() =>
    runCatalogImport({
      ...importOptions(importStore(events), []),
      exportCatalog: () => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return Promise.reject(new Error("untrusted message"));
        },
      }),
    }),
  );
  assert.equal(events.at(-1), "reject:INVALID_STREAM");
});

async function collect(chunks, options = {}) {
  const result = [];
  for await (const value of readNdjson(Readable.from(chunks), options))
    result.push(value);
  return result;
}

void test("client transport, empty body and malformed NDJSON persist only bounded protocol reasons", async () => {
  const cases = [
    {
      fetch: async () => {
        throw new Error("provider credentials and body");
      },
      code: "HTTP_BEFORE_STARTED",
    },
    {
      fetch: async () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
      code: "HTTP_BEFORE_STARTED",
    },
    ...[
      [Buffer.from("\n"), "CATALOG_STREAM_EMPTY_LINE"],
      [Buffer.from("no-json\n"), "CATALOG_STREAM_INVALID_JSON"],
      [Buffer.from([255, 10]), "CATALOG_STREAM_INVALID_UTF8"],
      [Buffer.from("{}"), "CATALOG_STREAM_INCOMPLETE"],
    ].map(([wire, code]) => ({
      fetch: async () =>
        new Response(wire, {
          headers: { "content-type": "application/x-ndjson" },
        }),
      code,
    })),
  ];
  for (const { fetch, code } of cases) {
    const store = importStore([]),
      client = new InternalCatalogClient({ fetch });
    await assert.rejects(() =>
      runCatalogImport({
        ...importOptions(store, []),
        exportCatalog: client.export.bind(client),
      }),
    );
    assert.deepEqual(store.durable, { state: "Rejected", failure_code: code });
  }
});

void test("provider terminal after batch waits for clean EOF and rejects a subsequent record", async () => {
  const failed = {
    streamVersion: "1",
    recordType: "snapshot-failed",
    snapshotRef,
    code: "PROVIDER_TIMEOUT",
    failedAt: "2026-09-21T00:00:00Z",
  };
  for (const tail of [
    [],
    [emptyBatch],
    [startedRecord],
    [failed],
    [completedRecord],
  ]) {
    const store = importStore([]);
    await assert.rejects(() =>
      runCatalogImport(
        importOptions(store, [startedRecord, emptyBatch, failed, ...tail]),
      ),
    );
    assert.deepEqual(store.durable, {
      state: "Rejected",
      failure_code:
        tail.length === 0 ? "PROVIDER_TIMEOUT" : "INVALID_STREAM_SEQUENCE",
    });
  }
});

void test(
  "large fragmented importer is memory-bounded and persistence backpressures upstream",
  { timeout: 180_000 },
  async (t) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--max-old-space-size=64",
        "tests/catalog/stream-capacity-proof.mjs",
      ],
      { timeout: 170_000 },
    );
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.upstreamPaused, true);
    assert.ok(receipt.wireBytes > 128 * 1024 * 1024);
    t.diagnostic(JSON.stringify(receipt));
  },
);

void test(
  "production complete verifies a large manifest with bounded retained memory",
  { timeout: 180_000 },
  async (t) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--expose-gc",
        "--max-old-space-size=64",
        "tests/catalog/terminal-capacity-proof.mjs",
      ],
      { timeout: 170_000 },
    );
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.productionComplete, true);
    assert.equal(receipt.manifests, 131_072);
    assert.equal(receipt.reconstructions, receipt.manifests);
    assert.ok(receipt.peakRetainedHeapGrowth < receipt.heapLimitBytes);
    t.diagnostic(JSON.stringify(receipt));
  },
);

for (const mode of [
  "recovery",
  "scheduler-recovery",
  "readiness-reject",
  "readiness-resolve",
  "catalog-service",
  "catalog-activation-worker",
]) {
  void test(`production composition ${mode}`, async () => {
    await promisify(execFile)(process.execPath, [
      "--experimental-test-module-mocks",
      "tests/catalog/composition-proof.mjs",
      mode,
    ]);
  });
}

void test("NDJSON checks growth before allocation and copies fragmented prefixes only once", async () => {
  const concatDescriptor = Object.getOwnPropertyDescriptor(Buffer, "concat");
  const originalConcat = (...args) =>
    Reflect.apply(concatDescriptor.value, Buffer, args);
  let copied = 0;
  Buffer.concat = (list, length) => {
    copied += length ?? list.reduce((sum, entry) => sum + entry.length, 0);
    return originalConcat(list, length);
  };
  try {
    const bytes = Buffer.from(
      JSON.stringify({ text: "Кофе☕".repeat(1000) }) + "\n",
    );
    async function* fragments() {
      for (let index = 0; index < bytes.length; index++)
        yield bytes.subarray(index, index + 1);
    }
    const values = [];
    for await (const record of readNdjson(
      Readable.from(fragments(), { highWaterMark: 1 }),
    ))
      values.push(record);
    assert.equal(values[0].text, "Кофе☕".repeat(1000));
    assert.ok(
      copied <= bytes.length * 2,
      `quadratic framing copies: ${copied} bytes for ${bytes.length}`,
    );
    copied = 0;
    await assert.rejects(
      () =>
        collect([Buffer.from('{"x":"'), Buffer.alloc(100000, 65)], {
          maxLineBytes: 32,
        }),
      /CATALOG_STREAM_LINE_TOO_LARGE/u,
    );
    assert.equal(copied, 0, "oversize must fail before buffer concatenation");
  } finally {
    Object.defineProperty(Buffer, "concat", concatDescriptor);
  }
});

void test("NDJSON decodes split UTF-8/codepoints and split lines", async () => {
  const bytes = Buffer.from('{"name":"Кофе ☕"}\n{"n":2}\n');
  const records = await collect([
    bytes.subarray(0, 12),
    bytes.subarray(12, 17),
    bytes.subarray(17),
  ]);
  assert.deepEqual(records, [{ name: "Кофе ☕" }, { n: 2 }]);
});

void test("NDJSON rejects malformed UTF-8, oversized lines, trailing incomplete data", async () => {
  await assert.rejects(
    () => collect([Buffer.from([0xc3, 0x28, 0x0a])]),
    /CATALOG_STREAM_INVALID_UTF8/u,
  );
  await assert.rejects(
    () => collect([Buffer.from('{"x":"12345"}\n')], { maxLineBytes: 8 }),
    /CATALOG_STREAM_LINE_TOO_LARGE/u,
  );
  await assert.rejects(
    () => collect([Buffer.from('{"x":1}')]),
    /CATALOG_STREAM_INCOMPLETE/u,
  );
});

void test("abort destroys upstream reader", async () => {
  const controller = new AbortController();
  let destroyed = false;
  const source = new Readable({
    read() {
      this.push('{"x":1}\n');
      controller.abort();
    },
    destroy(error, callback) {
      destroyed = true;
      callback(error);
    },
  });
  await assert.rejects(async () => {
    for await (const _value of readNdjson(source, {
      signal: controller.signal,
    })) {
    }
  });
  assert.equal(destroyed, true);
});

void test("hourly scheduler runs immediately and skips missed monotonic ticks without queueing", async () => {
  let now = 0;
  let runs = 0;
  let skipped = 0;
  const controller = new AbortController();
  const scheduler = createHourlyScheduler({
    intervalMs: 3_600_000,
    now: () => now,
    onSkippedTick: () => skipped++,
    wait: async () => {},
  });
  await scheduler.start(async () => {
    runs++;
    now = 7_200_001;
    controller.abort();
  }, controller.signal);
  assert.equal(runs, 1);
  assert.equal(skipped, 2);
});

void test("typed InternalApiV1 client requests and consumes the NDJSON boundary", async () => {
  let call;
  const started = {
    streamVersion: "1",
    recordType: "snapshot-started",
    snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    supplierRef: "sup_00000000000000000000000001",
    providerSnapshotRef: "provider-1",
    startedAt: "2026-09-20T00:00:00Z",
  };
  const http = {
    fetch: async (path, options) => {
      call = { path, options };
      return new Response(`${JSON.stringify(started)}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  };
  const client = new InternalCatalogClient(http);
  const signal = new AbortController().signal;
  const values = [];
  for await (const value of client.export(
    { snapshotRef: started.snapshotRef, supplierRef: started.supplierRef },
    { correlationId: "11111111-1111-4111-8111-111111111111", signal },
  ))
    values.push(value);
  assert.deepEqual(values, [started]);
  assert.equal(call.path, "/api/internal-v1/aroma/catalog-exports");
  assert.equal(call.options.headers.accept, "application/x-ndjson");
  assert.equal("x-service-delegation" in call.options.headers, false);
});

void test("hourly scheduler records a failed import and continues on the next tick", async () => {
  let now = 0;
  let runs = 0;
  let failures = 0;
  const controller = new AbortController();
  const scheduler = createHourlyScheduler({
    intervalMs: 3_600_000,
    now: () => now,
    wait: async (delay) => {
      now += delay;
    },
    onRunError: () => {
      failures++;
    },
  });
  await scheduler.start(async () => {
    runs++;
    if (runs === 1) throw new Error("fixture failure");
    controller.abort();
  }, controller.signal);
  assert.equal(runs, 2);
  assert.equal(failures, 1);
});

void test("completed snapshot is not persisted as Received until clean EOF", async () => {
  const events = [];
  await assert.rejects(
    () =>
      runCatalogImport({
        store: importStore(events),
        supplierRef,
        snapshotRef,
        signal: new AbortController().signal,
        context: { correlationId: "33333333-3333-4333-8333-333333333333" },
        exportCatalog: async function* () {
          yield startedRecord;
          yield completedRecord;
          yield startedRecord;
        },
      }),
    /INVALID_STREAM_SEQUENCE/u,
  );
  assert.equal(events.includes("complete"), false);
  assert.equal(events.at(-1), "reject:INVALID_STREAM_SEQUENCE");
});

void test("one total deadline aborts an import across the whole traversal", async () => {
  const events = [];
  await assert.rejects(
    () =>
      runCatalogImport({
        store: importStore(events),
        supplierRef,
        snapshotRef,
        signal: new AbortController().signal,
        deadlineMs: 5,
        context: { correlationId: "44444444-4444-4444-8444-444444444444" },
        exportCatalog: async function* (_request, context) {
          yield startedRecord;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            context.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(context.signal.reason);
              },
              { once: true },
            );
          });
          yield completedRecord;
        },
      }),
    (error) => error?.name === "TimeoutError",
  );
  assert.equal(events.includes("complete"), false);
  assert.equal(events.at(-1), "reject:IMPORT_DEADLINE_EXCEEDED");
});

void test("create and started reconciliation require their exact durable postconditions", async () => {
  const base = {
    snapshot_ref: snapshotRef,
    supplier_ref: supplierRef,
    provider_snapshot_ref: null,
    state: "Created",
    next_batch_number: 0,
    declared_batch_count: null,
    declared_product_count: null,
    declared_variant_count: null,
    declared_offer_count: null,
    received_batch_count: 0,
    received_product_count: 0,
    received_variant_count: 0,
    received_offer_count: 0,
    content_hash: null,
    failure_code: null,
    received_at: null,
  };
  const signal = new AbortController().signal;
  assert.equal(
    await reconcileCreate(
      { getSnapshot: async () => base },
      snapshotRef,
      supplierRef,
      signal,
    ),
    true,
  );
  const writes = { create: 0, reject: 0 };
  assert.equal(
    await reconcileCreate(
      {
        getSnapshot: async () => null,
        create: async () => {
          writes.create += 1;
        },
      },
      snapshotRef,
      supplierRef,
      signal,
    ),
    true,
  );
  assert.equal(writes.create, 1);
  const createdConflicts = [
    ["supplier_ref", "sup_00000000000000000000000002"],
    ["state", "Receiving"],
    ["provider_snapshot_ref", "unexpected-provider-ref"],
    ["next_batch_number", 1],
    ["declared_batch_count", 0],
    ["declared_product_count", 0],
    ["declared_variant_count", 0],
    ["declared_offer_count", 0],
    ["received_batch_count", 1],
    ["received_product_count", 1],
    ["received_variant_count", 1],
    ["received_offer_count", 1],
    ["content_hash", "a".repeat(64)],
    ["failure_code", "INVALID_STREAM"],
    ["received_at", new Date("2026-09-20T00:00:00Z")],
  ];
  for (const [field, value] of createdConflicts) {
    await assert.rejects(
      () =>
        reconcileCreate(
          {
            getSnapshot: async () => ({ ...base, [field]: value }),
            create: async () => {
              writes.create += 1;
            },
          },
          snapshotRef,
          supplierRef,
          signal,
        ),
      /ReconciledFailure:create:CONFLICTING_DURABLE_STATE/u,
      `create reconciliation must reject a changed ${String(field)}`,
    );
    assert.equal(
      writes.create,
      1,
      `must not recreate conflicting ${String(field)}`,
    );
  }

  const receiving = {
    ...base,
    state: "Receiving",
    provider_snapshot_ref: "provider-stream-test",
  };
  assert.equal(
    await reconcileStarted(
      { getSnapshot: async () => receiving },
      snapshotRef,
      "provider-stream-test",
      signal,
    ),
    true,
  );
  const startedConflicts = [
    ["provider_snapshot_ref", "unexpected-provider-ref"],
    ["next_batch_number", 1],
    ["declared_batch_count", 0],
    ["declared_product_count", 0],
    ["declared_variant_count", 0],
    ["declared_offer_count", 0],
    ["received_batch_count", 1],
    ["received_product_count", 1],
    ["received_variant_count", 1],
    ["received_offer_count", 1],
    ["content_hash", "a".repeat(64)],
    ["failure_code", "INVALID_STREAM"],
    ["received_at", new Date("2026-09-20T00:00:00Z")],
  ];
  for (const [field, value] of startedConflicts) {
    await assert.rejects(
      () =>
        reconcileStarted(
          {
            getSnapshot: async () => ({ ...receiving, [field]: value }),
            reject: async () => {
              writes.reject += 1;
            },
          },
          snapshotRef,
          "provider-stream-test",
          signal,
        ),
      /ReconciledFailure:started:CONFLICTING_DURABLE_STATE/u,
      `started reconciliation must reject a changed ${String(field)}`,
    );
    assert.equal(writes.reject, 0, `must not reject changed ${String(field)}`);
  }
  await assert.rejects(
    () =>
      reconcileStarted(
        {
          getSnapshot: async () => ({
            ...base,
            state: "Received",
            provider_snapshot_ref: "provider-stream-test",
          }),
        },
        snapshotRef,
        "provider-stream-test",
        signal,
      ),
    /ReconciledFailure:started:CONFLICTING_DURABLE_STATE/u,
  );
});

void test("reconciliation accepts an exact committed batch and terminal snapshot", async () => {
  const batchCalls = [];
  const batchStore = {
    verifyBatchReplay: async (record, signal) => {
      batchCalls.push({ record, signal });
      return true;
    },
    getSnapshot: async () => {
      throw new Error("an exact batch replay does not need a snapshot reread");
    },
  };
  const signal = new AbortController().signal;
  assert.equal(await reconcileBatch(batchStore, emptyBatch, signal), true);
  assert.deepEqual(batchCalls, [{ record: emptyBatch, signal }]);

  const terminalReads = [];
  let completedAgain = false;
  const terminalStore = {
    getSnapshot: async (ref, readSignal) => {
      terminalReads.push({ ref, signal: readSignal });
      return {
        snapshot_ref: snapshotRef,
        supplier_ref: supplierRef,
        provider_snapshot_ref: "provider-stream-test",
        state: "Received",
        next_batch_number: 0,
        declared_batch_count: 0,
        declared_product_count: 0,
        declared_variant_count: 0,
        declared_offer_count: 0,
        received_batch_count: 0,
        received_product_count: 0,
        received_variant_count: 0,
        received_offer_count: 0,
        content_hash: completedRecord.contentHash,
        failure_code: null,
        received_at: new Date(completedRecord.completedAt),
      };
    },
    complete: async () => {
      completedAgain = true;
    },
  };
  assert.equal(
    await reconcileCompleted(terminalStore, completedRecord, signal),
    true,
  );
  assert.deepEqual(terminalReads, [{ ref: snapshotRef, signal }]);
  assert.equal(completedAgain, false);
});

void test("terminal reconciliation retries only its guarded transition when verification left Receiving", async () => {
  const base = {
    snapshot_ref: snapshotRef,
    supplier_ref: supplierRef,
    provider_snapshot_ref: "provider-stream-test",
    state: "Receiving",
    next_batch_number: 0,
    declared_batch_count: null,
    declared_product_count: null,
    declared_variant_count: null,
    declared_offer_count: null,
    received_batch_count: 0,
    received_product_count: 0,
    received_variant_count: 0,
    received_offer_count: 0,
    content_hash: null,
    failure_code: null,
    received_at: null,
  };
  const calls = [];
  const store = {
    getSnapshot: async () => base,
    complete: async (record) => {
      calls.push(`complete:${record.snapshotRef}`);
      return "stored";
    },
    reject: async (ref, code) => {
      calls.push(`reject:${ref}:${code}`);
      return "stored";
    },
  };
  const signal = new AbortController().signal;
  assert.equal(await reconcileCompleted(store, completedRecord, signal), true);
  assert.equal(
    await reconcileRejected(store, snapshotRef, "INVALID_STREAM", signal),
    true,
  );
  assert.deepEqual(calls, [
    `complete:${snapshotRef}`,
    `reject:${snapshotRef}:INVALID_STREAM`,
  ]);

  const createdCalls = [];
  const createdStore = {
    getSnapshot: async () => ({ ...base, state: "Created" }),
    reject: async (ref, code) => {
      createdCalls.push(`reject:${ref}:${code}`);
    },
  };
  assert.equal(
    await reconcileRejected(
      createdStore,
      snapshotRef,
      "INVALID_STREAM",
      signal,
    ),
    true,
  );
  assert.deepEqual(createdCalls, [`reject:${snapshotRef}:INVALID_STREAM`]);

  const rejected = {
    ...base,
    state: "Rejected",
    failure_code: "INVALID_STREAM",
  };
  let rejectedWrites = 0;
  const rejectedStore = {
    getSnapshot: async () => rejected,
    reject: async () => {
      rejectedWrites += 1;
    },
  };
  assert.equal(
    await reconcileRejected(
      rejectedStore,
      snapshotRef,
      "INVALID_STREAM",
      signal,
    ),
    true,
  );
  await assert.rejects(
    () =>
      reconcileRejected(rejectedStore, snapshotRef, "PROVIDER_TIMEOUT", signal),
    /ReconciledFailure:reject:CONFLICTING_DURABLE_STATE/u,
  );
  const receivedStore = {
    getSnapshot: async () => ({ ...rejected, state: "Received" }),
    reject: async () => {
      rejectedWrites += 1;
    },
  };
  await assert.rejects(
    () =>
      reconcileRejected(receivedStore, snapshotRef, "INVALID_STREAM", signal),
    /ReconciledFailure:reject:CONFLICTING_DURABLE_STATE/u,
  );
  assert.equal(rejectedWrites, 0);
});

void test("started and batch reconciliation close a definitely unadvanced generation", async () => {
  const base = {
    snapshot_ref: snapshotRef,
    supplier_ref: supplierRef,
    provider_snapshot_ref: null,
    state: "Created",
    next_batch_number: 0,
    declared_batch_count: null,
    declared_product_count: null,
    declared_variant_count: null,
    declared_offer_count: null,
    received_batch_count: 0,
    received_product_count: 0,
    received_variant_count: 0,
    received_offer_count: 0,
    content_hash: null,
    failure_code: null,
    received_at: null,
  };
  const calls = [];
  const store = {
    getSnapshot: async () =>
      calls.length === 0
        ? base
        : {
            ...base,
            state: "Receiving",
            provider_snapshot_ref: "provider-stream-test",
          },
    verifyBatchReplay: async () => false,
    reject: async (ref, code) => {
      calls.push(`reject:${ref}:${code}`);
      return "stored";
    },
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    () => reconcileStarted(store, snapshotRef, "provider-stream-test", signal),
    /ReconciledFailure:started:KNOWN_NOT_COMMITTED/u,
  );
  const batch = {
    snapshotRef,
    batchNumber: 0,
    offerCount: 0,
    uncompressedBytes: 2,
    batchHash: "0".repeat(64),
    previousBatchHash: null,
    items: [],
  };
  await assert.rejects(
    () => reconcileBatch(store, batch, signal),
    /ReconciledFailure:batch:KNOWN_NOT_COMMITTED/u,
  );
  assert.deepEqual(calls, [
    `reject:${snapshotRef}:RECOVERY_INCOMPLETE`,
    `reject:${snapshotRef}:RECOVERY_INCOMPLETE`,
  ]);
});

void test("provider failure is durably rejected and reported as a failed import", async () => {
  const events = [];
  const failed = {
    streamVersion: "1",
    recordType: "snapshot-failed",
    snapshotRef,
    code: "PROVIDER_TIMEOUT",
    failedAt: "2026-09-20T00:01:00Z",
  };
  await assert.rejects(
    () =>
      runCatalogImport({
        store: importStore(events),
        supplierRef,
        snapshotRef,
        signal: new AbortController().signal,
        context: { correlationId: "55555555-5555-4555-8555-555555555555" },
        exportCatalog: async function* () {
          yield startedRecord;
          yield failed;
        },
      }),
    /SNAPSHOT_FAILED_PROVIDER_TIMEOUT/u,
  );
  assert.equal(events.at(-1), "reject:PROVIDER_TIMEOUT");
});

void test("residual observability measures production stream and COPY without leaking payloads", async (t) => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-test-module-mocks",
    "tests/catalog/observability-proof.mjs",
  ]);
  t.diagnostic(stdout.trim());
});

void test("import emits real OTel generation/validation spans and bounded metrics/diagnostics", async () => {
  const spans = [];
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startSpan: (name) => {
        const row = { name, ended: false };
        spans.push(row);
        return {
          end: () => {
            row.ended = true;
          },
          setStatus: () => {},
          spanContext: () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
            traceFlags: 1,
          }),
        };
      },
    }),
  });
  try {
    await runCatalogImport({
      store: importStore([]),
      supplierRef,
      snapshotRef,
      signal: new AbortController().signal,
      context: { correlationId: "11111111-1111-4111-8111-111111111111" },
      exportCatalog: async function* () {
        yield startedRecord;
        yield completedRecord;
      },
    });
    assert.ok(
      spans.some((span) => span.name === "catalog.import.generation"),
      "generation span missing",
    );
    assert.ok(
      spans.some((span) => span.name === "catalog.import.validation"),
      "validation span missing",
    );
    assert.ok(
      spans.every((span) => span.ended),
      "every span must end",
    );
    const { CatalogTelemetry } =
      await import("../../apps/catalog-supplier-sync/dist/telemetry/index.js");
    const diagnostics = [];
    let now = 0;
    const telemetry = new CatalogTelemetry(
      (value) => diagnostics.push(value),
      () => now,
    );
    await assert.rejects(() =>
      runCatalogImport({
        telemetry,
        store: importStore([]),
        supplierRef,
        snapshotRef,
        signal: new AbortController().signal,
        context: { correlationId: "11111111-1111-4111-8111-111111111111" },
        exportCatalog: async function* () {
          now = 500;
          await Promise.reject(
            new Error("secret raw-provider-id password=bad"),
          );
          yield startedRecord;
        },
      }),
    );
    telemetry.batch(17);
    now = 1500;
    const rendered = telemetry.render().join("\n");
    assert.match(rendered, /coffee_catalog_import_batches_total 1/u);
    assert.match(rendered, /coffee_catalog_import_batch_bytes_total 17/u);
    assert.match(rendered, /coffee_catalog_import_duration_seconds_sum 0.5/u);
    assert.match(rendered, /coffee_catalog_import_age_seconds 1.5/u);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].outcome, "failure");
    assert.doesNotMatch(
      rendered,
      /secret|raw-provider-id|password|snp_|sup_|correlationId|batchNumber/u,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /secret|raw-provider-id|password|sup_|authorization|payload|items/u,
    );
    assert.deepEqual(diagnostics[0], {
      event: "catalog_import",
      outcome: "failure",
      durationMs: 500,
      snapshotRef,
      correlationId: "11111111-1111-4111-8111-111111111111",
    });
  } finally {
    trace.disable();
  }
});
