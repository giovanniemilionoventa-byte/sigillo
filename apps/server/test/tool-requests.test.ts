import { describe, expect, it } from "vitest";
import { MAX_TOOL_REQUESTS, toolRequestsOf } from "../src/gateway/tool-requests.js";

/**
 * The tools a model asked for, read out of its answer in each provider's own
 * shape, whole and streamed. What the model said it wanted, never what the
 * agent then did.
 */

const EMAIL_ARGS = { to: "sara@example.com", subject: "Colloquio" };
const sse = (...events: unknown[]): string => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

describe("tool requests in a whole answer", () => {
  it("reads OpenAI's chat completions, with the arguments parsed", () => {
    const answer = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "send_email", arguments: JSON.stringify(EMAIL_ARGS) } },
              { id: "call_2", type: "function", function: { name: "log_decision", arguments: "" } },
            ],
          },
        },
      ],
    };
    expect(toolRequestsOf(JSON.stringify(answer), false)).toEqual([
      { name: "send_email", args: EMAIL_ARGS },
      { name: "log_decision", args: {} },
    ]);
  });

  it("reads the older function_call, and arguments that are not JSON as text", () => {
    const answer = { choices: [{ message: { function_call: { name: "send_email", arguments: "not json {" } } }] };
    expect(toolRequestsOf(JSON.stringify(answer), false)).toEqual([{ name: "send_email", args: "not json {" }]);
  });

  it("reads OpenAI's responses API", () => {
    const answer = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
        { type: "function_call", name: "send_email", arguments: JSON.stringify(EMAIL_ARGS) },
      ],
    };
    expect(toolRequestsOf(JSON.stringify(answer), false)).toEqual([{ name: "send_email", args: EMAIL_ARGS }]);
  });

  it("reads Anthropic's tool_use blocks and skips its text", () => {
    const answer = {
      content: [
        { type: "text", text: "I will email her." },
        { type: "tool_use", id: "toolu_1", name: "send_email", input: EMAIL_ARGS },
      ],
    };
    expect(toolRequestsOf(JSON.stringify(answer), false)).toEqual([{ name: "send_email", args: EMAIL_ARGS }]);
  });

  it("reads Gemini's functionCall parts, also in the array a non-SSE stream returns", () => {
    const chunk = { candidates: [{ content: { parts: [{ text: "..." }, { functionCall: { name: "send_email", args: EMAIL_ARGS } }] } }] };
    expect(toolRequestsOf(JSON.stringify(chunk), false)).toEqual([{ name: "send_email", args: EMAIL_ARGS }]);
    expect(toolRequestsOf(JSON.stringify([chunk, chunk]), false)).toHaveLength(2);
  });

  it("finds nothing in a plain answer, an error, or text that is not JSON", () => {
    expect(toolRequestsOf(JSON.stringify({ choices: [{ message: { content: "Candidate B" } }] }), false)).toEqual([]);
    expect(toolRequestsOf(JSON.stringify({ error: { message: "rate limited" } }), false)).toEqual([]);
    expect(toolRequestsOf("<html>bad gateway</html>", false)).toEqual([]);
    expect(toolRequestsOf("", false)).toEqual([]);
  });

  it("records at most MAX_TOOL_REQUESTS from one answer", () => {
    const calls = Array.from({ length: MAX_TOOL_REQUESTS + 8 }, (_, i) => ({ function: { name: `tool_${i}`, arguments: "{}" } }));
    expect(toolRequestsOf(JSON.stringify({ choices: [{ message: { tool_calls: calls } }] }), false)).toHaveLength(MAX_TOOL_REQUESTS);
  });
});

describe("tool requests in a stream", () => {
  it("joins OpenAI's argument fragments under each tool index", () => {
    const stream = sse(
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", function: { name: "send_email", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"to":"sara@' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "log_decision", arguments: "{}" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'example.com","subject":"Colloquio"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    );
    expect(toolRequestsOf(stream, true)).toEqual([
      { name: "send_email", args: EMAIL_ARGS },
      { name: "log_decision", args: {} },
    ]);
  });

  it("joins Anthropic's input_json_delta fragments and ignores its text blocks", () => {
    const stream = [
      "event: content_block_start",
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      "",
      "event: content_block_start",
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "send_email", input: {} } })}`,
      "",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"to":"sara@example.com",' } })}`,
      "",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"subject":"Colloquio"}' } })}`,
      "",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n");
    expect(toolRequestsOf(stream, true)).toEqual([{ name: "send_email", args: EMAIL_ARGS }]);
  });

  it("reads OpenAI's responses stream from the finished item", () => {
    const stream = sse(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "send_email", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", name: "send_email", arguments: JSON.stringify(EMAIL_ARGS) } },
    );
    expect(toolRequestsOf(stream, true)).toEqual([{ name: "send_email", args: EMAIL_ARGS }]);
  });

  it("reads Gemini's server-sent events, one whole call per event", () => {
    const stream = sse(
      { candidates: [{ content: { parts: [{ text: "Sending" }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: "send_email", args: EMAIL_ARGS } }] } }] },
    );
    expect(toolRequestsOf(stream, true)).toEqual([{ name: "send_email", args: EMAIL_ARGS }]);
  });

  it("records a request whose stream was cut short with what arrived of its arguments", () => {
    const stream = sse(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "send_email", arguments: '{"to":"sa' } }] } }] },
    );
    expect(toolRequestsOf(stream, true)).toEqual([{ name: "send_email", args: '{"to":"sa' }]);
  });

  it("finds nothing in a stream of plain text, or in lines that are not events", () => {
    const stream = sse({ choices: [{ index: 0, delta: { content: "Candidate B" } }] }, "[DONE]");
    expect(toolRequestsOf(stream, true)).toEqual([]);
    expect(toolRequestsOf(": keep-alive\n\nretry: 3000\n\n", true)).toEqual([]);
  });
});
