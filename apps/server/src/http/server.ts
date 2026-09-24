import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { hashCanonicalJson, type Receipt } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import { AttemptThrottle, type ThrottleSettings } from "../auth/throttle.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import type { ChainHealthMonitor } from "../health/chain-health.js";
import { adaptSpans } from "../ingest/adapter.js";
import { decodeJsonTraces, decodeProtobufTraces, OtlpDecodeError } from "../ingest/otlp.js";
import { SignerUnavailableError } from "../signer/client.js";
import type { ReceiptStore } from "../storage/store.js";
import { registerUi } from "./ui.js";

/**
 * The ingest surface.
 *
 * A request authenticates as exactly one system, and the receipts it produces go
 * on that system's chain. An OTLP payload carries no notion of a sigillo system,
 * so the API key is what decides which chain a span belongs to; the native API
 * may name the system, and it has to be the same one.
 */

export interface ServerOptions {
  store: ReceiptStore;
  keys: ApiKeyStore;
  /** Injected so that tests are not at the mercy of the wall clock. */
  now?: () => Date;
  bodyLimitBytes?: number;
  /** Request logging, one JSON line per request, to standard output. */
  logger?: boolean;
  /** Where the log goes instead of standard output. Turns logging on. For tests. */
  logStream?: { write(line: string): unknown };
  /**
   * Which proxies to believe about the client's address and protocol (see
   * config.ts, trustProxy). Every attempt limit is keyed on that address.
   */
  trustProxy?: string | false;
  /** Limits on failed API keys, per client address. */
  ingestLimits?: ThrottleSettings;
  /**
   * Whether the signer answers now. /healthz reports 503 when it does not, so
   * that a container orchestrator sees a server that cannot write.
   */
  signerHealthy?: () => Promise<boolean>;
  /**
   * The operator's view. Without a password it is not mounted at all: an
   * unguarded window onto an audit log is worse than no window.
   */
  ui?: {
    password: string;
    signerKey: { key_id: string; public_key_base64: string };
    healthMonitor: ChainHealthMonitor;
    checkpointer: Checkpointer;
    loginLimits?: ThrottleSettings;
    cookieSecure?: boolean | "auto";
  };
}

const DEFAULT_INGEST_LIMITS: ThrottleSettings = {
  maxFailures: 20,
  windowMs: 60_000,
  lockoutMs: 60_000,
  maxLockoutMs: 15 * 60_000,
};

/**
 * What a request looks like in the log: its method, its path without the
 * query string, and the address it came from. The query string of the web
 * view carries document fingerprints and search terms; headers carry the API
 * key and the session cookie; bodies carry whatever an agent sent. None of it
 * belongs in a log that is kept, rotated and copied around.
 */
function requestForLog(request: { method: string; url: string; ip: string }): Record<string, unknown> {
  const url = request.url;
  const query = url.indexOf("?");
  return {
    method: request.method,
    url: query === -1 ? url : url.slice(0, query),
    remoteAddress: request.ip,
  };
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

const receiptRequestSchema = z
  .object({
    system_id: z.string().min(1).max(128).optional(),
    ts_event: z.string().optional(),
    actor: z.object({ agent: z.string().min(1).max(256), on_behalf_of: z.string().min(1).max(256).optional() }).strict(),
    action: z
      .object({
        kind: z.enum(["tool_call", "llm_call", "agent_step", "decision"]),
        name: z.string().min(1).max(256),
      })
      .strict(),
    outcome: z.enum(["ok", "error", "blocked", "unknown"]),
    source: z
      .object({
        type: z.enum(["sdk", "api"]).default("api"),
        trace_id: z.string().regex(/^[0-9a-f]{32}$/).optional(),
        span_id: z.string().regex(/^[0-9a-f]{16}$/).optional(),
      })
      .strict()
      .optional(),
    input_hash: hex64.nullable().optional(),
    output_hash: hex64.nullable().optional(),
    /** A value to hash here and discard. Never stored, never logged. */
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .strict()
  .refine((body) => !(body.input_hash !== undefined && body.input !== undefined), {
    message: "send either input or input_hash, not both",
    path: ["input"],
  })
  .refine((body) => !(body.output_hash !== undefined && body.output !== undefined), {
    message: "send either output or output_hash, not both",
    path: ["output"],
  });

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store, keys } = options;
  const now = options.now ?? ((): Date => new Date());
  const bodyLimit = options.bodyLimitBytes ?? 8 * 1024 * 1024;

  const logging = options.logger === true || options.logStream !== undefined;
  const fastifyOptions: FastifyServerOptions = {
    bodyLimit,
    trustProxy: options.trustProxy ?? false,
    logger: logging
      ? {
          level: "info",
          ...(options.logStream === undefined ? {} : { stream: options.logStream }),
          serializers: {
            req: requestForLog,
            res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
            // An error's message may quote the input that caused it (JSON.parse
            // does); its name, code and stack say what went wrong without that.
            // The first line of a stack repeats the message, so it goes too.
            err: (error: Error & { code?: string }) => ({
              type: error.name,
              message: error.code ?? error.name,
              stack: (error.stack ?? "").split("\n").slice(1).join("\n"),
            }),
          },
        }
      : false,
  };
  const app = Fastify(fastifyOptions);

  // Errors reach the caller with a status that says whose problem they are,
  // and the caller of a 5xx learns nothing about the inside of the server.
  app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof SignerUnavailableError) {
      request.log.warn({ err: error }, "signer unavailable");
      return reply.code(503).send({ error: "the signer is not available; try again later" });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: error.message });
  });

  const ingestThrottle = new AttemptThrottle(options.ingestLimits ?? DEFAULT_INGEST_LIMITS);

  // OTLP protobuf arrives as opaque bytes; fastify has no parser for it.
  app.addContentTypeParser(
    "application/x-protobuf",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  /**
   * The system a request speaks for, or null. A client that has sent too many
   * wrong keys lately gets no scrypt run for it until its lockout ends: only a
   * key the server has already checked can still succeed, so an agent that was
   * working carries on while the guessing costs nothing.
   */
  const authenticate = async (request: FastifyRequest): Promise<string | null> => {
    const token = bearer(request);
    if (token === null) return null;
    const at = now().getTime();
    const client = request.ip;
    const systemId = await keys.verify(token, { hashAllowed: !ingestThrottle.isLocked(client, at) });
    if (systemId === null) ingestThrottle.recordFailure(client, at);
    return systemId;
  };

  app.get("/healthz", async (_request, reply) => {
    if (options.signerHealthy !== undefined && !(await options.signerHealthy())) {
      return reply.code(503).send({ status: "signer unavailable" });
    }
    return { status: "ok" };
  });

  if (options.ui !== undefined) {
    // The login form posts a urlencoded body, which fastify does not parse by
    // default. A null-prototype object, because the field names come from
    // outside.
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        const fields: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [key, value] of new URLSearchParams(body as string)) {
          fields[key] = value;
        }
        done(null, fields);
      },
    );
    registerUi(app, {
      store,
      keys,
      password: options.ui.password,
      signerKey: options.ui.signerKey,
      healthMonitor: options.ui.healthMonitor,
      checkpointer: options.ui.checkpointer,
      now,
      ...(options.ui.loginLimits === undefined ? {} : { loginLimits: options.ui.loginLimits }),
      ...(options.ui.cookieSecure === undefined ? {} : { cookieSecure: options.ui.cookieSecure }),
    });
  }

  app.post("/v1/traces", async (request, reply) => {
    const systemId = await authenticate(request);
    if (systemId === null) {
      return reply.code(401).send({ error: "a valid Bearer API key is required" });
    }

    const contentType = request.headers["content-type"] ?? "";
    let spans;
    try {
      spans = contentType.includes("application/x-protobuf")
        ? decodeProtobufTraces(new Uint8Array(request.body as Buffer))
        : decodeJsonTraces(request.body);
    } catch (error) {
      if (error instanceof OtlpDecodeError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }

    const batch = adaptSpans(spans);
    const receivedAt = isoNow(now);
    let accepted = 0;

    for (const action of batch.actions) {
      await store.append({
        system_id: systemId,
        ts_event: action.ts_event,
        ts_received: receivedAt,
        actor: action.actor,
        action: action.action,
        input_hash: action.input_hash,
        output_hash: action.output_hash,
        outcome: action.outcome,
        source: action.source,
        ...(action.artifacts === undefined ? {} : { artifacts: action.artifacts }),
        ...(action.model === undefined ? {} : { model: action.model }),
      });
      accepted += 1;
    }

    // OTLP expects a partial-success body; an empty object means "all accepted".
    return reply.code(200).send({
      partialSuccess: {},
      sigillo: { accepted, ignored: batch.ignored, unknown: batch.unknown },
    });
  });

  app.post("/api/v1/receipts", async (request, reply) => {
    const systemId = await authenticate(request);
    if (systemId === null) {
      return reply.code(401).send({ error: "a valid Bearer API key is required" });
    }

    const parsed = receiptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<body>"}: ${issue.message}`)
          .join("; "),
      });
    }
    const body = parsed.data;

    if (body.system_id !== undefined && body.system_id !== systemId) {
      return reply
        .code(403)
        .send({ error: `this key writes to ${systemId}, not to ${body.system_id}` });
    }

    const receivedAt = isoNow(now);
    let receipt: Receipt;
    try {
      receipt = await store.append({
        system_id: systemId,
        ts_event: body.ts_event ?? receivedAt,
        ts_received: receivedAt,
        actor: body.actor,
        action: body.action,
        input_hash:
          body.input_hash ?? (body.input === undefined ? null : hashCanonicalJson(body.input)),
        output_hash:
          body.output_hash ?? (body.output === undefined ? null : hashCanonicalJson(body.output)),
        outcome: body.outcome,
        source: body.source ?? { type: "api" },
      });
    } catch (error) {
      // The signer being away is not the caller's fault; the error handler
      // turns it into a 503. Anything else the store refused was the request.
      if (error instanceof SignerUnavailableError) throw error;
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    return reply.code(201).send({
      seq: receipt.seq,
      system_id: receipt.system_id,
      ts_received: receipt.ts_received,
      key_id: receipt.key_id,
    });
  });

  return app;
}
