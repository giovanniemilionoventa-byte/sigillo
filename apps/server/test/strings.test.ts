import { describe, expect, it } from "vitest";
import type { Receipt } from "@sigillo/core";
import {
  artifactRoleWords,
  describeArtifact,
  describeReceipt,
  formatClock,
  formatCount,
  formatDay,
  formatDayHeading,
  formatTime,
  formatTs,
  formatWhen,
  formatWhenInline,
  localDayRange,
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

describe("formatDay and formatTime: the history's day headings and times, in Italian time", () => {
  it("names the weekday and the month in full, of the day in Italy", () => {
    expect(formatDay("2026-09-29T12:40:13.790Z")).toBe("martedì 29 settembre 2026");
    // 23:59 UTC on 1 March is already 2 March in Rome.
    expect(formatDay("2026-03-01T23:59:59.000Z")).toBe("lunedì 2 marzo 2026");
  });

  it("gives the time to the second, summer and winter, and leaves what does not parse as it is", () => {
    expect(formatTime("2026-10-02T17:54:37.120Z")).toBe("19:54:37");
    expect(formatTime("2026-01-15T17:54:37.120Z")).toBe("18:54:37");
    expect(formatDay("not a date")).toBe("not a date");
    expect(formatTime("not a date")).toBe("not a date");
  });
});

describe("formatTs: a server timestamp in Italian time, its zone named", () => {
  it("shows summer time as CEST and winter time as CET", () => {
    expect(formatTs("2026-10-02T17:54:37.120Z")).toBe("2 ott 2026, 19:54:37 CEST");
    expect(formatTs("2026-12-31T23:30:00.000Z")).toBe("1 gen 2027, 00:30:00 CET");
  });

  it("leaves what does not parse as it is", () => {
    expect(formatTs("not a date")).toBe("not a date");
    expect(formatTs("2026-13-45T99:00:00Z")).toBe("2026-13-45T99:00:00Z");
  });
});

describe("localDayRange: a day picked in the filter is that day in Italy", () => {
  it("runs from local midnight to local midnight, across a change of clock too", () => {
    expect(localDayRange("2026-10-02")).toEqual({ from: "2026-10-01T22:00:00.000Z", to: "2026-10-02T21:59:59.999Z" });
    expect(localDayRange("2026-01-15")).toEqual({ from: "2026-01-14T23:00:00.000Z", to: "2026-01-15T22:59:59.999Z" });
    // The last Sunday of October has 25 hours.
    expect(localDayRange("2026-10-25")).toEqual({ from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T22:59:59.999Z" });
  });
});

describe("formatWhen and its kin: times as people say them, in Italian time", () => {
  const now = new Date("2026-10-01T12:44:00.000Z"); // 14:44 in Rome

  it("says today and yesterday by name, and gives the date otherwise", () => {
    expect(formatWhen("2026-10-01T12:44:10.000Z", now)).toBe("Oggi, 14:44");
    expect(formatWhen("2026-09-30T20:03:00.000Z", now)).toBe("Ieri, 22:03");
    expect(formatWhen("2026-09-29T16:03:00.000Z", now)).toBe("29 set 2026, 18:03");
    // 23:30 UTC on 30 September is already 1 October in Rome: today.
    expect(formatWhen("2026-09-30T23:30:00.000Z", now)).toBe("Oggi, 01:30");
    expect(formatWhenInline("2026-10-01T12:44:10.000Z", now)).toBe("oggi alle 14:44");
  });

  it("heads a day of the history with its weekday, and names today", () => {
    expect(formatDayHeading("2026-10-01T08:00:00.000Z", now)).toBe("Oggi · giovedì 1 ottobre");
    expect(formatDayHeading("2026-09-29T08:00:00.000Z", now)).toBe("martedì 29 settembre 2026");
    expect(formatClock("2026-10-02T17:54:37.120Z")).toBe("19:54");
  });

  it("groups thousands the Italian way, from four digits up", () => {
    expect(formatCount(2840)).toBe("2.840");
    expect(formatCount(10000)).toBe("10.000");
    expect(formatCount(7)).toBe("7");
  });
});

describe("the texts of the simple design", () => {
  it("have the three chain states, the export sheet, and the receipt's number", () => {
    expect(UI.chain).toEqual({ green: "Integro", yellow: "Da controllare", red: "Verifica fallita" });
    expect(UI.exportSheet.title("Assistente clienti")).toBe("Fascicolo di Assistente clienti");
    expect(UI.inspector.receiptNo(4)).toBe("Ricevuta n. 4");
    expect(UI.anchoring.at("1 ott 2026, 10:00:00 CEST")).toBe("Marca temporale del 1 ott 2026, 10:00:00 CEST");
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
