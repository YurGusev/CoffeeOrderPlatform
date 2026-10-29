import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRealtimeEnvelope,
  RealtimeHub,
  eventData,
  invalidationFrame,
} from "../../apps/realtime-gateway/dist/index.js";
import { config, fixture, record, envelope } from "./helpers.mjs";
import { processKafkaRecord } from "../../packages/platform-kafka-runtime/dist/index.js";
async function ingest(hub, r, quarantine = async () => {}) {
  const seen = [];
  await processKafkaRecord(r, {
    runtime: "realtime-gateway",
    groupId: "realtime-gateway-v1",
    topics: ["coffee.realtime.invalidate.v1"],
    leaseMs: 30000,
    maxMessageBytes: 1048576,
    signal: new AbortController().signal,
    binding: hub.binding,
    quarantine: async (...args) => {
      seen.push("quarantine");
      await quarantine(...args);
    },
    commit: async () => {
      seen.push("offset");
    },
  });
  return seen;
}
void test("strict canonical realtime decoder uses the actual Kafka key before ring/fanout", async () => {
  assert.deepEqual(
    decodeRealtimeEnvelope(fixture, record(), config.maxEventDataBytes),
    fixture,
  );
  for (const key of [
    null,
    " " + fixture.payload.subjectRef,
    fixture.payload.subjectRef + " ",
    "ord_00000000000000000000000000",
  ]) {
    const hub = new RealtimeHub(config);
    assert.deepEqual(await ingest(hub, record(fixture, key)), [
      "quarantine",
      "offset",
    ]);
    assert.equal(hub.stats().ringRecords, 0);
    await hub.shutdown();
  }
});
void test("canonical envelope/payload identifiers, metadata, UTC, int64, and additional properties fail closed", () => {
  const mutations = [
    (e) => {
      e.payload.subjectRef = "ord_bad";
      e.aggregate.ref = "ord_bad";
    },
    (e) => {
      e.messageId = "msg_bad";
    },
    (e) => {
      e.correlationId = "not-uuid";
    },
    (e) => {
      e.causationId = "bad";
    },
    (e) => {
      e.traceparent = "00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01";
    },
    (e) => {
      e.envelopeVersion = "2";
    },
    (e) => {
      e.messageType = "OrderChanged.v1";
    },
    (e) => {
      e.producer = "catalog-service";
    },
    (e) => {
      e.aggregate.type = "OrderCard";
    },
    (e) => {
      e.aggregate.ref = "ord_00000000000000000000000000";
    },
    (e) => {
      e.aggregate.version = "18";
    },
    (e) => {
      e.payload.reason = "AnythingElse";
    },
    (e) => {
      e.payload.subjectType = "customer";
    },
    (e) => {
      e.payload.ownerVersion = "019";
      e.aggregate.version = "019";
    },
    (e) => {
      e.payload.ownerVersion = "9223372036854775808";
      e.aggregate.version = e.payload.ownerVersion;
    },
    (e) => {
      e.payload.ownerVersion = "1".repeat(20000);
      e.aggregate.version = e.payload.ownerVersion;
    },
    (e) => {
      e.occurredAt = "2026-02-30T10:06:00Z";
    },
    (e) => {
      e.occurredAt = "2026-09-05T10:06:00+00:00";
    },
    (e) => {
      e.email = "pii";
    },
    (e) => {
      e.payload.email = "pii";
    },
    (e) => {
      e.aggregate.extra = true;
    },
    (e) => {
      delete e.causationId;
    },
  ];
  for (const mutate of mutations) {
    const e = structuredClone(fixture);
    mutate(e);
    assert.throws(() => decodeRealtimeEnvelope(e, record(e), 2048), {
      code: "KAFKA_ENVELOPE_INVALID",
    });
  }
  for (const producer of ["orders-service", "orders-aroma-preparation"]) {
    const e = { ...fixture, producer };
    assert.equal(decodeRealtimeEnvelope(e, record(e), 2048).producer, producer);
  }
});
void test("event data UTF8 byte limit includes metadata and exact serialized frame does not expose owner state", () => {
  const data = JSON.stringify(eventData(fixture));
  const bytes = Buffer.byteLength(data, "utf8");
  assert.equal(
    decodeRealtimeEnvelope(fixture, record(), bytes).messageId,
    fixture.messageId,
  );
  assert.throws(() => decodeRealtimeEnvelope(fixture, record(), bytes - 1), {
    code: "KAFKA_ENVELOPE_INVALID",
  });
  assert.equal(
    invalidationFrame(fixture),
    `id: ${fixture.messageId}\nevent: resource-invalidated.v1\nretry: 3000\ndata: ${data}\n\n`,
  );
  assert.deepEqual(Object.keys(eventData(fixture)), [
    "subjectType",
    "subjectRef",
    "ownerVersion",
    "reason",
    "correlationId",
  ]);
  assert.doesNotMatch(
    data,
    /customer|items|money|Desired|Observed|blockers|actions|token|email/i,
  );
});
void test("malformed JSON/fatal UTF8/oversize and conflicting Kafka headers quarantine before offset", async () => {
  for (const change of [
    { value: "broken JSON" },
    { value: Uint8Array.of(0xc3, 0x28) },
    { value: "a".repeat(1048577) },
    { headers: { messageId: "different" } },
    { headers: { correlationId: null } },
    { headers: { traceparent: "different" } },
  ]) {
    const hub = new RealtimeHub(config);
    assert.deepEqual(await ingest(hub, { ...record(), ...change }), [
      "quarantine",
      "offset",
    ]);
    assert.equal(hub.stats().ringRecords, 0);
    await hub.shutdown();
  }
});
void test("retained IDs and subject versions ignore duplicates/stale, quarantine equal conflicts without state mutation", async () => {
  const hub = new RealtimeHub(config);
  const e = envelope(1, "9223372036854775807");
  assert.deepEqual(await ingest(hub, record(e)), ["offset"]);
  assert.deepEqual(await ingest(hub, record(e)), ["offset"]);
  const samePayload = envelope(2, "9223372036854775807");
  samePayload.correlationId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(await ingest(hub, record(samePayload)), ["offset"]);
  assert.deepEqual(
    await ingest(hub, record(envelope(2, "9223372036854775806"))),
    ["offset"],
  );
  assert.deepEqual(
    await ingest(hub, record(envelope(3, "9223372036854775807"))),
    ["offset"],
  );
  const conflict = envelope(4, "9223372036854775807");
  conflict.payload.reason = "OrderChanged";
  assert.deepEqual(await ingest(hub, record(conflict)), [
    "quarantine",
    "offset",
  ]);
  const idConflict = structuredClone(e);
  idConflict.correlationId = "00000000-0000-4000-8000-000000000002";
  assert.deepEqual(await ingest(hub, record(idConflict)), [
    "quarantine",
    "offset",
  ]);
  assert.equal(hub.stats().ringRecords, 1);
  assert.equal(hub.stats().dedupEntries, 1);
  assert.equal(hub.stats().versionEntries, 1);
  await hub.shutdown();
});
