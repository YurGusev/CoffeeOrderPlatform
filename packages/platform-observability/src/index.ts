import { randomUUID } from "node:crypto";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogScalar = string | number | boolean | null;
export type LogValue =
  LogScalar | readonly LogValue[] | { readonly [key: string]: LogValue };
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogRecord = Readonly<{
  level: LogLevel;
  message: string;
  fields: LogFields;
}>;
export type LogSink = (record: LogRecord) => void;

const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "password",
  "privateKey",
  "secret",
  "token",
] as const;

function isObject(
  value: LogValue,
): value is { readonly [key: string]: LogValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldRedact(key: string, sensitiveKeys: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return sensitiveKeys.some(
    (candidate) =>
      lower === candidate.toLowerCase() ||
      lower.includes(candidate.toLowerCase()),
  );
}

export function redactLogValue(
  value: LogValue,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): LogValue {
  if (Array.isArray(value))
    return value.map((entry) => redactLogValue(entry, sensitiveKeys));
  if (!isObject(value)) return value;
  const result: Record<string, LogValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = shouldRedact(key, sensitiveKeys)
      ? "[REDACTED]"
      : redactLogValue(entry, sensitiveKeys);
  }
  return result;
}

export function redactLogFields(
  fields: LogFields,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): LogFields {
  return redactLogValue(fields, sensitiveKeys) as LogFields;
}

export function createLogger(
  sink: LogSink,
  baseFields: LogFields = {},
): Logger {
  return new StructuredLogger(sink, baseFields);
}

export interface Logger {
  child(fields: LogFields): Logger;
  log(level: LogLevel, message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
}

class StructuredLogger implements Logger {
  private readonly sink: LogSink;
  private readonly baseFields: LogFields;

  public constructor(sink: LogSink, baseFields: LogFields) {
    this.sink = sink;
    this.baseFields = baseFields;
  }

  public child(fields: LogFields): Logger {
    return new StructuredLogger(this.sink, { ...this.baseFields, ...fields });
  }

  public log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.sink({
      level,
      message,
      fields: redactLogFields({ ...this.baseFields, ...fields }),
    });
  }

  public trace(message: string, fields?: LogFields): void {
    this.log("trace", message, fields);
  }
  public debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }
  public info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }
  public warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }
  public error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }
  public fatal(message: string, fields?: LogFields): void {
    this.log("fatal", message, fields);
  }
}

export type CorrelationContext = Readonly<{
  correlationId: string;
  traceparent?: string;
  causationId?: string;
}>;

export type HeaderValue = string | readonly string[] | undefined;
export type HeaderSource =
  | Readonly<Record<string, HeaderValue>>
  | Readonly<{ get(name: string): string | null }>;

const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACEPARENT_PATTERN =
  /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const CORRELATION_HEADER = "x-correlation-id";
const TRACEPARENT_HEADER = "traceparent";
const CAUSATION_HEADER = "x-causation-id";

function header(
  source: HeaderSource | undefined,
  name: string,
): string | undefined {
  if (source === undefined) return undefined;
  if ("get" in source && typeof source.get === "function")
    return source.get(name) ?? undefined;
  const value = Object.entries(source).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function isCorrelationId(value: string): boolean {
  return CORRELATION_ID_PATTERN.test(value);
}

export function isTraceparent(value: string): boolean {
  if (!TRACEPARENT_PATTERN.test(value)) return false;
  const [version, traceId, parentId] = value.split("-");
  return (
    version?.toLowerCase() !== "ff" &&
    traceId !== "0".repeat(32) &&
    parentId !== "0".repeat(16)
  );
}

/**
 * Resolve the transport context once at the process boundary. Invalid incoming
 * values are intentionally discarded instead of being propagated downstream.
 */
export function createCorrelationContext(
  source?: HeaderSource,
  fallbackCorrelationId?: string,
): CorrelationContext {
  const incomingCorrelationId = header(source, CORRELATION_HEADER);
  const correlationId =
    incomingCorrelationId !== undefined &&
    isCorrelationId(incomingCorrelationId)
      ? incomingCorrelationId
      : fallbackCorrelationId !== undefined &&
          isCorrelationId(fallbackCorrelationId)
        ? fallbackCorrelationId
        : randomUUID();
  const traceparent = header(source, TRACEPARENT_HEADER);
  const causationId = header(source, CAUSATION_HEADER);
  return {
    correlationId,
    ...(traceparent !== undefined && isTraceparent(traceparent)
      ? { traceparent }
      : {}),
    ...(causationId !== undefined &&
    causationId.length > 0 &&
    causationId.length <= 128
      ? { causationId }
      : {}),
  };
}

export function correlationHeaders(
  context: CorrelationContext,
): Readonly<Record<string, string>> {
  return {
    [CORRELATION_HEADER]: context.correlationId,
    ...(context.traceparent === undefined
      ? {}
      : { [TRACEPARENT_HEADER]: context.traceparent }),
  };
}

export function withCorrelationFields(context: CorrelationContext): LogFields {
  return {
    correlationId: context.correlationId,
    ...(context.traceparent === undefined
      ? {}
      : { traceparent: context.traceparent }),
    ...(context.causationId === undefined
      ? {}
      : { causationId: context.causationId }),
  };
}
