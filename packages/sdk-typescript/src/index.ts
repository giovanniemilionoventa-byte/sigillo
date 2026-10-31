import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { SigilloSpanExporter, tracesEndpoint } from "./exporter.js";
import { haltProcess, Heartbeat, heartbeatEndpoint } from "./heartbeat.js";
import { isPlainText, textSha256, TEXT_CANON_1 } from "./text.js";
import { registerGlobally, SigilloTracerProvider, type SigilloSpan, type SigilloTracer } from "./tracer.js";

export { nonceFor, pseudonym } from "./content.js";
export { SigilloSpanExporter } from "./exporter.js";

export interface InitOptions {
  /** The server's base URL, or its full `/v1/traces` URL. */
  endpoint: string;
  /** The key issued with `sigillo-server key create`. It decides which system's chain the receipts join. */
  apiKey: string;
  /** Reported as `service.name`. */
  systemId: string;
  /** Hash a span's input and output here and drop every attribute the server does not read (default true). */
  redactContent?: boolean;
  /** Salt each digest with a fresh nonce (default true; needs a server from October 2026). */
  saltContent?: boolean;
  /** Your own secret: nonces are made from it and never sent, so not even sigillo can test a guess against a digest. */
  customerKey?: Uint8Array | string;
  /** How often the agent says it is still connected (default 60). The server calls it lost after 180. */
  heartbeatSeconds?: number;
  /** Print on standard error everything that leaves the process. */
  showSent?: boolean;
  /** Stop the agent if its script changes or three beats in a row do not get through. */
  strict?: boolean;
  /** Replaces how strict mode stops the agent (default: message on standard error, exit status 70). */
  onHalt?: (reason: string) => void;
  /** Seconds between the guard process's looks (default 5). */
  guardSeconds?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: no guard process, no hook on the process. */
  guard?: boolean;
}

const ARTIFACT_ROLES = ["input", "output"] as const;
type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".pdf": "application/pdf", ".html": "text/html", ".xml": "application/xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

let active: Tracing | undefined;

/** What `init` hands back. Holding on to it is optional. */
export class Tracing {
  /** What was turned on: "opentelemetry" when this package took the global tracer slot. */
  readonly instrumented: readonly string[];
  readonly systemId: string;
  readonly endpoint: string;
  readonly provider: SigilloTracerProvider;
  readonly heartbeat: Heartbeat;
  #shutdown = false;

  constructor(systemId: string, endpoint: string, provider: SigilloTracerProvider, heartbeat: Heartbeat, instrumented: readonly string[]) {
    this.systemId = systemId;
    this.endpoint = endpoint;
    this.provider = provider;
    this.heartbeat = heartbeat;
    this.instrumented = instrumented;
  }

  get tracer(): SigilloTracer {
    return this.provider.getTracer();
  }

  /** Push what is buffered, before a short process exits. */
  flush(): Promise<boolean> {
    return this.provider.forceFlush();
  }

  /** Flush, then tell the server this agent closed. */
  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await this.provider.shutdown();
    await this.heartbeat.close();
    if (active === this) active = undefined;
  }

  /**
   * Runs `fn` as a tool call and records it. An exception makes it an error,
   * recorded as its class only, and goes on unchanged. Inside `fn`,
   * `artifact(...)` attaches to this call.
   */
  async tool<T>(name: string, fn: () => T | Promise<T>, agent?: string): Promise<T> {
    const span = this.tracer.startSpan(name, {
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.agent.name": agent ?? this.systemId },
    });
    try {
      const result = await this.provider.run(span, fn);
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      span.setAttribute("error.type", error instanceof Error ? error.name : "Error");
      span.recordException(error);
      span.setStatus({ code: 2 });
      throw error;
    } finally {
      span.end();
    }
  }
}

/**
 * Points sigillo at your server. After this, the spans a framework emits
 * through OpenTelemetry's API (the Vercel AI SDK with `@ai-sdk/otel`, for one)
 * are sent as receipts, and the heartbeat runs. With an OpenTelemetry SDK of
 * your own, leave the global tracer to it and add a `SigilloSpanExporter` to
 * its span processor instead.
 */
export function init(options: InitOptions): Tracing {
  if (!options.apiKey) throw new Error("apiKey must not be empty");
  if (!options.systemId) throw new Error("systemId must not be empty");
  const heartbeatSeconds = options.heartbeatSeconds ?? 60;
  if (!(heartbeatSeconds > 0)) throw new Error("heartbeatSeconds must be a positive number of seconds");
  const redact = options.redactContent ?? true;
  const salt = options.saltContent ?? true;
  if (options.customerKey !== undefined) {
    const key = options.customerKey;
    if (key.length === 0) throw new Error("customerKey must not be empty");
    if (typeof key === "string" && key.startsWith("<")) {
      throw new Error("customerKey is still the placeholder: put your own secret there, for example the output of node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    }
    if (!(redact && salt)) throw new Error("customerKey salts the digests made here: it needs redactContent and saltContent");
  }

  const url = tracesEndpoint(options.endpoint);
  const exporter = new SigilloSpanExporter({
    endpoint: url,
    apiKey: options.apiKey,
    systemId: options.systemId,
    redactContent: redact,
    saltContent: salt,
    customerKey: options.customerKey,
    showSent: options.showSent ?? false,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const provider = new SigilloTracerProvider({ systemId: options.systemId, exporter });
  const instrumented = registerGlobally(provider) ? ["opentelemetry"] : [];
  if (instrumented.length === 0) {
    console.warn("sigillo: another OpenTelemetry provider is already installed; add a SigilloSpanExporter to its span processor");
  }

  const heartbeat = new Heartbeat({
    url: heartbeatEndpoint(url),
    apiKey: options.apiKey,
    intervalSeconds: heartbeatSeconds,
    showSent: options.showSent ?? false,
    strict: options.strict ?? false,
    onHalt: options.onHalt ?? haltProcess,
    guardPeriodSeconds: options.guardSeconds ?? 5,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.guard === undefined ? {} : { guard: options.guard }),
  });
  heartbeat.start();

  const tracing = new Tracing(options.systemId, url, provider, heartbeat, instrumented);
  active = tracing;
  // A process that empties its event loop without calling shutdown() still flushes and says it closed.
  process.once("beforeExit", () => void tracing.shutdown());
  return tracing;
}

/**
 * Attaches a document's fingerprint to the action being recorded right now:
 * its SHA-256 (over the exact bytes) and, for text/plain, the sigillo-text/1
 * fingerprint. Only the digests leave this process. `data` is the document
 * (bytes, or a string of exact text) or `{ path }` to read it from. `label` is
 * a category such as "curriculum", chosen so it cannot carry a person's name;
 * without one it is the role and the media type, never the file's name.
 */
export function artifact(
  data: Uint8Array | string | { path: string },
  options: { role: ArtifactRole; label?: string; mediaType?: string; span?: SigilloSpan },
): void {
  if (!ARTIFACT_ROLES.includes(options.role)) throw new Error(`role must be one of ${ARTIFACT_ROLES.join(", ")}, got ${String(options.role)}`);
  const target = options.span ?? active?.provider.currentSpan();
  if (target === undefined || !target.isRecording()) {
    console.warn("sigillo.artifact() called with no action being recorded; nothing was attached");
    return;
  }
  let bytes: Uint8Array;
  let mediaType: string;
  if (typeof data === "string") {
    bytes = Buffer.from(data, "utf8");
    mediaType = "text/plain";
  } else if (data instanceof Uint8Array) {
    bytes = data;
    mediaType = "application/octet-stream";
  } else {
    bytes = readFileSync(data.path);
    mediaType = MEDIA_TYPES[extname(basename(data.path)).toLowerCase()] ?? "application/octet-stream";
  }
  const effective = options.mediaType ?? mediaType;
  const attributes: Record<string, string> = {
    "sigillo.artifact.role": options.role,
    "sigillo.artifact.label": options.label ?? `${options.role} ${effective}`,
    "sigillo.artifact.media_type": effective,
    "sigillo.artifact.sha256": createHash("sha256").update(bytes).digest("hex"),
  };
  const fingerprint = isPlainText(effective) ? textSha256(bytes) : null;
  if (fingerprint !== null) {
    attributes["sigillo.artifact.text_canon"] = TEXT_CANON_1;
    attributes["sigillo.artifact.text_sha256"] = fingerprint;
  }
  target.addEvent("sigillo.artifact", attributes);
}
