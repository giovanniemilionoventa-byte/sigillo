import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { SigilloSpanExporter } from "./exporter.js";
import { nowUnixNano, toUnixNano, type Attributes, type FinishedSpan, type SpanEventData } from "./span.js";

/**
 * A small tracer, enough for what an agent framework needs from
 * OpenTelemetry's API (`startSpan`, `startActiveSpan`, attributes, events,
 * status, end), so that the SDK needs no OpenTelemetry package of its own.
 * Registered as the global provider by `init`, it is what a framework that
 * calls `trace.getTracer(...)` (the Vercel AI SDK's telemetry, for one) ends
 * up writing to.
 */

const OK = 1;
const ERROR = 2;
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

type AttributeInput = Record<string, unknown>;

function cleanAttributes(input: AttributeInput | undefined): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value)) {
      result[key] = value as Attributes[string];
    }
  }
  return result;
}

export class SigilloSpan {
  readonly #data: FinishedSpan;
  readonly #onEnd: (span: FinishedSpan) => void;
  #ended = false;

  constructor(name: string, traceId: string, parentSpanId: string | undefined, resource: Attributes, attributes: AttributeInput | undefined, startTime: unknown, onEnd: (span: FinishedSpan) => void) {
    const start = toUnixNano(startTime, nowUnixNano());
    this.#data = {
      traceId,
      spanId: hex(8),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      name,
      startUnixNano: start,
      endUnixNano: start,
      statusCode: 0,
      attributes: cleanAttributes(attributes),
      events: [],
      resource,
    };
    this.#onEnd = onEnd;
  }

  spanContext(): { traceId: string; spanId: string; traceFlags: number } {
    return { traceId: this.#data.traceId, spanId: this.#data.spanId, traceFlags: 1 };
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.#ended) Object.assign(this.#data.attributes, cleanAttributes({ [key]: value }));
    return this;
  }

  setAttributes(attributes: AttributeInput): this {
    if (!this.#ended) Object.assign(this.#data.attributes, cleanAttributes(attributes));
    return this;
  }

  addEvent(name: string, attributesOrTime?: AttributeInput | unknown, time?: unknown): this {
    if (this.#ended) return this;
    const isAttributes = typeof attributesOrTime === "object" && attributesOrTime !== null && !Array.isArray(attributesOrTime) && !(attributesOrTime instanceof Date);
    const event: SpanEventData = {
      name,
      attributes: isAttributes ? cleanAttributes(attributesOrTime as AttributeInput) : {},
      timeUnixNano: toUnixNano(isAttributes ? time : attributesOrTime, nowUnixNano()),
    };
    this.#data.events.push(event);
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    // An OK is not overwritten by a later ERROR or UNSET, as in OpenTelemetry.
    if (!this.#ended && this.#data.statusCode !== OK) this.#data.statusCode = status.code === OK ? OK : status.code === ERROR ? ERROR : 0;
    return this;
  }

  updateName(name: string): this {
    if (!this.#ended) this.#data.name = name;
    return this;
  }

  /** Only the exception's class is kept; its message and stack stay in the process. */
  recordException(exception: unknown, time?: unknown): void {
    const type = exception instanceof Error ? exception.name : typeof exception === "string" ? "Error" : "unknown";
    this.addEvent("exception", { "exception.type": type }, time);
  }

  isRecording(): boolean {
    return !this.#ended;
  }

  end(endTime?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#data.endUnixNano = toUnixNano(endTime, nowUnixNano());
    this.#onEnd(this.#data);
  }
}

export class SigilloTracer {
  readonly #provider: SigilloTracerProvider;

  constructor(provider: SigilloTracerProvider) {
    this.#provider = provider;
  }

  startSpan(name: string, options?: { attributes?: AttributeInput; startTime?: unknown; root?: boolean }): SigilloSpan {
    return this.#provider.open(name, options);
  }

  /** `startActiveSpan(name, fn)`, `(name, options, fn)` or `(name, options, context, fn)`. */
  startActiveSpan<T>(name: string, ...rest: unknown[]): T {
    const fn = rest[rest.length - 1] as (span: SigilloSpan) => T;
    const options = typeof rest[0] === "object" && rest[0] !== null ? (rest[0] as Parameters<SigilloTracer["startSpan"]>[1]) : undefined;
    const span = this.startSpan(name, options);
    return this.#provider.run(span, () => fn(span));
  }
}

export interface ProviderOptions {
  systemId: string;
  exporter: SigilloSpanExporter;
  flushEveryMs?: number;
  maxBatch?: number;
}

/** Collects ended spans and hands them to the exporter in batches. */
export class SigilloTracerProvider {
  readonly #resource: Attributes;
  readonly #exporter: SigilloSpanExporter;
  readonly #current = new AsyncLocalStorage<SigilloSpan>();
  readonly #queue: FinishedSpan[] = [];
  readonly #maxBatch: number;
  readonly #timer: NodeJS.Timeout;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: ProviderOptions) {
    this.#resource = { "service.name": options.systemId };
    this.#exporter = options.exporter;
    this.#maxBatch = options.maxBatch ?? 256;
    this.#timer = setInterval(() => void this.forceFlush(), options.flushEveryMs ?? 5_000);
    this.#timer.unref();
  }

  getTracer(): SigilloTracer {
    return new SigilloTracer(this);
  }

  open(name: string, options?: { attributes?: AttributeInput; startTime?: unknown; root?: boolean }): SigilloSpan {
    const parent = options?.root === true ? undefined : this.#current.getStore()?.spanContext();
    return new SigilloSpan(name, parent?.traceId ?? hex(16), parent?.spanId, this.#resource, options?.attributes, options?.startTime, (span) => {
      this.#queue.push(span);
      if (this.#queue.length >= this.#maxBatch) void this.forceFlush();
    });
  }

  run<T>(span: SigilloSpan, fn: () => T): T {
    return this.#current.run(span, fn);
  }

  /** The span running in this async context, if any. */
  currentSpan(): SigilloSpan | undefined {
    return this.#current.getStore();
  }

  /** Sends what is queued. Resolves true when everything queued so far was taken. */
  async forceFlush(): Promise<boolean> {
    const batch = this.#queue.splice(0, this.#queue.length);
    const sent = this.#pending.then(() => this.#exporter.send(batch));
    this.#pending = sent;
    return (await sent) as boolean;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#timer);
    await this.forceFlush();
  }
}

/**
 * Makes `provider` what OpenTelemetry's API hands out for `trace.getTracer()`,
 * by the slot the API itself uses (`Symbol.for("opentelemetry.js.api.1")`),
 * unless some other provider already holds it. Returns whether it took it.
 * Frameworks that find no provider there fall back to doing nothing, so this
 * is the whole of "turning the framework's telemetry on".
 */
export function registerGlobally(provider: SigilloTracerProvider): boolean {
  const slot = Symbol.for("opentelemetry.js.api.1");
  const holder = globalThis as unknown as Record<symbol, { version?: string; trace?: unknown } | undefined>;
  const existing = holder[slot];
  if (existing?.trace !== undefined) return false;
  holder[slot] = { ...existing, version: existing?.version ?? "1.99.0", trace: provider };
  return true;
}
