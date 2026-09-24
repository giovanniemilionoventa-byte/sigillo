import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, hashCanonicalJson, safeParseUnsignedReceipt } from "@sigillo/core";
import { adaptSpans, type AdaptedAction } from "../src/ingest/adapter.js";
import { decodeJsonTraces, decodeProtobufTraces, OtlpDecodeError, type OtlpSpan } from "../src/ingest/otlp.js";

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(fixture(name), "utf8"));
const readBinary = (name: string): Uint8Array => new Uint8Array(readFileSync(fixture(name)));

const ENCODINGS: [string, (dialect: string) => OtlpSpan[]][] = [
  ["protobuf", (dialect) => decodeProtobufTraces(readBinary(`${dialect}.protobuf.bin`))],
  ["JSON with hex ids", (dialect) => decodeJsonTraces(readJson(`${dialect}.hexids.json`))],
  ["JSON with base64 ids", (dialect) => decodeJsonTraces(readJson(`${dialect}.base64ids.json`))],
];

function byName(actions: AdaptedAction[], name: string): AdaptedAction {
  const found = actions.find((action) => action.action.name === name);
  if (found === undefined) {
    throw new Error(`no action named ${name} in ${actions.map((a) => a.action.name).join(", ")}`);
  }
  return found;
}

describe("decoding real OTLP payloads", () => {
  for (const [encoding, decode] of ENCODINGS) {
    describe(encoding, () => {
      it("reads the same six spans from the GenAI export", () => {
        const spans = decode("otel-genai");
        expect(spans).toHaveLength(6);
        expect(spans.map((span) => span.name)).toEqual([
          "invoke_agent support-agent",
          "chat claude-sonnet-5",
          "execute_tool search_orders",
          "openai.chat",
          "gen_ai.rerank",
          "GET /healthz",
        ]);
      });

      it("reads identifiers as lowercase hex whatever the wire encoding was", () => {
        for (const span of decode("otel-genai")) {
          expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
          expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
        }
        expect(decode("otel-genai")[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e0001");
        expect(decode("otel-genai")[0]?.spanId).toBe("00f067aa0ba90001");
      });

      it("reads attribute values of each type", () => {
        const spans = decode("otel-genai");
        const chat = spans[1];
        expect(chat?.attributes.get("gen_ai.request.model")).toBe("claude-sonnet-5");
        expect(chat?.attributes.get("gen_ai.usage.input_tokens")).toBe(812);
        expect(chat?.status).toBe("ok");
        expect(spans[0]?.status).toBe("unset");
        expect(spans[2]?.status).toBe("error");
      });

      it("reads the resource attributes alongside every span", () => {
        for (const span of decode("openinference")) {
          expect(span.resource.get("service.name")).toBe("acme-support-bot");
          expect(span.resource.get("service.version")).toBe("1.4.2");
        }
      });

      it("reads timestamps as nanoseconds", () => {
        const span = decode("otel-genai")[0];
        expect(typeof span?.startUnixNano).toBe("bigint");
        expect(span?.endUnixNano).toBeGreaterThanOrEqual(span?.startUnixNano ?? 0n);
      });
    });
  }

  it("decodes the three encodings of a dialect to the same spans", () => {
    for (const dialect of ["otel-genai", "openinference"]) {
      const [first, second, third] = ENCODINGS.map(([, decode]) => decode(dialect));
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    }
  });
});

describe("rejecting input that is not an OTLP export", () => {
  it("rejects protobuf that does not decode", () => {
    expect(() => decodeProtobufTraces(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(
      OtlpDecodeError,
    );
  });

  it("rejects JSON that is not an export", () => {
    for (const body of [null, 42, "traces", [], { spans: [] }]) {
      expect(() => decodeJsonTraces(body)).toThrow(OtlpDecodeError);
    }
  });

  it("rejects a span with an identifier of the wrong length", () => {
    expect(() =>
      decodeJsonTraces({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "abcd",
                    spanId: "00f067aa0ba90001",
                    name: "x",
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/trace_id/);
  });

  it("accepts the snake_case spelling the proto3 JSON mapping also allows", () => {
    const spans = decodeJsonTraces({
      resource_spans: [
        {
          resource: { attributes: [{ key: "service.name", value: { string_value: "s" } }] },
          scope_spans: [
            {
              spans: [
                {
                  trace_id: "4bf92f3577b34da6a3ce929d0e0e0001",
                  span_id: "00f067aa0ba90001",
                  name: "x",
                  start_time_unix_nano: "1789971053648178106",
                  end_time_unix_nano: "1789971053648204813",
                  attributes: [{ key: "gen_ai.operation.name", value: { string_value: "chat" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.resource.get("service.name")).toBe("s");
    expect(spans[0]?.attributes.get("gen_ai.operation.name")).toBe("chat");
  });

  it("keeps a hostile attribute name out of object prototypes", () => {
    const spans = decodeJsonTraces({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "4bf92f3577b34da6a3ce929d0e0e0001",
                  spanId: "00f067aa0ba90001",
                  name: "x",
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  attributes: [{ key: "__proto__", value: { stringValue: "polluted" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(spans[0]?.attributes.get("__proto__")).toBe("polluted");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("the OpenTelemetry GenAI dialect", () => {
  const batch = adaptSpans(decodeProtobufTraces(readBinary("otel-genai.protobuf.bin")));

  it("maps operations to action kinds", () => {
    expect(byName(batch.actions, "support-agent").action.kind).toBe("agent_step");
    expect(byName(batch.actions, "claude-sonnet-5").action.kind).toBe("llm_call");
    expect(byName(batch.actions, "search_orders").action.kind).toBe("tool_call");
  });

  it("takes the agent from gen_ai.agent.name and the operator from user.id", () => {
    expect(byName(batch.actions, "support-agent").actor).toEqual({
      agent: "support-agent",
      on_behalf_of: "urn:user:42",
    });
  });

  it("falls back to the provider, then to the service name, for the agent", () => {
    expect(byName(batch.actions, "claude-sonnet-5").actor).toEqual({ agent: "anthropic" });
    // The old-convention span names its provider in gen_ai.system.
    expect(byName(batch.actions, "gpt-4o").actor).toEqual({ agent: "openai" });
  });

  it("maps span status to outcome, and an unset status to unknown", () => {
    expect(byName(batch.actions, "claude-sonnet-5").outcome).toBe("ok");
    expect(byName(batch.actions, "search_orders").outcome).toBe("error");
    expect(byName(batch.actions, "support-agent").outcome).toBe("unknown");
  });

  it("carries the trace context into the receipt source", () => {
    const action = byName(batch.actions, "search_orders");
    expect(action.source.type).toBe("otlp");
    expect(action.source.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(action.source.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("tolerates an operation name it has never seen, and reports it", () => {
    expect(batch.unknown).toContain("gen_ai.operation.name=rerank_documents");
    expect(batch.actions.some((action) => action.action.name === "support-agent")).toBe(true);
  });

  it("tolerates the older convention that has no operation name at all", () => {
    expect(batch.unknown).toContain("gen_ai.operation.name=<absent>");
    expect(byName(batch.actions, "gpt-4o").action.kind).toBe("llm_call");
  });

  it("ignores and counts a span that is not an AI action", () => {
    expect(batch.ignored).toBe(1);
    expect(batch.actions).toHaveLength(5);
    expect(batch.actions.every((action) => action.action.name !== "GET /healthz")).toBe(true);
  });
});

describe("the OpenInference dialect", () => {
  const batch = adaptSpans(decodeProtobufTraces(readBinary("openinference.protobuf.bin")));

  it("maps span kinds to action kinds", () => {
    expect(byName(batch.actions, "AgentExecutor").action.kind).toBe("agent_step");
    expect(byName(batch.actions, "claude-sonnet-5").action.kind).toBe("llm_call");
    expect(byName(batch.actions, "search_orders").action.kind).toBe("tool_call");
    expect(byName(batch.actions, "RunnableSequence").action.kind).toBe("agent_step");
  });

  it("records digests of input and output, never the values", () => {
    const tool = byName(batch.actions, "search_orders");
    expect(tool.input_hash).toBe(hashCanonicalJson('{"order_id":"A-1099"}'));
    expect(tool.output_hash).toBe(hashCanonicalJson('{"status":"shipped"}'));

    const serialised = JSON.stringify(batch);
    expect(serialised).not.toContain("A-1099");
    expect(serialised).not.toContain("shipped");
    expect(serialised).not.toContain("where is my order");
  });

  it("maps span status to outcome", () => {
    expect(byName(batch.actions, "claude-sonnet-5").outcome).toBe("ok");
    expect(byName(batch.actions, "AgentExecutor").outcome).toBe("unknown");
  });

  it("tolerates a span kind it has no mapping for, and reports it", () => {
    // RETRIEVER is a real OpenInference kind that this build maps to agent_step.
    expect(byName(batch.actions, "VectorStoreRetriever").action.kind).toBe("agent_step");
    expect(batch.unknown).toEqual([]);
  });

  it("ignores and counts a span that is not an AI action", () => {
    expect(batch.ignored).toBe(1);
    expect(batch.actions).toHaveLength(5);
  });

  it("falls back to the service name when no agent is named", () => {
    expect(byName(batch.actions, "AgentExecutor").actor).toEqual({ agent: "acme-support-bot" });
  });
});

function jsonSpan(options: {
  attributes?: Record<string, string>;
  events?: { name: string; attributes: Record<string, string> }[];
}): OtlpSpan {
  const asAttributes = (values: Record<string, string>) =>
    Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } }));

  const spans = decodeJsonTraces({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "4bf92f3577b34da6a3ce929d0e0e0001",
                spanId: "00f067aa0ba90001",
                name: "x",
                startTimeUnixNano: "1789971053648178106",
                endTimeUnixNano: "1789971053648204813",
                attributes: asAttributes(options.attributes ?? {}),
                events: (options.events ?? []).map((event) => ({
                  name: event.name,
                  attributes: asAttributes(event.attributes),
                })),
              },
            ],
          },
        ],
      },
    ],
  });
  const span = spans[0];
  if (span === undefined) throw new Error("expected exactly one span");
  return span;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("extracting artifacts and model (phase 2)", () => {
  it("turns a sigillo.artifact event into the action's artifacts member", () => {
    const span = jsonSpan({
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "leggi_curriculum" },
      events: [
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "input",
            "sigillo.artifact.label": "curriculum",
            "sigillo.artifact.media_type": "text/plain",
            "sigillo.artifact.sha256": SHA_A,
          },
        },
      ],
    });
    const [action] = adaptSpans([span]).actions;
    expect(action?.artifacts).toEqual([
      { role: "input", label: "curriculum", media_type: "text/plain", sha256: SHA_A },
    ]);
  });

  it("keeps two artifacts in event order", () => {
    const span = jsonSpan({
      attributes: { "gen_ai.operation.name": "execute_tool" },
      events: [
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "input",
            "sigillo.artifact.label": "curriculum",
            "sigillo.artifact.media_type": "text/plain",
            "sigillo.artifact.sha256": SHA_A,
          },
        },
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "output",
            "sigillo.artifact.label": "email di risposta",
            "sigillo.artifact.media_type": "text/plain",
            "sigillo.artifact.sha256": SHA_B,
          },
        },
      ],
    });
    const [action] = adaptSpans([span]).actions;
    expect(action?.artifacts?.map((artifact) => artifact.role)).toEqual(["input", "output"]);
  });

  it("omits artifacts entirely when the span carries no sigillo.artifact event", () => {
    const span = jsonSpan({ attributes: { "gen_ai.operation.name": "execute_tool" } });
    const [action] = adaptSpans([span]).actions;
    expect(action).not.toHaveProperty("artifacts");
  });

  it("ignores an event of another name, and a malformed sigillo.artifact event, without failing the span", () => {
    const span = jsonSpan({
      attributes: { "gen_ai.operation.name": "execute_tool" },
      events: [
        { name: "some.other.event", attributes: { unrelated: "x" } },
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "sideways",
            "sigillo.artifact.label": "l",
            "sigillo.artifact.media_type": "text/plain",
            "sigillo.artifact.sha256": SHA_A,
          },
        },
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "input",
            "sigillo.artifact.label": "l",
            "sigillo.artifact.media_type": "text/plain",
            "sigillo.artifact.sha256": "not-a-digest",
          },
        },
        { name: "sigillo.artifact", attributes: { "sigillo.artifact.role": "input" } },
      ],
    });
    const [action] = adaptSpans([span]).actions;
    expect(action).not.toHaveProperty("artifacts");
  });

  it("caps an artifact's label and media_type exactly as it caps an action name", () => {
    const span = jsonSpan({
      attributes: { "gen_ai.operation.name": "execute_tool" },
      events: [
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "input",
            "sigillo.artifact.label": "l".repeat(400),
            "sigillo.artifact.media_type": "m".repeat(400),
            "sigillo.artifact.sha256": SHA_A,
          },
        },
      ],
    });
    const [action] = adaptSpans([span]).actions;
    expect(action?.artifacts?.[0]?.label).toHaveLength(256);
    expect(action?.artifacts?.[0]?.media_type).toHaveLength(128);
  });

  it("reads model name, provider and digest for a recognised llm_call, GenAI dialect", () => {
    const span = jsonSpan({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "qwen2.5:3b",
        "gen_ai.provider.name": "ollama",
        "sigillo.model.digest": "sha256:deadbeef",
      },
    });
    const [action] = adaptSpans([span]).actions;
    expect(action?.model).toEqual({ name: "qwen2.5:3b", provider: "ollama", digest: "sha256:deadbeef" });
  });

  it("reads the model name alone for OpenInference, with provider and digest null", () => {
    const span = jsonSpan({
      attributes: { "openinference.span.kind": "LLM", "llm.model_name": "gpt-4o" },
    });
    const [action] = adaptSpans([span]).actions;
    expect(action?.model).toEqual({ name: "gpt-4o", provider: null, digest: null });
  });

  it("does not attach model information to a span that is not a recognised llm_call", () => {
    const span = jsonSpan({
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.request.model": "should-be-ignored" },
    });
    const [action] = adaptSpans([span]).actions;
    expect(action).not.toHaveProperty("model");
  });
});

describe("adapting a batch", () => {
  it("produces the same result from every encoding of the same payload", () => {
    for (const dialect of ["otel-genai", "openinference"]) {
      const results = ENCODINGS.map(([, decode]) => adaptSpans(decode(dialect)));
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    }
  });

  it("orders actions by start time, so the same payload always gives the same chain", () => {
    const spans = decodeProtobufTraces(readBinary("otel-genai.protobuf.bin"));
    const forwards = adaptSpans(spans);
    const backwards = adaptSpans([...spans].reverse());
    expect(backwards.actions).toEqual(forwards.actions);
  });

  it("gives every action a timestamp the receipt format accepts", () => {
    for (const action of adaptSpans(decodeProtobufTraces(readBinary("otel-genai.protobuf.bin"))).actions) {
      expect(action.ts_event).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("caps a name that arrives longer than the format allows", () => {
    const spans = decodeJsonTraces({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "4bf92f3577b34da6a3ce929d0e0e0001",
                  spanId: "00f067aa0ba90001",
                  name: "x",
                  startTimeUnixNano: "1789971053648178106",
                  endTimeUnixNano: "1789971053648204813",
                  attributes: [
                    { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
                    { key: "tool.name", value: { stringValue: "t".repeat(400) } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const action = adaptSpans(spans).actions[0];
    expect(action?.action.name).toHaveLength(256);
  });

  it("returns nothing for an empty export", () => {
    const batch = adaptSpans([]);
    expect(batch).toEqual({ actions: [], ignored: 0, unknown: [] });
  });
});

describe("text fields: length and well-formed Unicode", () => {
  // RFC 8785 is defined over well-formed Unicode: a string holding half of a
  // surrogate pair has no canonical form another implementation will agree
  // on (Python's refuses to encode it at all), so a receipt carrying one
  // could be signed here and never re-hashed anywhere else.

  const GRINNING_FACE = "\u{1F600}"; // two UTF-16 code units

  /** Every string anywhere inside a value, keys included. */
  const stringsIn = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, inner]) => [key, ...stringsIn(inner)])
        : [];

  it("cuts an over-long name without splitting a character in two", () => {
    const span = jsonSpan({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": `${"a".repeat(255)}${GRINNING_FACE}`,
      },
    });
    const name = adaptSpans([span]).actions[0]?.action.name ?? "";
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe("a".repeat(255));
  });

  it("keeps a character that ends exactly at the limit", () => {
    const span = jsonSpan({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": `${"a".repeat(254)}${GRINNING_FACE}${"b".repeat(10)}`,
      },
    });
    expect(adaptSpans([span]).actions[0]?.action.name).toBe(`${"a".repeat(254)}${GRINNING_FACE}`);
  });

  it("caps a model's provider and digest the way it caps its name", () => {
    const span = jsonSpan({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "m".repeat(300),
        "gen_ai.provider.name": "p".repeat(300),
        "sigillo.model.digest": "d".repeat(300),
      },
    });
    expect(adaptSpans([span]).actions[0]?.model).toEqual({
      name: "m".repeat(256),
      provider: "p".repeat(256),
      digest: "d".repeat(256),
    });
  });

  it("replaces a lone surrogate from an OTLP/JSON attribute, as protobuf decoding already does", () => {
    const span = jsonSpan({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "cerca\ud800ordini",
        "user.id": "utente\udfff",
      },
      events: [
        {
          name: "sigillo.artifact",
          attributes: {
            "sigillo.artifact.role": "input",
            "sigillo.artifact.label": "curriculum\ud83d",
            "sigillo.artifact.media_type": "text/plain",
            "sigillo.artifact.sha256": SHA_A,
          },
        },
      ],
    });
    const action = adaptSpans([span]).actions[0];
    expect(action?.action.name).toBe("cerca\ufffdordini");
    expect(action?.actor.on_behalf_of).toBe("utente\ufffd");
    expect(action?.artifacts?.[0]?.label).toBe("curriculum\ufffd");
  });

  it("turns any string at all into fields a receipt accepts and any RFC 8785 implementation can hash", () => {
    // Any UTF-16 code unit, lone surrogates included, at every length up to
    // well past the cap: fast-check's default sizes would stay short, and its
    // "binary" unit never produces half a pair.
    const anyText = fc.string16bits({ minLength: 1, maxLength: 600, size: "max" });
    fc.assert(
      fc.property(anyText, anyText, anyText, anyText, (tool, user, provider, label) => {
        const span = jsonSpan({
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool,
            "user.id": user,
            "gen_ai.provider.name": provider,
          },
          events: [
            {
              name: "sigillo.artifact",
              attributes: {
                "sigillo.artifact.role": "output",
                "sigillo.artifact.label": label,
                "sigillo.artifact.media_type": "text/plain",
                "sigillo.artifact.sha256": SHA_A,
              },
            },
          ],
        });
        for (const action of adaptSpans([span]).actions) {
          const unsigned = {
            v: 2,
            system_id: "acme-support-bot",
            seq: 1,
            ts_event: action.ts_event,
            ts_received: action.ts_event,
            actor: action.actor,
            action: action.action,
            input_hash: action.input_hash,
            output_hash: action.output_hash,
            outcome: action.outcome,
            source: action.source,
            prev_hash: GENESIS_PREV_HASH,
            key_id: "0123456789abcdef",
            ...(action.artifacts === undefined ? {} : { artifacts: action.artifacts }),
            ...(action.model === undefined ? {} : { model: action.model }),
          };
          const parsed = safeParseUnsignedReceipt(unsigned);
          expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
          expect(stringsIn(unsigned).every((text) => text.isWellFormed())).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
