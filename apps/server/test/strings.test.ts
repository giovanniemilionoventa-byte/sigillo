import { describe, expect, it } from "vitest";
import type { Receipt } from "@sigillo/core";
import {
  artifactRoleWords,
  describeArtifact,
  describeReceipt,
  formatDay,
  formatTime,
  modelWhere,
  receiptSubtitle,
  receiptTitle,
  UI,
} from "../src/http/strings.js";

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

describe("receiptTitle: the short title of a row in the history (Interfaccia B)", () => {
  it("gives every kind its own title, and a tool's verb follows the outcome", () => {
    expect(receiptTitle(receipt({ action: { kind: "tool_call", name: "cerca_ordine" } }))).toBe("Ha usato «cerca_ordine»");
    expect(receiptTitle(receipt({ action: { kind: "tool_call", name: "rimborsa" }, outcome: "blocked" }))).toBe("Ha tentato «rimborsa»");
    expect(receiptTitle(receipt({ action: { kind: "decision", name: "escalation" } }))).toBe("Decisione «escalation»");
    expect(receiptTitle(receipt({ action: { kind: "agent_step", name: "saluto" } }))).toBe("Passo «saluto»");
    expect(receiptTitle(receipt({ action: { kind: "genesis", name: "acme" } }))).toBe("Registro aperto");
    expect(receiptTitle(receipt({ action: { kind: "llm_call", name: "chat" } }))).toBe("Chiamata a «chat»");
  });

  it("names the model when the receipt names one", () => {
    const withModel = { ...receipt({ action: { kind: "llm_call", name: "chat" } }), v: 2, model: { name: "llama3.1:8b", provider: "ollama", digest: null } } as Receipt;
    expect(receiptTitle(withModel)).toBe("Risposta da «llama3.1:8b»");
  });

  it("is never empty and never leaks a field name, for every kind and outcome", () => {
    for (const kind of KINDS) {
      for (const outcome of OUTCOMES) {
        const title = receiptTitle(receipt({ action: { kind, name: "x" }, outcome }));
        expect(title.length).toBeGreaterThan(0);
        expect(title).not.toContain("undefined");
      }
    }
  });
});

describe("receiptSubtitle: the line under a row's title", () => {
  it("lists the agent, where the model ran, on whose behalf, and the files", () => {
    const v3 = {
      ...receipt({ actor: { agent: "screener", on_behalf_of: "m.rossi" }, action: { kind: "llm_call", name: "chat" } }),
      v: 3,
      model: { name: "gpt-4o", provider: "openai", digest: null },
      artifacts: [{ role: "input", label: "candidato-01.txt", media_type: "text/plain", sha256: "c".repeat(64) }],
    } as Receipt;
    expect(receiptSubtitle(v3)).toBe("screener · modello openai · per conto di m.rossi · candidato-01.txt");
    expect(receiptSubtitle(receipt())).toBe("planner");
  });

  it("says whose register an opening is", () => {
    expect(receiptSubtitle(receipt({ action: { kind: "genesis", name: "acme" } }))).toBe("Apertura del registro di acme");
  });
});

describe("modelWhere", () => {
  it("says a local model runs locally, names any other provider, and says nothing when unknown", () => {
    expect(modelWhere("ollama")).toBe("in locale, con ollama");
    expect(modelWhere("vLLM")).toBe("in locale, con vLLM");
    expect(modelWhere("openai")).toBe("openai");
    expect(modelWhere(null)).toBeNull();
  });
});

describe("artifactRoleWords", () => {
  it("is the words describeArtifact puts in brackets", () => {
    expect(artifactRoleWords("input")).toBe("usato in input");
    expect(describeArtifact("output", "x")).toBe(`x (${artifactRoleWords("output")})`);
  });
});

describe("formatDay and formatTime: the history's day headings and times, in UTC", () => {
  it("names the weekday and the month in full", () => {
    expect(formatDay("2026-09-29T12:40:13.790Z")).toBe("martedì 29 settembre 2026");
    expect(formatDay("2026-03-01T23:59:59.000Z")).toBe("domenica 1 marzo 2026");
    expect(UI.history.dayUtc(formatDay("2026-10-01T00:00:00.000Z"))).toBe("giovedì 1 ottobre 2026 · ore UTC");
  });

  it("gives the time to the second, and leaves what does not parse as it is", () => {
    expect(formatTime("2026-09-29T12:40:13.790Z")).toBe("12:40:13");
    expect(formatDay("not a date")).toBe("not a date");
    expect(formatTime("not a date")).toBe("not a date");
  });
});

describe("the history's count", () => {
  it("agrees in number, and says when the list stops at the 200 most recent", () => {
    expect(UI.history.shown(1, false)).toBe("1 ricevuta");
    expect(UI.history.shown(0, false)).toBe("0 ricevute");
    expect(UI.history.shown(200, true)).toBe("200 ricevute (le 200 più recenti)");
  });
});

describe("the new texts of direction B", () => {
  it("have the three chain states, the export sheet, and the not-found page", () => {
    expect(UI.chain).toEqual({ green: "Registro integro", yellow: "Da controllare", red: "Verifica fallita" });
    expect(UI.exportSheet.title("Assistente clienti")).toBe("Genera il fascicolo di Assistente clienti");
    expect(UI.notFound.system("x")).toBe("Nessun sistema chiamato x.");
    expect(UI.system.receipts(1)).toBe("1 ricevuta");
    expect(UI.inspector.receiptNo(4)).toBe("Ricevuta n. 4");
    expect(UI.anchoring.at("1 ott 2026, 10:00:00 UTC")).toBe("con marca temporale del 1 ott 2026, 10:00:00 UTC");
  });

  it("use no exclamation marks and no emoji", () => {
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") texts.push(value);
      else if (typeof value === "function") texts.push(String((value as (...args: never[]) => string)(...([1, true] as never[]))));
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(UI);
    expect(texts.length).toBeGreaterThan(150);
    for (const text of texts) {
      expect(text, text).not.toContain("!");
      expect(text, text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
