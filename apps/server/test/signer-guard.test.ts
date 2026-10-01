import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromHex,
  merkleRoot,
  publicKeyFromRaw,
  receiptHashHex,
  toHex,
  verifyCheckpointSignature,
  verifyReceiptSignature,
  type Receipt,
  type UnsignedReceipt,
} from "@sigillo/core";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { SignerClient, SignerRefusedError } from "../src/signer/client.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { killSigner, runSignerCli, runSignerCommand } from "./helpers/signer-process.js";

/**
 * The signer as a guard of the past, scenario by scenario, against a server
 * that has been taken over: it holds the socket and the database, and can
 * send the signer anything. Every scenario runs the real `sigillo-signer`
 * process, with its state on disk, and real Ed25519 throughout. What such a
 * server can still do is add receipts at the end of a chain. What it must
 * not be able to do is get a signature on a rewritten or forked past, or a
 * checkpoint over a tree the signer did not build.
 */

const SERVER_CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const SYSTEM = "acme-support-bot";
const TRACE = "0af7651916cd43dd8448eb211c80319c";

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

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: now(),
    ts_received: now(),
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "otlp", trace_id: TRACE, span_id: index.toString(16).padStart(16, "0") },
  };
}

/** The receipt a compromised server would build for `seq`, hanging off `prevHash`. */
function forged(seq: number, prevHash: string, name: string): UnsignedReceipt {
  const ts = now();
  return {
    v: 1,
    system_id: SYSTEM,
    seq,
    ts_event: ts,
    ts_received: ts,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "api" },
    prev_hash: prevHash,
    key_id: client.keyId,
  };
}

async function startSigner(state = stateDir): Promise<void> {
  daemon = await runSignerCli(["serve", "--key", keyPath, "--socket", socketPath, "--state", state], /listening on/);
}

function rawCount(sql: string): number {
  const raw = new Database(databasePath, { readonly: true });
  try {
    return (raw.prepare(sql).get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

function health(): ReturnType<ChainHealthMonitor["statusFor"]> {
  const monitor = new ChainHealthMonitor(
    store,
    publicKeyFromRaw(new Uint8Array(Buffer.from(client.publicKeyBase64, "base64"))),
    24 * 60 * 60_000,
  );
  monitor.check();
  return monitor.statusFor(SYSTEM, new Date());
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-guard-"));
  keyPath = join(directory, "signer.key");
  socketPath = join(directory, "signer.sock");
  stateDir = join(directory, "signer-state");
  databasePath = join(directory, "sigillo.db");
  expect(runSignerCommand(["keygen", "--key", keyPath]).code).toBe(0);
  await startSigner();
  client = await SignerClient.connect(socketPath, { timeoutMs: 5000 });
  store = ReceiptStore.open(databasePath, client);
  await store.createSystem(SYSTEM, now());
  await store.appendBatch([1, 2, 3, 4].map((index) => event(index)));
}, 60_000);

afterEach(() => {
  store.close();
  client.close();
  killSigner(daemon);
  daemon = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("a seq already used, with different content", () => {
  it("is refused by the signer: a receipt already signed cannot be replaced", async () => {
    const chain = store.readChain(SYSTEM);
    const third = chain[2] as Receipt;
    const rewrite = forged(2, third.prev_hash, "call-2-rewritten");

    const attempt = client.signReceipt(rewrite);
    await expect(attempt).rejects.toBeInstanceOf(SignerRefusedError);
    await expect(attempt).rejects.toMatchObject({ code: "sequence" });
    // Not even with the original content: one signature per position, ever.
    const { sig: _sig, ...original } = third;
    await expect(client.signReceipt(original)).rejects.toMatchObject({ code: "sequence" });

    // The honest server carries on at the end of the chain, untouched.
    const next = await store.append(event(5));
    expect(next.seq).toBe(5);
    expect(store.readChain(SYSTEM).map((receipt) => receipt.action.name)).toEqual([
      SYSTEM,
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
    ]);
  });
});

describe("a prev_hash that is not the hash of the last receipt signed", () => {
  it("is refused at the next position: no fork, from anywhere in the chain", async () => {
    const chain = store.readChain(SYSTEM);
    const fromEarlier = forged(5, receiptHashHex(chain[1] as Receipt), "branch");
    await expect(client.signReceipt(fromEarlier)).rejects.toMatchObject({ code: "sequence" });
    await expect(client.signReceipt(forged(5, "f".repeat(64), "branch"))).rejects.toMatchObject({ code: "sequence" });
    // A second genesis is a fork from the start, and refused the same way.
    await expect(
      client.signReceipt({ ...forged(0, "0".repeat(64), SYSTEM), action: { kind: "genesis", name: SYSTEM } }),
    ).rejects.toMatchObject({ code: "sequence" });
    // The real next receipt, hanging off the real head, is still signed.
    expect(await client.signReceipt(forged(5, receiptHashHex(chain[4] as Receipt), "call-5"))).toMatch(/==$/);
  });
});

describe("a checkpoint over a fake tree", () => {
  it("cannot be asked for: the signer takes no root, size or time from the server", async () => {
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ v: 2, id: "x", method: "CHECKPOINT", system_id: SYSTEM, tree_size: 2, root_hash: "a".repeat(64) })}\n`,
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(buffer.split("\n")[0] ?? "{}") as Record<string, unknown>);
        }
      });
      socket.on("error", reject);
    });
    expect(reply["ok"]).toBe(false);
    expect(reply["code"]).toBe("malformed");
    expect(reply["checkpoint"]).toBeUndefined();
  });

  it("is what the signer's own checkpoint is not: its root is the root of the chain it signed", async () => {
    const stored = await store.createCheckpoint(SYSTEM);
    expect(stored).not.toBeNull();
    const checkpoint = stored!.checkpoint;
    const leaves = store.readReceiptHashes(SYSTEM).map((hash) => fromHex(hash));
    expect(checkpoint.tree_size).toBe(5);
    expect(checkpoint.root_hash).toBe(toHex(merkleRoot(leaves)));
    expect(verifyCheckpointSignature(checkpoint, publicKeyFromRaw(new Uint8Array(Buffer.from(client.publicKeyBase64, "base64"))))).toBe(true);
  });

  it("is never stored when the database's chain is not the one the signer signed: red, and logged", async () => {
    // Someone with the database rewrites a receipt in the middle of the chain
    // (the triggers stop SQL, not someone who can replace the file).
    const raw = new Database(databasePath);
    raw.exec("DROP TRIGGER receipts_no_update");
    raw.prepare("UPDATE receipts SET hash = ? WHERE system_id = ? AND seq = 2").run("e".repeat(64), SYSTEM);
    raw.close();

    await expect(store.createCheckpoint(SYSTEM)).rejects.toThrow(/root/);
    expect(rawCount("SELECT COUNT(*) AS n FROM checkpoints")).toBe(0);
    expect(store.signerDivergence(SYSTEM)).toMatch(/root/);
    expect(store.adminLog().map((entry) => entry.action)).toContain("signer.divergence");
    expect(health().status).toBe("red");
  });
});

describe("a crash between the signature and the insert", () => {
  it("is recovered at start-up: the receipt the signer signed is written, once", async () => {
    // The server asks for the next receipt and dies before storing it: the
    // signer has it, durably, and the database does not.
    const tip = store.readChain(SYSTEM)[4] as Receipt;
    const lost: UnsignedReceipt = {
      ...forged(5, receiptHashHex(tip), "call-5"),
      source: { type: "otlp", trace_id: TRACE, span_id: (5).toString(16).padStart(16, "0") },
    };
    const sig = await client.signReceipt(lost);
    store.close();

    // A new server process takes over the same database.
    store = ReceiptStore.open(databasePath, client);
    const outcomes = await store.reconcileWithSigner();
    expect(outcomes).toEqual([{ system_id: SYSTEM, status: "recovered", seq: 5, hash: receiptHashHex(lost) }]);
    const chain = store.readChain(SYSTEM);
    expect(chain[5]).toEqual({ ...lost, sig });
    const recovery = store.adminLog().find((entry) => entry.action === "signer.recovered");
    expect(recovery?.detail).toMatchObject({ seq: 5, trace_id: TRACE, span_id: lost.source.span_id });

    // The exporter never got its answer, and sends the same span again: it is
    // found by trace_id/span_id, and not recorded a second time.
    const resend = await store.appendBatch([event(5)]);
    expect(resend.duplicates).toBe(1);
    expect(store.readChain(SYSTEM)).toHaveLength(6);
    expect(health().status).not.toBe("red");
  }, 30_000);

  it("is recovered by `sigillo-server serve` itself, before it serves anything", async () => {
    const tip = store.readChain(SYSTEM)[4] as Receipt;
    await client.signReceipt(forged(5, receiptHashHex(tip), "signed-then-lost"));
    store.close();

    // The real server command, in a process of its own, started and stopped.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
      });
    });
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(TSX, [SERVER_CLI, "serve"], {
        env: {
          PATH: process.env["PATH"] ?? "",
          SIGILLO_DB: databasePath,
          SIGILLO_SIGNER_SOCKET: socketPath,
          SIGILLO_PORT: String(port),
          SIGILLO_CHECKPOINT_MINUTES: "60",
        },
        detached: true,
      });
      let printed = "";
      const timer = setTimeout(() => {
        process.kill(-(child.pid ?? 0), "SIGKILL");
        reject(new Error(`serve did not start: ${printed}`));
      }, 45_000);
      const collect = (chunk: Buffer): void => {
        printed += chunk.toString("utf8");
        if (/signing with key/.test(printed)) process.kill(-(child.pid ?? 0), "SIGTERM");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(printed);
      });
    });

    expect(output).toContain(`${SYSTEM}: recovered seq 5 from the signer`);
    store = ReceiptStore.open(databasePath, client);
    expect(store.readChain(SYSTEM).map((receipt) => receipt.action.name)[5]).toBe("signed-then-lost");
    expect(store.adminLog().map((entry) => entry.action)).toEqual(["signer.recovered"]);
  }, 60_000);

  it("is recovered on the next write too, without a restart", async () => {
    const tip = store.readChain(SYSTEM)[4] as Receipt;
    await client.signReceipt(forged(5, receiptHashHex(tip), "signed-then-lost"));

    // The next write is refused its position, the heads are compared, the
    // lost receipt is written, and the write goes in after it.
    const next = await store.append(event(6));
    expect(next.seq).toBe(6);
    expect(store.readChain(SYSTEM).map((receipt) => receipt.action.name).slice(4)).toEqual([
      "call-4",
      "signed-then-lost",
      "call-6",
    ]);
  });
});

describe("a signer restarted with its state kept", () => {
  it("carries on where it stopped, and still refuses the past", async () => {
    const before = store.readChain(SYSTEM);
    killSigner(daemon);
    await startSigner();

    // The server reconnects by itself, and the chain goes on at the right seq.
    expect((await store.append(event(5))).seq).toBe(5);
    expect(await client.head(SYSTEM)).toEqual(store.readChain(SYSTEM)[5]);
    await expect(client.signReceipt(forged(3, receiptHashHex(before[2] as Receipt), "rewrite"))).rejects.toMatchObject({
      code: "sequence",
    });
    expect(await store.reconcileWithSigner()).toEqual([{ system_id: SYSTEM, status: "in_sync" }]);

    const stored = await store.createCheckpoint(SYSTEM);
    expect(stored?.checkpoint.tree_size).toBe(6);
    const chain = store.readChain(SYSTEM);
    const key = publicKeyFromRaw(new Uint8Array(Buffer.from(client.publicKeyBase64, "base64")));
    for (const receipt of chain) expect(verifyReceiptSignature(receipt, key)).toBe(true);
  }, 60_000);
});

describe("any other divergence", () => {
  it("a signer more than one receipt ahead: red, logged, and nothing corrected", async () => {
    const tip = store.readChain(SYSTEM)[4] as Receipt;
    const fifth = forged(5, receiptHashHex(tip), "lost-5");
    await client.signReceipt(fifth);
    await client.signReceipt(forged(6, receiptHashHex(fifth), "lost-6"));

    const [outcome] = await store.reconcileWithSigner();
    expect(outcome?.status).toBe("diverged");
    expect(store.readChain(SYSTEM)).toHaveLength(5);
    await expect(store.append(event(7))).rejects.toBeInstanceOf(SignerRefusedError);
    expect(store.readChain(SYSTEM)).toHaveLength(5);

    const logged = store.adminLog().filter((entry) => entry.action === "signer.divergence");
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.detail["detail"])).toMatch(/seq 6.*seq 4/);
    expect(health().status).toBe("red");
  });

  it("a signer that has lost its state: red, and pointed at init-from-db", async () => {
    killSigner(daemon);
    await startSigner(join(directory, "empty-state"));

    const [outcome] = await store.reconcileWithSigner();
    expect(outcome).toMatchObject({ status: "diverged" });
    expect(store.signerDivergence(SYSTEM)).toMatch(/init-from-db/);
    // The signer will not take the chain up from the server's word for it.
    await expect(store.append(event(5))).rejects.toBeInstanceOf(SignerRefusedError);
    expect(store.readChain(SYSTEM)).toHaveLength(5);
    expect(health().status).toBe("red");
  }, 60_000);
});

describe("the signer's clock", () => {
  it("refuses a receipt received, by the server's clock, ten minutes from its own", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(store.append({ ...event(5), ts_event: future, ts_received: future })).rejects.toMatchObject({
      code: "clock",
    });
    expect(store.readChain(SYSTEM)).toHaveLength(5);
    // Not a divergence: the chains still agree, and the next honest receipt goes in.
    expect(store.signerDivergence(SYSTEM)).toBeNull();
    expect((await store.append(event(5))).seq).toBe(5);
  });
});
