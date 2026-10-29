export type HourlySchedulerOptions = Readonly<{
  intervalMs?: number;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onSkippedTick?: () => void;
  onRunError?: (error: unknown) => void;
}>;

export type HourlyScheduler = Readonly<{
  start: (run: () => Promise<void>, signal: AbortSignal) => Promise<void>;
}>;

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    }
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function createHourlyScheduler(
  options: HourlySchedulerOptions = {},
): HourlyScheduler {
  const intervalMs = options.intervalMs ?? 3_600_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    throw new RangeError("intervalMs must be positive");
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? defaultWait;
  return Object.freeze({
    async start(run: () => Promise<void>, signal: AbortSignal): Promise<void> {
      let next = now();
      while (!signal.aborted) {
        const current = now();
        if (current >= next) {
          next = current + intervalMs;
          try {
            await run();
          } catch (error) {
            if (signal.aborted) break;
            options.onRunError?.(error);
          }
          const after = now();
          if (after >= next) {
            const missed = Math.floor((after - next) / intervalMs) + 1;
            for (let index = 0; index < missed; index += 1)
              options.onSkippedTick?.();
            next += missed * intervalMs;
          }
        }
        if (signal.aborted) break;
        try {
          await wait(Math.max(1, next - now()), signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    },
  });
}
