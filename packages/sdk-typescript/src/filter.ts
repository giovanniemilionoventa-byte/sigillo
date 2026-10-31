import { freshNonce, hashContentValue, nonceFor, NONCE_KEPT_BY_CUSTOMER, saltedHashContentValue } from "./content.js";
import type { AttributeValue, Attributes, FinishedSpan, SpanEventData } from "./span.js";

/**
 * What leaves the process of a span, and in what form. The rule is the Python
 * SDK's (`_filtered_span`): an input or an output goes as a digest, never as
 * it arrived; every attribute the server does not read is dropped; an
 * exception goes as its class only. The sets below are the attributes
 * apps/server/src/ingest/adapter.ts reads, dialect for dialect.
 */

/** The attributes that hold content, and the digest each becomes. */
const CONTENT_ATTRIBUTES: Record<string, "sigillo.input.sha256" | "sigillo.output.sha256"> = {
  "input.value": "sigillo.input.sha256",
  "gen_ai.input.messages": "sigillo.input.sha256",
  "gen_ai.prompt": "sigillo.input.sha256",
  "output.value": "sigillo.output.sha256",
  "gen_ai.output.messages": "sigillo.output.sha256",
  "gen_ai.completion": "sigillo.output.sha256",
};

const NONCE_ATTRIBUTES = {
  "sigillo.input.sha256": "sigillo.input.nonce",
  "sigillo.output.sha256": "sigillo.output.nonce",
} as const;

/** Identifiers and categories the server reads: never a value an agent produced. */
const KEEP_ATTRIBUTES = new Set([
  "gen_ai.operation.name",
  "gen_ai.tool.name",
  "gen_ai.tool.type",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.agent.name",
  "gen_ai.provider.name",
  "gen_ai.system",
  "openinference.span.kind",
  "tool.name",
  "llm.model_name",
  "llm.provider",
  "llm.system",
  "user.id",
  "enduser.id",
  "error.type",
  "sigillo.model.digest",
]);

export interface FilterOptions {
  /** Salt each digest with a fresh nonce (the default). */
  salt: boolean;
  /** The customer's own key: nonces are made from it and never sent. */
  customerKey?: Uint8Array | string | undefined;
}

export function filterAttributes(
  attributes: Attributes,
  options: FilterOptions,
  ids: { traceId: string; spanId: string },
): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const digestName = Object.hasOwn(CONTENT_ATTRIBUTES, key) ? CONTENT_ATTRIBUTES[key] : undefined;
    if (digestName !== undefined) {
      if (typeof value !== "string" || kept[digestName] !== undefined) continue;
      const role = digestName === "sigillo.input.sha256" ? "input" : "output";
      if (options.customerKey !== undefined) {
        const nonce = Buffer.from(nonceFor(options.customerKey, ids.traceId, ids.spanId, role), "hex");
        kept[digestName] = saltedHashContentValue(value, nonce);
        kept[NONCE_ATTRIBUTES[digestName]] = NONCE_KEPT_BY_CUSTOMER;
      } else if (options.salt) {
        const nonce = freshNonce();
        kept[digestName] = saltedHashContentValue(value, nonce);
        kept[NONCE_ATTRIBUTES[digestName]] = nonce.toString("hex");
      } else {
        kept[digestName] = hashContentValue(value);
      }
      continue;
    }
    if (KEEP_ATTRIBUTES.has(key) && value !== undefined) kept[key] = value;
  }
  return kept;
}

/**
 * An `exception` event keeps its name and the exception's class: its message
 * and stack can quote the very content the attributes are filtered for. Any
 * other event goes as it is (`sigillo.artifact` never carried content).
 */
function filterEvent(event: SpanEventData): SpanEventData {
  if (event.name !== "exception") return event;
  const type = event.attributes["exception.type"];
  const attributes: Attributes = type === undefined ? {} : { "exception.type": type };
  return { ...event, attributes };
}

/** A copy of the span as it may leave: filtered attributes and events, no status text. */
export function filterSpan(span: FinishedSpan, options: FilterOptions): FinishedSpan {
  return {
    ...span,
    attributes: filterAttributes(span.attributes, options, span),
    events: span.events.map(filterEvent),
  };
}

export type { AttributeValue };
