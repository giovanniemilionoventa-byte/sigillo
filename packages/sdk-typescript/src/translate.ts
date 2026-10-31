import type { Attributes, FinishedSpan } from "./span.js";

/**
 * The Vercel AI SDK emits its own `ai.*` attributes, with a few `gen_ai.*`
 * ones beside them. The server reads the OpenTelemetry GenAI vocabulary and
 * OpenInference, so a span in the AI SDK's dialect is rewritten here, before
 * it is filtered, into the standard names: a model call is `chat`, a tool
 * call `execute_tool`, the call that wraps them `invoke_agent`. Anything that
 * already says `gen_ai.operation.name` is left alone.
 */

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function first(attributes: Attributes, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = text(attributes[name]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function translateVercelAi(span: FinishedSpan): FinishedSpan {
  const a = span.attributes;
  if (!span.name.startsWith("ai.") || a["gen_ai.operation.name"] !== undefined) return span;

  const out: Attributes = { ...a };
  const agent = first(a, "ai.telemetry.functionId") ?? text(span.resource["service.name"]);
  if (agent !== undefined) out["gen_ai.agent.name"] = agent;

  if (span.name === "ai.toolCall") {
    out["gen_ai.operation.name"] = "execute_tool";
    const tool = first(a, "ai.toolCall.name");
    if (tool !== undefined) out["gen_ai.tool.name"] = tool;
    const input = first(a, "ai.toolCall.args");
    if (input !== undefined) out["gen_ai.input.messages"] = input;
    const output = first(a, "ai.toolCall.result");
    if (output !== undefined) out["gen_ai.output.messages"] = output;
  } else if (/\.(doGenerate|doStream)$/.test(span.name)) {
    out["gen_ai.operation.name"] = "chat";
    const model = first(a, "gen_ai.request.model", "ai.model.id");
    if (model !== undefined) out["gen_ai.request.model"] = model;
    const provider = first(a, "gen_ai.provider.name", "ai.model.provider", "gen_ai.system");
    if (provider !== undefined) out["gen_ai.provider.name"] = provider;
    const input = first(a, "ai.prompt.messages", "ai.prompt");
    if (input !== undefined) out["gen_ai.input.messages"] = input;
    const output = first(a, "ai.response.text", "ai.response.object", "ai.response.toolCalls");
    if (output !== undefined) out["gen_ai.output.messages"] = output;
  } else if (/\.doEmbed$/.test(span.name)) {
    out["gen_ai.operation.name"] = "embeddings";
    const model = first(a, "gen_ai.request.model", "ai.model.id");
    if (model !== undefined) out["gen_ai.request.model"] = model;
    const provider = first(a, "gen_ai.provider.name", "ai.model.provider", "gen_ai.system");
    if (provider !== undefined) out["gen_ai.provider.name"] = provider;
  } else {
    out["gen_ai.operation.name"] = "invoke_agent";
    const input = first(a, "ai.prompt");
    if (input !== undefined) out["gen_ai.input.messages"] = input;
    const output = first(a, "ai.response.text", "ai.response.object");
    if (output !== undefined) out["gen_ai.output.messages"] = output;
  }
  return { ...span, attributes: out };
}
