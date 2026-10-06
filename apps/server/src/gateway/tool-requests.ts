/**
 * What a model asked its agent to do: the tools it requested in an answer.
 *
 * The gateway sees the answer of a model call, and a model that wants an email
 * sent says so in it ("call send_email with these arguments"); the agent's own
 * code then does it, out of the gateway's sight. Reading the request out of the
 * answer is how a cloud agent's intentions reach the chain without the SDK
 * inside it. It shows what the model asked for, never that the agent did it.
 *
 * The shapes below are the providers' own and do not overlap, so none needs to
 * know which provider answered:
 *   OpenAI chat       choices[].message.tool_calls[].function {name, arguments}
 *   OpenAI responses  output[] items of type "function_call" {name, arguments}
 *   Anthropic         content[] blocks of type "tool_use" {name, input}
 *   Gemini            candidates[].content.parts[].functionCall {name, args}
 * Streams carry the same pieces in events: OpenAI's arguments arrive in
 * fragments by tool index, Anthropic's as `input_json_delta`, Gemini's whole.
 *
 * Nothing here keeps text: the caller digests `args` under a nonce.
 */

export interface ToolRequest {
  name: string;
  /** The arguments as the model wrote them: parsed JSON where it is JSON, else the text. */
  args: unknown;
}

/** More requests than this in one answer are not recorded: a broken model, not an agent. */
export const MAX_TOOL_REQUESTS = 32;

export function toolRequestsOf(answer: string, streamed: boolean): ToolRequest[] {
  const found = streamed ? fromStream(answer) : fromBody(parseJson(answer));
  return found.slice(0, MAX_TOOL_REQUESTS);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asName = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Arguments that arrive as a JSON text (OpenAI's) are parsed; whatever else is passed on as it is. */
function argumentsOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value === "" ? {} : (parseJson(value) ?? value);
}

/** A whole answer: a body, or Gemini's streamGenerateContent without `alt=sse`, which is an array of them. */
function fromBody(body: unknown): ToolRequest[] {
  if (Array.isArray(body)) return body.flatMap(fromBody);
  if (!isObject(body)) return [];
  const requests: ToolRequest[] = [];

  for (const choice of asArray(body["choices"])) {
    const message = isObject(choice) ? choice["message"] : undefined;
    if (!isObject(message)) continue;
    for (const call of asArray(message["tool_calls"])) {
      const fn = isObject(call) ? call["function"] : undefined;
      const name = isObject(fn) ? asName(fn["name"]) : null;
      if (name !== null && isObject(fn)) requests.push({ name, args: argumentsOf(fn["arguments"]) });
    }
    const legacy = message["function_call"];
    const legacyName = isObject(legacy) ? asName(legacy["name"]) : null;
    if (legacyName !== null && isObject(legacy)) requests.push({ name: legacyName, args: argumentsOf(legacy["arguments"]) });
  }

  for (const item of asArray(body["output"])) {
    const name = isObject(item) && item["type"] === "function_call" ? asName(item["name"]) : null;
    if (name !== null && isObject(item)) requests.push({ name, args: argumentsOf(item["arguments"]) });
  }

  for (const block of asArray(body["content"])) {
    const name = isObject(block) && block["type"] === "tool_use" ? asName(block["name"]) : null;
    if (name !== null && isObject(block)) requests.push({ name, args: block["input"] ?? {} });
  }

  for (const candidate of asArray(body["candidates"])) {
    const content = isObject(candidate) ? candidate["content"] : undefined;
    for (const part of isObject(content) ? asArray(content["parts"]) : []) {
      const call = isObject(part) ? part["functionCall"] : undefined;
      const name = isObject(call) ? asName(call["name"]) : null;
      if (name !== null && isObject(call)) requests.push({ name, args: call["args"] ?? {} });
    }
  }
  return requests;
}

interface Pending {
  name: string | null;
  text: string;
  args: unknown;
}

/** The events of a server-sent stream, in order: every `data:` line that is JSON. */
function eventsOf(stream: string): Json[] {
  const events: Json[] = [];
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const event = parseJson(line.slice(5).trim());
    if (isObject(event)) events.push(event);
  }
  return events;
}

function fromStream(stream: string): ToolRequest[] {
  const pending = new Map<string, Pending>();
  const slot = (key: string): Pending => {
    let found = pending.get(key);
    if (found === undefined) {
      found = { name: null, text: "", args: undefined };
      pending.set(key, found);
    }
    return found;
  };
  const whole: ToolRequest[] = [];

  for (const event of eventsOf(stream)) {
    // Gemini: each event holds whole function calls.
    if (event["candidates"] !== undefined) whole.push(...fromBody(event));

    // OpenAI chat: a tool call's name comes first, its arguments in fragments, all under its index.
    for (const choice of asArray(event["choices"])) {
      const delta = isObject(choice) ? choice["delta"] : undefined;
      if (!isObject(delta)) continue;
      const index = isObject(choice) ? String(choice["index"] ?? 0) : "0";
      for (const call of asArray(delta["tool_calls"])) {
        if (!isObject(call)) continue;
        const target = slot(`chat:${index}:${String(call["index"] ?? 0)}`);
        const fn = call["function"];
        if (!isObject(fn)) continue;
        target.name ??= asName(fn["name"]);
        if (typeof fn["arguments"] === "string") target.text += fn["arguments"];
      }
      const legacy = delta["function_call"];
      if (isObject(legacy)) {
        const target = slot(`chat:${index}:legacy`);
        target.name ??= asName(legacy["name"]);
        if (typeof legacy["arguments"] === "string") target.text += legacy["arguments"];
      }
    }

    const type = event["type"];
    // Anthropic: a tool_use block opens with its name, its input follows as JSON fragments.
    if (type === "content_block_start") {
      const block = event["content_block"];
      if (isObject(block) && block["type"] === "tool_use") {
        const target = slot(`block:${String(event["index"])}`);
        target.name ??= asName(block["name"]);
        if (isObject(block["input"]) && Object.keys(block["input"]).length > 0) target.args = block["input"];
      }
    } else if (type === "content_block_delta") {
      const delta = event["delta"];
      if (isObject(delta) && delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        slot(`block:${String(event["index"])}`).text += delta["partial_json"];
      }
    }
    // OpenAI responses: the item opens with its name and is finished with its arguments.
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = event["item"];
      if (isObject(item) && item["type"] === "function_call") {
        const target = slot(`item:${String(item["id"] ?? item["call_id"] ?? event["output_index"])}`);
        target.name ??= asName(item["name"]);
        if (type === "response.output_item.done" && item["arguments"] !== undefined) target.args = argumentsOf(item["arguments"]);
      }
    }
  }

  const streamed: ToolRequest[] = [];
  for (const target of pending.values()) {
    if (target.name === null) continue;
    streamed.push({ name: target.name, args: target.args ?? (target.text === "" ? {} : argumentsOf(target.text)) });
  }
  return [...streamed, ...whole];
}
