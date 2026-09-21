import { describe, expect, it } from "vitest";
import {
  GENESIS_PREV_HASH,
  parseReceipt,
  RECEIPT_VERSION,
  safeParseReceipt,
  type Receipt,
} from "@sigillo/core";

const SIG =
  "cGxhY2Vob2xkZXItc2lnbmF0dXJlLW5vdC12ZXJpZmlhYmxlLW0xLXZlY3RvcnMtc2VlLUZPUk1BVC5tZC0wMQ==";
const HASH = "f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543";

function validReceipt(): Receipt {
  return {
    v: 1,
    system_id: "acme-support-bot",
    seq: 3,
    ts_event: "2026-03-29T14:30:00.123Z",
    ts_received: "2026-03-29T14:30:00.456Z",
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: "search_orders" },
    input_hash: HASH,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    prev_hash: HASH,
    key_id: "3f2a1c9d8e7b6a5f",
    sig: SIG,
  };
}

/** Builds an invalid receipt without fighting the compile-time types. */
function withField(field: string, value: unknown): unknown {
  return { ...validReceipt(), [field]: value };
}

function expectRejected(value: unknown, pathFragment: string): void {
  const result = safeParseReceipt(value);
  expect(result.ok, `expected rejection mentioning ${pathFragment}`).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(pathFragment);
}

describe("receipt schema", () => {
  it("accepts a well-formed receipt", () => {
    const result = safeParseReceipt(validReceipt());
    expect(result.ok).toBe(true);
    expect(parseReceipt(validReceipt())).toEqual(validReceipt());
  });

  it("accepts every action kind and outcome in the format", () => {
    for (const kind of ["tool_call", "llm_call", "agent_step", "decision", "genesis"]) {
      expect(safeParseReceipt(withField("action", { kind, name: "x" })).ok).toBe(true);
    }
    for (const outcome of ["ok", "error", "blocked", "unknown"]) {
      expect(safeParseReceipt(withField("outcome", outcome)).ok).toBe(true);
    }
    for (const type of ["otlp", "sdk", "api"]) {
      expect(safeParseReceipt(withField("source", { type })).ok).toBe(true);
    }
  });

  it("accepts the optional fields when present and when absent", () => {
    expect(
      safeParseReceipt(withField("actor", { agent: "planner", on_behalf_of: "urn:user:42" })).ok,
    ).toBe(true);
    expect(
      safeParseReceipt(
        withField("source", {
          type: "otlp",
          trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
          span_id: "00f067aa0ba902b7",
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects unknown fields, which would otherwise ride along unsigned-looking", () => {
    expectRejected({ ...validReceipt(), note: "smuggled" }, "note");
    expectRejected(withField("actor", { agent: "planner", role: "admin" }), "actor");
  });

  it("rejects missing mandatory fields", () => {
    for (const field of [
      "v",
      "system_id",
      "seq",
      "ts_event",
      "ts_received",
      "actor",
      "action",
      "input_hash",
      "output_hash",
      "outcome",
      "source",
      "prev_hash",
      "key_id",
      "sig",
    ]) {
      const receipt: Record<string, unknown> = { ...validReceipt() };
      delete receipt[field];
      expectRejected(receipt, field);
    }
  });

  it("rejects a sequence number that is not a whole number at or above zero", () => {
    for (const seq of [-1, 1.5, Number.NaN, "3", null]) {
      expectRejected(withField("seq", seq), "seq");
    }
  });

  it("rejects hashes that are not 64 lowercase hex characters", () => {
    for (const bad of [HASH.slice(0, 63), `${HASH}a`, HASH.toUpperCase(), "z".repeat(64), "", 1]) {
      expectRejected(withField("prev_hash", bad), "prev_hash");
      expectRejected(withField("input_hash", bad), "input_hash");
    }
    expectRejected(withField("prev_hash", null), "prev_hash");
    expect(safeParseReceipt(withField("input_hash", null)).ok).toBe(true);
  });

  it("rejects a key_id that is not 16 lowercase hex characters", () => {
    for (const bad of ["3f2a1c9d8e7b6a5", "3f2a1c9d8e7b6a5ff", "3F2A1C9D8E7B6A5F", "not-hex-at-all"]) {
      expectRejected(withField("key_id", bad), "key_id");
    }
  });

  it("rejects a signature that is not 64 bytes of standard base64", () => {
    for (const bad of [
      SIG.slice(0, 87),
      `${SIG}A`,
      SIG.replace("+", "-").replace("/", "_").slice(0, 86) + "..",
      "",
    ]) {
      expectRejected(withField("sig", bad), "sig");
    }
  });

  it("rejects a signature in a non-canonical spelling of the same bytes", () => {
    // The last base64 character before the padding carries four bits that
    // decoding ignores, so several spellings decode to the same 64 bytes.
    // Without this rule an evidence file would have more than one valid form
    // for one signature, and a byte comparison of two exports would be
    // meaningless.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const signed = Buffer.from(SIG, "base64");

    const equivalents = [...alphabet]
      .map((character) => `${SIG.slice(0, 85)}${character}==`)
      .filter(
        (candidate) => candidate !== SIG && Buffer.from(candidate, "base64").equals(signed),
      );

    expect(equivalents.length).toBeGreaterThan(0);
    for (const restyled of equivalents) {
      expectRejected(withField("sig", restyled), "sig");
    }
    expect(safeParseReceipt(withField("sig", SIG)).ok).toBe(true);
  });

  it("rejects timestamps that are not ISO-8601 UTC with milliseconds", () => {
    for (const bad of [
      "2026-03-29T14:30:00Z",
      "2026-03-29T14:30:00.123+00:00",
      "2026-03-29T14:30:00.123456Z",
      "2026-03-29 14:30:00.123Z",
      "2026-13-29T14:30:00.123Z",
      "2026-02-30T14:30:00.123Z",
      "not a timestamp",
    ]) {
      expectRejected(withField("ts_event", bad), "ts_event");
      expectRejected(withField("ts_received", bad), "ts_received");
    }
  });

  it("rejects trace and span identifiers that are not OTLP-shaped hex", () => {
    expectRejected(withField("source", { type: "otlp", trace_id: "nope" }), "trace_id");
    expectRejected(withField("source", { type: "otlp", span_id: "00f067aa0ba902" }), "span_id");
  });

  it("rejects empty and oversized free-text fields, which must not carry content", () => {
    expectRejected(withField("system_id", ""), "system_id");
    expectRejected(withField("action", { kind: "tool_call", name: "" }), "action");
    expectRejected(withField("actor", { agent: "" }), "actor");
    expectRejected(withField("action", { kind: "tool_call", name: "x".repeat(257) }), "action");
    expectRejected(withField("system_id", "x".repeat(129)), "system_id");
  });

  it("rejects values that are not objects at all", () => {
    for (const bad of [null, undefined, 42, "receipt", []]) {
      expect(safeParseReceipt(bad).ok).toBe(false);
    }
  });

  it("refuses to parse a schema version it does not implement", () => {
    expectRejected(withField("v", RECEIPT_VERSION + 1), "v");
    expectRejected(withField("v", 0), "v");
    expect(() => parseReceipt(withField("v", 2))).toThrow(/version/i);
  });

  it("reports the failing field so a verifier can name it", () => {
    const result = safeParseReceipt(withField("prev_hash", "short"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/prev_hash/);
    expect(result.error).toMatch(/64/);
  });
});

describe("genesis receipt", () => {
  it("uses 64 zeros as the previous hash", () => {
    expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
    expect(
      safeParseReceipt({
        ...validReceipt(),
        seq: 0,
        action: { kind: "genesis", name: "acme-support-bot" },
        prev_hash: GENESIS_PREV_HASH,
      }).ok,
    ).toBe(true);
  });
});
