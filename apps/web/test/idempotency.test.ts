import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import type { ProblemDetails } from "@coffee-platform/generated-client-v1";
import { isTerminalCommandProblem, isTerminalProblemForCommand } from "../src/browser/api/client.js";
import {
  beginIntent,
  browserFingerprint,
  clearPendingIntents,
  markIntentAmbiguous,
  readPendingIntents,
} from "../src/browser/api/idempotency.js";

const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemOne = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemTwo = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const prefix = "coffee-platform:intent:v1:";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number { return this.#values.size; }

  clear(): void { this.#values.clear(); }

  getItem(key: string): string | null { return this.#values.get(key) ?? null; }

  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }

  removeItem(key: string): void { this.#values.delete(key); }

  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

let sessionStorage: MemoryStorage;

beforeEach(() => {
  sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      sessionStorage,
    },
  });
});

test("classifies terminal command outcomes by protocol code instead of HTTP class", () => {
  const problem = (code: string, status: number): ProblemDetails => ({
    code,
    correlationId: "00000000-0000-4000-8000-000000000099",
    detail: code,
    errors: [],
    instance: "/api/client-v1/orders/drafts",
    status,
    title: code,
    type: "about:blank",
  });
  assert.equal(isTerminalCommandProblem(problem("VALIDATION_FAILED", 400)), true);
  assert.equal(isTerminalCommandProblem(problem("ORDER_VERSION_CONFLICT", 409)), true);
  assert.equal(isTerminalCommandProblem(problem("IDEMPOTENCY_CONFLICT", 409)), false);
  assert.equal(isTerminalCommandProblem(problem("IDEMPOTENCY_REQUEST_IN_PROGRESS", 409)), false);
  assert.equal(isTerminalCommandProblem(problem("AUTHENTICATION_REQUIRED", 401)), false);
  assert.equal(isTerminalCommandProblem(problem("CATALOG_UNAVAILABLE", 503)), false);
  assert.equal(isTerminalCommandProblem(problem("UNKNOWN_COMMAND_ERROR", 400)), false);
  assert.equal(isTerminalProblemForCommand("create-draft", problem("ORDER_VERSION_CONFLICT", 409)), false);
  assert.equal(isTerminalProblemForCommand("put-item", problem("ORDER_VERSION_CONFLICT", 409)), true);
  assert.equal(isTerminalProblemForCommand("put-item", problem("ORDER_VERSION_CONFLICT", 422)), false);
  assert.equal(isTerminalProblemForCommand("create-draft", problem("VALIDATION_FAILED", 400)), true);
  assert.equal(isTerminalProblemForCommand("create-draft", problem("VALIDATION_FAILED", 422)), false);
});

test("fingerprint канонизирует порядок ключей JSON object", async () => {
  const left = await browserFingerprint({ quantity: "2", product: { b: 2, a: 1 } });
  const right = await browserFingerprint({ product: { a: 1, b: 2 }, quantity: "2" });
  assert.equal(left, right);
});

test("unresolved order command блокирует другую команду того же заказа", async () => {
  const first = await beginIntent({
    actorRef: "operator-1",
    body: { quantity: "2" },
    kind: "put-item",
    method: "PUT",
    path: `/api/client-v1/orders/${orderRef}/items/${itemOne}`,
  });
  const second = await beginIntent({
    actorRef: "operator-1",
    body: { expectedVersion: "2" },
    kind: "delete-item",
    method: "DELETE",
    path: `/api/client-v1/orders/${orderRef}/items/${itemTwo}`,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.intent.key, first.intent.key);
  assert.equal(readPendingIntents().items.length, 1);
});

test("late response не восстанавливает intent после session cleanup", async () => {
  const begun = await beginIntent({
    actorRef: "operator-1",
    body: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    kind: "create-draft",
    method: "POST",
    path: "/api/client-v1/orders/drafts",
  });
  clearPendingIntents();
  markIntentAmbiguous(begun.intent);
  assert.equal(readPendingIntents().items.length, 0);
});

test("kind, method и path должны образовывать разрешённую команду", async () => {
  await assert.rejects(beginIntent({
    actorRef: "operator-1",
    body: null,
    kind: "confirm-order",
    method: "DELETE",
    path: `/api/client-v1/orders/${orderRef}/commands/confirm`,
  }), /allowlist/u);
  assert.equal(sessionStorage.length, 0);
});

test("повреждённая или переименованная metadata блокирует новую команду", async () => {
  const storageKey = "123e4567-e89b-42d3-a456-426614174000";
  sessionStorage.setItem(`${prefix}${storageKey}`, JSON.stringify({
    actorRef: "operator-1",
    createdAt: "2026-09-29T00:00:00Z",
    fingerprint: "a".repeat(64),
    key: "223e4567-e89b-42d3-a456-426614174000",
    kind: "create-draft",
    method: "POST",
    path: "/api/client-v1/orders/drafts",
    state: "ambiguous",
    version: 1,
  }));
  assert.equal(readPendingIntents().corrupt, true);
  await assert.rejects(beginIntent({
    actorRef: "operator-1",
    body: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    kind: "create-draft",
    method: "POST",
    path: "/api/client-v1/orders/drafts",
  }), /Повреждённые данные/u);
});
