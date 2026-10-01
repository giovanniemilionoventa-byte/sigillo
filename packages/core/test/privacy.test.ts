import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  hashCanonicalJson,
  HASH_SCHEME_PLAIN,
  HASH_SCHEME_SALTED,
  isPseudonym,
  openSaltedDigest,
  pseudonymFromRandom,
  receiptHashHex,
  RECEIPT_VERSION_4,
  safeParseReceipt,
  saltedDigest,
  SALT_NONCE_BYTES,
  type ReceiptV4,
} from "@sigillo/core";
import { randomBytes } from "node:crypto";

/**
 * Receipt version 4: no personal identifier in the clear, and input/output
 * digests that cannot be reversed by guessing, nor linked across receipts.
 * Every digest here is real SHA-256 from node:crypto, and the fixed vector was
 * computed with Python's hashlib, outside this code base.
 */

const SIG =
  "cGxhY2Vob2xkZXItc2lnbmF0dXJlLW5vdC12ZXJpZmlhYmxlLW0xLXZlY3RvcnMtc2VlLUZPUk1BVC5tZC0wMQ==";
const HASH = "f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543";
const TOKEN = "psn_0123456789abcdef0123456789abcdef";

/** bytes 0x00..0x1f */
const FIXED_NONCE = Uint8Array.from({ length: 32 }, (_, index) => index);
/**
 * python3 -c "import hashlib; print(hashlib.sha256(bytes(range(32)) + b'\"score: 7\"').hexdigest())"
 */
const SALTED_SCORE_7 = "0de84395a90cb98f917231a13f03446f21af13e0c18d18f073f32417d119e0ac";
/** python3 -c "import hashlib; print(hashlib.sha256(b'\"score: 7\"').hexdigest())" */
const PLAIN_SCORE_7 = "ee57ba52c06d0f98e05f7685c4993b57a3290eacc5432af9c8fcf18924c12764";

function validV4(): ReceiptV4 {
  return {
    v: RECEIPT_VERSION_4,
    system_id: "selezione-cv",
    seq: 3,
    ts_event: "2026-10-01T09:00:00.000Z",
    ts_received: "2026-10-01T09:00:00.100Z",
    actor: { agent: "agente-cv", on_behalf_of: TOKEN },
    action: { kind: "tool_call", name: "valuta_candidato" },
    input_hash: HASH,
    input_hash_scheme: HASH_SCHEME_SALTED,
    output_hash: null,
    output_hash_scheme: null,
    outcome: "ok",
    source: { type: "otlp" },
    prev_hash: HASH,
    key_id: "3f2a1c9d8e7b6a5f",
    sig: SIG,
  };
}

function expectRejected(value: unknown, pathFragment: string): void {
  const result = safeParseReceipt(value);
  expect(result.ok, `expected rejection mentioning ${pathFragment}`).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(pathFragment);
}

describe("salted digests", () => {
  it("is SHA-256 of the 32-byte nonce followed by the value's canonical JSON", () => {
    expect(saltedDigest(FIXED_NONCE, "score: 7")).toBe(SALTED_SCORE_7);
    const independent = createHash("sha256")
      .update(FIXED_NONCE)
      .update(canonicalBytes({ esito: "idoneo", punteggio: 7 }))
      .digest("hex");
    expect(saltedDigest(FIXED_NONCE, { punteggio: 7, esito: "idoneo" })).toBe(independent);
  });

  it("is a plain digest of the same value only when computed without the nonce", () => {
    expect(hashCanonicalJson("score: 7")).toBe(PLAIN_SCORE_7);
    expect(saltedDigest(FIXED_NONCE, "score: 7")).not.toBe(PLAIN_SCORE_7);
  });

  it("gives the same content a different digest under every nonce", () => {
    const digests = new Set(Array.from({ length: 50 }, () => saltedDigest(randomBytes(SALT_NONCE_BYTES), "score: 7")));
    expect(digests.size).toBe(50);
  });

  it("cannot be found by guessing short content without the nonce", () => {
    const recorded = saltedDigest(randomBytes(SALT_NONCE_BYTES), "score: 7");
    const guesses = [];
    for (let score = 0; score <= 100; score += 1) guesses.push(`score: ${score}`, `score:${score}`, String(score));
    for (const outcome of ["idoneo", "non idoneo", "ok", "ko", "sì", "no"]) guesses.push(outcome);
    // The guesser's best move without the nonce: the plain digest of every guess.
    expect(guesses.map((guess) => hashCanonicalJson(guess))).not.toContain(recorded);
    // A plain digest of the same content is found by the same guesses at once.
    expect(guesses.map((guess) => hashCanonicalJson(guess))).toContain(hashCanonicalJson("score: 7"));
  });

  it("opens with the right nonce and content, and with nothing else", () => {
    const nonce = randomBytes(SALT_NONCE_BYTES);
    const digest = saltedDigest(nonce, "score: 7");
    expect(openSaltedDigest(digest, nonce, "score: 7")).toBe(true);
    expect(openSaltedDigest(digest, nonce, "score: 8")).toBe(false);
    expect(openSaltedDigest(digest, randomBytes(SALT_NONCE_BYTES), "score: 7")).toBe(false);
    expect(openSaltedDigest(digest.toUpperCase(), nonce, "score: 7")).toBe(false);
  });

  it("refuses a nonce that is not exactly 32 bytes", () => {
    expect(() => saltedDigest(new Uint8Array(16), "x")).toThrow(/32 bytes/);
    expect(() => saltedDigest(new Uint8Array(33), "x")).toThrow(/32 bytes/);
    expect(openSaltedDigest(SALTED_SCORE_7, FIXED_NONCE.slice(1), "score: 7")).toBe(false);
  });
});

describe("pseudonym tokens", () => {
  it("is psn_ followed by 128 random bits in lowercase hex", () => {
    const token = pseudonymFromRandom(Uint8Array.from({ length: 16 }, (_, index) => index * 16));
    expect(token).toBe("psn_00102030405060708090a0b0c0d0e0f0");
    expect(isPseudonym(token)).toBe(true);
  });

  it("refuses anything but 16 bytes of randomness", () => {
    expect(() => pseudonymFromRandom(new Uint8Array(15))).toThrow(/16 bytes/);
    expect(() => pseudonymFromRandom(new Uint8Array(32))).toThrow(/16 bytes/);
  });

  it("recognises only the exact shape", () => {
    expect(isPseudonym(TOKEN)).toBe(true);
    for (const value of ["elena.rizzo", "psn_", `${TOKEN}0`, TOKEN.toUpperCase(), `p:${"a".repeat(32)}`, ` ${TOKEN}`]) {
      expect(isPseudonym(value), value).toBe(false);
    }
  });
});

describe("receipt schema version 4", () => {
  it("accepts a receipt with a pseudonym and a salted input digest", () => {
    const result = safeParseReceipt(validV4());
    expect(result.ok ? "" : result.error).toBe("");
  });

  it("accepts a receipt with no on_behalf_of, and both schemes", () => {
    const { actor: _actor, ...rest } = validV4();
    const receipt = {
      ...rest,
      actor: { agent: "agente-cv" },
      output_hash: HASH,
      output_hash_scheme: HASH_SCHEME_PLAIN,
    };
    expect(safeParseReceipt(receipt).ok).toBe(true);
  });

  it("refuses an identifier in the clear: on_behalf_of must be a pseudonym token", () => {
    expectRejected({ ...validV4(), actor: { agent: "agente-cv", on_behalf_of: "elena.rizzo" } }, "actor.on_behalf_of");
    expectRejected({ ...validV4(), actor: { agent: "agente-cv", on_behalf_of: `p:${"a".repeat(32)}` } }, "actor.on_behalf_of");
  });

  it("requires a scheme exactly when there is a digest", () => {
    expectRejected({ ...validV4(), input_hash_scheme: null }, "input_hash_scheme");
    expectRejected({ ...validV4(), output_hash_scheme: HASH_SCHEME_PLAIN }, "output_hash_scheme");
    expectRejected({ ...validV4(), input_hash_scheme: "sha256" }, "input_hash_scheme");
    const { input_hash_scheme: _scheme, ...missing } = validV4();
    expectRejected(missing, "input_hash_scheme");
  });

  it("keeps versions 1 to 3 closed to the scheme members, and open to a clear on_behalf_of as they always were", () => {
    const { input_hash_scheme: _i, output_hash_scheme: _o, ...rest } = validV4();
    for (const v of [1, 2, 3]) {
      expect(safeParseReceipt({ ...rest, v, actor: { agent: "a", on_behalf_of: "elena.rizzo" } }).ok, `v${v}`).toBe(true);
      expectRejected({ ...validV4(), v }, "Unrecognized key(s)");
    }
  });

  it("covers the scheme with the receipt hash: plain and salted are different claims", () => {
    const salted = validV4();
    const plain = { ...validV4(), input_hash_scheme: HASH_SCHEME_PLAIN };
    expect(receiptHashHex(salted)).not.toBe(receiptHashHex(plain));
  });
});
