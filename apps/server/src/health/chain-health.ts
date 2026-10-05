import { type KeyObject } from "node:crypto";
import {
  DEFAULT_MAX_ANCHOR_DELAY_MS,
  GENESIS_PREV_HASH,
  receiptHashHex,
  verifyReceiptSignature,
} from "@sigillo/core";
import { durationWords, formatTs, healthWords } from "../http/strings.js";
import { connectionStatus } from "../connection/watch.js";
import type { ReceiptStore } from "../storage/store.js";

/**
 * The traffic light on the main page: not a replacement for `sigillo-verify`,
 * which an auditor runs against an exported archive, but a live signal for an
 * operator watching the server itself. It checks the same two things that
 * matter most — the chain links and the signatures — incrementally, so a
 * system with a long history is not re-verified from its genesis on every
 * tick, only from wherever the last tick left off.
 *
 * It also watches the anchoring. A checkpoint whose timestamp has not arrived
 * is retried by the checkpointer, and is not worth a yellow light until it
 * has waited longer than `maxAnchorDelayMs`, the delay sigillo-verify accepts
 * (--max-anchor-delay); nor is one timestamped within it. Beyond it, the next
 * export will carry an anchor-delay warning, and the light says so now. A new
 * system has the same allowance for its first checkpoint, counted from its
 * opening: the checkpointer seals each chain on its own timer, and a system
 * opened a minute ago that has not met it yet has nothing wrong with it.
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
  failure?: { kind: "link" | "signature"; seq: number };
}

export class ChainHealthMonitor {
  private readonly tracked = new Map<string, TrackedState>();
  private timer: NodeJS.Timeout | undefined;
  /** Whether the signer answered when last asked; null until asked, or with no way to ask. */
  private signerReachable: boolean | null = null;

  constructor(
    private readonly store: ReceiptStore,
    private readonly publicKey: KeyObject,
    private readonly staleAfterMs: number,
    private readonly maxAnchorDelayMs: number = DEFAULT_MAX_ANCHOR_DELAY_MS,
    /** Asked on every tick: a server that cannot sign is not shown green. */
    private readonly signerHealthy?: () => Promise<boolean>,
  ) {}

  /** Asks the signer whether it answers, and remembers the answer for statusFor. */
  async checkSigner(): Promise<void> {
    if (this.signerHealthy === undefined) return;
    try {
      this.signerReachable = await this.signerHealthy();
    } catch {
      this.signerReachable = false;
    }
  }

  /** The systems whose chain failed its check: a broken link or signature. Sorted. */
  failedSystems(): string[] {
    return [...this.tracked.entries()].filter(([, state]) => state.failed).map(([systemId]) => systemId).sort();
  }

  /** Verifies whatever is new since the last call, for every system that exists. */
  check(): void {
    for (const systemId of this.store.listSystems()) {
      this.checkSystem(systemId);
    }
  }

  /**
   * Drops what was remembered about a system, for one that was just deleted:
   * its identifier is not reused (ReceiptStore.createSystem), but a monitor
   * that kept the old chain's tip would call any later chain under that name
   * broken.
   */
  forget(systemId: string): void {
    this.tracked.delete(systemId);
  }

  /** Same shape as Checkpointer.start(): a timer the process does not wait on. */
  start(intervalMinutes = 1): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      this.check();
      void this.checkSigner();
    };
    tick();
    this.timer = setInterval(tick, intervalMinutes * 60 * 1000);
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
          failure: { kind: "link", seq: receipt.seq },
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
          failure: { kind: "signature", seq: receipt.seq },
        });
        return;
      }
      lastHash = receiptHashHex(receipt);
      lastSeq = receipt.seq;
    }

    this.tracked.set(systemId, { lastSeq, lastHash, failed: false });
  }

  statusFor(systemId: string, now: Date): SystemHealth {
    // The words are read at every call, in the language of the page asking.
    const words = healthWords();
    const state = this.tracked.get(systemId);
    if (state?.failed === true) {
      const failure = state.failure;
      const detail =
        failure === undefined ? null : failure.kind === "link" ? words.linkBroken(failure.seq) : words.signatureInvalid(failure.seq);
      return { status: "red", message: words.failed(detail) };
    }
    if (this.signerReachable === false) {
      return { status: "red", message: words.signerDown };
    }
    // The signer keeps its own record of every chain. When the two disagree
    // in any way other than the one the server repairs by itself, nothing
    // more is written to this chain until a person has looked.
    if (this.store.signerDivergence(systemId) !== null) {
      return { status: "red", message: words.divergence };
    }

    const tip = this.store.tip(systemId);
    if (tip === null) {
      return { status: "yellow", message: words.noActions };
    }

    const [latest] = this.store.searchReceipts({ systemId, limit: 1 });
    const minutesSinceActivity =
      latest === undefined ? Number.POSITIVE_INFINITY : (now.getTime() - Date.parse(latest.ts_received)) / 60_000;
    // An agent whose heartbeat is still beating is idle, not gone: no warning
    // for quiet. One whose heartbeat stopped without closing is, at once.
    const connection = connectionStatus(this.store, systemId);
    const lost = connection?.state === "lost";
    const stale = connection?.state !== "open" && minutesSinceActivity > this.staleAfterMs / 60_000;

    const checkpoint = this.store.latestCheckpoint(systemId);
    const tolerance = Math.round(this.maxAnchorDelayMs / 60_000);
    // How the newest checkpoint stands with its timestamp: none yet within the
    // tolerance is "coming"; none beyond it, or one attested beyond it, is late.
    let anchoring: "anchored" | "coming" | "missing" | "late" | "first" | "none" = "none";
    let lateBy = 0;
    if (checkpoint === null) {
      const opened = this.store.receiptAt(systemId, 0);
      if (opened !== null && now.getTime() - Date.parse(opened.ts_received) <= this.maxAnchorDelayMs) anchoring = "first";
    } else {
      const declared = Date.parse(checkpoint.checkpoint.ts);
      const attested = this.store
        .readTimestamps(checkpoint.id)
        .map((stamp) => (stamp.genTime === undefined ? declared : Date.parse(stamp.genTime)));
      if (attested.length === 0) {
        anchoring = now.getTime() - declared > this.maxAnchorDelayMs ? "missing" : "coming";
      } else {
        lateBy = Math.min(...attested) - declared;
        anchoring = lateBy > this.maxAnchorDelayMs ? "late" : "anchored";
      }
    }

    const total = tip.seq + 1;
    if (anchoring === "first" && !stale && !lost) {
      return { status: "green", message: words.firstComing(total, durationWords(tolerance)) };
    }
    if ((anchoring === "anchored" || anchoring === "coming") && !stale && !lost && checkpoint !== null) {
      return { status: "green", message: words.sealed(total, formatTs(checkpoint.checkpoint.ts), anchoring === "coming") };
    }

    const reasons: string[] = [];
    if (anchoring === "none") reasons.push(words.notSealed(durationWords(tolerance)));
    if (anchoring === "missing") reasons.push(words.stampMissing(durationWords(tolerance)));
    if (anchoring === "late") reasons.push(words.stampLate(durationWords(Math.round(lateBy / 60_000)), durationWords(tolerance)));
    if (stale) reasons.push(words.idle(durationWords(Math.round(this.staleAfterMs / 60_000))));
    if (lost) reasons.push(words.disconnected(formatTs(connection.since)));
    return { status: "yellow", message: words.attention(total, reasons) };
  }
}

/** In the reader's language now (http/strings.ts); exported from here as before. */
export { durationWords };
