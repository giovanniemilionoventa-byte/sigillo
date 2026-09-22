import { describe, expect, it } from "vitest";
import type { Receipt } from "@sigillo/core";
import { describeArtifact, describeReceipt } from "../src/http/strings.js";

const BASE = {
  v: 1 as const,
  system_id: "acme-support-bot",
  seq: 3,
  ts_event: "2026-03-29T14:30:00.123Z",
  ts_received: "2026-03-29T14:30:00.456Z",
  input_hash: null,
  output_hash: null,
  source: { type: "sdk" as const },
  prev_hash: "a".repeat(64),
  key_id: "3f2a1c9d8e7b6a5f",
  sig: "cGxhY2Vob2xkZXItc2lnbmF0dXJlLW5vdC12ZXJpZmlhYmxlLW0xLXZlY3RvcnMtc2VlLUZPUk1BVC5tZC0wMQ==",
};

const KINDS = ["tool_call", "llm_call", "agent_step", "decision", "genesis"] as const;
const OUTCOMES = ["ok", "error", "blocked", "unknown"] as const;

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    ...BASE,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: "search_orders" },
    outcome: "ok",
    ...overrides,
  } as Receipt;
}

describe("describeReceipt: every action kind and outcome produces a non-empty sentence", () => {
  for (const kind of KINDS) {
    for (const outcome of OUTCOMES) {
      it(`${kind} / ${outcome}`, () => {
        const sentence = describeReceipt(
          receipt({
            action: { kind, name: kind === "genesis" ? "acme-support-bot" : "do-something" },
            outcome,
          }),
        );
        expect(sentence.length).toBeGreaterThan(0);
        expect(sentence.endsWith(".")).toBe(true);
        // The sentence is for a reader, not a debugger: no raw field names leaking through.
        expect(sentence).not.toContain("undefined");
        expect(sentence).not.toContain("[object");
      });
    }
  }

  it("gives every non-genesis kind its own sentence shape, not one generic template", () => {
    const sentences = new Set(
      KINDS.filter((kind) => kind !== "genesis").map((kind) =>
        describeReceipt(receipt({ action: { kind, name: "x" }, outcome: "ok" })),
      ),
    );
    expect(sentences.size).toBe(KINDS.length - 1);
  });

  it("changes the verb, not just appends a code, when the outcome is not ok", () => {
    const ok = describeReceipt(receipt({ action: { kind: "tool_call", name: "invia_email" }, outcome: "ok" }));
    const blocked = describeReceipt(
      receipt({ action: { kind: "tool_call", name: "invia_email" }, outcome: "blocked" }),
    );
    expect(ok).toContain("ha usato");
    expect(blocked).toContain("ha tentato");
    expect(blocked).not.toContain("ha usato");
  });
});

describe("describeReceipt: genesis", () => {
  it("names the system and says the register was opened, regardless of outcome", () => {
    const sentence = describeReceipt(
      receipt({ action: { kind: "genesis", name: "acme-support-bot" }, outcome: "ok" }),
    );
    expect(sentence).toBe("Il sistema «acme-support-bot» ha aperto il registro.");
  });
});

describe("describeReceipt: on_behalf_of", () => {
  it("names the operator when the actor acted on someone's behalf", () => {
    const sentence = describeReceipt(
      receipt({
        actor: { agent: "selezione-cv", on_behalf_of: "m.rossi" },
        action: { kind: "tool_call", name: "leggi_curriculum" },
        outcome: "ok",
      }),
    );
    expect(sentence).toContain("per conto di «m.rossi»");
  });

  it("says nothing about an operator when there is none", () => {
    const sentence = describeReceipt(receipt({ actor: { agent: "selezione-cv" } }));
    expect(sentence).not.toContain("per conto di");
  });
});

describe("describeReceipt: model identity (v2)", () => {
  function v2Receipt(overrides: Partial<Receipt> = {}): Receipt {
    return {
      ...BASE,
      v: 2,
      actor: { agent: "planner" },
      action: { kind: "llm_call", name: "chat.completions" },
      outcome: "ok",
      ...overrides,
    } as Receipt;
  }

  it("names a local model as local", () => {
    const sentence = describeReceipt(
      v2Receipt({ model: { name: "qwen2.5:3b", provider: "ollama", digest: null } }),
    );
    expect(sentence).toContain("«qwen2.5:3b»");
    expect(sentence).toContain("(locale)");
  });

  it("names the provider for a model that is not local", () => {
    const sentence = describeReceipt(
      v2Receipt({ model: { name: "gpt-4o", provider: "openai", digest: null } }),
    );
    expect(sentence).toContain("(openai)");
    expect(sentence).not.toContain("locale");
  });

  it("omits the parenthetical when the provider is unknown", () => {
    const sentence = describeReceipt(
      v2Receipt({ model: { name: "mystery-model", provider: null, digest: null } }),
    );
    expect(sentence).toContain("«mystery-model»");
    expect(sentence).not.toContain("(");
  });

  it("falls back to the agent-based sentence for an llm_call with no model", () => {
    const withModel = describeReceipt(
      v2Receipt({ model: { name: "gpt-4o", provider: "openai", digest: null } }),
    );
    const withoutModel = describeReceipt({ ...v2Receipt(), v: 1 } as Receipt);
    expect(withoutModel).not.toEqual(withModel);
    expect(withoutModel).toContain("L'agente «planner»");
  });
});

describe("describeArtifact", () => {
  it("labels an input and an output differently", () => {
    expect(describeArtifact("input", "curriculum")).toBe("curriculum (usato in input)");
    expect(describeArtifact("output", "email di risposta")).toBe("email di risposta (prodotto in output)");
  });
});
