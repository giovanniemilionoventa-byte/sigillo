import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  checkpointHash,
  createZip,
  fromHex,
  keyIdFromRawPublicKey,
  merkleRoot,
  rawPublicKeyBytes,
  readZip,
  receiptHashHex,
  signReceipt,
  toHex,
  type Checkpoint,
  type Receipt,
} from "@sigillo/core";
import { generateKeyPairSync } from "node:crypto";
import { buildArchive } from "../src/export/archive.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Phase 6: tampering, scenario by scenario, as an auditor would meet it.
 *
 * One real evidence file is produced the way the server produces it — real
 * SQLite, real Ed25519 signatures, a real checkpoint, a real RFC 3161 token
 * from a local openssl authority — and each scenario doctors a copy of it and
 * hands it to the real `sigillo-verify` command, in a process of its own. A
 * scenario passes only if the command exits 1 and names the check that failed
 * and where.
 *
 * Some scenarios cannot be caught from the archive alone, and the tests say
 * so: they show the doctored archive passing on its own, then being caught
 * once the auditor brings what the archive cannot supply itself (the
 * operator's key identifier, an earlier export). SECURITY.md lists these limits.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SYSTEM = "acme-support-bot";
const EXPORTED_AT = "2026-03-29T16:00:00.000Z";
const RECEIPTS = 12;

let directory: string;
let tsa: LocalTsa;
let signer: TestSigner;
let original: Map<string, Uint8Array>;
let counter = 0;

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: `2026-03-29T14:3${index % 10}:01.005Z`,
    actor: { agent: "planner" },
    action: { kind: index % 3 === 0 ? "llm_call" : "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

/** A whole chain, checkpointed and anchored, exported as the server exports it. */
async function produceArchive(withSigner: TestSigner, database: string): Promise<Uint8Array> {
  const store = ReceiptStore.open(database, withSigner);
  try {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    for (let index = 1; index < RECEIPTS; index += 1) await store.append(event(index));
    const checkpoint = await store.createCheckpoint(SYSTEM, "2026-03-29T15:00:00.000Z");
    if (checkpoint === null) throw new Error("no checkpoint");
    const token = tsa.stamp(checkpoint.checkpoint.root_hash);
    await store.recordTimestamp(checkpoint.id, "http://tsa.test/", token.toString("base64"), "2026-03-29T15:00:05.000Z");

    const archive = await buildArchive({
      systemId: SYSTEM,
      receipts: store.readChain(SYSTEM),
      checkpoints: store.readCheckpoints(SYSTEM).map((stored) => ({
        stored,
        timestamps: store.readTimestamps(stored.id),
      })),
      keys: [{ key_id: withSigner.keyId, public_key_base64: withSigner.publicKeyBase64 }],
      exportedAt: EXPORTED_AT,
    });
    return archive.zip;
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-tamper-"));
  tsa = createLocalTsa();
  signer = createTestSigner();
  original = new Map(readZip(await produceArchive(signer, join(directory, "real.db"))).map((e) => [e.name, e.data]));
}, 60_000);

afterAll(() => {
  tsa.close();
  rmSync(directory, { recursive: true, force: true });
});

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);

function receiptsOf(files: Map<string, Uint8Array>): Receipt[] {
  return text(files.get("receipts.jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Receipt);
}
function jsonl(values: unknown[]): Uint8Array {
  return bytesOf(values.map((value) => canonicalJson(value)).join("\n") + "\n");
}
function jsonOf<T>(files: Map<string, Uint8Array>, name: string): T {
  return JSON.parse(text(files.get(name))) as T;
}
function linesOf<T>(files: Map<string, Uint8Array>, name: string): T[] {
  return text(files.get(name)).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

interface Entry {
  checkpoint: Checkpoint;
  proofs: { seq: number; receipt_hash: string; path: string[] }[];
  timestamps: { tsa_url: string; obtained_at: string; file: string }[];
}
interface Manifest {
  keys: { key_id: string; public_key_base64: string }[];
  range: { from_seq: number; to_seq: number; from_ts: string; to_ts: string };
  counts: { receipts: number; checkpoints: number; timestamps: number };
}

/** A copy of the real archive with some files replaced (or, for null, removed). */
function doctor(changes: Record<string, Uint8Array | null>, base = original): Map<string, Uint8Array> {
  const copy = new Map(base);
  for (const [name, data] of Object.entries(changes)) {
    if (data === null) copy.delete(name);
    else copy.set(name, data);
  }
  return copy;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function writeArchive(files: Map<string, Uint8Array> | Uint8Array): string {
  counter += 1;
  const path = join(directory, `archive-${counter}.zip`);
  writeFileSync(path, files instanceof Uint8Array ? files : createZip([...files].map(([name, data]) => ({ name, data }))));
  return path;
}

/** The real verifier, as an auditor runs it. */
function verify(files: Map<string, Uint8Array> | Uint8Array, ...extra: string[]): Run {
  const run = spawnSync(TSX, [VERIFY_CLI, writeArchive(files), "--tsa-ca", tsa.caFile, ...extra], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function expectCaught(run: Run, check: string, location: string): void {
  expect(run.code, run.stdout + run.stderr).toBe(1);
  expect(run.stderr).toContain(`FAILED  ${check} at ${location}`);
}

describe("the untouched evidence file", () => {
  it("verifies, signature of the authority included, and shows the attested time", () => {
    const run = verify(original);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`OK  ${SYSTEM}: ${RECEIPTS} receipts`);
    expect(run.stdout).toMatch(/timestamp timestamps\/\S+: verified \(http:\/\/tsa\.test\/\), attested time 20\d\d-/);
    // VERIFY.md gives the same attested time, read by the server from the token.
    const attested = /attested time (\S+)\n/.exec(run.stdout)?.[1];
    expect(attested).toBeDefined();
    expect(text(original.get("VERIFY.md"))).toContain(`The authority dates it ${attested ?? ""}`);
  }, 30_000);
});

describe("the ten scenarios of phase 6", () => {
  it("1. one byte changed in a receipt", () => {
    const lines = text(original.get("receipts.jsonl")).split("\n");
    lines[4] = (lines[4] ?? "").replace('"ok"', '"error"');
    expectCaught(verify(doctor({ "receipts.jsonl": bytesOf(lines.join("\n")) })), "chain-link", "receipts.jsonl:6");
  }, 30_000);

  it("2. a receipt removed", () => {
    const receipts = receiptsOf(original).filter((receipt) => receipt.seq !== 5);
    expectCaught(verify(doctor({ "receipts.jsonl": jsonl(receipts) })), "sequence", "receipts.jsonl:6");
  }, 30_000);

  it("3. two receipts swapped", () => {
    const receipts = receiptsOf(original);
    [receipts[3], receipts[4]] = [receipts[4] as Receipt, receipts[3] as Receipt];
    expectCaught(verify(doctor({ "receipts.jsonl": jsonl(receipts) })), "sequence", "receipts.jsonl:4");
  }, 30_000);

  it("4. a receipt duplicated", () => {
    const receipts = receiptsOf(original);
    receipts.splice(6, 0, receipts[5] as Receipt);
    const run = verify(doctor({ "receipts.jsonl": jsonl(receipts) }));
    expectCaught(run, "sequence", "receipts.jsonl:7");
    expect(run.stderr).toContain("seq 5 appears twice");
  }, 30_000);

  it("5. signatures replaced with those of another valid key, which the verifier was not told to expect", () => {
    // The forger re-signs the chain from seq 7 on with a key of their own,
    // relinks it, publishes that key in the manifest, and drops the
    // checkpoint and its token, which no longer match. On its own, the
    // archive is a valid chain signed by two published keys...
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPublicKeyBytes(publicKey);
    const forgerKeyId = keyIdFromRawPublicKey(raw);
    const receipts = receiptsOf(original);
    for (let index = 7; index < receipts.length; index += 1) {
      const { sig: _sig, ...unsigned } = receipts[index] as Receipt;
      receipts[index] = signReceipt(
        { ...unsigned, key_id: forgerKeyId, prev_hash: receiptHashHex(receipts[index - 1] as Receipt) },
        privateKey,
      );
    }
    const manifest = jsonOf<Manifest>(original, "manifest.json");
    manifest.keys.push({ key_id: forgerKeyId, public_key_base64: Buffer.from(raw).toString("base64") });
    manifest.counts.checkpoints = 0;
    manifest.counts.timestamps = 0;
    const tokenFiles = Object.fromEntries([...original.keys()].filter((n) => n.startsWith("timestamps/")).map((n) => [n, null]));
    const forged = doctor({
      "receipts.jsonl": jsonl(receipts),
      "manifest.json": bytesOf(JSON.stringify(manifest)),
      "checkpoints.jsonl": bytesOf(""),
      ...tokenFiles,
    });

    const alone = verify(forged);
    expect(alone.code, alone.stderr).toBe(0);
    expect(alone.stdout).toContain(forgerKeyId);
    expect(alone.stdout).toContain("no timestamp token was checked");

    // ...and with the key the operator published elsewhere, it is caught at
    // the first receipt the forger signed.
    expectCaught(verify(forged, "--key-id", signer.keyId), "key", "receipts.jsonl:8");
  }, 30_000);

  it("6. prev_hash altered, and nothing else", () => {
    const receipts = receiptsOf(original);
    const target = receipts[8] as Receipt;
    receipts[8] = { ...target, prev_hash: `${target.prev_hash.slice(0, -1)}${target.prev_hash.endsWith("0") ? "1" : "0"}` };
    expectCaught(verify(doctor({ "receipts.jsonl": jsonl(receipts) })), "chain-link", "receipts.jsonl:9");
  }, 30_000);

  it("7. a checkpoint's Merkle root altered", () => {
    const [entry] = linesOf<Entry>(original, "checkpoints.jsonl");
    if (entry === undefined) throw new Error("no checkpoint");
    entry.checkpoint.root_hash = `${"0".repeat(63)}1`;
    expectCaught(
      verify(doctor({ "checkpoints.jsonl": jsonl([entry]) })),
      "checkpoint-signature",
      "checkpoints.jsonl:1",
    );
  }, 30_000);

  it("7b. ...even signed by the real key, as an attacker holding the server could have it signed", async () => {
    // SECURITY.md: with the server, an attacker can use the signer's socket.
    // A checkpoint over a wrong root, properly signed, still does not match
    // the receipts it claims to cover.
    const [entry] = linesOf<Entry>(original, "checkpoints.jsonl");
    if (entry === undefined) throw new Error("no checkpoint");
    const { sig: _sig, ...unsigned } = entry.checkpoint;
    const wrong = { ...unsigned, root_hash: `${"0".repeat(63)}1` };
    entry.checkpoint = { ...wrong, sig: await signer.sign(checkpointHash(wrong)) };
    expectCaught(verify(doctor({ "checkpoints.jsonl": jsonl([entry]) })), "merkle-root", "checkpoints.jsonl:1");
  }, 30_000);

  it("8. an inclusion proof falsified", () => {
    const [entry] = linesOf<Entry>(original, "checkpoints.jsonl");
    const proof = entry?.proofs[0];
    if (entry === undefined || proof === undefined || proof.path.length === 0) throw new Error("no proof to alter");
    proof.path[0] = "ab".repeat(32);
    expectCaught(verify(doctor({ "checkpoints.jsonl": jsonl([entry]) })), "inclusion-proof", "checkpoints.jsonl:1");
  }, 30_000);

  it("9. the timestamp token swapped for a genuine one over another digest", () => {
    const [entry] = linesOf<Entry>(original, "checkpoints.jsonl");
    const file = entry?.timestamps[0]?.file;
    if (file === undefined) throw new Error("no token");
    // A real token, from the same real authority, over another root.
    const other = tsa.stamp("cd".repeat(32));
    const run = verify(doctor({ [file]: new Uint8Array(other) }));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`FAILED  timestamp at ${file}`);
    expect(run.stderr).toContain(`the token is over ${"cd".repeat(32)}`);
  }, 30_000);

  it("10. the manifest missing the key_id the receipts are signed with", () => {
    const manifest = jsonOf<Manifest>(original, "manifest.json");
    manifest.keys = [];
    expectCaught(verify(doctor({ "manifest.json": bytesOf(JSON.stringify(manifest)) })), "manifest", "manifest.json");
    // Or with the key replaced by another, valid one.
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPublicKeyBytes(publicKey);
    manifest.keys = [{ key_id: keyIdFromRawPublicKey(raw), public_key_base64: Buffer.from(raw).toString("base64") }];
    expectCaught(verify(doctor({ "manifest.json": bytesOf(JSON.stringify(manifest)) })), "key", "receipts.jsonl:1");
  }, 30_000);
});

describe("beyond the ten", () => {
  it("11. the last receipts cut off, with the manifest adjusted: caught only against an earlier export", () => {
    // Review point 3b. Remove the last three receipts and the checkpoint that
    // covered them, fix the manifest's range and counts: what is left is a
    // valid, shorter chain, and nothing inside the archive can say otherwise.
    const receipts = receiptsOf(original).slice(0, RECEIPTS - 3);
    const manifest = jsonOf<Manifest>(original, "manifest.json");
    manifest.range.to_seq = RECEIPTS - 4;
    manifest.range.to_ts = (receipts[receipts.length - 1] as Receipt).ts_received;
    manifest.counts = { receipts: RECEIPTS - 3, checkpoints: 0, timestamps: 0 };
    const tokenFiles = Object.fromEntries([...original.keys()].filter((n) => n.startsWith("timestamps/")).map((n) => [n, null]));
    const truncated = doctor({
      "receipts.jsonl": jsonl(receipts),
      "manifest.json": bytesOf(JSON.stringify(manifest)),
      "checkpoints.jsonl": bytesOf(""),
      ...tokenFiles,
    });

    expect(verify(truncated).code).toBe(0);
    const previous = writeArchive(original);
    expectCaught(verify(truncated, "--previous", previous), "previous-export", "manifest.json");
  }, 30_000);

  it("12. a whole archive fabricated under a new key: caught only against the operator's key_id", async () => {
    // Review point 3c. Everything is consistent, because the forger made all
    // of it, timestamp included (a public authority stamps any digest).
    const forger = createTestSigner();
    const forged = await produceArchive(forger, join(directory, "forged.db"));
    const alone = verify(forged);
    expect(alone.code, alone.stderr).toBe(0);
    expect(alone.stdout).toContain("Compare them with the key_id the operator published elsewhere");

    expectCaught(verify(forged, "--key-id", signer.keyId), "key", "receipts.jsonl:1");
    expect(verify(original, "--key-id", signer.keyId).code).toBe(0);
    // Repeatable, for a chain signed by more than one key over its life.
    expect(verify(original, "--key-id", forger.keyId, "--key-id", signer.keyId).code).toBe(0);
  }, 60_000);

  it("13. history rewritten after an export was handed over", async () => {
    const receipts = receiptsOf(original);
    // Re-signed with the real key through the signer, and relinked: the
    // archive alone verifies, the earlier export does not agree with it.
    {
      for (let index = 3; index < receipts.length; index += 1) {
        const { sig: _sig, ...unsigned } = receipts[index] as Receipt;
        const rewritten = {
          ...unsigned,
          ...(index === 3 ? { outcome: "blocked" as const } : {}),
          prev_hash: receiptHashHex(receipts[index - 1] as Receipt),
        };
        receipts[index] = { ...rewritten, sig: await signer.sign(fromHex(receiptHashHex(rewritten))) } as Receipt;
      }
      const leaves = receipts.map((receipt) => fromHex(receiptHashHex(receipt)));
      const [entry] = linesOf<Entry>(original, "checkpoints.jsonl");
      if (entry === undefined) throw new Error("no checkpoint");
      const { sig: _sig, ...unsigned } = entry.checkpoint;
      const checkpoint = { ...unsigned, root_hash: toHex(merkleRoot(leaves)) };
      const manifest = jsonOf<Manifest>(original, "manifest.json");
      manifest.counts.timestamps = 0;
      const tokenFiles = Object.fromEntries([...original.keys()].filter((n) => n.startsWith("timestamps/")).map((n) => [n, null]));
      const rewrittenArchive = doctor({
        "receipts.jsonl": jsonl(receipts),
        "checkpoints.jsonl": jsonl([
          { checkpoint: { ...checkpoint, sig: await signer.sign(checkpointHash(checkpoint)) }, proofs: [], timestamps: [] },
        ]),
        "manifest.json": bytesOf(JSON.stringify(manifest)),
        ...tokenFiles,
      });

      const alone = verify(rewrittenArchive);
      expect(alone.code, alone.stderr).toBe(0);
      expectCaught(verify(rewrittenArchive, "--previous", writeArchive(original)), "previous-export", "receipts.jsonl:4");
    }
  }, 30_000);

  it("14. a timestamp token removed from the archive", () => {
    const file = [...original.keys()].find((name) => name.startsWith("timestamps/"));
    if (file === undefined) throw new Error("no token");
    const run = verify(doctor({ [file]: null }));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`FAILED  timestamp at ${file}`);
  }, 30_000);

  it("15. a second receipts.jsonl slipped into the zip, for tools that read the last one", () => {
    const doctored = [...original].map(([name, data]) => ({ name, data }));
    doctored.push({ name: "receiptz.jsonl", data: bytesOf("{}\n") });
    const bytes = Buffer.from(createZip(doctored));
    for (let at = bytes.indexOf("receiptz.jsonl"); at >= 0; at = bytes.indexOf("receiptz.jsonl", at + 1)) {
      bytes.write("receipts.jsonl", at, "latin1");
    }
    const run = verify(new Uint8Array(bytes));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("appears twice");
  }, 30_000);

  it("16. a receipt signed by the right key over a different receipt", () => {
    const receipts = receiptsOf(original);
    const last = receipts[RECEIPTS - 1] as Receipt;
    // The signature of the one before it: genuine, by the real key, but not of this receipt.
    receipts[RECEIPTS - 1] = { ...last, sig: (receipts[RECEIPTS - 2] as Receipt).sig };
    expectCaught(verify(doctor({ "receipts.jsonl": jsonl(receipts) })), "signature", `receipts.jsonl:${RECEIPTS}`);
  }, 30_000);
});
