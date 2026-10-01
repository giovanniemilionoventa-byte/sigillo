import { SignerRefusedError } from "../signer/errors.js";
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
 *
 * The delay matters, though: the time the authority attests is the proven
 * time of the checkpoint, and sigillo-verify warns about one timestamped more
 * than --max-anchor-delay (60 minutes by default) after its own time. So a
 * run that leaves tokens missing tries again after `retryMinutes`, and keeps
 * trying at that pace until none is missing, rather than waiting a whole
 * interval. The light on the main page turns yellow once a token is overdue.
 */

export interface CheckpointerOptions {
  store: ReceiptStore;
  /** Injected, so tests do not depend on the wall clock. */
  now: () => Date;
  tsa?: TsaOptions;
  retry?: RetryOptions;
  intervalMinutes?: number;
  /** How soon to ask again for tokens a run could not obtain. Default 5. */
  retryMinutes?: number;
  onError?: (message: string) => void;
}

export interface CheckpointRun {
  checkpoints: StoredCheckpoint[];
  timestamped: number;
  pending: number;
}

export class Checkpointer {
  private timer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: CheckpointerOptions) {}

  /** One checkpoint per chain that has receipts the last one did not cover. */
  async checkpointAll(): Promise<StoredCheckpoint[]> {
    const written: StoredCheckpoint[] = [];
    for (const systemId of this.options.store.listSystems()) {
      let checkpoint: StoredCheckpoint | null;
      try {
        // The signer builds it, root and time included, from its own record.
        checkpoint = await this.options.store.createCheckpoint(systemId);
      } catch (error) {
        // An empty system deleted between the listing and its turn has
        // nothing left to check point; that is not a failed run.
        if (!this.options.store.hasSystem(systemId)) continue;
        // A chain the signer disagrees with gets no checkpoint, and is
        // already red and in the administrative log; the others still do.
        if (error instanceof SignerRefusedError) {
          this.options.onError?.(`no checkpoint for ${systemId}: ${error.message}`);
          continue;
        }
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

  /**
   * Runs at once, then every interval. The first run must not wait for a full
   * interval: a server restarted more often than that (a deploy, an update, a
   * crash loop) would otherwise never reach its first tick and never write a
   * checkpoint. A run still in progress when the next one is due is left to
   * finish, so a slow authority cannot pile up overlapping runs.
   */
  start(): void {
    if (this.timer !== undefined) return;
    const minutes = this.options.intervalMinutes ?? 60;
    const tick = (): void => {
      void this.exclusively(() => this.runOnce());
    };
    this.timer = setInterval(tick, minutes * 60 * 1000);
    // The timer must not be what keeps the process alive.
    this.timer.unref();
    tick();
  }

  /**
   * Runs `work` unless a run is already going, then schedules a retry of the
   * timestamps if any are still missing.
   */
  private async exclusively(work: () => Promise<{ pending: number }>): Promise<void> {
    if (this.running) return;
    this.running = true;
    let pending = 0;
    try {
      ({ pending } = await work());
    } catch (error: unknown) {
      this.options.onError?.(
        `checkpoint run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
    if (pending > 0 && this.timer !== undefined && this.retryTimer === undefined) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.exclusively(() => this.timestampPending());
      }, (this.options.retryMinutes ?? 5) * 60 * 1000);
      this.retryTimer.unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
