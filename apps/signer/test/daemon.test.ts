import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromHex,
  merkleRoot,
  parseCheckpoint,
  parseReceipt,
  publicKeyFromRaw,
  receiptHash,
  receiptHashHex,
  verifyCheckpointSignature,
  verifyDigestSignature,
  verifyReceiptSignature,
  type UnsignedReceipt,
} from "@sigillo/core";
import { generateKeyFile, loadKeyFile, type SignerKey } from "../src/key-file.js";
import { startSignerDaemon, type SignerDaemon } from "../src/daemon.js";
import { action, call, exchange, genesis, T0, testClock } from "./helpers.js";

/**
 * The signer's socket protocol, version 2, against the real daemon over a
 * real Unix socket, with real Ed25519 and a real state directory on disk.
 *
 * The point of version 2 is what the signer no longer does: it does not sign
 * a hash it is handed. It signs a receipt it can read, and only the one that
 * extends the chain it remembers, so a server that has been taken over can
 * add receipts but cannot rewrite or fork what is already signed.
 */

const SYSTEM = "acme-support-bot";

let directory: string;
let socketPath: string;
let stateDir: string;
let key: SignerKey;
let daemon: SignerDaemon | undefined;
let clock: ReturnType<typeof testClock>;

async function start(options: { clockToleranceMs?: number } = {}): Promise<void> {
  daemon = await startSignerDaemon({ socketPath, key, stateDir, now: clock.now, ...options });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-daemon-"));
  socketPath = join(directory, "signer.sock");
  stateDir = join(directory, "state");
  const keyPath = join(directory, "signer.key");
  generateKeyFile(keyPath);
  key = loadKeyFile(keyPath);
  clock = testClock();
  await start();
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  rmSync(directory, { recursive: true, force: true });
});

const sign = (receipt: unknown): Promise<Record<string, unknown>> =>
  call(socketPath, "SIGN_RECEIPT", { receipt });

/** Signs a genesis and `count` actions after it, returning the signed receipts. */
async function chain(count: number, systemId = SYSTEM): Promise<ReturnType<typeof parseReceipt>[]> {
  const signed = [];
  let unsigned: UnsignedReceipt = genesis(systemId, key.keyId);
  for (let seq = 0; seq <= count; seq += 1) {
    const reply = await sign(unsigned);
    expect(reply["ok"], JSON.stringify(reply)).toBe(true);
    const receipt = parseReceipt({ ...unsigned, sig: reply["sig"] });
    signed.push(receipt);
    unsigned = action(systemId, key.keyId, seq + 1, receiptHashHex(receipt));
  }
  return signed;
}

function expectRefused(reply: Record<string, unknown>, code: string, error?: RegExp): void {
  expect(reply["ok"], JSON.stringify(reply)).toBe(false);
  expect(reply["code"]).toBe(code);
  expect(reply["sig"]).toBeUndefined();
  expect(reply["checkpoint"]).toBeUndefined();
  if (error !== undefined) expect(String(reply["error"])).toMatch(error);
}

describe("the signer socket", () => {
  it("listens on a Unix socket that only its own user and group can reach", () => {
    expect(statSync(socketPath).mode & 0o007).toBe(0);
  });

  it("keeps its state in a directory only its own user can read", async () => {
    await chain(0);
    expect(statSync(stateDir).mode & 0o077).toBe(0);
  });
});

describe("PUBKEY", () => {
  it("returns the key identifier, the raw public key and the protocol version", async () => {
    const reply = await call(socketPath, "PUBKEY");
    expect(reply["ok"]).toBe(true);
    expect(reply["v"]).toBe(2);
    expect(reply["key_id"]).toBe(key.keyId);
    expect(reply["public_key_base64"]).toBe(key.publicKeyBase64);
    const raw = new Uint8Array(Buffer.from(String(reply["public_key_base64"]), "base64"));
    expect(publicKeyFromRaw(raw).export({ format: "der", type: "spki" })).toEqual(
      key.publicKey.export({ format: "der", type: "spki" }),
    );
  });

  it("refuses a PUBKEY request carrying extra fields", async () => {
    expectRefused(await call(socketPath, "PUBKEY", { digest: "a".repeat(64) }), "malformed");
  });
});

describe("the raw-hash method of version 1", () => {
  it("is gone: a bare digest is never signed, in either protocol version", async () => {
    const digest = "74a67e081df5c321729640090e63ca95991f9657bfaab0af51e4504cc2056241";
    const old = JSON.parse((await exchange(socketPath, `${JSON.stringify({ id: "1", method: "sign", digest })}\n`))[0] ?? "{}") as Record<string, unknown>;
    expectRefused(old, "version", /version 2/);
    expect(old["id"]).toBe("1");
    expectRefused(await call(socketPath, "sign", { digest }), "malformed");
    expectRefused(await call(socketPath, "SIGN", { digest }), "malformed");
  });

  it("refuses any other protocol version", async () => {
    for (const v of [1, 3, "2", null]) {
      const [line] = await exchange(socketPath, `${JSON.stringify({ v, id: "x", method: "PUBKEY" })}\n`);
      expectRefused(JSON.parse(line ?? "{}") as Record<string, unknown>, "version");
    }
  });
});

describe("SIGN_RECEIPT", () => {
  it("signs the genesis of a system it has never seen, over the receipt's own hash", async () => {
    const unsigned = genesis(SYSTEM, key.keyId);
    const reply = await sign(unsigned);
    expect(reply["ok"]).toBe(true);
    expect(reply["hash"]).toBe(receiptHashHex(unsigned));
    // The signature is Ed25519 over the 32 bytes of the receipt hash, as it
    // always was: receipts and exports made before version 2 stay valid.
    expect(verifyDigestSignature(receiptHash(unsigned), String(reply["sig"]), key.publicKey)).toBe(true);
    expect(verifyReceiptSignature(parseReceipt({ ...unsigned, sig: reply["sig"] }), key.publicKey)).toBe(true);
  });

  it("signs each receipt that extends the chain it remembers", async () => {
    const signed = await chain(5);
    expect(signed.map((receipt) => receipt.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const receipt of signed) expect(verifyReceiptSignature(receipt, key.publicKey)).toBe(true);
  });

  it("refuses anything but seq 0 for a system it has never seen", async () => {
    expectRefused(await sign(action(SYSTEM, key.keyId, 1, "a".repeat(64))), "sequence", /seq 0/);
    expectRefused(await sign(action(SYSTEM, key.keyId, 7, "a".repeat(64))), "sequence");
  });

  it("refuses a seq already used, with different content (a rewrite of the past)", async () => {
    const [first, second] = await chain(2);
    const rewrite = { ...action(SYSTEM, key.keyId, 1, receiptHashHex(first!), { name: "something-else" }) };
    expectRefused(await sign(rewrite), "sequence", /seq 3/);
    // Not even the same content twice: there is one signature per position.
    const { sig: _sig, ...again } = second!;
    expectRefused(await sign(again), "sequence");
  });

  it("refuses a second genesis for a system it knows (a fork from the start)", async () => {
    await chain(1);
    expectRefused(await sign(genesis(SYSTEM, key.keyId)), "sequence");
  });

  it("refuses a seq that skips ahead", async () => {
    const signed = await chain(1);
    expectRefused(await sign(action(SYSTEM, key.keyId, 3, receiptHashHex(signed[1]!))), "sequence");
  });

  it("refuses a prev_hash that is not the hash of the receipt it signed last (a fork)", async () => {
    const signed = await chain(2);
    // Hanging off an earlier receipt, at the right seq: a branch.
    expectRefused(await sign(action(SYSTEM, key.keyId, 3, receiptHashHex(signed[1]!))), "sequence", /prev_hash/);
    expectRefused(await sign(action(SYSTEM, key.keyId, 3, "f".repeat(64))), "sequence", /prev_hash/);
  });

  it("refuses a receipt that names another key", async () => {
    expectRefused(await sign(genesis(SYSTEM, "0123456789abcdef")), "invalid", /key_id/);
  });

  it("refuses a genesis anywhere but seq 0, and anything but a genesis at seq 0", async () => {
    const signed = await chain(0);
    const late = { ...genesis(SYSTEM, key.keyId), seq: 1, prev_hash: receiptHashHex(signed[0]!) };
    expectRefused(await sign(late), "invalid", /genesis/);
    expectRefused(await sign({ ...action("other", key.keyId, 0, "0".repeat(64)) }), "invalid", /genesis/);
  });

  it("refuses a receipt that is not a valid unsigned receipt, field by field", async () => {
    const base = genesis(SYSTEM, key.keyId);
    const bad: unknown[] = [
      null,
      "receipt",
      { ...base, extra: "please sign this too" },
      { ...base, sig: "A".repeat(86) + "==" },
      { ...base, seq: -1 },
      { ...base, ts_received: "yesterday" },
      { ...base, source: { type: "api", note: "x" } },
      { ...base, v: 9 },
    ];
    for (const receipt of bad) expectRefused(await sign(receipt), "malformed");
    // None of them left a trace: the genesis is still free.
    expect((await sign(base))["ok"]).toBe(true);
  });

  it("refuses a string that is not well-formed Unicode, which has no canonical form", async () => {
    const reply = await sign({ ...genesis(SYSTEM, key.keyId), actor: { agent: "half \ud800 pair" } });
    expectRefused(reply, "invalid", /Unicode/);
  });

  it("refuses unknown fields around the receipt", async () => {
    expectRefused(await call(socketPath, "SIGN_RECEIPT", { receipt: genesis(SYSTEM, key.keyId), digest: "a".repeat(64) }), "malformed");
    expectRefused(await call(socketPath, "SIGN_RECEIPT", {}), "malformed");
  });
});

describe("the signer's clock", () => {
  it("refuses a ts_received further from its own clock than the tolerance, default 5 minutes", async () => {
    const minute = 60_000;
    const at = (offset: number): string => new Date(Date.parse(T0) + offset).toISOString();
    expectRefused(await sign(genesis(SYSTEM, key.keyId, at(5 * minute + 1))), "clock", /clock/);
    expectRefused(await sign(genesis(SYSTEM, key.keyId, at(-5 * minute - 1))), "clock");
    expect((await sign(genesis(SYSTEM, key.keyId, at(5 * minute))))["ok"]).toBe(true);
    expect((await sign(genesis("other", key.keyId, at(-5 * minute))))["ok"]).toBe(true);
  });

  it("takes the tolerance it is configured with", async () => {
    await daemon?.close();
    await start({ clockToleranceMs: 60 * 60_000 });
    const halfAnHourAhead = new Date(Date.parse(T0) + 30 * 60_000).toISOString();
    expect((await sign(genesis(SYSTEM, key.keyId, halfAnHourAhead)))["ok"]).toBe(true);
  });

  it("refuses a ts_received earlier than the receipt before it, and accepts an equal one", async () => {
    const later = new Date(Date.parse(T0) + 1000).toISOString();
    const first = parseReceipt({ ...genesis(SYSTEM, key.keyId, later), sig: (await sign(genesis(SYSTEM, key.keyId, later)))["sig"] });
    expectRefused(await sign(action(SYSTEM, key.keyId, 1, receiptHashHex(first), { ts: T0 })), "clock", /earlier/);
    expect((await sign(action(SYSTEM, key.keyId, 1, receiptHashHex(first), { ts: later })))["ok"]).toBe(true);
  });
});

describe("GET_HEAD", () => {
  it("is null for a system the signer has never signed for", async () => {
    const reply = await call(socketPath, "GET_HEAD", { system_id: SYSTEM });
    expect(reply["ok"]).toBe(true);
    expect(reply["head"]).toBeNull();
  });

  it("returns the last receipt it signed, signature included", async () => {
    const signed = await chain(3);
    const reply = await call(socketPath, "GET_HEAD", { system_id: SYSTEM });
    expect(reply["head"]).toEqual(signed[3]);
    expect(verifyReceiptSignature(parseReceipt(reply["head"]), key.publicKey)).toBe(true);
  });

  it("refuses extra fields", async () => {
    expectRefused(await call(socketPath, "GET_HEAD", { system_id: SYSTEM, seq: 2 }), "malformed");
  });
});

describe("CHECKPOINT", () => {
  it("computes the root and the time itself, from its own state and its own clock", async () => {
    const signed = await chain(6);
    clock.advance(42_000);
    const reply = await call(socketPath, "CHECKPOINT", { system_id: SYSTEM });
    expect(reply["ok"], JSON.stringify(reply)).toBe(true);
    const checkpoint = parseCheckpoint(reply["checkpoint"]);
    expect(checkpoint.tree_size).toBe(7);
    expect(checkpoint.root_hash).toBe(
      Buffer.from(merkleRoot(signed.map((receipt) => fromHex(receiptHashHex(receipt))))).toString("hex"),
    );
    expect(checkpoint.ts).toBe(new Date(Date.parse(T0) + 42_000).toISOString());
    expect(checkpoint.key_id).toBe(key.keyId);
    expect(verifyCheckpointSignature(checkpoint, key.publicKey)).toBe(true);
  });

  it("refuses a root, a size or a time from the caller", async () => {
    await chain(1);
    for (const extra of [{ root_hash: "a".repeat(64) }, { tree_size: 2 }, { ts: T0 }]) {
      expectRefused(await call(socketPath, "CHECKPOINT", { system_id: SYSTEM, ...extra }), "malformed");
    }
  });

  it("refuses a system it has never signed for", async () => {
    expectRefused(await call(socketPath, "CHECKPOINT", { system_id: SYSTEM }), "unknown_system");
  });
});

describe("one request at a time", () => {
  it("signs exactly one of many competing receipts for the same position", async () => {
    const [first] = await chain(0);
    const competing = Array.from({ length: 8 }, (_, index) =>
      sign(action(SYSTEM, key.keyId, 1, receiptHashHex(first!), { name: `contender-${index}` })),
    );
    const replies = await Promise.all(competing);
    expect(replies.filter((reply) => reply["ok"] === true)).toHaveLength(1);
    expect(replies.filter((reply) => reply["code"] === "sequence")).toHaveLength(7);
  });
});

describe("the state, across a restart", () => {
  it("is kept: the head, the next position and the checkpoint root survive", async () => {
    const signed = await chain(4);
    const before = await call(socketPath, "CHECKPOINT", { system_id: SYSTEM });
    await daemon?.close();
    await start();

    expect((await call(socketPath, "GET_HEAD", { system_id: SYSTEM }))["head"]).toEqual(signed[4]);
    expectRefused(await sign(genesis(SYSTEM, key.keyId)), "sequence");
    expectRefused(await sign(action(SYSTEM, key.keyId, 4, receiptHashHex(signed[3]!), { name: "rewrite" })), "sequence");
    const after = await call(socketPath, "CHECKPOINT", { system_id: SYSTEM });
    expect((after["checkpoint"] as Record<string, unknown>)["root_hash"]).toBe(
      (before["checkpoint"] as Record<string, unknown>)["root_hash"],
    );
    expect((await sign(action(SYSTEM, key.keyId, 5, receiptHashHex(signed[4]!))))["ok"]).toBe(true);
  });
});

describe("the size of a request", () => {
  it("is limited: a connection that sends an oversized line is answered once and dropped", async () => {
    const lines = await exchange(socketPath, "x".repeat(300 * 1024));
    const reply = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expectRefused(reply, "malformed", /too long/i);
  });
});

describe("rejecting anything that is not a known request", () => {
  it("refuses an unknown method", async () => {
    for (const method of ["export", "keygen", "pubkey", "", null, 7]) {
      expectRefused(await call(socketPath, method as string), "malformed");
    }
  });

  it("refuses input that is not JSON, and JSON that is not an object", async () => {
    for (const payload of ["this is not json", '"sign"', "42", "null", "[1,2,3]"]) {
      const [line] = await exchange(socketPath, `${payload}\n`);
      expectRefused(JSON.parse(line ?? "{}") as Record<string, unknown>, "malformed");
    }
  });

  it("ignores a blank line, and keeps serving after a refusal", async () => {
    const lines = await exchange(
      socketPath,
      `\n{"v":2,"id":"1","method":"nope"}\n${JSON.stringify({ v: 2, id: "2", method: "PUBKEY" })}\n`,
      2,
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")["ok"]).toBe(false);
    expect(JSON.parse(lines[1] ?? "{}")["ok"]).toBe(true);
  });
});

describe("request ids", () => {
  it("echoes the id, on an answer and on a refusal", async () => {
    const [ok] = await exchange(socketPath, `${JSON.stringify({ v: 2, id: "handshake-1", method: "PUBKEY" })}\n`);
    expect(JSON.parse(ok ?? "{}")["id"]).toBe("handshake-1");
    const [refused] = await exchange(socketPath, `${JSON.stringify({ v: 2, id: "b", method: "SIGN_RECEIPT" })}\n`);
    expect(JSON.parse(refused ?? "{}")["id"]).toBe("b");
  });

  it("requires one, and refuses an id that is not a short token without echoing it", async () => {
    const badIds: unknown[] = [undefined, "", "x".repeat(65), "has space", 7, null, ["1"]];
    for (const id of badIds) {
      const [line] = await exchange(socketPath, `${JSON.stringify({ v: 2, id, method: "PUBKEY" })}\n`);
      const reply = JSON.parse(line ?? "{}") as Record<string, unknown>;
      expectRefused(reply, "malformed", /id/);
      expect(reply["id"]).toBeUndefined();
    }
  });
});

describe("a failure to keep its state", () => {
  it("stops the signer: no reply with a signature, and nothing served afterwards", async () => {
    await chain(0);
    await daemon?.close();
    const fatal: unknown[] = [];
    daemon = await startSignerDaemon({ socketPath, key, stateDir, now: clock.now, onFatal: (error) => fatal.push(error) });
    // The next state cannot be written (a directory stands where its
    // temporary file would go), so no signature may leave the signer.
    mkdirSync(join(stateDir, `${createHash("sha256").update(SYSTEM).digest("hex")}.json.tmp`));
    {
      const head = (await call(socketPath, "GET_HEAD", { system_id: SYSTEM }))["head"] as { sig: string } & UnsignedReceipt;
      const lines = await exchange(
        socketPath,
        `${JSON.stringify({ v: 2, id: "n", method: "SIGN_RECEIPT", receipt: action(SYSTEM, key.keyId, 1, receiptHashHex(head)) })}\n`,
      );
      expect(lines.join("")).not.toContain('"sig"');
      expect(fatal).toHaveLength(1);
      await expect(call(socketPath, "PUBKEY")).rejects.toThrow();
    }
  });
});

