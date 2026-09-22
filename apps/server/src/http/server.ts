import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { hashCanonicalJson, type Receipt } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import type { ChainHealthMonitor } from "../health/chain-health.js";
import { adaptSpans } from "../ingest/adapter.js";
import { decodeJsonTraces, decodeProtobufTraces, OtlpDecodeError } from "../ingest/otlp.js";
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
  logger?: boolean;
  /**
   * The operator's view. Without a password it is not mounted at all: an
   * unguarded window onto an audit log is worse than no window.
   */
  ui?: {
    password: string;
    signerKey: { key_id: string; public_key_base64: string };
    healthMonitor: ChainHealthMonitor;
    checkpointer: Checkpointer;
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

  const app = Fastify({ bodyLimit, logger: options.logger ?? false });

  // OTLP protobuf arrives as opaque bytes; fastify has no parser for it.
  app.addContentTypeParser(
    "application/x-protobuf",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  const authenticate = (request: FastifyRequest): string | null => {
    const token = bearer(request);
    return token === null ? null : keys.verify(token);
  };

  app.get("/healthz", async () => ({ status: "ok" }));

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
    });
  }

  app.post("/v1/traces", async (request, reply) => {
    const systemId = authenticate(request);
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
    const systemId = authenticate(request);
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
