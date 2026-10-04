import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createZip,
  keyIdFromRawPublicKey,
  rawPublicKeyBytes,
  readZip,
  receiptHashHex,
  type Receipt,
} from "@sigillo/core";
import { verifyBundle } from "../../../packages/verifier/src/verify.js";
import { buildArchive } from "../src/export/archive.js";
import { EVIDENCE_CHECK_SOURCE } from "../src/http/evidence-check.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The public "Verify" page checks an evidence pack in the reader's browser
 * (site.ts, evidence-check.ts). It is a second implementation of the
 * archive checks, written in plain browser JavaScript, so it is held to the
 * first: real archives, made the way the server makes them, are doctored one
 * way after another, and for each the browser's verdict must be the verdict
 * of `sigillo-verify` (packages/verifier), check for check. Nothing is mocked:
 * Web Crypto's SHA-256 and Ed25519 against node:crypto's.
 *
 * The page does not check what the command-line verifier alone can: the
 * receipt schema in full, the RFC 3161 tokens (which need openssl), the times
 * they prove, and the optional inputs (--key-id, --previous). Those mutations
 * are left out of the comparison and the page says so to its reader.
 */

const SYSTEM = "acme-support-bot";
const EXPORTED_AT = "2026-03-29T16:00:00.000Z";
const RECEIPTS = 12;

type Result =
  | { ok: true; summary: { system_id: string; receipts: number; first_seq: number; last_seq: number; checkpoints: number; roots_recomputed: number; inclusion_proofs: number; timestamps: number; unanchored_receipts: number; last_checkpoint_ts: string | null } }
  | { ok: false; check: string; location: string; detail: string };

const checkPack = new Function(`${EVIDENCE_CHECK_SOURCE}\nreturn sigilloCheckPack;`)() as (bytes: Uint8Array) => Promise<Result>;

let directory: string;
let tsa: LocalTsa;
let signer: TestSigner;
let signerClock = new Date("2026-03-29T15:00:00.000Z");
let whole: Map<string, Uint8Array>;
let window: Map<string, Uint8Array>;

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: `2026-03-29T14:3${index % 10}:01.005Z`,
    actor: { agent: "planner", ...(index === 4 ? { on_behalf_of: "anna@example.com" } : {}) },
    action: { kind: index % 3 === 0 ? "llm_call" : "tool_call", name: `call-${index} è “quoted” \u0007` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    ...(index % 4 === 1
      ? {
          artifacts: [
            { role: "input" as const, label: "curriculum", media_type: "text/plain", sha256: "7930b9c8f62bf831bf5d051ffa3e25051329b7148e0b8ee22a13b2d8cd0cfb1e" },
            { role: "output" as const, label: "verdetto", media_type: "application/json", sha256: "a".repeat(64) },
          ],
        }
      : {}),
  };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-evidence-check-"));
  tsa = createLocalTsa();
  signer = createTestSigner({ now: () => signerClock });
  const store = ReceiptStore.open(join(directory, "real.db"), signer);
  try {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    for (let index = 1; index < 8; index += 1) await store.append(event(index));
    const first = await store.createCheckpoint(SYSTEM);
    if (first === null) throw new Error("no checkpoint");
    const token = tsa.stampAt(first.checkpoint.root_hash, "2026-03-29T15:00:05.000Z");
    await store.recordTimestamp(first.id, "http://tsa.test/", token.toString("base64"), "2026-03-29T15:00:05.000Z");
    for (let index = 8; index < RECEIPTS; index += 1) await store.append(event(index));
    signerClock = new Date("2026-03-29T15:30:00.000Z");
    if ((await store.createCheckpoint(SYSTEM)) === null) throw new Error("no second checkpoint");

    const chain = store.readChain(SYSTEM);
    const checkpoints = store.readCheckpoints(SYSTEM).map((stored) => ({ stored, timestamps: store.readTimestamps(stored.id) }));
    const keys = [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }];
    whole = filesOf((await buildArchive({ systemId: SYSTEM, receipts: chain, checkpoints, keys, exportedAt: EXPORTED_AT })).zip);
    // A window that does not start at seq 0: its receipts are tied to the
    // checkpoints by inclusion proofs only.
    window = filesOf(
      (
        await buildArchive({
          systemId: SYSTEM,
          receipts: chain.slice(5, 10),
          checkpoints,
          keys,
          exportedAt: EXPORTED_AT,
          chainLeaves: chain.map((receipt) => receiptHashHex(receipt)),
        })
      ).zip,
    );
  } finally {
    store.close();
  }
}, 60_000);

afterAll(() => {
  tsa.close();
  rmSync(directory, { recursive: true, force: true });
});

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);

function filesOf(zip: Uint8Array): Map<string, Uint8Array> {
  return new Map(readZip(zip).map((entry) => [entry.name, entry.data]));
}

function zipOf(files: Map<string, Uint8Array>): Uint8Array {
  return createZip([...files].map(([name, data]) => ({ name, data })));
}

function linesOf<T>(files: Map<string, Uint8Array>, name: string): T[] {
  return text(files.get(name)).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function withLines(files: Map<string, Uint8Array>, name: string, values: unknown[]): Map<string, Uint8Array> {
  const copy = new Map(files);
  copy.set(name, bytesOf(values.map((value) => `${canonicalJson(value)}\n`).join("")));
  return copy;
}

function withJson(files: Map<string, Uint8Array>, name: string, change: (value: Record<string, unknown>) => void): Map<string, Uint8Array> {
  const copy = new Map(files);
  const value = JSON.parse(text(files.get(name))) as Record<string, unknown>;
  change(value);
  copy.set(name, bytesOf(JSON.stringify(value, null, 2)));
  return copy;
}

function withReceipts(files: Map<string, Uint8Array>, change: (receipts: Receipt[]) => Receipt[]): Map<string, Uint8Array> {
  return withLines(files, "receipts.jsonl", change(linesOf<Receipt>(files, "receipts.jsonl")));
}

/** What `sigillo-verify` makes of the same files. */
function cliVerdict(files: Map<string, Uint8Array>): { ok: boolean; check?: string } {
  const optional = (name: string): string | undefined => (files.has(name) ? text(files.get(name)) : undefined);
  const result = verifyBundle({
    manifestJson: text(files.get("manifest.json")),
    receiptsJsonl: text(files.get("receipts.jsonl")),
    ...(optional("checkpoints.jsonl") === undefined ? {} : { checkpointsJsonl: optional("checkpoints.jsonl") as string }),
    ...(optional("artifacts-index.jsonl") === undefined ? {} : { artifactsIndexJsonl: optional("artifacts-index.jsonl") as string }),
  });
  return result.ok ? { ok: true } : { ok: false, check: result.check };
}

async function browserVerdict(files: Map<string, Uint8Array>): Promise<{ ok: boolean; check?: string }> {
  const result = await checkPack(zipOf(files));
  return result.ok ? { ok: true } : { ok: false, check: result.check };
}

/** A second key, as a forger would have: a real Ed25519 key that is not the operator's. */
function otherKey(): { key_id: string; public_key_base64: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKeyBytes(publicKey);
  return { key_id: keyIdFromRawPublicKey(raw), public_key_base64: Buffer.from(raw).toString("base64") };
}

const MUTATIONS: [string, () => Map<string, Uint8Array>, string | null][] = [
  ["the archive as exported", () => whole, null],
  ["a window as exported", () => window, null],
  [
    "one character of a receipt in the middle",
    () => withReceipts(whole, (receipts) => receipts.map((r) => (r.seq === 5 ? { ...r, action: { ...r.action, name: `${r.action.name}x` } } : r))),
    "chain-link",
  ],
  [
    "one character of the last receipt",
    () => withReceipts(whole, (receipts) => receipts.map((r, i) => (i === receipts.length - 1 ? { ...r, outcome: "error" } : r)) as Receipt[]),
    "signature",
  ],
  ["a receipt deleted", () => withReceipts(whole, (receipts) => receipts.filter((r) => r.seq !== 6)), "sequence"],
  [
    "two receipts swapped",
    () => withReceipts(whole, (receipts) => receipts.map((_, i) => receipts[i === 3 ? 4 : i === 4 ? 3 : i] as Receipt)),
    "sequence",
  ],
  ["a receipt repeated", () => withReceipts(whole, (receipts) => [...receipts.slice(0, 4), receipts[3] as Receipt, ...receipts.slice(4)]), "sequence"],
  [
    "the genesis receipt turned into an ordinary one",
    () => withReceipts(whole, (receipts) => receipts.map((r) => (r.seq === 0 ? { ...r, action: { ...r.action, kind: "tool_call" } } : r)) as Receipt[]),
    "genesis",
  ],
  [
    "a receipt claiming another system",
    () => withReceipts(whole, (receipts) => receipts.map((r) => (r.seq === 2 ? { ...r, system_id: "other-bot" } : r))),
    "system",
  ],
  [
    "a signature from another key published in the manifest",
    () =>
      withJson(whole, "manifest.json", (manifest) => {
        manifest["keys"] = [otherKey()];
      }),
    "key",
  ],
  [
    "a key published under an identifier that is not its own",
    () =>
      withJson(whole, "manifest.json", (manifest) => {
        const keys = manifest["keys"] as { key_id: string; public_key_base64: string }[];
        manifest["keys"] = keys.map((key) => ({ ...key, public_key_base64: otherKey().public_key_base64 }));
      }),
    "key",
  ],
  [
    "a signature replaced by another receipt's",
    () =>
      withReceipts(whole, (receipts) => receipts.map((r, i) => (i === receipts.length - 1 ? { ...r, sig: (receipts[2] as Receipt).sig } : r))),
    "signature",
  ],
  [
    "a checkpoint root changed",
    () =>
      withLines(
        whole,
        "checkpoints.jsonl",
        linesOf<{ checkpoint: { root_hash: string } }>(whole, "checkpoints.jsonl").map((entry, i) =>
          i === 0 ? { ...entry, checkpoint: { ...entry.checkpoint, root_hash: "0".repeat(64) } } : entry,
        ),
      ),
    "checkpoint-signature",
  ],
  [
    "an inclusion proof step changed",
    () =>
      withLines(
        window,
        "checkpoints.jsonl",
        linesOf<{ proofs: { path: string[] }[] }>(window, "checkpoints.jsonl").map((entry, i) =>
          i === 0 ? { ...entry, proofs: entry.proofs.map((proof) => ({ ...proof, path: proof.path.map(() => "1".repeat(64)) })) } : entry,
        ),
      ),
    "inclusion-proof",
  ],
  [
    "an inclusion proof one step short",
    () =>
      withLines(
        window,
        "checkpoints.jsonl",
        linesOf<{ proofs: { path: string[] }[] }>(window, "checkpoints.jsonl").map((entry, i) =>
          i === 0 ? { ...entry, proofs: entry.proofs.map((proof) => ({ ...proof, path: proof.path.slice(1) })) } : entry,
        ),
      ),
    "inclusion-proof",
  ],
  [
    "a document missing from the index",
    () => withLines(whole, "artifacts-index.jsonl", linesOf(whole, "artifacts-index.jsonl").slice(1)),
    "artifacts-index",
  ],
  [
    "a document added to the index",
    () =>
      withLines(whole, "artifacts-index.jsonl", [
        ...linesOf(whole, "artifacts-index.jsonl"),
        { sha256: "b".repeat(64), seq: 3, role: "input", label: "curriculum" },
      ]),
    "artifacts-index",
  ],
  [
    // The last checkpoint's proof names the receipt that is gone.
    "the last receipt removed, the manifest left as it was",
    () => withReceipts(whole, (receipts) => receipts.slice(0, -1)),
    "inclusion-proof",
  ],
  ["the receipt count changed", () => withJson(whole, "manifest.json", (manifest) => {
    (manifest["counts"] as { receipts: number }).receipts += 1;
  }), "range"],
  ["the period changed", () => withJson(whole, "manifest.json", (manifest) => {
    (manifest["range"] as { to_ts: string }).to_ts = "2026-03-29T23:00:00.000Z";
  }), "range"],
  ["the timestamp count changed", () => withJson(whole, "manifest.json", (manifest) => {
    (manifest["counts"] as { timestamps: number }).timestamps = 0;
  }), "range"],
  ["the receipt version claimed changed", () => withJson(whole, "manifest.json", (manifest) => {
    manifest["receipt_version"] = 1;
  }), "range"],
  ["the system renamed in the manifest", () => withJson(whole, "manifest.json", (manifest) => {
    manifest["system_id"] = "other-bot";
  }), "system"],
  ["a receipt that is not JSON", () => {
    const copy = new Map(whole);
    copy.set("receipts.jsonl", bytesOf(`${text(whole.get("receipts.jsonl"))}{not json\n`));
    return copy;
  }, "receipt-json"],
  ["receipts reformatted, members reordered and spaced", () => {
    const copy = new Map(whole);
    const lines = linesOf<Record<string, unknown>>(whole, "receipts.jsonl").map((receipt) =>
      JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse()), null, 1).replaceAll("\n", " "),
    );
    copy.set("receipts.jsonl", bytesOf(lines.join("\r\n") + "\r\n"));
    return copy;
  }, null],
];

describe("checking an evidence pack in the browser", () => {
  for (const [name, mutate, check] of MUTATIONS) {
    it(`agrees with sigillo-verify: ${name}`, async () => {
      const files = mutate();
      const expected = cliVerdict(files);
      // The case is what it says it is, for the reference verifier first.
      expect(expected).toEqual(check === null ? { ok: true } : { ok: false, check });
      expect(await browserVerdict(files)).toEqual(expected);
    });
  }

  it("summarises an intact pack the way its reader needs it", async () => {
    const result = await checkPack(zipOf(whole));
    expect(result).toEqual({
      ok: true,
      summary: {
        system_id: SYSTEM,
        receipts: RECEIPTS,
        first_seq: 0,
        last_seq: RECEIPTS - 1,
        checkpoints: 2,
        roots_recomputed: 2,
        inclusion_proofs: 4,
        timestamps: 1,
        unanchored_receipts: 0,
        last_checkpoint_ts: "2026-03-29T15:30:00.000Z",
      },
    });
    const part = await checkPack(zipOf(window));
    expect(part.ok && part.summary).toMatchObject({ receipts: 5, first_seq: 5, last_seq: 9, roots_recomputed: 0 });
  });

  it("says plainly when a file is not an evidence pack at all", async () => {
    for (const bytes of [bytesOf("just some text"), new Uint8Array(0), zipOf(new Map([["note.txt", bytesOf("hi")]]))]) {
      const result = await checkPack(bytes);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.check).toBe("archive");
    }
  });

  it("refuses an archive whose entries have been altered under the zip's own checksum", async () => {
    const zip = zipOf(whole);
    // Flip one byte inside the first stored entry's data, past its local header.
    const damaged = new Uint8Array(zip);
    const nameLength = (damaged[26] ?? 0) | ((damaged[27] ?? 0) << 8);
    const at = 30 + nameLength + 5;
    damaged[at] = (damaged[at] ?? 0) ^ 0x01;
    const result = await checkPack(damaged);
    expect(result.ok).toBe(false);
  });
});
