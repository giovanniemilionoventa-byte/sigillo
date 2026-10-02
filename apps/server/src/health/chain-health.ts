import { type KeyObject } from "node:crypto";
import {
  DEFAULT_MAX_ANCHOR_DELAY_MS,
  GENESIS_PREV_HASH,
  receiptHashHex,
  verifyReceiptSignature,
} from "@sigillo/core";
import { formatTs } from "../http/strings.js";
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
 * export will carry an anchor-delay warning, and the light says so now.
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
    if (this.signerReachable === false) {
      return {
        status: "red",
        message:
          "Il firmatario non risponde: nessuna nuova azione può essere registrata finché non torna. " +
          "Le ricevute già scritte non cambiano.",
      };
    }
    // The signer keeps its own record of every chain. When the two disagree
    // in any way other than the one the server repairs by itself, nothing
    // more is written to this chain until a person has looked.
    if (this.store.signerDivergence(systemId) !== null) {
      return {
        status: "red",
        message:
          "Il firmatario e il database non concordano su questo registro: nessuna correzione automatica, " +
          "il dettaglio è nel registro amministrativo.",
      };
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
    const tolerance = Math.round(this.maxAnchorDelayMs / 60_000);
    // How the newest checkpoint stands with its timestamp: none yet within the
    // tolerance is "coming"; none beyond it, or one attested beyond it, is late.
    let anchoring: "anchored" | "coming" | "missing" | "late" | "none" = "none";
    let lateBy = 0;
    if (checkpoint !== null) {
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
    if ((anchoring === "anchored" || anchoring === "coming") && !stale && checkpoint !== null) {
      return {
        status: "green",
        message:
          `Registro integro. ${total} azion${total === 1 ? "e" : "i"} registrat${total === 1 ? "a" : "e"}, ultimo sigillo del ${formatTs(checkpoint.checkpoint.ts)}` +
          `${anchoring === "coming" ? ", marca temporale in arrivo" : ""}.`,
      };
    }

    const reasons: string[] = [];
    if (anchoring === "none") reasons.push("la marca temporale è in attesa");
    if (anchoring === "missing") reasons.push(`manca la marca temporale da oltre ${tolerance} minuti`);
    if (anchoring === "late") {
      reasons.push(`l'ultima marca temporale è arrivata ${Math.round(lateBy / 60_000)} minuti dopo il sigillo, oltre i ${tolerance} ammessi`);
    }
    if (stale) reasons.push(`nessuna attività da oltre ${Math.round(this.staleAfterMs / 60_000)} minuti`);
    return {
      status: "yellow",
      message: `Registro integro (${total} azion${total === 1 ? "e" : "i"}), ma ${reasons.join(" e ")}.`,
    };
  }
}
