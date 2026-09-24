import { type KeyObject } from "node:crypto";
import { GENESIS_PREV_HASH, receiptHashHex, verifyReceiptSignature } from "@sigillo/core";
import type { ReceiptStore } from "../storage/store.js";

/**
 * The traffic light on the main page: not a replacement for `sigillo-verify`,
 * which an auditor runs against an exported archive, but a live signal for an
 * operator watching the server itself. It checks the same two things that
 * matter most — the chain links and the signatures — incrementally, so a
 * system with a long history is not re-verified from its genesis on every
 * tick, only from wherever the last tick left off.
 *
 * A failure is sticky: once a system turns red it stays red until the process
 * restarts. Manufacturing an "un-failing" would mean deciding when a broken
 * chain is trusted again, which is not this monitor's call to make.
 */

export type ChainStatus = "green" | "yellow" | "red";

export interface SystemHealth {
  status: ChainStatus;
  message: string;
}

interface TrackedState {
  lastSeq: number;
  lastHash: string;
  failed: boolean;
  failureDetail?: string;
}

export class ChainHealthMonitor {
  private readonly tracked = new Map<string, TrackedState>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ReceiptStore,
    private readonly publicKey: KeyObject,
    private readonly staleAfterMs: number,
  ) {}

  /** Verifies whatever is new since the last call, for every system that exists. */
  check(): void {
    for (const systemId of this.store.listSystems()) {
      this.checkSystem(systemId);
    }
  }

  /** Same shape as Checkpointer.start(): a timer the process does not wait on. */
  start(intervalMinutes = 1): void {
    if (this.timer !== undefined) return;
    this.check();
    this.timer = setInterval(() => this.check(), intervalMinutes * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private checkSystem(systemId: string): void {
    const previous = this.tracked.get(systemId);
    if (previous?.failed === true) return;

    let lastSeq = previous?.lastSeq ?? -1;
    let lastHash = previous?.lastHash ?? GENESIS_PREV_HASH;

    for (const receipt of this.store.readChainFrom(systemId, lastSeq)) {
      if (receipt.prev_hash !== lastHash) {
        this.tracked.set(systemId, {
          lastSeq,
          lastHash,
          failed: true,
          failureDetail: `la ricevuta seq ${receipt.seq} non collega alla precedente`,
        });
        return;
      }
      // Each receipt under the key it names, from the keys this database has
      // signed with: a chain may span a change of key (review point 7).
      const key = this.store.publicKeyFor(receipt.key_id) ?? this.publicKey;
      if (!verifyReceiptSignature(receipt, key)) {
        this.tracked.set(systemId, {
          lastSeq,
          lastHash,
          failed: true,
          failureDetail: `la firma della ricevuta seq ${receipt.seq} non è valida`,
        });
        return;
      }
      lastHash = receiptHashHex(receipt);
      lastSeq = receipt.seq;
    }

    this.tracked.set(systemId, { lastSeq, lastHash, failed: false });
  }

  statusFor(systemId: string, now: Date): SystemHealth {
    const state = this.tracked.get(systemId);
    if (state?.failed === true) {
      return { status: "red", message: `Verifica fallita: ${state.failureDetail ?? "la catena non torna"}.` };
    }

    const tip = this.store.tip(systemId);
    if (tip === null) {
      return { status: "yellow", message: "Nessuna azione registrata ancora." };
    }

    const [latest] = this.store.searchReceipts({ systemId, limit: 1 });
    const minutesSinceActivity =
      latest === undefined ? Number.POSITIVE_INFINITY : (now.getTime() - Date.parse(latest.ts_received)) / 60_000;
    const stale = minutesSinceActivity > this.staleAfterMs / 60_000;

    const checkpoint = this.store.latestCheckpoint(systemId);
    const anchored = checkpoint !== null && this.store.readTimestamps(checkpoint.id).length > 0;

    const total = tip.seq + 1;
    if (anchored && !stale) {
      return {
        status: "green",
        message: `Registro integro. ${total} azion${total === 1 ? "e" : "i"} registrat${total === 1 ? "a" : "e"}, ultimo sigillo del ${checkpoint.checkpoint.ts}.`,
      };
    }

    const reasons: string[] = [];
    if (!anchored) reasons.push("la marca temporale è in attesa");
    if (stale) reasons.push(`nessuna attività da oltre ${Math.round(this.staleAfterMs / 60_000)} minuti`);
    return {
      status: "yellow",
      message: `Registro integro (${total} azion${total === 1 ? "e" : "i"}), ma ${reasons.join(" e ")}.`,
    };
  }
}
