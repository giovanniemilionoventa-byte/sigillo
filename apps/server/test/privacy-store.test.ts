import { verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromHex,
  hashCanonicalJson,
  HASH_SCHEME_PLAIN,
  HASH_SCHEME_SALTED,
  isPseudonym,
  openSaltedDigest,
  receiptHash,
  type Receipt,
  type ReceiptV4,
  type UnsignedReceipt,
} from "@sigillo/core";
import { normaliseSubjectIdentifier, ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Receipt version 4 as the store writes it: identifiers replaced by
 * pseudonym tokens kept in the erasable `subjects` table, content received in
 * the clear hashed under a nonce kept in the erasable `openings` table, and
 * both erasures written to the administrative log by token or position only.
 * A real SQLite file and a real Ed25519 signer throughout.
 */

const SYSTEM = "selezione-cv";
const OTHER = "assistenza-clienti";
const PERSON = "elena.rizzo";
const ADMIN = { actor: "cli test@host", ts: "2026-10-01T12:00:00.000Z" };

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-privacy-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-10-01T08:00:00.000Z");
  await store.createSystem(OTHER, "2026-10-01T08:00:00.000Z");
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-10-01T09:00:00.000Z",
    ts_received: "2026-10-01T09:00:00.005Z",
    actor: { agent: "agente-cv" },
    action: { kind: "tool_call", name: "valuta_candidato" },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "api" },
    ...overrides,
  };
}

function v4(receipt: Receipt): ReceiptV4 {
  if (receipt.v !== 4) throw new Error(`expected a v4 receipt, got v${receipt.v}`);
  return receipt;
}

function signatureIsValid(receipt: Receipt): boolean {
  return verify(null, receiptHash(receipt), signer.publicKey, Buffer.from(receipt.sig, "base64"));
}

/** Every byte SQLite keeps for this database: the file and its write-ahead log. */
function databaseBytes(): Buffer {
  const parts = [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path));
  return Buffer.concat(parts);
}

/** Every text value of every row of the evidence tables, through a separate connection. */
function evidenceText(): string {
  const raw = new Database(databasePath, { readonly: true });
  try {
    return ["receipts", "artifacts", "checkpoints", "admin_log", "systems"]
      .flatMap((table) => raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
      .map((row) => JSON.stringify(row))
      .join("\n");
  } finally {
    raw.close();
  }
}

describe("every receipt the store writes is version 4", () => {
  it("genesis included, with null schemes when there is no digest", () => {
    const [genesis] = store.readChain(SYSTEM);
    expect(genesis?.v).toBe(4);
    expect(v4(genesis as Receipt)).toMatchObject({ input_hash_scheme: null, output_hash_scheme: null });
  });

  it("marks a digest computed by the client as plain, and keeps it exactly", async () => {
    const digest = hashCanonicalJson({ cv: "..." });
    const receipt = v4(await store.append(event({ input_hash: digest })));
    expect(receipt.input_hash).toBe(digest);
    expect(receipt.input_hash_scheme).toBe(HASH_SCHEME_PLAIN);
    expect(store.opening(SYSTEM, receipt.seq, "input")).toBeNull();
  });
});

describe("pseudonyms", () => {
  it("normalises an identifier: Unicode NFC, no surrounding space, lower case", () => {
    expect(normaliseSubjectIdentifier("  Elena.Rizzo\t")).toBe(PERSON);
    expect(normaliseSubjectIdentifier("Angéla")).toBe("angéla");
    expect(() => normaliseSubjectIdentifier("   ")).toThrow();
  });

  it("replaces on_behalf_of with a token, the same one for the same person in any spelling", async () => {
    const first = v4(await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: PERSON } })));
    const second = v4(await store.append(event({ system_id: OTHER, actor: { agent: "bot", on_behalf_of: " Elena.RIZZO " } })));
    const someoneElse = v4(await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: "mario.bianchi" } })));

    const token = first.actor.on_behalf_of ?? "";
    expect(isPseudonym(token)).toBe(true);
    expect(second.actor.on_behalf_of).toBe(token);
    expect(someoneElse.actor.on_behalf_of).not.toBe(token);
    expect(store.subjectToken(PERSON)).toBe(token);
    expect(store.subjectIdentifier(token)).toBe(PERSON);
    for (const receipt of [first, second, someoneElse]) expect(signatureIsValid(receipt)).toBe(true);
  });

  it("passes a token through unchanged, without creating a subject for it", async () => {
    const token = "psn_0123456789abcdef0123456789abcdef";
    const receipt = v4(await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: token } })));
    expect(receipt.actor.on_behalf_of).toBe(token);
    expect(store.subjectIdentifier(token)).toBeNull();
  });

  it("never lets the identifier into the evidence tables", async () => {
    await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: "Elena.Rizzo" } }));
    await store.append(event({ system_id: OTHER, actor: { agent: "bot", on_behalf_of: PERSON } }));
    expect(evidenceText().toLowerCase()).not.toContain(PERSON);
  });

  it("finds a person's receipts across systems by the identifier, through the table", async () => {
    await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: PERSON } }));
    await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: "mario.bianchi" } }));
    await store.append(event({ system_id: OTHER, actor: { agent: "bot", on_behalf_of: PERSON } }));
    const found = store.receiptsOnBehalfOf(store.subjectToken(PERSON) ?? "");
    expect(found.map((receipt) => [receipt.system_id, receipt.seq])).toEqual([
      [OTHER, 1],
      [SYSTEM, 1],
    ]);
  });
});

describe("erasing a subject", () => {
  it("removes the row, logs only the token, and leaves every receipt valid but unlinkable", async () => {
    const receipt = v4(await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: PERSON } })));
    const token = receipt.actor.on_behalf_of ?? "";

    expect(await store.eraseSubject(token, ADMIN)).toBe(true);
    expect(store.subjectToken(PERSON)).toBeNull();
    expect(store.subjectIdentifier(token)).toBeNull();

    const [entry] = store.adminLog(1);
    expect(entry).toMatchObject({ action: "subject.erase", actor: ADMIN.actor, detail: { token } });
    expect(JSON.stringify(entry).toLowerCase()).not.toContain(PERSON);

    const stored = store.readChain(SYSTEM)[1];
    expect(stored).toEqual(receipt);
    expect(signatureIsValid(stored as Receipt)).toBe(true);

    // The same person coming back later gets a token that has nothing to do with the old one.
    const later = v4(await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: PERSON } })));
    expect(later.actor.on_behalf_of).not.toBe(token);
  });

  it("leaves no trace of the identifier in the database file or its log", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: index % 2 === 0 ? PERSON : "Elena.Rizzo" } }));
    }
    expect(databaseBytes().includes(PERSON)).toBe(true);

    expect(await store.eraseSubject(store.subjectToken(PERSON) ?? "", ADMIN)).toBe(true);
    const bytes = databaseBytes();
    expect(bytes.includes(PERSON)).toBe(false);
    expect(bytes.includes("Elena.Rizzo")).toBe(false);
  });

  it("takes its turn with receipts whose signatures are still on their way", async () => {
    const token = v4(await store.append(event({ actor: { agent: "agente-cv", on_behalf_of: PERSON } }))).actor.on_behalf_of ?? "";
    store.close();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = { ...signer, signReceipt: async (receipt: UnsignedReceipt) => (await gate, signer.signReceipt(receipt)) };
    store = ReceiptStore.open(databasePath, slow);

    const pending = store.append(event({ raw_input: { value: "score: 7" } }));
    const erasing = store.eraseSubject(token, ADMIN);
    const after = store.append(event({ raw_output: { value: "idoneo" } }));
    release();
    expect(signatureIsValid(await pending)).toBe(true);
    expect(await erasing).toBe(true);
    expect(signatureIsValid(await after)).toBe(true);
    expect(databaseBytes().includes(PERSON)).toBe(false);
  });

  it("says so when there is nothing to erase, and logs nothing", async () => {
    expect(await store.eraseSubject("psn_0123456789abcdef0123456789abcdef", ADMIN)).toBe(false);
    expect(store.adminLog(10).filter((entry) => entry.action === "subject.erase")).toEqual([]);
  });
});

describe("salted digests of content received in the clear", () => {
  it("hashes it under a fresh nonce kept in openings, and marks the scheme", async () => {
    const receipt = v4(await store.append(event({ raw_input: { value: "score: 7" } })));
    expect(receipt.input_hash_scheme).toBe(HASH_SCHEME_SALTED);
    expect(receipt.input_hash).not.toBe(hashCanonicalJson("score: 7"));
    const nonce = store.opening(SYSTEM, receipt.seq, "input");
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(openSaltedDigest(receipt.input_hash ?? "", fromHex(nonce ?? ""), "score: 7")).toBe(true);
    expect(signatureIsValid(receipt)).toBe(true);
  });

  it("gives the same content a different digest in different receipts", async () => {
    const digests = [];
    for (let index = 0; index < 5; index += 1) {
      digests.push(v4(await store.append(event({ raw_output: { value: "score: 7" } }))).output_hash);
    }
    expect(new Set(digests).size).toBe(5);
  });

  it("refuses a digest and content for the same field", async () => {
    await expect(store.append(event({ input_hash: "a".repeat(64), raw_input: { value: "x" } }))).rejects.toThrow(/input/);
  });

  it("never stores the content", async () => {
    await store.append(event({ raw_input: { value: "un testo riservato del candidato" } }));
    expect(databaseBytes().includes("un testo riservato del candidato")).toBe(false);
  });

  it("erasing the nonces makes a digest impossible to open, and is logged by position only", async () => {
    const receipt = v4(await store.append(event({ raw_input: { value: "score: 7" }, raw_output: { value: "idoneo" } })));
    const nonce = store.opening(SYSTEM, receipt.seq, "input") ?? "";

    expect(await store.eraseOpenings(SYSTEM, [receipt.seq], ADMIN)).toBe(2);
    expect(store.opening(SYSTEM, receipt.seq, "input")).toBeNull();
    expect(store.opening(SYSTEM, receipt.seq, "output")).toBeNull();
    expect(databaseBytes().includes(Buffer.from(fromHex(nonce)))).toBe(false);
    expect(databaseBytes().includes(nonce)).toBe(false);

    const [entry] = store.adminLog(1);
    expect(entry).toMatchObject({ action: "openings.erase", system_id: SYSTEM, detail: { seqs: [receipt.seq], erased: 2 } });
    expect(signatureIsValid(store.readChain(SYSTEM)[receipt.seq] as Receipt)).toBe(true);
  });
});

describe("a candidate's erasure, from the fingerprint of their CV", () => {
  const CV = "c".repeat(64);
  const TRACE = "0af7651916cd43dd8448eb211c80319c";
  const OTHER_TRACE = "1af7651916cd43dd8448eb211c80319c";
  const span = (n: number): string => n.toString(16).padStart(16, "0");

  it("finds the receipts that name the CV and those of the same trace, and erases their nonces", async () => {
    // The candidate's run: reading the CV, then two steps on its content.
    await store.append(event({
      action: { kind: "tool_call", name: "leggi_curriculum" },
      source: { type: "otlp", trace_id: TRACE, span_id: span(1) },
      artifacts: [{ role: "input", label: "input text/plain", media_type: "text/plain", sha256: CV }],
      raw_output: { value: "testo del curriculum" },
    }));
    await store.append(event({ source: { type: "otlp", trace_id: TRACE, span_id: span(2) }, raw_input: { value: "testo del curriculum" }, raw_output: { value: "score: 7" } }));
    await store.append(event({ source: { type: "otlp", trace_id: TRACE, span_id: span(3) }, raw_input: { value: "score: 7" } }));
    // Someone else's run, which must not be touched.
    await store.append(event({ source: { type: "otlp", trace_id: OTHER_TRACE, span_id: span(4) }, raw_input: { value: "score: 5" } }));

    const found = store.receiptsOfDocument(CV);
    expect(found).toEqual([{ system_id: SYSTEM, seqs: [1, 2, 3] }]);

    expect(await store.eraseOpenings(SYSTEM, [1, 2, 3], ADMIN)).toBe(4);
    for (const seq of [1, 2, 3]) {
      expect(store.opening(SYSTEM, seq, "input")).toBeNull();
      expect(store.opening(SYSTEM, seq, "output")).toBeNull();
    }
    expect(store.opening(SYSTEM, 4, "input")).not.toBeNull();
  });
});
