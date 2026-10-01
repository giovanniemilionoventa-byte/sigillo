import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  parseFrontier,
  receiptHashHex,
  receiptSchema,
  serializeFrontier,
  type MerkleFrontier,
  type Receipt,
} from "@sigillo/core";

/**
 * What the signer remembers about each chain, and how it keeps it.
 *
 * A chain's state is everything the signer needs to decide what it may sign
 * next and to compute a checkpoint by itself: the position and hash of the
 * last receipt it signed, that receipt in full, and the Merkle frontier of
 * every receipt up to it. A retired system — one deleted before the signer
 * started keeping state (init-from-db) — is remembered only so that its
 * identifier is never given a new chain.
 *
 * The state lives in the signer's own volume, one file per system, never in
 * the server's database: the whole point is that a server which has been
 * taken over cannot change it. Each file is replaced atomically and durably —
 * written to a temporary file, flushed with fsync, renamed over the old one,
 * and the directory flushed too — and put() returns only after all of that.
 * The daemon answers a request only after put() returns, so a signature the
 * server has received is always one the signer will remember after a crash.
 */

export interface ChainState {
  system_id: string;
  seq: number;
  /** receiptHashHex(head). */
  hash: string;
  head: Receipt;
  frontier: MerkleFrontier;
}

export interface RetiredSystem {
  system_id: string;
  retired: { genesis_hash: string };
}

export type SystemState = ChainState | RetiredSystem;

export function isChain(state: SystemState | undefined): state is ChainState {
  return state !== undefined && "head" in state;
}

const STATE_FORMAT = 1;
const FILE_NAME = /^[0-9a-f]{64}\.json$/;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const chainFileSchema = z
  .object({
    format: z.literal(STATE_FORMAT),
    system_id: z.string().min(1).max(128),
    seq: z.number().int().nonnegative(),
    hash: hex64,
    head: receiptSchema,
    frontier: z.unknown(),
  })
  .strict();

const retiredFileSchema = z
  .object({
    format: z.literal(STATE_FORMAT),
    system_id: z.string().min(1).max(128),
    retired: z.object({ genesis_hash: hex64 }).strict(),
  })
  .strict();

/** The name of the file that holds a system's state: the system_id may hold any character. */
function fileNameOf(systemId: string): string {
  return `${createHash("sha256").update(systemId, "utf8").digest("hex")}.json`;
}

function serialize(state: SystemState): string {
  if (isChain(state)) {
    return JSON.stringify({
      format: STATE_FORMAT,
      system_id: state.system_id,
      seq: state.seq,
      hash: state.hash,
      head: state.head,
      frontier: serializeFrontier(state.frontier),
    });
  }
  return JSON.stringify({ format: STATE_FORMAT, system_id: state.system_id, retired: state.retired });
}

/** Reads one state file, refusing anything that is not a state the signer could have written. */
function parseStateFile(name: string, text: string): SystemState {
  const value = JSON.parse(text) as unknown;
  const retired = retiredFileSchema.safeParse(value);
  if (retired.success) {
    return { system_id: retired.data.system_id, retired: retired.data.retired };
  }
  const parsed = chainFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`state file ${name} is not a chain state: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const { system_id, seq, hash, head } = parsed.data;
  const frontier = parseFrontier(parsed.data.frontier);
  const problem =
    head.system_id !== system_id
      ? "its head belongs to another system"
      : head.seq !== seq
        ? `its seq ${seq} is not its head's ${head.seq}`
        : receiptHashHex(head) !== hash
          ? "its hash is not its head's"
          : frontier.size !== seq + 1
            ? `its frontier covers ${frontier.size} receipts, not ${seq + 1}`
            : null;
  if (problem !== null) {
    throw new Error(`state file ${name} for ${system_id} is inconsistent: ${problem}`);
  }
  return { system_id, seq, hash, head, frontier };
}

/** Flushes a directory, so that a rename inside it survives a power cut. */
function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class StateDirectory {
  private constructor(
    private readonly path: string,
    private readonly systems: Map<string, SystemState>,
  ) {}

  /** Creates the directory if needed, and loads every state in it. */
  static open(path: string): StateDirectory {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // mkdir's mode is subject to the umask, and does nothing to a directory
    // that already existed; this is neither.
    chmodSync(path, 0o700);

    const systems = new Map<string, SystemState>();
    for (const name of readdirSync(path)) {
      if (name.endsWith(".tmp")) {
        // A write that never reached its rename: the request it belonged to
        // was never answered, so there is nothing in it anyone relies on.
        unlinkSync(join(path, name));
        continue;
      }
      if (!FILE_NAME.test(name)) continue;
      const state = parseStateFile(name, readFileSync(join(path, name), "utf8"));
      if (fileNameOf(state.system_id) !== name) {
        throw new Error(`state file ${name} holds ${state.system_id}, whose file name would be ${fileNameOf(state.system_id)}`);
      }
      systems.set(state.system_id, state);
    }
    return new StateDirectory(path, systems);
  }

  get(systemId: string): SystemState | undefined {
    return this.systems.get(systemId);
  }

  isEmpty(): boolean {
    return this.systems.size === 0;
  }

  /** Every system the signer knows, by system_id. */
  list(): SystemState[] {
    return [...this.systems.values()].sort((a, b) => (a.system_id < b.system_id ? -1 : 1));
  }

  /** Replaces a system's state on disk, durably, and only then in memory. */
  put(state: SystemState): void {
    const name = fileNameOf(state.system_id);
    const target = join(this.path, name);
    const temporary = `${target}.tmp`;
    const descriptor = openSync(temporary, "w", 0o600);
    try {
      writeSync(descriptor, serialize(state));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
    fsyncDirectory(this.path);
    this.systems.set(state.system_id, state);
  }
}
