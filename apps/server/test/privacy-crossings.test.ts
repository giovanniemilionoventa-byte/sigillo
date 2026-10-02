import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReceiptBytes,
  hashCanonicalJson,
  HASH_SCHEME_PLAIN,
  HASH_SCHEME_SALTED,
  publicKeyFromRaw,
  readZip,
  receiptHashHex,
  RECEIPT_VERSION_2,
  RECEIPT_VERSION_4,
  saltedDigest,
  sha256,
  toHex,
  verifyCheckpointSignature,
  verifyReceiptSignature,
  type Receipt,
  type UnsignedReceipt,
  type UnsignedReceiptV2,
} from "@sigillo/core";
import { archiveFromStore } from "../src/export/from-store.js";
import { SignerClient, SignerRefusedError } from "../src/signer/client.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";
import { killSigner, runSignerCli, runSignerCommand } from "./helpers/signer-process.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Where receipt version 4 (pseudonyms, salted digests, opt-in disclosure)
 * meets what was built beside it: the signer that keeps its own state and
 * signs only the next receipt of each chain (protocol 2), the times an export
 * proves (the authority's attested time, the range a verifier checks, the
 * signer's clock rules), and the export's PDF. Real processes, real Ed25519,
 * real RFC 3161 tokens from a local authority built with openssl.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFIER_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SYSTEM = "selezione-cv";
const PERSON = "elena.rizzo";
const TRACE = "0af7651916cd43dd8448eb211c80319c";

const span = (index: number): string => index.toString(16).padStart(16, "0");

function verifier(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync(TSX, [VERIFIER_CLI, ...args], { encoding: "utf8" }), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Every byte of every file in a directory, recursively. */
function bytesUnder(path: string): Buffer {
  return Buffer.concat(
    readdirSync(path, { withFileTypes: true }).map((entry) =>
      entry.isDirectory() ? bytesUnder(join(path, entry.name)) : readFileSync(join(path, entry.name)),
    ),
  );
}

describe("the signer process, protocol 2, and receipt version 4", () => {
  let directory: string;
  let keyPath: string;
  let socketPath: string;
  let stateDir: string;
  let databasePath: string;
  let daemon: ChildProcessWithoutNullStreams | undefined;
  let client: SignerClient;
  let store: ReceiptStore;

  /** The real signer checks ts_received against its own clock, so receipts here are written now. */
  const now = (): string => new Date().toISOString();

  function event(index: number, overrides: Partial<ChainEvent> = {}): ChainEvent {
    return {
      system_id: SYSTEM,
      ts_event: now(),
      ts_received: now(),
      actor: { agent: "agente-cv", on_behalf_of: PERSON },
      action: { kind: "tool_call", name: `call-${index}` },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "otlp", trace_id: TRACE, span_id: span(index) },
      ...overrides,
    };
  }

  /** The receipt a server would send for the next position, built by hand. */
  function next(fields: Record<string, unknown>): UnsignedReceipt {
    const tip = store.readChain(SYSTEM).at(-1) as Receipt;
    const ts = now();
    return {
      v: RECEIPT_VERSION_4,
      system_id: SYSTEM,
      seq: tip.seq + 1,
      ts_event: ts,
      ts_received: ts,
      actor: { agent: "agente-cv" },
      action: { kind: "tool_call", name: "valuta_candidato" },
      input_hash: null,
      input_hash_scheme: null,
      output_hash: null,
      output_hash_scheme: null,
      outcome: "ok",
      source: { type: "api" },
      prev_hash: receiptHashHex(tip),
      key_id: client.keyId,
      ...fields,
    } as UnsignedReceipt;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-crossings-"));
    keyPath = join(directory, "signer.key");
    socketPath = join(directory, "signer.sock");
    stateDir = join(directory, "signer-state");
    databasePath = join(directory, "sigillo.db");
    expect(runSignerCommand(["keygen", "--key", keyPath]).code).toBe(0);
    daemon = await runSignerCli(["serve", "--key", keyPath, "--socket", socketPath, "--state", stateDir], /listening on/);
    client = await SignerClient.connect(socketPath, { timeoutMs: 5000 });
    store = ReceiptStore.open(databasePath, client);
    await store.createSystem(SYSTEM, now());
  }, 60_000);

  afterEach(() => {
    store.close();
    client.close();
    killSigner(daemon);
    daemon = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it("signs v4 receipts with a pseudonym and salted digests, and its own state holds neither name nor content", async () => {
    const first = await store.append(event(1, { raw_input: { value: "score: 7" } }));
    const second = await store.append(event(2, { raw_output: { value: "idoneo" }, input_hash: hashCanonicalJson("cv") }));
    const key = publicKeyFromRaw(new Uint8Array(Buffer.from(client.publicKeyBase64, "base64")));

    for (const receipt of [first, second]) {
      expect(receipt.v).toBe(4);
      expect(receipt.actor.on_behalf_of).toMatch(/^psn_[0-9a-f]{32}$/);
      expect(verifyReceiptSignature(receipt, key)).toBe(true);
    }
    expect(second.v === 4 && [second.input_hash_scheme, second.output_hash_scheme]).toEqual([HASH_SCHEME_PLAIN, HASH_SCHEME_SALTED]);
    // The signer remembers the head it signed: the v4 receipt, token and all.
    expect(await client.head(SYSTEM)).toEqual(second);

    // The signer's volume holds the head receipt of every chain: a token and
    // digests, never the identifier or the content.
    const state = bytesUnder(stateDir);
    expect(state.includes(first.actor.on_behalf_of ?? "missing")).toBe(true);
    for (const secret of [PERSON, "score: 7", "idoneo"]) expect(state.includes(secret), secret).toBe(false);

    // Its own checkpoint, root and time chosen by the signer, covers the v4 chain.
    const stored = await store.createCheckpoint(SYSTEM);
    expect(stored?.checkpoint.tree_size).toBe(3);
    expect(verifyCheckpointSignature(stored!.checkpoint, key)).toBe(true);
  }, 30_000);

  it("refuses a v4 receipt that names a person in the clear, or whose digest and scheme disagree", async () => {
    await store.append(event(1));
    const clear = client.signReceipt(next({ actor: { agent: "agente-cv", on_behalf_of: PERSON } }));
    await expect(clear).rejects.toBeInstanceOf(SignerRefusedError);
    await expect(clear).rejects.toMatchObject({ code: "malformed" });
    await expect(client.signReceipt(next({ input_hash: "a".repeat(64) }))).rejects.toMatchObject({ code: "malformed" });
    // The chain is untouched and carries on.
    expect((await store.append(event(2))).seq).toBe(2);
  }, 30_000);

  it("signs a v2 receipt and v4 receipts after it in one chain, which exports and verifies", async () => {
    await store.append(event(1));
    // What a server from before receipt v4 would send for the next position.
    const { input_hash_scheme: _i, output_hash_scheme: _o, ...base } = next({}) as Record<string, unknown>;
    const v2 = {
      ...base,
      v: RECEIPT_VERSION_2,
      actor: { agent: "agente-cv", on_behalf_of: "mario.bianchi" },
      input_hash: hashCanonicalJson("score: 5"),
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: "e".repeat(64) }],
    } as UnsignedReceiptV2;
    const sig = await client.signReceipt(v2);
    // The server died before storing it; the next one recovers it from the signer.
    expect(await store.reconcileWithSigner([SYSTEM])).toEqual([
      { system_id: SYSTEM, status: "recovered", seq: 2, hash: receiptHashHex(v2), count: 1 },
    ]);
    expect(store.readChain(SYSTEM)[2]).toEqual({ ...v2, sig });
    await store.append(event(3, { raw_input: { value: "score: 7" } }));
    expect(store.readChain(SYSTEM).map((receipt) => receipt.v)).toEqual([4, 4, 2, 4]);

    const archive = await archiveFromStore(store, SYSTEM, { exportedAt: now() });
    expect(archive.verification.ok).toBe(true);
    const archivePath = join(directory, "misto.zip");
    writeFileSync(archivePath, archive.zip);
    const result = verifier(archivePath, "--key-id", client.keyId);
    expect(result.status, result.stderr).toBe(0);
    expect(verifier("open", archivePath, "2", "input", "--text", "score: 5").stdout).toContain("MATCH");
  }, 30_000);

  it("recovers a v4 receipt the database lost: its token and digest stay, its nonce and new subject were never kept", async () => {
    await store.append(event(1));
    const nonce = new Uint8Array(32).fill(7);
    const token = "psn_1234567890abcdef1234567890abcdef";
    const lost = next({
      actor: { agent: "agente-cv", on_behalf_of: token },
      input_hash: saltedDigest(nonce, "score: 7"),
      input_hash_scheme: HASH_SCHEME_SALTED,
    });
    await client.signReceipt(lost);

    expect((await store.reconcileWithSigner([SYSTEM]))[0]?.status).toBe("recovered");
    const recovered = store.readChain(SYSTEM)[2];
    expect(recovered?.actor.on_behalf_of).toBe(token);
    // The nonce lived only in the server's rolled-back transaction: the
    // receipt is valid and can no longer be opened by anyone (SECURITY.md).
    expect(store.opening(SYSTEM, 2, "input")).toBeNull();
    expect(store.subjectIdentifier(token)).toBeNull();
    expect(store.adminLog().map((entry) => entry.action)).toContain("signer.recovered");
    expect((await store.append(event(3))).seq).toBe(3);
  }, 30_000);
});

describe("proven times across receipt versions, in the export and its PDF", () => {
  let directory: string;
  let tsa: LocalTsa;
  let signer: TestSigner;
  let store: ReceiptStore;
  let signerClock = new Date("2026-10-01T09:00:00.000Z");

  beforeAll(() => {
    tsa = createLocalTsa();
  });

  afterAll(() => tsa.close());

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-crossings-times-"));
    signerClock = new Date("2026-10-01T09:00:00.000Z");
    // The signer's clock rule on: ts_received within 5 minutes of its own clock.
    signer = createTestSigner({ now: () => signerClock, clockToleranceMs: 5 * 60_000 });
    store = ReceiptStore.open(join(directory, "sigillo.db"), signer);
    await store.createSystem(SYSTEM, "2026-10-01T09:00:00.000Z");
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A v2 receipt at the next position, as the server before v4 built it, signed by the signer and stored as it stored it. */
  async function appendV2(tsReceived: string): Promise<Receipt> {
    const tip = store.readChain(SYSTEM).at(-1) as Receipt;
    const unsigned: UnsignedReceiptV2 = {
      v: RECEIPT_VERSION_2,
      system_id: SYSTEM,
      seq: tip.seq + 1,
      ts_event: tsReceived,
      ts_received: tsReceived,
      actor: { agent: "agente-cv", on_behalf_of: "mario.bianchi" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      input_hash: hashCanonicalJson("score: 5"),
      output_hash: null,
      outcome: "ok",
      source: { type: "sdk" },
      prev_hash: receiptHashHex(tip),
      key_id: signer.keyId,
    };
    const sig = await signer.signReceipt(unsigned);
    const bytes = canonicalReceiptBytes(unsigned);
    const raw = new Database(join(directory, "sigillo.db"));
    raw
      .prepare(
        `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id, ts_event, ts_received, action_kind, action_name, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tool_call', 'leggi_curriculum', 'ok')`,
      )
      .run(SYSTEM, unsigned.seq, toHex(sha256(bytes)), unsigned.prev_hash, new TextDecoder().decode(bytes), sig, signer.keyId, tsReceived, tsReceived);
    raw.close();
    return { ...unsigned, sig };
  }

  function event(tsReceived: string, overrides: Partial<ChainEvent> = {}): ChainEvent {
    return {
      system_id: SYSTEM,
      ts_event: tsReceived,
      ts_received: tsReceived,
      actor: { agent: "agente-cv", on_behalf_of: PERSON },
      action: { kind: "decision", name: "decidi" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "otlp", trace_id: TRACE, span_id: span(Date.parse(tsReceived) % 1_000_000) },
      ...overrides,
    };
  }

  it("applies the signer's clock rules to v2 and v4 receipts alike", async () => {
    // An hour from the signer's clock: refused, whatever the version.
    await expect(appendV2("2026-10-01T10:00:00.000Z")).rejects.toMatchObject({ code: "clock" });
    await expect(store.append(event("2026-10-01T10:00:00.000Z"))).rejects.toMatchObject({ code: "clock" });

    // In time: both signed. A server clock that stepped back is absorbed by
    // the store (ts_received no earlier than the receipt before), for v4 too.
    const v2 = await appendV2("2026-10-01T09:01:00.000Z");
    const v4 = await store.append(event("2026-10-01T09:00:30.000Z", { raw_input: { value: "score: 7" } }));
    expect([v2.v, v4.v]).toEqual([2, 4]);
    expect(v4.ts_received).toBe(v2.ts_received);
  });

  it("carries the attested time, the checked range and the chosen disclosures in the export, the verifier's output and the PDF", async () => {
    await appendV2("2026-10-01T09:01:00.000Z");
    const v4 = await store.append(event("2026-10-01T09:02:00.000Z", { raw_input: { value: "score: 7" } }));
    signerClock = new Date("2026-10-01T09:03:00.000Z");
    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint === null) throw new Error("no checkpoint");
    const token = tsa.stamp(checkpoint.checkpoint.root_hash);
    await store.recordTimestamp(checkpoint.id, "http://tsa.test/", token.toString("base64"), "2026-10-01T09:03:05.000Z");

    const archive = await archiveFromStore(store, SYSTEM, {
      subjects: [v4.actor.on_behalf_of ?? ""],
      openings: [v4.seq],
      exportedAt: "2026-10-01T10:00:00.000Z",
    });
    const files = new Map(readZip(archive.zip).map((entry) => [entry.name, entry.data]));
    expect([...files.keys()]).toEqual(expect.arrayContaining(["subjects.jsonl", "openings.jsonl", "report.pdf", "VERIFY.md"]));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as { receipt_version: number; range: { from_ts: string; to_ts: string } };
    expect(manifest.receipt_version).toBe(4);
    expect(manifest.range).toMatchObject({ from_ts: "2026-10-01T09:00:00.000Z", to_ts: "2026-10-01T09:02:00.000Z" });

    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, archive.zip);
    const result = verifier(archivePath, "--tsa-ca", tsa.caFile, "--key-id", signer.keyId);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/timestamp timestamps\/checkpoint-3-1\.tsr: verified .*attested time 20\d\d-/);
    expect(result.stdout).toContain("names the person behind 1 pseudonym token");
    expect(result.stdout).toContain("1 nonce(s) disclosed");
    expect(verifier("open", archivePath, String(v4.seq), "input", "--text", "score: 7").status).toBe(0);

    // The range the manifest claims is a checked time, for a v4 export as for any.
    const lied = new Map(files);
    lied.set("manifest.json", new TextEncoder().encode(JSON.stringify({ ...manifest, range: { ...manifest.range, to_ts: "2026-10-01T09:59:00.000Z" } })));
    const liedPath = join(directory, "falso.zip");
    const { createZip } = await import("@sigillo/core");
    writeFileSync(liedPath, createZip([...lied].map(([name, data]) => ({ name, data }))));
    const refused = verifier(liedPath);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("range");

    // The PDF says both: when the authority attests, and what was disclosed.
    const pdfPath = join(directory, "report.pdf");
    writeFileSync(pdfPath, files.get("report.pdf") ?? new Uint8Array());
    const text = pdfText(pdfPath);
    if (text !== null) {
      expect(text).toContain("(the time the authority attests)");
      expect(text).toContain("receipt version 4");
      expect(text).toContain("names the person behind 1 pseudonym token");
      expect(text).toContain("discloses the nonce of 1 salted digest");
    }

    // And an export made without choosing anything discloses nothing, and says so.
    const plain = await archiveFromStore(store, SYSTEM, { exportedAt: "2026-10-01T10:00:00.000Z" });
    const plainFiles = new Map(readZip(plain.zip).map((entry) => [entry.name, entry.data]));
    expect(plainFiles.has("subjects.jsonl") || plainFiles.has("openings.jsonl")).toBe(false);
    writeFileSync(pdfPath, plainFiles.get("report.pdf") ?? new Uint8Array());
    const plainText = pdfText(pdfPath);
    if (plainText !== null) {
      expect(plainText).toContain("This file names nobody");
      expect(plainText).toContain("discloses no nonce");
      expect(plainText).toContain("(the time the authority attests)");
    }
  }, 60_000);
});

/** The PDF's text on one line, or null where pdftotext is not installed (the export checks above still hold). */
function pdfText(path: string): string | null {
  try {
    return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
