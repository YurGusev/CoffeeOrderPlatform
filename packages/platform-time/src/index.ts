import {Temporal} from "@js-temporal/polyfill";

export type InstantInput = Temporal.Instant | string;
export type DurationInput = Temporal.Duration | string;
export type DstDisambiguation = "compatible" | "earlier" | "later" | "reject";

function requireTimeOnly(duration: Temporal.Duration): Temporal.Duration {
  if (duration.years !== 0 || duration.months !== 0 || duration.weeks !== 0 || duration.days !== 0) {
    throw new RangeError("deadline durations must use time units only");
  }
  return duration;
}

export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

export function toInstant(input: InstantInput): Temporal.Instant {
  return Temporal.Instant.from(input);
}

export function toDuration(input: DurationInput): Temporal.Duration {
  return requireTimeOnly(Temporal.Duration.from(input));
}

export function deadlineAt(start: InstantInput, duration: DurationInput): Temporal.Instant {
  return toInstant(start).add(toDuration(duration));
}

export function deadlineFromNow(duration: DurationInput, start: Temporal.Instant = nowInstant()): Temporal.Instant {
  return deadlineAt(start, duration);
}

export function isExpired(expiresAt: InstantInput, at: InstantInput = nowInstant()): boolean {
  return Temporal.Instant.compare(toInstant(at), toInstant(expiresAt)) >= 0;
}

export function remainingUntil(expiresAt: InstantInput, at: InstantInput = nowInstant()): Temporal.Duration {
  const expiry = toInstant(expiresAt);
  const current = toInstant(at);
  if (Temporal.Instant.compare(current, expiry) >= 0) return Temporal.Duration.from({nanoseconds: 0});
  return expiry.since(current);
}

export function resolveBusinessDateTime(
  localDateTime: string,
  timeZone: string,
  disambiguation: DstDisambiguation = "reject",
): Temporal.ZonedDateTime {
  const plainDateTime = Temporal.PlainDateTime.from(localDateTime);
  return plainDateTime.toZonedDateTime(timeZone, {disambiguation});
}

export function businessDateTimeToInstant(value: Temporal.ZonedDateTime): Temporal.Instant {
  return value.toInstant();
}

export function durationMilliseconds(duration: DurationInput): number {
  return toDuration(duration).total({unit: "milliseconds"});
}
