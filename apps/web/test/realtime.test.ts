import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  OrderCardResponse,
  SseResourceInvalidated,
} from "@coffee-platform/generated-client-v1";
import { test } from "vitest";
import { ProtocolError } from "../src/browser/api/client.js";
import { isFatalOrderCardReadError } from "../src/browser/api/order-card.js";
import {
  invalidateExistingOrderDetails,
  invalidateOrderHint,
  orderStreamSchemas,
  parseOrderStreamData,
} from "../src/realtime/order-invalidations.js";

const ref = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const otherRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const key = ["orders", "detail", ref] as const;
const hint: SseResourceInvalidated = {
  subjectType: "order",
  subjectRef: ref,
  ownerVersion: "5",
  reason: "OrderChanged",
  correlationId: "00000000-0000-4000-8000-000000000012",
};
function card(projectionVersion: string, version = "1"): OrderCardResponse {
  // Query tests only inspect versions; no fixture business projection is used by a UI.
  return { projectionVersion, version } as OrderCardResponse;
}

function resolveSchema(value: unknown, document: unknown, path: URL): unknown {
  if (Array.isArray(value))
    return value.map((item) => resolveSchema(item, document, path));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record["$ref"] === "string") {
    const [file = "", fragment = ""] = record["$ref"].split("#");
    const target = file ? new URL(file, path) : path;
    const root = file
      ? (JSON.parse(readFileSync(target, "utf8")) as unknown)
      : document;
    const selected = fragment
      .split("/")
      .filter(Boolean)
      .reduce<unknown>(
        (current, segment) => (current as Record<string, unknown>)[segment],
        root,
      );
    return resolveSchema(selected, root, target);
  }
  return Object.fromEntries(
    Object.entries(record).map(([name, child]) => [
      name,
      resolveSchema(child, document, path),
    ]),
  );
}

test("browser SSE runtime schemas are exact public client-v1 component schemas (drift gate)", () => {
  const path = new URL(
    "../../../contracts/openapi/client-v1.yaml",
    import.meta.url,
  );
  const document = load(readFileSync(path, "utf8")) as {
    components: { schemas: Record<string, unknown> };
  };
  for (const [event, component] of [
    ["resource-invalidated.v1", "SseResourceInvalidated"],
    ["stream-ready.v1", "SseStreamReady"],
    ["stream-reset.v1", "SseStreamReset"],
  ] as const) {
    assert.deepEqual(
      orderStreamSchemas[event],
      resolveSchema(document.components.schemas[component], document, path),
    );
  }
});

test("strict runtime validation rejects malformed hints and any business/additional field", () => {
  assert.deepEqual(
    parseOrderStreamData("resource-invalidated.v1", JSON.stringify(hint)),
    hint,
  );
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...hint, ownerVersion: 5 },
    { ...hint, ownerVersion: "05" },
    { ...hint, ownerVersion: "-1" },
    { ...hint, subjectRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    { ...hint, subjectType: "customer" },
    { ...hint, reason: "InSync" },
    { ...hint, correlationId: "bad" },
  ];
  for (const field of [
    "items",
    "customer",
    "totalMinor",
    "desired",
    "observed",
    "blockers",
    "allowedActions",
  ])
    invalid.push({ ...hint, [field]: [] });
  for (const value of invalid)
    assert.equal(
      parseOrderStreamData("resource-invalidated.v1", JSON.stringify(value)),
      undefined,
    );
  assert.equal(parseOrderStreamData("resource-invalidated.v1", "{"), undefined);
  assert.equal(
    parseOrderStreamData("resource-invalidated.v1", "x".repeat(2049)),
    undefined,
  );
  const ready = {
    connectionId: hint.correlationId,
    connectedAt: "2026-10-07T12:00:00Z",
  };
  assert.deepEqual(
    parseOrderStreamData("stream-ready.v1", JSON.stringify(ready)),
    ready,
  );
  assert.equal(
    parseOrderStreamData(
      "stream-ready.v1",
      JSON.stringify({ ...ready, connectedAt: "2026-02-30T00:00:00Z" }),
    ),
    undefined,
  );
  assert.equal(
    parseOrderStreamData(
      "stream-ready.v1",
      JSON.stringify({ ...ready, actorRef: "operator" }),
    ),
    undefined,
  );
  assert.deepEqual(
    parseOrderStreamData("stream-reset.v1", '{"reason":"REPLAY_UNAVAILABLE"}'),
    { reason: "REPLAY_UNAVAILABLE" },
  );
  assert.equal(
    parseOrderStreamData("stream-reset.v1", '{"reason":"OTHER"}'),
    undefined,
  );
});

test("hints invalidate exact existing Order detail, refetch active only, and never create a query or patch owner data", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let reads = 0;
  client.setQueryData(key, card("4", "999"));
  client.setQueryData([...key, "items"], "nested");
  client.setQueryData(["orders", "detail", otherRef], card("1"));
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      reads += 1;
      return card("5", "999");
    },
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await invalidateOrderHint(client, hint, () => true);
    assert.equal(reads, 1, "uses projectionVersion=4, never Order.version=999");
    assert.equal(client.getQueryState([...key, "items"])?.isInvalidated, false);
    assert.equal(
      client.getQueryState(["orders", "detail", otherRef])?.isInvalidated,
      false,
    );
    await invalidateOrderHint(client, hint, () => true);
    await invalidateOrderHint(
      client,
      { ...hint, ownerVersion: "3" },
      () => true,
    );
    assert.equal(reads, 1);
    const count = client.getQueryCache().getAll().length;
    await invalidateOrderHint(
      client,
      { ...hint, subjectRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAX" },
      () => true,
    );
    assert.equal(client.getQueryCache().getAll().length, count);
    await invalidateOrderHint(
      client,
      { ...hint, subjectRef: otherRef },
      () => true,
    );
    assert.equal(
      client.getQueryState(["orders", "detail", otherRef])?.isInvalidated,
      true,
    );
    assert.deepEqual(
      client.getQueryData(["orders", "detail", otherRef]),
      card("1"),
    );
    await invalidateOrderHint(
      client,
      { ...hint, ownerVersion: "999" },
      () => false,
    );
    assert.equal(reads, 1);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("ready/reset/manual invalidate only existing exact detail shape, not Customer/Catalog/Pricing or prefix neighbors", async () => {
  const client = new QueryClient();
  const untouched = [
    ["customers", "search", "name"],
    ["catalog", "search", "coffee"],
    ["pricing", "quote", "quote"],
    ["orders"],
    ["orders", "detail"],
    [...key, "items"],
  ];
  client.setQueryData(key, card("1"));
  for (const queryKey of untouched) client.setQueryData(queryKey, "private");
  try {
    await invalidateExistingOrderDetails(client, () => true);
    assert.equal(client.getQueryState(key)?.isInvalidated, true);
    for (const queryKey of untouched)
      assert.equal(client.getQueryState(queryKey)?.isInvalidated, false);
  } finally {
    client.clear();
  }
});

test("BigInt projection dedup preserves decimal values beyond safe Number range", async () => {
  const client = new QueryClient();
  client.setQueryData(key, card("9007199254740992"));
  try {
    await invalidateOrderHint(
      client,
      { ...hint, ownerVersion: "9007199254740993" },
      () => true,
    );
    assert.equal(client.getQueryState(key)?.isInvalidated, true);
  } finally {
    client.clear();
  }
});

test("ready during initial GET forces one subsequent active owner read", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let reads = 0,
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      const first = ++reads === 1;
      if (first) await gate;
      return card(first ? "1" : "2");
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const invalidation = invalidateExistingOrderDetails(client, () => true);
    assert.equal(reads, 1);
    release();
    await invalidation;
    assert.equal(reads, 2);
    assert.equal(
      client.getQueryData<OrderCardResponse>(key)?.projectionVersion,
      "2",
    );
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("session switch cannot launch the deferred first-ready refetch into a new session", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let current = true,
    reads = 0,
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      reads += 1;
      await gate;
      return card("1");
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const invalidation = invalidateExistingOrderDetails(client, () => current);
    current = false;
    unsubscribe();
    client.clear();
    client.setQueryData(key, card("8"));
    release();
    await invalidation;
    assert.equal(reads, 1);
    assert.equal(
      client.getQueryData<OrderCardResponse>(key)?.projectionVersion,
      "8",
    );
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("protocol owner-read failure is a fatal privacy barrier, not offline business data", () => {
  assert.equal(
    isFatalOrderCardReadError(new ProtocolError("invalid owner payload")),
    true,
  );
});
