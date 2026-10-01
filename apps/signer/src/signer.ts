import {
  CHECKPOINT_VERSION,
  emptyFrontier,
  frontierAppend,
  frontierRoot,
  fromHex,
  GENESIS_PREV_HASH,
  receiptHash,
  signCheckpoint,
  signDigest,
  toHex,
  type Checkpoint,
  type Receipt,
  type UnsignedReceipt,
} from "@sigillo/core";
import type { SignerKey } from "./key-file.js";
import { isChain, type StateDirectory } from "./state.js";

/**
 * The rules the signer applies before it puts its key behind anything. They
 * are what make a compromised server harmless to the past: it can still ask
 * for a new receipt at the end of a chain, but never for a second receipt at
 * a position already signed (a rewrite), never for one that hangs off
 * anything but the last receipt signed (a fork), and never for a checkpoint
 * over a tree the signer did not build itself.
 */

/** Why a request was refused, as the reply's `code` names it. */
export type RefusalCode = "malformed" | "version" | "invalid" | "sequence" | "clock" | "unknown_system";

export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export const DEFAULT_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export interface SignerOptions {
  key: SignerKey;
  state: StateDirectory;
  /** The signer's own clock. */
  now: () => Date;
  /** How far a receipt's ts_received may be from that clock, either way. */
  clockToleranceMs?: number;
}

/** The path of the first string in `value` that is not well-formed Unicode, or null. */
function malformedStringIn(value: unknown, path: string): string | null {
  if (typeof value === "string") return value.isWellFormed() ? null : path;
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      const found = malformedStringIn(inner, path === "" ? key : `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

export class Signer {
  private readonly toleranceMs: number;

  constructor(private readonly options: SignerOptions) {
    this.toleranceMs = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
    if (!(this.toleranceMs >= 0)) {
      throw new Error(`the clock tolerance must be 0 or more milliseconds, received ${this.toleranceMs}`);
    }
  }

  get keyId(): string {
    return this.options.key.keyId;
  }

  get publicKeyBase64(): string {
    return this.options.key.publicKeyBase64;
  }

  /**
   * Signs `receipt` if, and only if, it is the next receipt of its chain. The
   * hash is computed here, from the receipt, by the same code the verifier
   * uses; the new state is on disk before the signature is returned.
   */
  signReceipt(receipt: UnsignedReceipt): { sig: string; hash: string } {
    const { key, state, now } = this.options;
    if (receipt.key_id !== key.keyId) {
      throw new Refusal("invalid", `the receipt names key_id ${receipt.key_id}, and this signer holds ${key.keyId}`);
    }
    const malformed = malformedStringIn(receipt, "");
    if (malformed !== null) {
      throw new Refusal("invalid", `receipt field ${malformed} is not well-formed Unicode, so it has no canonical form`);
    }
    if ((receipt.seq === 0) !== (receipt.action.kind === "genesis")) {
      throw new Refusal("invalid", "a genesis receipt is the one at seq 0, and only it");
    }

    const known = state.get(receipt.system_id);
    if (known !== undefined && !isChain(known)) {
      throw new Refusal("sequence", `${receipt.system_id} belonged to a deleted system and is not given a new chain`);
    }
    const expectedSeq = known === undefined ? 0 : known.seq + 1;
    const expectedPrev = known === undefined ? GENESIS_PREV_HASH : known.hash;
    if (receipt.seq !== expectedSeq) {
      throw new Refusal(
        "sequence",
        known === undefined
          ? `${receipt.system_id} has no chain yet, so only seq 0 can be signed, not seq ${receipt.seq}`
          : `the next receipt of ${receipt.system_id} is seq ${expectedSeq}, not seq ${receipt.seq}`,
      );
    }
    if (receipt.prev_hash !== expectedPrev) {
      throw new Refusal(
        "sequence",
        `prev_hash ${receipt.prev_hash} is not the hash of the last receipt signed for ${receipt.system_id} (${expectedPrev})`,
      );
    }

    const received = Date.parse(receipt.ts_received);
    const clock = now();
    if (Math.abs(received - clock.getTime()) > this.toleranceMs) {
      throw new Refusal(
        "clock",
        `ts_received ${receipt.ts_received} is more than ${this.toleranceMs / 1000} s from the signer's clock (${clock.toISOString()})`,
      );
    }
    if (known !== undefined && received < Date.parse(known.head.ts_received)) {
      throw new Refusal(
        "clock",
        `ts_received ${receipt.ts_received} is earlier than that of the receipt before it (${known.head.ts_received})`,
      );
    }

    const digest = receiptHash(receipt);
    const sig = signDigest(digest, key.privateKey);
    const hash = toHex(digest);
    const head = { ...receipt, sig } as Receipt;
    state.put({
      system_id: receipt.system_id,
      seq: receipt.seq,
      hash,
      head,
      frontier: frontierAppend(known?.frontier ?? emptyFrontier(), fromHex(hash)),
    });
    return { sig, hash };
  }

  /** A checkpoint over everything signed for the system, at the signer's own time. */
  checkpoint(systemId: string): Checkpoint {
    const known = this.options.state.get(systemId);
    if (!isChain(known)) {
      throw new Refusal("unknown_system", `this signer has signed no chain for ${systemId}`);
    }
    return signCheckpoint(
      {
        v: CHECKPOINT_VERSION,
        system_id: systemId,
        tree_size: known.frontier.size,
        root_hash: toHex(frontierRoot(known.frontier)),
        ts: this.options.now().toISOString(),
        key_id: this.options.key.keyId,
      },
      this.options.key.privateKey,
    );
  }

  /** The last receipt signed for the system, or null if there is none. */
  head(systemId: string): Receipt | null {
    const known = this.options.state.get(systemId);
    return isChain(known) ? known.head : null;
  }
}
