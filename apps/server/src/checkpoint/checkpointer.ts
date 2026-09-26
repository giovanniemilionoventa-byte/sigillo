import type { ReceiptStore, StoredCheckpoint } from "../storage/store.js";
import {
  requestTimestampWithRetry,
  type RetryOptions,
  type TsaOptions,
} from "../timestamp/rfc3161.js";

/**
 * Turns the chains into signed checkpoints on a timer, and anchors each
 * checkpoint with an RFC 3161 token.
 *
 * The two steps are deliberately independent. A checkpoint is written and
 * signed whether or not the timestamp authority is reachable; the token is
 * fetched afterwards and retried until it arrives. An authority that is down
 * delays the anchor, it does not cost a checkpoint.
 */

export interface CheckpointerOptions {
  store: ReceiptStore;
  /** Injected, so tests do not depend on the wall clock. */
  now: () => Date;
  tsa?: TsaOptions;
  retry?: RetryOptions;
  intervalMinutes?: number;
  onError?: (message: string) => void;
}

export interface CheckpointRun {
  checkpoints: StoredCheckpoint[];
  timestamped: number;
  pending: number;
}

export class Checkpointer {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: CheckpointerOptions) {}

  /** One checkpoint per chain that has receipts the last one did not cover. */
  async checkpointAll(): Promise<StoredCheckpoint[]> {
    const written: StoredCheckpoint[] = [];
    for (const systemId of this.options.store.listSystems()) {
      const ts = this.options.now().toISOString();
      let checkpoint: StoredCheckpoint | null;
      try {
        checkpoint = await this.options.store.createCheckpoint(systemId, ts);
      } catch (error) {
        // An empty system deleted between the listing and its turn has
        // nothing left to check point; that is not a failed run.
        if (!this.options.store.hasSystem(systemId)) continue;
        throw error;
      }
      if (checkpoint !== null) {
        written.push(checkpoint);
      }
    }
    return written;
  }

  /**
   * Asks the authority for a token over every checkpoint that has none yet,
   * including ones from earlier runs that failed. Returns how many are still
   * waiting afterwards.
   */
  async timestampPending(): Promise<{ obtained: number; pending: number }> {
    const tsa = this.options.tsa;
    if (tsa === undefined) {
      return { obtained: 0, pending: 0 };
    }

    const waiting = this.options.store.checkpointsAwaitingTimestamp(tsa.url);
    let obtained = 0;

    for (const stored of waiting) {
      try {
        const token = await requestTimestampWithRetry(
          stored.checkpoint.root_hash,
          tsa,
          this.options.retry ?? {},
        );
        await this.options.store.recordTimestamp(
          stored.id,
          tsa.url,
          token,
          this.options.now().toISOString(),
        );
        obtained += 1;
      } catch (error) {
        // The checkpoint stays, and stays in the queue for the next run.
        this.options.onError?.(
          `checkpoint ${stored.id} is still unanchored: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { obtained, pending: waiting.length - obtained };
  }

  async runOnce(): Promise<CheckpointRun> {
    const checkpoints = await this.checkpointAll();
    const { obtained, pending } = await this.timestampPending();
    return { checkpoints, timestamped: obtained, pending };
  }

  start(): void {
    if (this.timer !== undefined) return;
    const minutes = this.options.intervalMinutes ?? 60;
    this.timer = setInterval(
      () => {
        void this.runOnce().catch((error: unknown) => {
          this.options.onError?.(
            `checkpoint run failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      minutes * 60 * 1000,
    );
    // The timer must not be what keeps the process alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
