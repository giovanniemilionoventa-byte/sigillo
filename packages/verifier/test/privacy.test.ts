import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HASH_SCHEME_PLAIN, HASH_SCHEME_SALTED, hashCanonicalJson, saltedDigest, toHex } from "@sigillo/core";
import { openDigest, verifyBundle, type Bundle } from "../src/verify.js";
import { buildManifest, buildReceipts, createIdentity, toBundle } from "./helpers/chain.js";

/**
 * Receipt version 4 in an export: v2 receipts beside it still verify, a v4
 * receipt that names a person in the clear does not, and the two optional
 * disclosure files (openings.jsonl, subjects.jsonl) are checked against the
 * receipts rather than taken as given.
 */

const identity = createIdentity();
const TOKEN = "psn_0123456789abcdef0123456789abcdef";
const NONCE = randomBytes(32);
const SALTED = saltedDigest(NONCE, "score: 7");
const PLAIN = hashCanonicalJson("idoneo");

/** seq 0 genesis (v1), 1 a v2 receipt with an artifact, 2 a v4 one with a salted input, 3 a v4 one with a plain output. */
function mixedChain(): Bundle {
  const receipts = buildReceipts(4, identity, "selezione-cv", [
    undefined,
    {
      v: 2,
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) }],
      fields: { actor: { agent: "agente", on_behalf_of: "elena.rizzo" } },
    },
    {
      v: 4,
      fields: { actor: { agent: "agente", on_behalf_of: TOKEN }, input_hash: SALTED, input_hash_scheme: HASH_SCHEME_SALTED },
    },
    { v: 4, fields: { output_hash: PLAIN, output_hash_scheme: HASH_SCHEME_PLAIN } },
  ]);
  return toBundle(receipts, buildManifest(receipts, identity));
}

function failure(bundle: Bundle): string {
  const result = verifyBundle(bundle);
  return result.ok ? "ok" : `${result.check} at ${result.location}: ${result.detail}`;
}

describe("version 4 receipts in an export", () => {
  it("verifies a chain that mixes v1, v2 and v4 receipts: v2 stays valid", () => {
    const result = verifyBundle(mixedChain());
    expect(result.ok ? "ok" : result.detail).toBe("ok");
    if (!result.ok) return;
    expect(result.receipts.map((receipt) => receipt.v)).toEqual([1, 2, 4, 4]);
    expect(JSON.parse(mixedChain().manifestJson).receipt_version).toBe(4);
  });

  it("refuses a v4 receipt that names a person in the clear, even correctly signed", () => {
    const receipts = buildReceipts(2, identity, "selezione-cv", [
      undefined,
      { v: 4, fields: { actor: { agent: "agente", on_behalf_of: "elena.rizzo" } } },
    ]);
    expect(failure(toBundle(receipts, buildManifest(receipts, identity)))).toMatch(/^receipt-schema at receipts.jsonl:2: actor.on_behalf_of/);
  });
});

describe("openings.jsonl", () => {
  const withOpenings = (lines: unknown[]): Bundle => ({
    ...mixedChain(),
    openingsJsonl: lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  });

  it("accepts a nonce for a salted digest, and counts it", () => {
    const result = verifyBundle(withOpenings([{ seq: 2, role: "input", nonce: toHex(NONCE) }]));
    expect(result.ok ? "ok" : result.detail).toBe("ok");
    if (result.ok) expect(result.summary.openings_disclosed).toBe(1);
  });

  it("refuses a nonce for a digest that is not salted, or for a receipt not in the export", () => {
    expect(failure(withOpenings([{ seq: 3, role: "output", nonce: toHex(NONCE) }]))).toMatch(/^openings at openings.jsonl:1: .*not a salted digest/);
    expect(failure(withOpenings([{ seq: 2, role: "output", nonce: toHex(NONCE) }]))).toMatch(/^openings at openings.jsonl:1/);
    expect(failure(withOpenings([{ seq: 9, role: "input", nonce: toHex(NONCE) }]))).toMatch(/^openings at openings.jsonl:1: .*seq 9/);
  });

  it("refuses a malformed line and a repeated one", () => {
    expect(failure(withOpenings([{ seq: 2, role: "input", nonce: "abc" }]))).toMatch(/^openings at openings.jsonl:1: nonce/);
    expect(failure(withOpenings([{ seq: 2, role: "input", nonce: toHex(NONCE), extra: 1 }]))).toMatch(/^openings at openings.jsonl:1/);
    const line = { seq: 2, role: "input", nonce: toHex(NONCE) };
    expect(failure(withOpenings([line, line]))).toMatch(/^openings at openings.jsonl:2: .*twice/);
  });
});

describe("subjects.jsonl", () => {
  const withSubjects = (lines: unknown[]): Bundle => ({
    ...mixedChain(),
    subjectsJsonl: lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  });

  it("accepts the identifier of a token the receipts use, and counts it", () => {
    const result = verifyBundle(withSubjects([{ token: TOKEN, identifier: "elena.rizzo" }]));
    expect(result.ok ? "ok" : result.detail).toBe("ok");
    if (result.ok) expect(result.summary.subjects_disclosed).toBe(1);
  });

  it("refuses a token no receipt in the export uses, a malformed one, and a repeated one", () => {
    expect(failure(withSubjects([{ token: `psn_${"f".repeat(32)}`, identifier: "x" }]))).toMatch(/^subjects at subjects.jsonl:1: .*no receipt/);
    expect(failure(withSubjects([{ token: "elena.rizzo", identifier: "x" }]))).toMatch(/^subjects at subjects.jsonl:1: token/);
    const line = { token: TOKEN, identifier: "elena.rizzo" };
    expect(failure(withSubjects([line, line]))).toMatch(/^subjects at subjects.jsonl:2: .*twice/);
  });

  it("an export without either file says nothing about anyone: both counts are zero", () => {
    const result = verifyBundle(mixedChain());
    expect(result.ok && result.summary.openings_disclosed + result.summary.subjects_disclosed).toBe(0);
  });
});

describe("opening a salted digest", () => {
  const receipts = (): ReturnType<typeof buildReceipts> => {
    const result = verifyBundle(mixedChain());
    if (!result.ok) throw new Error(result.detail);
    return result.receipts;
  };

  it("matches with the right nonce and content", () => {
    expect(openDigest(receipts(), 2, "input", NONCE, "score: 7")).toEqual({ ok: true, scheme: "salted" });
  });

  it("does not match other content, or the right content under another nonce", () => {
    expect(openDigest(receipts(), 2, "input", NONCE, "score: 8").ok).toBe(false);
    expect(openDigest(receipts(), 2, "input", randomBytes(32), "score: 7").ok).toBe(false);
  });

  it("opens a plain digest without a nonce, and says why it cannot open what is not there", () => {
    expect(openDigest(receipts(), 3, "output", null, "idoneo")).toEqual({ ok: true, scheme: "plain" });
    expect(openDigest(receipts(), 2, "input", null, "score: 7")).toMatchObject({ ok: false, reason: expect.stringMatching(/nonce/) });
    expect(openDigest(receipts(), 9, "input", NONCE, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/seq 9/) });
    expect(openDigest(receipts(), 3, "input", NONCE, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/no input/) });
  });
});
