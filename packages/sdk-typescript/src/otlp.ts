import type { AttributeValue, Attributes, FinishedSpan } from "./span.js";

/** A finished span as OTLP/JSON, which the server reads next to protobuf (apps/server/src/ingest/otlp.ts). */

interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: AnyValue[] };
}

function anyValue(value: AttributeValue | string | number | boolean): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: (value as Array<string | number | boolean>).map(anyValue) } };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function keyValues(attributes: Attributes): Array<{ key: string; value: AnyValue }> {
  const list: Array<{ key: string; value: AnyValue }> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) list.push({ key, value: anyValue(value) });
  }
  return list;
}

export function toOtlpJson(spans: FinishedSpan[]): object {
  const byResource = new Map<string, FinishedSpan[]>();
  for (const span of spans) {
    const key = JSON.stringify(span.resource);
    const group = byResource.get(key);
    if (group === undefined) byResource.set(key, [span]);
    else group.push(span);
  }
  return {
    resourceSpans: [...byResource.values()].map((group) => ({
      resource: { attributes: keyValues(group[0]?.resource ?? {}) },
      scopeSpans: [
        {
          scope: { name: "@sigillo/sdk" },
          spans: group.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
            name: span.name,
            kind: 1,
            startTimeUnixNano: span.startUnixNano.toString(),
            endTimeUnixNano: span.endUnixNano.toString(),
            attributes: keyValues(span.attributes),
            events: span.events.map((event) => ({
              name: event.name,
              timeUnixNano: event.timeUnixNano.toString(),
              attributes: keyValues(event.attributes),
            })),
            // No description: OpenTelemetry's can quote an exception message.
            status: { code: span.statusCode },
          })),
        },
      ],
    })),
  };
}
