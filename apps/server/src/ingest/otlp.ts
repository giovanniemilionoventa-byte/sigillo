import { join } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

/**
 * Decodes an OTLP/HTTP trace export into a flat list of spans.
 *
 * Both encodings are accepted, because both are sent in practice: the official
 * Python exporter speaks protobuf only, while browser and Node exporters speak
 * JSON. The two are normalised into one shape here so that nothing downstream
 * has to know which arrived.
 *
 * Attribute names come from outside, so they are kept in a Map: an attribute
 * called `__proto__` is then just an entry, not a way into an object prototype.
 */

export type AttributeValue = string | number | boolean | null | AttributeValue[];

export interface OtlpSpanEvent {
  name: string;
  attributes: Map<string, AttributeValue>;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  startUnixNano: bigint;
  endUnixNano: bigint;
  status: "unset" | "ok" | "error";
  attributes: Map<string, AttributeValue>;
  resource: Map<string, AttributeValue>;
  events: OtlpSpanEvent[];
}

export class OtlpDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpDecodeError";
  }
}

const PROTO_DIRECTORY = fileURLToPath(new URL("../../proto/", import.meta.url));
const ENTRY_PROTO = "opentelemetry/proto/collector/trace/v1/trace_service.proto";
const REQUEST_TYPE = "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest";

let requestType: protobuf.Type | undefined;

/** Loads the vendored protocol definitions once, on first use. */
function exportRequestType(): protobuf.Type {
  if (requestType === undefined) {
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => join(PROTO_DIRECTORY, target);
    root.loadSync(ENTRY_PROTO);
    requestType = root.lookupType(REQUEST_TYPE);
  }
  return requestType;
}

export function decodeProtobufTraces(body: Uint8Array): OtlpSpan[] {
  let decoded: unknown;
  try {
    const type = exportRequestType();
    decoded = type.toObject(type.decode(body), {
      longs: String,
      enums: String,
      bytes: String,
      defaults: false,
    });
  } catch (error) {
    throw new OtlpDecodeError(
      `not a valid OTLP protobuf trace export: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalizeExportRequest(decoded);
}

export function decodeJsonTraces(body: unknown): OtlpSpan[] {
  return normalizeExportRequest(body);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** OTLP/JSON allows both the proto field name and its camel-case spelling. */
function field(source: Record<string, unknown>, camel: string, snake: string): unknown {
  return source[camel] ?? source[snake];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const HEX = /^[0-9a-fA-F]+$/;

/**
 * Identifiers arrive as hex in OTLP/JSON and as base64 from the proto3 JSON
 * mapping and from protobufjs. Both are accepted; the length tells them apart,
 * since base64 of n bytes is never 2n characters for these sizes.
 */
function decodeId(value: unknown, bytes: number, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OtlpDecodeError(`span is missing its ${what}`);
  }
  if (value.length === bytes * 2 && HEX.test(value)) {
    return value.toLowerCase();
  }
  const raw = Buffer.from(value, "base64");
  if (raw.length !== bytes) {
    throw new OtlpDecodeError(`${what} is ${raw.length} bytes, expected ${bytes}`);
  }
  return raw.toString("hex");
}

function decodeAnyValue(value: unknown): AttributeValue {
  const source = asRecord(value);
  if (source === null) return null;

  const string = field(source, "stringValue", "string_value");
  if (typeof string === "string") return string;

  const boolean = field(source, "boolValue", "bool_value");
  if (typeof boolean === "boolean") return boolean;

  const integer = field(source, "intValue", "int_value");
  if (typeof integer === "string" || typeof integer === "number") {
    const parsed = Number(integer);
    return Number.isSafeInteger(parsed) ? parsed : String(integer);
  }

  const double = field(source, "doubleValue", "double_value");
  if (typeof double === "number") return double;

  const bytes = field(source, "bytesValue", "bytes_value");
  if (typeof bytes === "string") return bytes;

  const array = asRecord(field(source, "arrayValue", "array_value"));
  if (array !== null) {
    return asArray(array["values"]).map(decodeAnyValue);
  }

  const kvlist = asRecord(field(source, "kvlistValue", "kvlist_value"));
  if (kvlist !== null) {
    // Never interpreted, only recorded: kept as text rather than as an object,
    // so a key like __proto__ cannot reach an object prototype.
    return JSON.stringify(
      asArray(kvlist["values"]).map((entry) => {
        const pair = asRecord(entry);
        return [String(pair?.["key"] ?? ""), decodeAnyValue(pair?.["value"])];
      }),
    );
  }

  return null;
}

function decodeEvents(value: unknown): OtlpSpanEvent[] {
  const events: OtlpSpanEvent[] = [];
  for (const entry of asArray(value)) {
    const event = asRecord(entry);
    if (event === null) continue;
    const name = event["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    events.push({ name, attributes: decodeAttributes(event["attributes"]) });
  }
  return events;
}

function decodeAttributes(value: unknown): Map<string, AttributeValue> {
  const attributes = new Map<string, AttributeValue>();
  for (const entry of asArray(value)) {
    const pair = asRecord(entry);
    const key = pair?.["key"];
    if (typeof key === "string" && key.length > 0) {
      attributes.set(key, decodeAnyValue(pair?.["value"]));
    }
  }
  return attributes;
}

function decodeUnixNano(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new OtlpDecodeError(`span has no usable ${what}`);
}

function decodeStatus(value: unknown): "unset" | "ok" | "error" {
  const status = asRecord(value);
  if (status === null) return "unset";
  const code = status["code"];
  if (code === "STATUS_CODE_OK" || code === 1) return "ok";
  if (code === "STATUS_CODE_ERROR" || code === 2) return "error";
  return "unset";
}

function normalizeExportRequest(value: unknown): OtlpSpan[] {
  const request = asRecord(value);
  if (request === null) {
    throw new OtlpDecodeError("an OTLP trace export must be an object");
  }

  const resourceSpans = field(request, "resourceSpans", "resource_spans");
  if (resourceSpans === undefined) {
    throw new OtlpDecodeError("an OTLP trace export must carry resourceSpans");
  }

  const spans: OtlpSpan[] = [];
  for (const resourceEntry of asArray(resourceSpans)) {
    const resourceSpan = asRecord(resourceEntry);
    if (resourceSpan === null) continue;
    const resource = decodeAttributes(asRecord(resourceSpan["resource"])?.["attributes"]);

    for (const scopeEntry of asArray(field(resourceSpan, "scopeSpans", "scope_spans"))) {
      const scopeSpan = asRecord(scopeEntry);
      if (scopeSpan === null) continue;

      for (const spanEntry of asArray(scopeSpan["spans"])) {
        const span = asRecord(spanEntry);
        if (span === null) continue;
        const name = span["name"];
        spans.push({
          traceId: decodeId(field(span, "traceId", "trace_id"), 16, "trace_id"),
          spanId: decodeId(field(span, "spanId", "span_id"), 8, "span_id"),
          name: typeof name === "string" ? name : "",
          startUnixNano: decodeUnixNano(
            field(span, "startTimeUnixNano", "start_time_unix_nano"),
            "start time",
          ),
          endUnixNano: decodeUnixNano(
            field(span, "endTimeUnixNano", "end_time_unix_nano"),
            "end time",
          ),
          status: decodeStatus(span["status"]),
          attributes: decodeAttributes(span["attributes"]),
          resource,
          events: decodeEvents(span["events"]),
        });
      }
    }
  }

  return spans;
}
