export type TestClock = Readonly<{
  nowMs(): number;
  setMs(value: number): void;
  advanceMs(value: number): void;
}>;

export function createTestClock(initialMs: number): TestClock {
  if (!Number.isSafeInteger(initialMs) || initialMs < 0) throw new RangeError("initialMs должен быть неотрицательным целым числом");
  let current = initialMs;
  return {
    nowMs: () => current,
    setMs: (value: number): void => {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("clock value должен быть неотрицательным целым числом");
      current = value;
    },
    advanceMs: (value: number): void => {
      if (!Number.isSafeInteger(value) || value < 0 || current + value > Number.MAX_SAFE_INTEGER) throw new RangeError("clock advance некорректен");
      current += value;
    },
  };
}
