/**
 * The shape of a finished span as this package handles it, whatever made it:
 * its own tracer (tracer.ts) or an OpenTelemetry SDK that has a
 * `SigilloSpanExporter` attached.
 */
export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue | undefined>;

export interface SpanEventData {
  name: string;
  attributes: Attributes;
  timeUnixNano: bigint;
}

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startUnixNano: bigint;
  endUnixNano: bigint;
  /** OpenTelemetry's status code: 0 unset, 1 ok, 2 error. */
  statusCode: 0 | 1 | 2;
  attributes: Attributes;
  events: SpanEventData[];
  /** Resource attributes of whoever made the span (service.name, ...). */
  resource: Attributes;
}

/** An OpenTelemetry `HrTime` ([seconds, nanoseconds]) or a number of milliseconds, as nanoseconds. */
export function toUnixNano(time: unknown, fallback: bigint): bigint {
  if (Array.isArray(time) && typeof time[0] === "number" && typeof time[1] === "number") {
    return BigInt(Math.trunc(time[0])) * 1_000_000_000n + BigInt(Math.trunc(time[1]));
  }
  if (typeof time === "number" && Number.isFinite(time)) return BigInt(Math.round(time * 1_000_000));
  if (time instanceof Date) return BigInt(time.getTime()) * 1_000_000n;
  return fallback;
}

export function nowUnixNano(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}
