import assert from "node:assert/strict";
import type { ProblemDetails } from "@coffee-platform/generated-client-v1";
import {
  MutationObserver,
  onlineManager,
  QueryObserver,
} from "@tanstack/react-query";
import { test, vi } from "vitest";
import { ApiError, ProtocolError } from "../src/browser/api/client.js";
import {
  queryClient,
  safeQueryRetry,
} from "../src/browser/app/query-client.js";

function problem(status: number): ProblemDetails {
  return {
    code: `HTTP_${status}`,
    correlationId: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    detail: `HTTP ${status}`,
    instance: "/api/client-v1/customers",
    status,
    title: "Тестовая ошибка",
    type: "about:blank",
  };
}

test("safe GET retry допускает один повтор только для network/502/503/504", () => {
  assert.equal(safeQueryRetry(0, new TypeError("Failed to fetch")), true);
  assert.equal(
    safeQueryRetry(0, new ApiError(problem(502), false, false)),
    true,
  );
  assert.equal(
    safeQueryRetry(0, new ApiError(problem(503), false, false)),
    true,
  );
  assert.equal(
    safeQueryRetry(0, new ApiError(problem(504), false, false)),
    true,
  );
  assert.equal(
    safeQueryRetry(0, new ApiError(problem(500), false, false)),
    false,
  );
  assert.equal(
    safeQueryRetry(0, new ApiError(problem(409), false, true)),
    false,
  );
  assert.equal(
    safeQueryRetry(0, new ProtocolError("malformed response")),
    false,
  );
  assert.equal(safeQueryRetry(1, new TypeError("Failed to fetch")), false);
});

test("общая query policy не повторяет mutations и хранит cache пять минут", () => {
  const defaults = queryClient.getDefaultOptions();
  assert.equal(defaults.mutations?.networkMode, "always");
  assert.equal(defaults.mutations?.retry, false);
  assert.equal(defaults.queries?.gcTime, 300_000);
  assert.equal(defaults.queries?.refetchOnWindowFocus, false);
  assert.equal(defaults.queries?.retryDelay, 500);
  assert.equal(defaults.queries?.staleTime, 0);
});

test("offline mutation завершается немедленно и не ставится в очередь до reconnect", async () => {
  let effects = 0;
  const observer = new MutationObserver(queryClient, {
    mutationFn: async () => {
      effects += 1;
      throw new TypeError("offline");
    },
  });
  onlineManager.setOnline(false);
  try {
    await assert.rejects(observer.mutate(), /offline/u);
    assert.equal(effects, 1);
    assert.equal(observer.getCurrentResult().isPaused, false);
  } finally {
    onlineManager.setOnline(true);
    observer.reset();
  }
});

test("два query observer с одинаковым key делят один in-flight запрос", async () => {
  const queryKey = ["query-sharing-test"] as const;
  queryClient.removeQueries({ queryKey });
  let calls = 0;
  let release: ((value: string) => void) | undefined;
  const queryFn = async (): Promise<string> => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = new QueryObserver(queryClient, { queryFn, queryKey });
  const second = new QueryObserver(queryClient, { queryFn, queryKey });
  const unsubscribeFirst = first.subscribe(() => undefined);
  const unsubscribeSecond = second.subscribe(() => undefined);
  try {
    await Promise.resolve();
    assert.equal(calls, 1);
    release?.("shared");
    await vi.waitFor(() => {
      assert.equal(first.getCurrentResult().data, "shared");
      assert.equal(second.getCurrentResult().data, "shared");
    });
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
    queryClient.removeQueries({ queryKey });
  }
});

test("safe GET retry ждёт ровно 500ms перед единственным повтором", async () => {
  const queryKey = ["retry-delay-test"] as const;
  queryClient.removeQueries({ queryKey });
  vi.useFakeTimers();
  let calls = 0;
  const observer = new QueryObserver(queryClient, {
    queryFn: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("temporary network failure");
      return "ok";
    },
    queryKey,
  });
  try {
    const result = observer.refetch();
    await Promise.resolve();
    assert.equal(calls, 1);
    await vi.advanceTimersByTimeAsync(499);
    assert.equal(calls, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal((await result).data, "ok");
    assert.equal(calls, 2);
  } finally {
    vi.useRealTimers();
    queryClient.removeQueries({ queryKey });
  }
});
