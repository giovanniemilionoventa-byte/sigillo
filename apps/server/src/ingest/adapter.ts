import {
  hashCanonicalJson,
  type Action,
  type Actor,
  type ArtifactEntry,
  type ModelInfo,
  type Outcome,
  type Source,
} from "@sigillo/core";
import type { AttributeValue, OtlpSpan } from "./otlp.js";

/**
 * Turns spans into the material for receipts, in two dialects.
 *
 * Neither convention is stable. OpenTelemetry's GenAI attributes are still
 * changing (gen_ai.provider.name replaced gen_ai.system, operation names keep
 * being added) and OpenInference is a separate vocabulary with its own names.
 * So the rule here is: recognise what we know, record what we do not, and never
 * drop a span silently. Anything that is not an AI action at all is counted and
 * ignored, which is different from being unrecognised.
 *
 * No payload is ever carried through: an input or output the source provided is
 * reduced to a digest right here, and the value is not returned.
 */

export interface AdaptedAction {
  action: Action;
  actor: Actor;
  outcome: Outcome;
  input_hash: string | null;
  output_hash: string | null;
  source: Source;
  ts_event: string;
  /** Present only when the span carried at least one `sigillo.artifact` event. */
  artifacts?: ArtifactEntry[];
  /** Present only for a recognised llm_call that named a model. */
  model?: ModelInfo;
}

/** Ordering keys, kept inside this module: a caller has no use for them. */
interface OrderedAction extends AdaptedAction {
  startUnixNano: bigint;
  spanId: string;
}

export interface AdaptedBatch {
  actions: AdaptedAction[];
  /** Spans that describe no AI action: an HTTP handler, a database query. */
  ignored: number;
  /** Convention values this build does not know, reported rather than dropped. */
  unknown: string[];
}

const GENAI_PREFIX = "gen_ai.";
const OPENINFERENCE_KIND = "openinference.span.kind";
const ARTIFACT_EVENT_NAME = "sigillo.artifact";
const ARTIFACT_ROLES = new Set(["input", "output"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Both dialects a model name and its provider arrive under, tried in order.
const MODEL_NAME_ATTRIBUTES = ["gen_ai.request.model", "gen_ai.response.model", "llm.model_name"];
const MODEL_PROVIDER_ATTRIBUTES = ["gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system"];

function text(attributes: Map<string, AttributeValue>, ...names: string[]): string | null {
  for (const name of names) {
    const value = attributes.get(name);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** Receipt fields are capped, and a name that arrives longer is cut, not dropped. */
function cap(value: string, limit = 256): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function outcomeOf(span: OtlpSpan): Outcome {
  // An unset status is not a success: OpenTelemetry leaves it unset unless the
  // source said otherwise, so the honest reading is that nothing was reported.
  if (span.status === "ok") return "ok";
  if (span.status === "error") return "error";
  return "unknown";
}

function isoFromUnixNano(nanos: bigint): string {
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

function digestOf(attributes: Map<string, AttributeValue>, ...names: string[]): string | null {
  const value = text(attributes, ...names);
  return value === null ? null : hashCanonicalJson(value);
}

/**
 * Turns this span's `sigillo.artifact` events into the receipt's `artifacts`
 * member. An event that is missing a field or carries a malformed sha256 is
 * skipped rather than thrown on: the SDK guarantees its own shape, but a
 * span from anywhere else on the wire does not get to crash ingest.
 */
function artifactsOf(span: OtlpSpan): ArtifactEntry[] | undefined {
  const artifacts: ArtifactEntry[] = [];
  for (const event of span.events) {
    if (event.name !== ARTIFACT_EVENT_NAME) continue;
    const role = text(event.attributes, "sigillo.artifact.role");
    const label = text(event.attributes, "sigillo.artifact.label");
    const mediaType = text(event.attributes, "sigillo.artifact.media_type");
    const sha256 = text(event.attributes, "sigillo.artifact.sha256");
    if (role === null || !ARTIFACT_ROLES.has(role)) continue;
    if (label === null || mediaType === null || sha256 === null) continue;
    if (!SHA256_HEX.test(sha256)) continue;
    artifacts.push({
      role: role as "input" | "output",
      label: cap(label),
      media_type: cap(mediaType, 128),
      sha256,
    });
  }
  return artifacts.length > 0 ? artifacts : undefined;
}

/** Model identity for a recognised llm_call. Absent unless a model name is known. */
function modelOf(attributes: Map<string, AttributeValue>): ModelInfo | undefined {
  const name = text(attributes, ...MODEL_NAME_ATTRIBUTES);
  if (name === null) return undefined;
  return {
    name: cap(name),
    provider: text(attributes, ...MODEL_PROVIDER_ATTRIBUTES),
    digest: text(attributes, "sigillo.model.digest"),
  };
}

/** OpenTelemetry GenAI: gen_ai.operation.name decides what kind of action it was. */
const GENAI_OPERATIONS = new Map<string, Action["kind"]>([
  ["chat", "llm_call"],
  ["text_completion", "llm_call"],
  ["generate_content", "llm_call"],
  ["embeddings", "llm_call"],
  ["execute_tool", "tool_call"],
  ["invoke_agent", "agent_step"],
  ["create_agent", "agent_step"],
]);

/** OpenInference: openinference.span.kind does. */
const OPENINFERENCE_KINDS = new Map<string, Action["kind"]>([
  ["LLM", "llm_call"],
  ["TOOL", "tool_call"],
  ["AGENT", "agent_step"],
  ["CHAIN", "agent_step"],
  ["RERANKER", "agent_step"],
  ["RETRIEVER", "agent_step"],
  ["EMBEDDING", "llm_call"],
  ["GUARDRAIL", "decision"],
  ["EVALUATOR", "decision"],
]);

function adaptGenAi(span: OtlpSpan, unknown: Set<string>): OrderedAction | null {
  const operation = text(span.attributes, "gen_ai.operation.name");
  let kind = operation === null ? null : GENAI_OPERATIONS.get(operation);

  if (kind === undefined && operation !== null) {
    unknown.add(`gen_ai.operation.name=${operation}`);
    kind = "agent_step";
  }
  if (kind === null || kind === undefined) {
    // gen_ai.* attributes but no operation name: the older convention, where
    // gen_ai.system named the provider and the span name carried the rest.
    kind = "llm_call";
    unknown.add("gen_ai.operation.name=<absent>");
  }

  const name =
    kind === "tool_call"
      ? text(span.attributes, "gen_ai.tool.name", "gen_ai.tool.type")
      : kind === "llm_call"
        ? text(span.attributes, "gen_ai.request.model", "gen_ai.response.model")
        : text(span.attributes, "gen_ai.agent.name");

  const agent = text(
    span.attributes,
    "gen_ai.agent.name",
    "gen_ai.provider.name",
    // Replaced by gen_ai.provider.name, still emitted by deployed code.
    "gen_ai.system",
  );

  return {
    action: { kind, name: cap(name ?? span.name ?? operation ?? "unknown") },
    actor: buildActor(span, agent),
    outcome: outcomeOf(span),
    input_hash: digestOf(span.attributes, "gen_ai.input.messages", "gen_ai.prompt"),
    output_hash: digestOf(span.attributes, "gen_ai.output.messages", "gen_ai.completion"),
    source: { type: "otlp", trace_id: span.traceId, span_id: span.spanId },
    ts_event: isoFromUnixNano(span.startUnixNano),
    startUnixNano: span.startUnixNano,
    spanId: span.spanId,
    ...withArtifactsAndModel(span, kind),
  };
}

function adaptOpenInference(span: OtlpSpan, unknown: Set<string>): OrderedAction | null {
  const declared = text(span.attributes, OPENINFERENCE_KIND);
  if (declared === null) return null;

  let kind = OPENINFERENCE_KINDS.get(declared.toUpperCase());
  if (kind === undefined) {
    unknown.add(`${OPENINFERENCE_KIND}=${declared}`);
    kind = "agent_step";
  }

  const name =
    kind === "tool_call"
      ? text(span.attributes, "tool.name")
      : kind === "llm_call"
        ? text(span.attributes, "llm.model_name")
        : null;

  return {
    action: { kind, name: cap(name ?? span.name ?? declared) },
    actor: buildActor(span, text(span.attributes, "llm.system")),
    outcome: outcomeOf(span),
    input_hash: digestOf(span.attributes, "input.value"),
    output_hash: digestOf(span.attributes, "output.value"),
    source: { type: "otlp", trace_id: span.traceId, span_id: span.spanId },
    ts_event: isoFromUnixNano(span.startUnixNano),
    startUnixNano: span.startUnixNano,
    spanId: span.spanId,
    ...withArtifactsAndModel(span, kind),
  };
}

/**
 * `exactOptionalPropertyTypes` means an optional member must be omitted, not
 * set to `undefined`: this builds exactly the members that are actually
 * present, once, for both adapters to spread into their result.
 */
function withArtifactsAndModel(
  span: OtlpSpan,
  kind: Action["kind"],
): Pick<AdaptedAction, "artifacts" | "model"> {
  const artifacts = artifactsOf(span);
  const model = kind === "llm_call" ? modelOf(span.attributes) : undefined;
  return {
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(model === undefined ? {} : { model }),
  };
}

function buildActor(span: OtlpSpan, agent: string | null): Actor {
  const named = agent ?? text(span.resource, "service.name") ?? "unknown";
  const onBehalfOf = text(span.attributes, "user.id", "enduser.id");
  return onBehalfOf === null
    ? { agent: cap(named) }
    : { agent: cap(named), on_behalf_of: cap(onBehalfOf) };
}

function hasGenAiAttributes(span: OtlpSpan): boolean {
  for (const key of span.attributes.keys()) {
    if (key.startsWith(GENAI_PREFIX)) return true;
  }
  return false;
}

export function adaptSpans(spans: OtlpSpan[]): AdaptedBatch {
  const unknown = new Set<string>();
  const ordered: OrderedAction[] = [];
  let ignored = 0;

  for (const span of spans) {
    // OpenInference is checked first: an instrumentation that emits both
    // vocabularies has said explicitly what kind of span this is.
    const adapted = span.attributes.has(OPENINFERENCE_KIND)
      ? adaptOpenInference(span, unknown)
      : hasGenAiAttributes(span)
        ? adaptGenAi(span, unknown)
        : null;

    if (adapted === null) {
      ignored += 1;
      continue;
    }
    ordered.push(adapted);
  }

  // A batch arrives in no particular order, so ingest is made deterministic
  // here: the same payload always produces the same chain.
  ordered.sort((left, right) => {
    if (left.startUnixNano !== right.startUnixNano) {
      return left.startUnixNano < right.startUnixNano ? -1 : 1;
    }
    return left.spanId.localeCompare(right.spanId);
  });

  const actions = ordered.map(({ startUnixNano: _start, spanId: _span, ...action }) => action);
  return { actions, ignored, unknown: [...unknown].sort() };
}
