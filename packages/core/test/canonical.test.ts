import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalReceiptBytes,
  GENESIS_PREV_HASH,
  hashCanonicalJson,
  receiptHash,
  receiptHashHex,
  toHex,
  type Receipt,
} from "@sigillo/core";

// Decodes to "placeholder-signature-not-verifiable-m1-vectors-see-FORMAT.md-01".
// M1 fixes the wire format only; real Ed25519 signatures arrive with the signer in M3.
const PLACEHOLDER_SIG =
  "cGxhY2Vob2xkZXItc2lnbmF0dXJlLW5vdC12ZXJpZmlhYmxlLW0xLXZlY3RvcnMtc2VlLUZPUk1BVC5tZC0wMQ==";

// The two canonical forms below were written by hand from RFC 8785 and their
// digests computed with Python hashlib and openssl, independently of this
// codebase. They are the anchor for everything else in the format.
const CANONICAL_GENESIS = String.raw`{"action":{"kind":"genesis","name":"acme-support-bot"},"actor":{"agent":"acme-support-bot"},"input_hash":null,"key_id":"3f2a1c9d8e7b6a5f","outcome":"ok","output_hash":null,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":0,"source":{"type":"api"},"system_id":"acme-support-bot","ts_event":"2026-03-29T14:30:00.123Z","ts_received":"2026-03-29T14:30:00.456Z","v":1}`;
const HASH_GENESIS = "f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543";

const CANONICAL_TOOL_CALL = String.raw`{"action":{"kind":"tool_call","name":"quote\" backslash\\ newline\n tab\t é☕"},"actor":{"agent":"café-agent ☕","on_behalf_of":"urn:user:42"},"input_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","key_id":"3f2a1c9d8e7b6a5f","outcome":"ok","output_hash":"7930b9c8f62bf831bf5d051ffa3e25051329b7148e0b8ee22a13b2d8cd0cfb1e","prev_hash":"f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543","seq":7,"source":{"span_id":"00f067aa0ba902b7","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","type":"otlp"},"system_id":"acme-support-bot","ts_event":"2026-03-29T14:31:02.000Z","ts_received":"2026-03-29T14:31:02.004Z","v":1}`;
const HASH_TOOL_CALL = "7d4c012657b39ef1dcc64c67c53c04343dcadedd59d01c3a8214410c6ddab4e9";

const genesisReceipt: Receipt = {
  v: 1,
  system_id: "acme-support-bot",
  seq: 0,
  ts_event: "2026-03-29T14:30:00.123Z",
  ts_received: "2026-03-29T14:30:00.456Z",
  actor: { agent: "acme-support-bot" },
  action: { kind: "genesis", name: "acme-support-bot" },
  input_hash: null,
  output_hash: null,
  outcome: "ok",
  source: { type: "api" },
  prev_hash: GENESIS_PREV_HASH,
  key_id: "3f2a1c9d8e7b6a5f",
  sig: PLACEHOLDER_SIG,
};

const toolCallReceipt: Receipt = {
  v: 1,
  system_id: "acme-support-bot",
  seq: 7,
  ts_event: "2026-03-29T14:31:02.000Z",
  ts_received: "2026-03-29T14:31:02.004Z",
  actor: { agent: "café-agent ☕", on_behalf_of: "urn:user:42" },
  action: { kind: "tool_call", name: 'quote" backslash\\ newline\n tab\t é☕' },
  input_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  output_hash: "7930b9c8f62bf831bf5d051ffa3e25051329b7148e0b8ee22a13b2d8cd0cfb1e",
  outcome: "ok",
  source: {
    type: "otlp",
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
  },
  prev_hash: HASH_GENESIS,
  key_id: "3f2a1c9d8e7b6a5f",
  sig: PLACEHOLDER_SIG,
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonical receipt bytes", () => {
  it("matches the hand-written RFC 8785 form of the genesis receipt", () => {
    expect(decode(canonicalReceiptBytes(genesisReceipt))).toBe(CANONICAL_GENESIS);
  });

  it("matches the hand-written RFC 8785 form with escapes and non-ASCII text", () => {
    expect(decode(canonicalReceiptBytes(toolCallReceipt))).toBe(CANONICAL_TOOL_CALL);
  });

  it("encodes as UTF-8, not UTF-16 or escaped ASCII", () => {
    expect(canonicalReceiptBytes(genesisReceipt)).toHaveLength(399);
    // 654 bytes for 648 characters: é is 2 bytes and ☕ is 3, twice over.
    expect(canonicalReceiptBytes(toolCallReceipt)).toHaveLength(654);
    expect(CANONICAL_TOOL_CALL).toHaveLength(648);
  });

  it("excludes the sig field, so a receipt can be hashed before it is signed", () => {
    expect(decode(canonicalReceiptBytes(genesisReceipt))).not.toContain("sig");
    const { sig: _sig, ...unsigned } = genesisReceipt;
    expect(decode(canonicalReceiptBytes(unsigned))).toBe(CANONICAL_GENESIS);
  });
});

describe("receipt hash", () => {
  it("matches digests computed independently with hashlib and openssl", () => {
    expect(receiptHashHex(genesisReceipt)).toBe(HASH_GENESIS);
    expect(receiptHashHex(toolCallReceipt)).toBe(HASH_TOOL_CALL);
  });

  it("returns the 32 raw bytes that Ed25519 signs", () => {
    const digest = receiptHash(genesisReceipt);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest).toHaveLength(32);
    expect(toHex(digest)).toBe(HASH_GENESIS);
  });

  it("is unchanged when the keys are supplied in a different order", () => {
    const reordered: Receipt = {
      sig: genesisReceipt.sig,
      key_id: genesisReceipt.key_id,
      prev_hash: genesisReceipt.prev_hash,
      source: { type: genesisReceipt.source.type },
      outcome: genesisReceipt.outcome,
      output_hash: genesisReceipt.output_hash,
      input_hash: genesisReceipt.input_hash,
      action: { name: genesisReceipt.action.name, kind: genesisReceipt.action.kind },
      actor: { agent: genesisReceipt.actor.agent },
      ts_received: genesisReceipt.ts_received,
      ts_event: genesisReceipt.ts_event,
      seq: genesisReceipt.seq,
      system_id: genesisReceipt.system_id,
      v: genesisReceipt.v,
    };
    expect(receiptHashHex(reordered)).toBe(HASH_GENESIS);
  });

  it("is unchanged when only the signature changes", () => {
    const resigned: Receipt = { ...genesisReceipt, sig: `B${PLACEHOLDER_SIG.slice(1)}` };
    expect(receiptHashHex(resigned)).toBe(HASH_GENESIS);
  });

  it("changes when a single character of any signed field changes", () => {
    const mutations: Receipt[] = [
      { ...genesisReceipt, system_id: "acme-support-bou" },
      { ...genesisReceipt, seq: 1 },
      { ...genesisReceipt, ts_event: "2026-03-29T14:30:00.124Z" },
      { ...genesisReceipt, ts_received: "2026-03-29T14:30:00.457Z" },
      { ...genesisReceipt, outcome: "error" },
      { ...genesisReceipt, key_id: "3f2a1c9d8e7b6a50" },
      { ...genesisReceipt, prev_hash: `${GENESIS_PREV_HASH.slice(0, 63)}1` },
      { ...genesisReceipt, actor: { agent: "acme-support-bou" } },
      { ...genesisReceipt, action: { kind: "genesis", name: "acme-support-bou" } },
      { ...genesisReceipt, source: { type: "sdk" } },
      { ...genesisReceipt, input_hash: HASH_GENESIS },
      { ...genesisReceipt, output_hash: HASH_GENESIS },
    ];
    for (const mutated of mutations) {
      expect(receiptHashHex(mutated)).not.toBe(HASH_GENESIS);
    }
    const digests = new Set(mutations.map((receipt) => receiptHashHex(receipt)));
    expect(digests.size).toBe(mutations.length);
  });

  it("changes when the schema version changes", () => {
    // A v2 receipt is not a valid v1 receipt, but it must never collide with one.
    const nextVersion = { ...genesisReceipt, v: 2 } as unknown as Receipt;
    expect(receiptHashHex(nextVersion)).not.toBe(HASH_GENESIS);
  });

  it("distinguishes an absent optional field from an empty one", () => {
    const withEmptyPrincipal: Receipt = {
      ...genesisReceipt,
      actor: { agent: "acme-support-bot", on_behalf_of: "" },
    };
    expect(receiptHashHex(withEmptyPrincipal)).not.toBe(HASH_GENESIS);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys by UTF-16 code unit, at every depth", () => {
    expect(canonicalJson({ b: 1, a: 2, A: 3, _: 4 })).toBe('{"A":3,"_":4,"a":2,"b":1}');
    expect(canonicalJson({ outer: { z: 1, a: { y: 1, b: 2 } } })).toBe(
      '{"outer":{"a":{"b":2,"y":1},"z":1}}',
    );
  });

  it("treats a key set to undefined as absent, the way JSON does", () => {
    expect(canonicalJson({ agent: "x", on_behalf_of: undefined })).toBe(canonicalJson({ agent: "x" }));
  });

  it("emits non-ASCII text literally and escapes control characters", () => {
    expect(canonicalJson({ s: "café ☕" })).toBe('{"s":"café ☕"}');
    expect(canonicalJson({ s: "\u0001" })).toBe(String.raw`{"s":"\u0001"}`);
    expect(canonicalJson({ s: '"\\\n\t' })).toBe(String.raw`{"s":"\"\\\n\t"}`);
  });

  it("rejects values that cannot be canonicalised", () => {
    expect(() => canonicalJson(undefined)).toThrow(/canonical/i);
    expect(() => canonicalJson(() => undefined)).toThrow(/canonical/i);
  });
});

describe("hashCanonicalJson", () => {
  it("hashes the canonical form, so payload hashes do not depend on key order", () => {
    // sha256 of {"a":1,"b":2} computed with: printf '%s' '{"a":1,"b":2}' | openssl dgst -sha256
    const expected = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
    expect(hashCanonicalJson({ a: 1, b: 2 })).toBe(expected);
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(expected);
  });

  it("hashes the canonical JSON text, not the raw value", () => {
    // An empty JSON string canonicalises to the two characters `""`, so its
    // digest is not the digest of zero bytes.
    expect(hashCanonicalJson("")).toBe(
      "12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126",
    );
    expect(hashCanonicalJson("")).not.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hashCanonicalJson({ s: "café ☕" })).toBe(
      "e48d2e238d662d54921c056d0c7fcb1b33f5ca156970f163369a0ed9607023b0",
    );
  });
});
