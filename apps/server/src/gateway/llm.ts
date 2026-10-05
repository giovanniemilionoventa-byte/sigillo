import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Receipt } from "@sigillo/core";
import type { ReceiptStore } from "../storage/store.js";
import { isProvider, type Provider, type ProviderKeyStore } from "./provider-keys.js";

/**
 * The model gateway: a system's agent talks to its cloud model through
 * sigillo, with sigillo's key for the system, and sigillo calls the model with
 * the customer's own key (provider-keys.ts), which the agent never holds.
 * Every call that reaches the model becomes a receipt (`llm_call`, with the
 * model's name and the digests of the request and of the answer), so an agent
 * whose sigillo code is removed loses its model, not its record.
 *
 *   OpenAI-compatible   base_url = <server>/llm/openai/v1
 *   Anthropic (Claude)  base_url = <server>/llm/anthropic
 *   Google Gemini       base_url = <server>/llm/gemini
 *
 * Whatever path follows the prefix is the provider's own, forwarded as it is:
 * `/llm/openai/v1/chat/completions` reaches `https://api.openai.com/v1/chat/completions`.
 * POST is recorded; GET (a model list) is forwarded and not.
 *
 * The request and the answer cross this process in the clear, in memory only,
 * the way any proxy's do; they are hashed under a fresh nonce on the way to
 * the receipt and never written anywhere (store.ts, digestFor). A plain
 * answer is handed back only once its receipt is written: if the receipt
 * cannot be written, the agent gets a 503 and not the answer. A streamed
 * answer is passed on as it arrives, and its receipt written at the end.
 */

export type GatewayAccess = "operator" | "all";

export interface GatewayOptions {
  keys: ProviderKeyStore;
  /** Who may use it: the operator's own systems only, until the owner opens it to every account. */
  access: GatewayAccess;
  /** The providers' addresses; tests point them at a local stand-in. */
  upstream?: Partial<Record<Provider, string>>;
}

export interface GatewayGuards {
  store: ReceiptStore;
  now: () => Date;
  authenticate: (request: FastifyRequest, token: string | null) => Promise<string | null>;
  pausedFor: (systemId: string, reply: FastifyReply) => boolean;
  overQuota: (systemId: string, reply: FastifyReply) => boolean;
}

const UPSTREAM: Record<Provider, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/**
 * A provider path: starts at its API version, no `..`, nothing but URL-safe
 * characters. Gemini's versions are v1 and v1beta, and its methods follow a
 * colon: `v1beta/models/gemini-2.5-flash:generateContent`.
 */
const PATH: Record<Provider, RegExp> = {
  openai: /^v1\/[A-Za-z0-9._~\/-]+$/,
  anthropic: /^v1\/[A-Za-z0-9._~\/-]+$/,
  gemini: /^v1(beta)?\/[A-Za-z0-9._~\/:-]+$/,
};

/** The request headers the providers read that are not the key: passed on as they are. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "x-goog-api-client",
];

/** The response headers an SDK reads: the type, the request id, rate limits and when to retry. */
const FORWARDED_RESPONSE_HEADER = /^(content-type|retry-after|x-request-id|request-id|openai-[a-z-]+|anthropic-[a-z-]+|x-ratelimit-[a-z-]+)$/;

const MAX_NAME = 256;

/** Whether a system may use the gateway under `access`: one with no organization is the operator's. */
export function gatewayAllowed(access: GatewayAccess, organizationId: string | null): boolean {
  return access === "all" || organizationId === null;
}

export function registerGateway(app: FastifyInstance, options: GatewayOptions, guards: GatewayGuards): void {
  const { store, now } = guards;
  const upstreamOf = (provider: Provider): string => (options.upstream?.[provider] ?? UPSTREAM[provider]).replace(/\/+$/, "");

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const { provider, "*": rest } = request.params as { provider: string; "*": string };
    if (!isProvider(provider) || !PATH[provider].test(rest) || rest.split("/").includes("..")) {
      return reply.code(404).send({ error: "no such model endpoint" });
    }
    // OpenAI's SDKs send the key as a bearer token, Anthropic's as x-api-key,
    // Google's as x-goog-api-key or as `?key=`.
    const token =
      bearerOf(request) ?? headerOf(request, "x-api-key") ?? headerOf(request, "x-goog-api-key") ?? keyParamOf(request);
    const systemId = await guards.authenticate(request, token);
    if (systemId === null) return reply.code(401).send({ error: "a valid sigillo API key is required" });
    if (!gatewayAllowed(options.access, store.systemRecord(systemId)?.organization_id ?? null)) {
      return reply.code(403).send({ error: "the model gateway is not available for this account yet" });
    }
    const providerKey = options.keys.get(systemId, provider);
    if (providerKey === null) {
      return reply.code(409).send({ error: `no ${provider} key is set for ${systemId}: add one in the console, on the system's page` });
    }
    const recorded = request.method === "POST";
    if (recorded && (guards.pausedFor(systemId, reply) || guards.overQuota(systemId, reply))) return reply;

    const body = request.method === "POST" ? request.body : undefined;
    if (recorded && (typeof body !== "object" || body === null)) {
      return reply.code(415).send({ error: "the gateway carries JSON requests only" });
    }

    const query = queryWithoutKey(request.url);
    const headers = providerAuth(provider, rest, providerKey);
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (body !== undefined) headers["content-type"] = "application/json";

    const startedAt = now().toISOString();
    // The agent going away (its connection closing before the answer is
    // written) stops the call to the provider. The response's close, not the
    // request's: a request "closes" as soon as its body has been read.
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamOf(provider)}/${rest}${query}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: abort.signal,
      });
    } catch (error) {
      request.log.warn({ system: systemId, provider, err: error }, "the model provider did not answer");
      return reply.code(502).send({ error: `${provider} did not answer` });
    }

    const passOn: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (FORWARDED_RESPONSE_HEADER.test(name)) passOn[name] = value;
    });

    const record = async (answer: string, outcome: Receipt["outcome"]): Promise<Receipt> =>
      store.append({
        system_id: systemId,
        ts_event: startedAt,
        ts_received: now().toISOString(),
        actor: { agent: agentOf(request, systemId) },
        action: { kind: "llm_call", name: rest.slice(0, MAX_NAME) },
        input_hash: null,
        output_hash: null,
        raw_input: { value: body },
        raw_output: { value: parsedOrText(answer) },
        outcome,
        source: { type: "api" },
        model: { name: modelOf(body, rest), provider, digest: null },
      });

    if (!recorded) {
      return reply.code(upstream.status).headers(passOn).send(Buffer.from(await upstream.arrayBuffer()));
    }

    const outcome: Receipt["outcome"] = upstream.ok ? "ok" : "error";
    const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!streamed || upstream.body === null) {
      const answer = await upstream.text();
      // No receipt, no answer: the signer being away comes back as a 503 (server.ts).
      await record(answer, outcome);
      return reply.code(upstream.status).headers(passOn).send(answer);
    }

    // A stream is passed on chunk by chunk, as the agent expects, and kept
    // whole here until its end, when its receipt is written.
    reply.hijack();
    reply.raw.writeHead(upstream.status, { ...passOn, "cache-control": "no-cache" });
    const chunks: Buffer[] = [];
    let finished = true;
    try {
      for await (const chunk of upstream.body) {
        const bytes = Buffer.from(chunk);
        chunks.push(bytes);
        reply.raw.write(bytes);
      }
    } catch {
      // The agent went away, or the provider broke off: what arrived is recorded, as of unknown outcome.
      finished = false;
    }
    reply.raw.end();
    try {
      await record(Buffer.concat(chunks).toString("utf8"), finished ? outcome : "unknown");
    } catch (error) {
      request.log.error({ system: systemId, provider, err: error }, "a streamed model call was passed on but its receipt could not be written");
    }
    return reply;
  };

  app.post("/llm/:provider/*", handle);
  app.get("/llm/:provider/*", handle);
}

/** How each provider takes its key. Gemini's OpenAI-compatible endpoints take it as OpenAI does. */
function providerAuth(provider: Provider, path: string, key: string): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": key };
  if (provider === "gemini" && !/^v1(beta)?\/openai\//.test(path)) return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

function headerOf(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function keyParamOf(request: FastifyRequest): string | null {
  const key = new URLSearchParams(request.url.split("?")[1] ?? "").get("key");
  return key === null || key === "" ? null : key;
}

/** The query string passed on to the provider: the agent's own, less a `key` (the sigillo key, from a Gemini client). */
function queryWithoutKey(url: string): string {
  const at = url.indexOf("?");
  if (at === -1) return "";
  const params = new URLSearchParams(url.slice(at + 1));
  params.delete("key");
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  return /^Bearer (.+)$/.exec(header.trim())?.[1] ?? null;
}

/** The agent's name: `x-sigillo-agent` when the client sets it, else the system's own. */
function agentOf(request: FastifyRequest, systemId: string): string {
  const named = request.headers["x-sigillo-agent"];
  return typeof named === "string" && named.trim() !== "" ? named.trim().slice(0, MAX_NAME) : systemId;
}

/** The model asked for: the body's `model`, or for Gemini's own API the path's `models/<name>:<method>`. */
function modelOf(body: unknown, path: string): string {
  const model = typeof body === "object" && body !== null ? (body as { model?: unknown }).model : undefined;
  if (typeof model === "string" && model !== "") return model.slice(0, MAX_NAME);
  const named = /(?:^|\/)models\/([^/:]+)(?::|$)/.exec(path)?.[1];
  return named === undefined ? "unknown" : named.slice(0, MAX_NAME);
}

function parsedOrText(answer: string): unknown {
  try {
    return JSON.parse(answer) as unknown;
  } catch {
    return answer;
  }
}
