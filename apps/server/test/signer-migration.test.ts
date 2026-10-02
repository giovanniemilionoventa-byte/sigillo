import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromHex, GENESIS_PREV_HASH, merkleRoot, receiptHashHex, toHex } from "@sigillo/core";
import { generateKeyFile, loadKeyFile } from "../../signer/src/index.js";
import { SignerClient } from "../src/signer/client.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";
import { killSigner, runSignerCli, runSignerCommand } from "./helpers/signer-process.js";

/**
 * `sigillo-signer init-from-db`: an installation whose chains were signed
 * before the signer kept any state of its own, upgraded. The chains are
 * written by the old arrangement (a signer that remembered nothing), then the
 * real command builds the signer's state from the database, and the real
 * signer process takes the chains up from there.
 */

const ADMIN = { actor: "web 127.0.0.1", ts: "2026-09-01T10:00:00.000Z" };

let directory: string;
let databasePath: string;
let keyPath: string;
let stateDir: string;
let socketPath: string;
let daemon: ChildProcessWithoutNullStreams | undefined;

function event(systemId: string, index: number): ChainEvent {
  return {
    system_id: systemId,
    ts_event: "2026-09-01T09:30:00.000Z",
    ts_received: `2026-09-01T09:3${index}:00.000Z`,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

/** Two chains and a deleted system, written under the key the signer will hold afterwards. */
async function oldInstallation(): Promise<void> {
  // The signer before this change kept no record: a fresh state each time it
  // started is as close to that as the current code comes.
  const old = ReceiptStore.open(databasePath, createTestSigner({ key: loadKeyFile(keyPath) }));
  try {
    await old.createSystem("support-bot", "2026-09-01T09:00:00.000Z");
    for (let index = 1; index <= 5; index += 1) await old.append(event("support-bot", index));
    await old.createSystem("triage-bot", "2026-09-01T09:00:00.000Z");
    await old.append(event("triage-bot", 1));
    await old.createCheckpoint("support-bot");
    await old.createSystem("created-by-mistake", "2026-09-01T09:00:00.000Z");
    await old.deleteEmptySystem("created-by-mistake", ADMIN);
  } finally {
    old.close();
  }
}

const init = (): ReturnType<typeof runSignerCommand> =>
  runSignerCommand(["init-from-db", "--db", databasePath, "--state", stateDir]);

function adminActions(): { action: string; system_id: string }[] {
  const raw = new Database(databasePath, { readonly: true });
  try {
    return raw.prepare("SELECT action, system_id FROM admin_log ORDER BY id").all() as { action: string; system_id: string }[];
  } finally {
    raw.close();
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-migration-"));
  databasePath = join(directory, "sigillo.db");
  keyPath = join(directory, "signer.key");
  stateDir = join(directory, "signer-state");
  socketPath = join(directory, "signer.sock");
  generateKeyFile(keyPath);
  await oldInstallation();
}, 60_000);

afterEach(() => {
  killSigner(daemon);
  daemon = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("init-from-db", () => {
  it("builds the signer's state from the database's chains, and writes it to the administrative log", async () => {
    const run = init();
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/support-bot: seq 5, 6 receipts/);
    expect(run.stdout).toMatch(/triage-bot: seq 1, 2 receipts/);
    expect(run.stdout).toMatch(/created-by-mistake: deleted/);

    expect(adminActions().filter((entry) => entry.action === "signer.init")).toEqual([
      { action: "signer.init", system_id: "support-bot" },
      { action: "signer.init", system_id: "triage-bot" },
      { action: "signer.init", system_id: "created-by-mistake" },
    ]);

    // The real signer takes the chains up exactly where the database has them.
    daemon = await runSignerCli(["serve", "--key", keyPath, "--socket", socketPath, "--state", stateDir], /listening on/);
    const client = await SignerClient.connect(socketPath);
    const store = ReceiptStore.open(databasePath, client);
    try {
      expect(await store.reconcileWithSigner()).toEqual([
        { system_id: "support-bot", status: "in_sync" },
        { system_id: "triage-bot", status: "in_sync" },
      ]);
      const now = new Date().toISOString();
      const next = await store.append({ ...event("support-bot", 6), ts_event: now, ts_received: now });
      expect(next.seq).toBe(6);

      // The signer's checkpoint, from the frontier it built at migration and
      // grew since, is the root of the whole chain as the database holds it.
      const stored = await store.createCheckpoint("support-bot");
      const leaves = store.readReceiptHashes("support-bot").map((hash) => fromHex(hash));
      expect(stored?.checkpoint.tree_size).toBe(7);
      expect(stored?.checkpoint.root_hash).toBe(toHex(merkleRoot(leaves)));

      // A deleted system's identifier stays retired, at the signer too, not
      // only in the server's own check.
      const genesis = {
        v: 1 as const,
        system_id: "created-by-mistake",
        seq: 0,
        ts_event: now,
        ts_received: now,
        actor: { agent: "created-by-mistake" },
        action: { kind: "genesis" as const, name: "created-by-mistake" },
        input_hash: null,
        output_hash: null,
        outcome: "ok" as const,
        source: { type: "api" as const },
        prev_hash: GENESIS_PREV_HASH,
        key_id: client.keyId,
      };
      await expect(client.signReceipt(genesis)).rejects.toMatchObject({ code: "sequence" });
      await expect(store.createSystem("created-by-mistake", now)).rejects.toThrow(/not reused/);
    } finally {
      store.close();
      client.close();
    }
  }, 60_000);

  it("runs once: a second run writes nothing, and says the signer still agrees", () => {
    expect(init().code).toBe(0);
    const files = readdirSync(stateDir).sort();
    const logged = adminActions().length;

    const again = init();
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/already initialised on .*; the signer agrees with the database on all 2 chain\(s\): nothing to do/);
    expect(readdirSync(stateDir).sort()).toEqual(files);
    expect(adminActions()).toHaveLength(logged);
  });

  it("after a rollback, when the signer's record is ahead of the database, refuses a second run and points at R4", async () => {
    expect(init().code).toBe(0);
    // The new release signed one more receipt; then the previous release and
    // its database were put back, and the signer's record stayed where it was.
    const reader = ReceiptStore.open(databasePath);
    const head = reader.readChain("support-bot").at(-1);
    reader.close();
    if (head === undefined) throw new Error("no head");
    const ahead = createTestSigner({ key: loadKeyFile(keyPath), stateDir });
    const now = new Date().toISOString();
    await ahead.signReceipt({
      v: 1,
      system_id: "support-bot",
      seq: head.seq + 1,
      ts_event: now,
      ts_received: now,
      actor: { agent: "planner" },
      action: { kind: "tool_call", name: "after-upgrade" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "sdk" },
      prev_hash: receiptHashHex(head),
      key_id: ahead.keyId,
    });
    const files = readdirSync(stateDir).sort();
    const logged = adminActions().length;

    const again = init();
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/no longer agrees with this one: support-bot \(signer seq 6, database seq 5\)/);
    expect(again.stderr).toMatch(/DEPLOY\.md, step R4/);
    expect(readdirSync(stateDir).sort()).toEqual(files);
    expect(adminActions()).toHaveLength(logged);
  });

  it("never re-initialises a system the signer already knows with another head", async () => {
    // The signer already holds a different chain under one of the names.
    const other = createTestSigner({ key: loadKeyFile(keyPath), stateDir });
    await other.signReceipt({
      v: 1,
      system_id: "triage-bot",
      seq: 0,
      ts_event: "2026-09-02T09:00:00.000Z",
      ts_received: "2026-09-02T09:00:00.000Z",
      actor: { agent: "triage-bot" },
      action: { kind: "genesis", name: "triage-bot" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "api" },
      prev_hash: GENESIS_PREV_HASH,
      key_id: other.keyId,
    });
    const before = readdirSync(stateDir).sort();

    const run = init();
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/triage-bot.*never re-initialised/);
    // Nothing was written: not the other systems, not the marker, not the log.
    expect(readdirSync(stateDir).sort()).toEqual(before);
    expect(existsSync(join(stateDir, "init-from-db.json"))).toBe(false);
    expect(adminActions().some((entry) => entry.action === "signer.init")).toBe(false);
  });

  it("refuses a database whose chain does not hold together, writing nothing", () => {
    const raw = new Database(databasePath);
    raw.exec("DROP TRIGGER receipts_no_update");
    raw.prepare("UPDATE receipts SET hash = ? WHERE system_id = 'support-bot' AND seq = 3").run("f".repeat(64));
    raw.close();

    const run = init();
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/support-bot seq 3/);
    expect(existsSync(stateDir) ? readdirSync(stateDir) : []).toEqual([]);
  });
});
