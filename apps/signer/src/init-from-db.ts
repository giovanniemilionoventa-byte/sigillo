import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  emptyFrontier,
  frontierAppend,
  fromHex,
  GENESIS_PREV_HASH,
  parseReceipt,
  publicKeyFromRaw,
  receiptHashHex,
  sha256,
  toHex,
  verifyReceiptSignature,
  type MerkleFrontier,
  type Receipt,
} from "@sigillo/core";
import { isChain, StateDirectory, type ChainState, type SystemState } from "./state.js";

/**
 * `sigillo-signer init-from-db`: the one-time migration of an installation
 * whose chains were signed before the signer kept any state.
 *
 * It reads every chain from the server's database, checks it (positions,
 * links, hashes, and each signature under the key the database names for it),
 * and writes the signer's state from it: the head, its hash and the Merkle
 * frontier of each chain, and, for each system deleted earlier, a record that
 * keeps its identifier from ever being given a chain again. Then it writes
 * one entry per system to the database's administrative log, and a marker in
 * the state directory.
 *
 * This is the only moment the signer takes the server's word for anything,
 * and it happens once: with the marker present it refuses to run again, and
 * a system the signer already knows is never overwritten. Run it with the
 * signer and the server both stopped.
 */

export const INIT_MARKER = "init-from-db.json";

export interface InitReport {
  systems: { system_id: string; seq: number; hash: string; tree_size: number }[];
  retired: string[];
  /** Systems the signer already knew with exactly the database's head. */
  unchanged: string[];
}

interface ReceiptRow {
  seq: number;
  hash: string;
  canonical: string;
  sig: string;
}

function chainStateOf(systemId: string, rows: ReceiptRow[], keys: Map<string, string>): ChainState {
  let frontier: MerkleFrontier = emptyFrontier();
  let previous = GENESIS_PREV_HASH;
  let head: Receipt | undefined;
  for (const [index, row] of rows.entries()) {
    const where = `${systemId} seq ${row.seq}`;
    if (row.seq !== index) throw new Error(`${systemId}: expected seq ${index}, found seq ${row.seq}`);
    const receipt = parseReceipt({ ...(JSON.parse(row.canonical) as object), sig: row.sig });
    const hash = receiptHashHex(receipt);
    if (hash !== row.hash || toHex(sha256(new TextEncoder().encode(row.canonical))) !== hash) {
      throw new Error(`${where}: the stored hash is not the hash of the stored receipt`);
    }
    if (receipt.system_id !== systemId || receipt.seq !== row.seq) {
      throw new Error(`${where}: the receipt names another position`);
    }
    if (receipt.prev_hash !== previous) throw new Error(`${where}: prev_hash does not link to the receipt before it`);
    const publicKey = keys.get(receipt.key_id);
    if (publicKey === undefined) throw new Error(`${where}: key ${receipt.key_id} is not in the database's signing keys`);
    if (!verifyReceiptSignature(receipt, publicKeyFromRaw(new Uint8Array(Buffer.from(publicKey, "base64"))))) {
      throw new Error(`${where}: the signature does not verify under key ${receipt.key_id}`);
    }
    frontier = frontierAppend(frontier, fromHex(hash));
    previous = hash;
    head = receipt;
  }
  if (head === undefined) throw new Error(`${systemId} has no receipts, not even a genesis`);
  return { system_id: systemId, seq: head.seq, hash: previous, head, frontier };
}

export function initFromDatabase(options: {
  databasePath: string;
  stateDir: string;
  /** Who ran it, for the administrative log. */
  actor: string;
  now: () => Date;
}): InitReport {
  const markerPath = join(options.stateDir, INIT_MARKER);
  const state = StateDirectory.open(options.stateDir);
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { ts?: string };
    throw new Error(`the signer's state was already initialised from a database on ${marker.ts ?? "an unknown date"}; it is done once`);
  }
  if (!existsSync(options.databasePath)) {
    throw new Error(`no database at ${options.databasePath}`);
  }

  const db = new Database(options.databasePath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_log'").get();
    if (hasLog === undefined) {
      throw new Error("the database has no administrative log: start this version of the server on it once, then run this again");
    }

    const keys = new Map(
      (db.prepare("SELECT key_id, public_key_base64 FROM signing_keys").all() as { key_id: string; public_key_base64: string }[]).map(
        (row) => [row.key_id, row.public_key_base64],
      ),
    );
    const systemIds = (db.prepare("SELECT system_id FROM systems ORDER BY system_id").all() as { system_id: string }[]).map(
      (row) => row.system_id,
    );
    const receipts = db.prepare("SELECT seq, hash, canonical, sig FROM receipts WHERE system_id = ? ORDER BY seq");

    // Everything is built and checked before anything is written.
    const toWrite: SystemState[] = [];
    const report: InitReport = { systems: [], retired: [], unchanged: [] };
    for (const systemId of systemIds) {
      const chain = chainStateOf(systemId, receipts.all(systemId) as ReceiptRow[], keys);
      const known = state.get(systemId);
      if (known !== undefined) {
        if (isChain(known) && known.seq === chain.seq && known.hash === chain.hash) {
          report.unchanged.push(systemId);
          continue;
        }
        throw new Error(`the signer already holds a different state for ${systemId}; it is never re-initialised`);
      }
      toWrite.push(chain);
      report.systems.push({ system_id: systemId, seq: chain.seq, hash: chain.hash, tree_size: chain.frontier.size });
    }

    const deletions = db
      .prepare("SELECT system_id, genesis_hash FROM admin_log WHERE action = 'system.delete' AND genesis_hash IS NOT NULL ORDER BY id")
      .all() as { system_id: string; genesis_hash: string }[];
    for (const { system_id, genesis_hash } of deletions) {
      if (systemIds.includes(system_id) || state.get(system_id) !== undefined || report.retired.includes(system_id)) continue;
      toWrite.push({ system_id, retired: { genesis_hash } });
      report.retired.push(system_id);
    }

    for (const entry of toWrite) state.put(entry);

    const ts = options.now().toISOString();
    const log = db.prepare(
      "INSERT INTO admin_log (ts, action, system_id, actor, detail, genesis_hash) VALUES (?, 'signer.init', ?, ?, ?, NULL)",
    );
    db.transaction(() => {
      for (const system of report.systems) {
        log.run(ts, system.system_id, options.actor, JSON.stringify({ seq: system.seq, hash: system.hash, tree_size: system.tree_size }));
      }
      for (const systemId of report.retired) {
        log.run(ts, systemId, options.actor, JSON.stringify({ retired: true }));
      }
    })();

    writeFileSync(
      markerPath,
      JSON.stringify({ ts, database: options.databasePath, systems: report.systems.length, retired: report.retired.length }),
      { mode: 0o600, flag: "wx" },
    );
    return report;
  } finally {
    db.close();
  }
}
