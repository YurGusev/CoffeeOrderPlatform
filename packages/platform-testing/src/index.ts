import { strict as assert } from "node:assert";

export type TestClock = Readonly<{
  nowMs(): number;
  setMs(value: number): void;
  advanceMs(value: number): void;
}>;

export function createTestClock(initialMs: number): TestClock {
  if (!Number.isSafeInteger(initialMs) || initialMs < 0)
    throw new RangeError("initialMs должен быть неотрицательным целым числом");
  let current = initialMs;
  return {
    nowMs: () => current,
    setMs: (value: number): void => {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(
          "clock value должен быть неотрицательным целым числом",
        );
      current = value;
    },
    advanceMs: (value: number): void => {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        current + value > Number.MAX_SAFE_INTEGER
      )
        throw new RangeError("clock advance некорректен");
      current += value;
    },
  };
}

export type Deferred<Result> = Readonly<{
  promise: Promise<Result>;
  resolve(value: Result): void;
  reject(reason?: unknown): void;
}>;

export function createDeferred<Result>(): Deferred<Result> {
  let resolvePromise: ((value: Result) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<Result>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: Result): void => {
      resolvePromise?.(value);
    },
    reject: (reason?: unknown): void => {
      rejectPromise?.(reason);
    },
  };
}

export async function assertEventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs <= 0
  )
    throw new RangeError("окно assertEventually некорректно");
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`условие не выполнено за ${timeoutMs}ms`);
}

export async function assertRejectsCode(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === expectedCode
    )
      return;
    throw error;
  }
  assert.fail(`ожидалась ошибка с code=${expectedCode}`);
}
