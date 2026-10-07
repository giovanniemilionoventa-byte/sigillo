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
  /** The least time between two runs asked for from the web view (requestRun). Default 10 seconds. */
  requestGapMs?: number;
  onError?: (message: string) => void;
  /** How a run asked for waits out the gap; tests pass one that does not. */
  sleep?: (ms: number) => Promise<void>;
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
  /** Every run, the timer's and those asked for, one after the other: never two at once. */
  private lock: Promise<unknown> = Promise.resolve();
  /** A run asked for that has not started yet: whoever asks meanwhile is covered by it. */
  private requested: Promise<void> | null = null;
  /** When the last run asked for ended, for the gap. */
  private requestedEndedAt = 0;

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
   * A run as the web view's "seal now" asks for it: one that starts after
   * the request, so it covers every receipt written before it, but never
   * alongside another run, and never sooner than `requestGapMs` after the
   * last one asked for. Requests that arrive while one is waiting to start
   * share it. Any number of clicks, from any number of accounts, costs at
   * most one run per gap, and one token request per new checkpoint: two runs
   * at once would each ask the authority for the same checkpoints' tokens.
   */
  requestRun(): Promise<void> {
    if (this.requested !== null) return this.requested;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const run = this.serially(async () => {
      const wait = this.requestedEndedAt + (this.options.requestGapMs ?? 10_000) - this.options.now().getTime();
      if (wait > 0) await sleep(wait);
      // From here on, a new request needs a run of its own.
      this.requested = null;
      try {
        await this.whileRunning(() => this.runOnce());
      } finally {
        this.requestedEndedAt = this.options.now().getTime();
      }
    });
    this.requested = run;
    return run;
  }

  /** `work` once every run queued before it has finished. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** `work` with the timer told a run is going, so that its tick skips rather than queues. */
  private async whileRunning(work: () => Promise<{ pending: number }>): Promise<{ pending: number }> {
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }

  /**
   * Runs `work` unless a run is already going, then schedules a retry of the
   * timestamps if any are still missing.
   */
  private async exclusively(work: () => Promise<{ pending: number }>): Promise<void> {
    if (this.running) return;
    let pending = 0;
    try {
      ({ pending } = await this.serially(() => this.whileRunning(work)));
    } catch (error: unknown) {
      this.options.onError?.(
        `checkpoint run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
