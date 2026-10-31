import { filterSpan, type FilterOptions } from "./filter.js";
import { toOtlpJson } from "./otlp.js";
import { nowUnixNano, toUnixNano, type Attributes, type FinishedSpan } from "./span.js";
import { translateVercelAi } from "./translate.js";

export interface ExporterOptions {
  /** The server's base URL, or its full `/v1/traces` URL. */
  endpoint: string;
  apiKey: string;
  /** Reported as `service.name` where the span's resource has none. */
  systemId: string;
  /** Send content as digests made here (default true). With false, the raw attributes travel as they are. */
  redactContent?: boolean;
  saltContent?: boolean;
  customerKey?: Uint8Array | string | undefined;
  /** Print everything sent to standard error, one line per action. */
  showSent?: boolean;
  /** For tests. */
  fetch?: typeof fetch;
}

export function tracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

function attributesOf(raw: unknown): Attributes {
  const result: Attributes = {};
  if (typeof raw !== "object" || raw === null) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value)) {
      result[key] = value as Attributes[string];
    }
  }
  return result;
}

/**
 * A span from an OpenTelemetry SDK (`ReadableSpan`), read by shape only: this
 * package does not import OpenTelemetry. Returns null for something that is
 * not a finished span.
 */
export function fromReadableSpan(raw: unknown, systemId: string): FinishedSpan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const span = raw as Record<string, unknown>;
  const context = typeof span["spanContext"] === "function" ? (span["spanContext"] as () => unknown).call(raw) : span["_spanContext"];
  const ids = context as { traceId?: unknown; spanId?: unknown } | undefined;
  if (typeof ids?.traceId !== "string" || typeof ids.spanId !== "string") return null;
  const parent = (span["parentSpanContext"] as { spanId?: unknown } | undefined)?.spanId ?? span["parentSpanId"];
  const now = nowUnixNano();
  const start = toUnixNano(span["startTime"], now);
  const status = (span["status"] as { code?: unknown } | undefined)?.code;
  const resource = attributesOf((span["resource"] as { attributes?: unknown } | undefined)?.attributes);
  if (resource["service.name"] === undefined) resource["service.name"] = systemId;
  const events = Array.isArray(span["events"]) ? span["events"] : [];
  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    ...(typeof parent === "string" && parent.length > 0 ? { parentSpanId: parent } : {}),
    name: typeof span["name"] === "string" ? span["name"] : "",
    startUnixNano: start,
    endUnixNano: toUnixNano(span["endTime"], start),
    statusCode: status === 1 ? 1 : status === 2 ? 2 : 0,
    attributes: attributesOf(span["attributes"]),
    events: events.map((event) => {
      const e = event as { name?: unknown; attributes?: unknown; time?: unknown };
      return { name: String(e.name ?? ""), attributes: attributesOf(e.attributes), timeUnixNano: toUnixNano(e.time, start) };
    }),
    resource,
  };
}

/**
 * Sends finished spans to a sigillo server as OTLP/JSON, after translating the
 * AI SDK's dialect and filtering every span (filter.ts). It is also an
 * OpenTelemetry `SpanExporter` by shape: give it to the `BatchSpanProcessor`
 * of an OpenTelemetry SDK you already run and the same rules apply.
 */
export class SigilloSpanExporter {
  readonly #url: string;
  readonly #options: ExporterOptions;
  readonly #fetch: typeof fetch;
  readonly #filter: FilterOptions;

  constructor(options: ExporterOptions) {
    if (!options.apiKey) throw new Error("apiKey must not be empty");
    this.#options = options;
    this.#url = tracesEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? fetch;
    this.#filter = { salt: options.saltContent ?? true, customerKey: options.customerKey };
  }

  /** OpenTelemetry's `SpanExporter.export`. */
  export(spans: unknown[], resultCallback: (result: { code: number }) => void): void {
    const finished = spans.flatMap((raw) => {
      const span = fromReadableSpan(raw, this.#options.systemId);
      return span === null ? [] : [span];
    });
    void this.send(finished).then((ok) => resultCallback({ code: ok ? 0 : 1 }));
  }

  /** Resolves true when the server took the batch. Never rejects: an agent must not fall over for a lost span. */
  async send(spans: FinishedSpan[]): Promise<boolean> {
    if (spans.length === 0) return true;
    const ready = spans.map((span) => {
      const translated = translateVercelAi(span);
      return this.#options.redactContent === false ? translated : filterSpan(translated, this.#filter);
    });
    if (this.#options.showSent === true) {
      for (const span of ready) {
        const shown: Record<string, unknown> = { name: span.name, attributes: span.attributes };
        if (span.statusCode !== 0) shown["status"] = span.statusCode === 1 ? "OK" : "ERROR";
        if (span.events.length > 0) shown["events"] = span.events.map((e) => ({ name: e.name, attributes: e.attributes }));
        process.stderr.write(`[sigillo sends] action ${JSON.stringify(shown)}\n`);
      }
    }
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#options.apiKey}` },
        body: JSON.stringify(toOtlpJson(ready)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.warn(`sigillo: the server refused a batch of spans (HTTP ${response.status})`);
      return response.ok;
    } catch (error) {
      console.warn(`sigillo: spans not delivered: ${error instanceof Error ? error.name : "error"}`);
      return false;
    }
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
