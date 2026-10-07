import type { Outcome, Receipt, SourceType } from "@sigillo/core";
import type { ConnectionRow, ReceiptStore } from "../storage/store.js";
import { CONNECTION_PREFIX } from "./names.js";

/**
 * The Python SDK's heartbeat, seen from the server.
 *
 * A running agent that called `sigillo.init` sends `start` once, `beat` every
 * minute while it runs (idle or not), and `stop` when it closes normally. The
 * server writes a receipt on the chain at every change of state, and only
 * then, so a day of beats costs no receipts:
 *
 *   sigillo.connection.start     the agent connected (a new session)
 *   sigillo.connection.stop      it closed normally
 *   sigillo.connection.lost      it went silent without closing: the code
 *                                was removed, the process killed, the machine
 *                                switched off, or the network cut. ts_event is
 *                                its last beat: the silence started there.
 *   sigillo.connection.restored  the same session beats again after a loss
 *
 * Those names are refused from every client (store.ts, CONNECTION_PREFIX), so
 * a receipt by one of them was written here. They are ordinary receipts:
 * signed, chained, sealed and exported like any other, and an auditor reads
 * the gaps in an agent's connection from the archive alone.
 *
 * The script guard. When the SDK also sends the SHA-256 of the agent's main
 * script (taken again at every beat), the server remembers the one a session
 * started with and writes `sigillo.connection.script_changed`:
 *
 *   - once, when a running session sends a different one (or null: the file
 *     can no longer be read), and from then on answers `script_changed: true`
 *     to every beat, which an SDK in strict mode takes as its order to stop;
 *   - once, right after the start of a session whose script differs from the
 *     last session's that sent one (the agent edited itself and restarted;
 *     an owner's own update looks the same, and is written the same).
 *
 * New, so the operator's own systems only until the owner opens it
 * (SIGILLO_SCRIPT_GUARD, CLAUDE.md rule 11): for any other system the server
 * calls this without a hash and the beats are as they were.
 *
 * What this does not tell: what happened while the agent was silent, nor why
 * it was silent. A program that rebuilds the heartbeat by hand, or keeps it
 * and switches the recording off, goes unseen (docs/SECURITY.md).
 */

export const CONNECTION = {
  start: `${CONNECTION_PREFIX}start`,
  stop: `${CONNECTION_PREFIX}stop`,
  lost: `${CONNECTION_PREFIX}lost`,
  restored: `${CONNECTION_PREFIX}restored`,
  scriptChanged: `${CONNECTION_PREFIX}script_changed`,
} as const;

export type HeartbeatEvent = "start" | "beat" | "stop";

/** The SDK beats every 60 seconds; three missed beats are a loss. */
export const DEFAULT_LOST_AFTER_MS = 3 * 60_000;
const SWEEP_EVERY_MS = 30_000;
/**
 * How many sessions one system may open in an hour. An agent opens one each
 * time its program starts, so an honest one stays far below; what this stops
 * is a client inventing a new session id per request, each of which would
 * write a receipt (and later a `lost` one) past the organization's monthly
 * limit, and a row the sweep reads every 30 seconds.
 */
export const DEFAULT_MAX_NEW_SESSIONS_PER_HOUR = 60;
const HOUR_MS = 60 * 60_000;

export interface ConnectionWatchOptions {
  store: ReceiptStore;
  now?: () => Date;
  lostAfterMs?: number;
  maxNewSessionsPerHour?: number;
}

/** A session this system may not open now: it opened too many in the last hour. */
export class TooManySessionsError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("too many new heartbeat sessions for this system in the last hour");
    this.name = "TooManySessionsError";
  }
}

export class ConnectionWatch {
  private readonly store: ReceiptStore;
  private readonly now: () => Date;
  readonly lostAfterMs: number;
  private readonly maxNewSessionsPerHour: number;
  /** When each system opened its sessions of the last hour. In memory: a restart forgets it. */
  private readonly opened = new Map<string, number[]>();
  /**
   * When this process started. A session whose beats stopped while the
   * server itself was down is not called lost until it has had a full
   * allowance to reach this process: the silence may have been ours.
   */
  private readonly since: number;
  /** One change at a time: two beats of one session never both write a receipt. */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ConnectionWatchOptions) {
    this.store = options.store;
    this.now = options.now ?? ((): Date => new Date());
    this.lostAfterMs = options.lostAfterMs ?? DEFAULT_LOST_AFTER_MS;
    this.maxNewSessionsPerHour = options.maxNewSessionsPerHour ?? DEFAULT_MAX_NEW_SESSIONS_PER_HOUR;
    this.since = this.now().getTime();
  }

  /**
   * A heartbeat from one running copy of an agent. Returns the receipt it
   * caused, if any. A session not seen before counts against the system's
   * hourly allowance, and past it is refused with TooManySessionsError,
   * nothing written; sessions already open go on beating as before.
   */
  heartbeat(
    systemId: string,
    sessionId: string,
    event: HeartbeatEvent,
    script?: { hash: string | null },
  ): Promise<Receipt | null> {
    return this.serially(async () => {
      const at = this.now().toISOString();
      const known = this.store.connection(systemId, sessionId);
      if (known === null) this.admitNewSession(systemId, Date.parse(at));
      // The script guard (see the head of this file) looks at a start or a
      // beat that carried a hash; a stop never does.
      const guard = event === "stop" ? undefined : script;
      const row = (state: ConnectionRow["state"], changed = known?.script_changed ?? 0): ConnectionRow => ({
        system_id: systemId,
        session_id: sessionId,
        state,
        started_at: known?.started_at ?? at,
        last_beat_at: at,
        script_hash: known === null ? (guard?.hash ?? null) : known.script_hash,
        script_changed: changed,
      });

      if (event === "stop") {
        if (known?.state === "closed") return null;
        return this.store.recordConnection(row("closed"), receiptOf(systemId, CONNECTION.stop, at, at, "ok", "sdk"));
      }
      // A beat from a session never seen starting (its start was lost on the
      // way) starts it: the chain shows when the server first heard from it.
      if (known === null) {
        // What the last session that sent a hash ran, read before this one is saved.
        const before = guard === undefined ? undefined : this.store.connectionsOf(systemId).find((s) => s.script_hash !== null);
        const started = await this.store.recordConnection(row("open"), receiptOf(systemId, CONNECTION.start, at, at, "ok", "sdk"));
        if (before === undefined || guard === undefined || before.script_hash === guard.hash) return started;
        return this.store.recordConnection(row("open"), receiptOf(systemId, CONNECTION.scriptChanged, at, at, "error", "sdk"));
      }
      let written: Receipt | null = null;
      if (known.state !== "open") {
        written = await this.store.recordConnection(row("open"), receiptOf(systemId, CONNECTION.restored, at, at, "ok", "sdk"));
      }
      if (guard !== undefined && known.script_hash !== null && known.script_changed === 0 && guard.hash !== known.script_hash) {
        return this.store.recordConnection(row("open", 1), receiptOf(systemId, CONNECTION.scriptChanged, at, at, "error", "sdk"));
      }
      return written ?? (await this.store.recordConnection(row("open"), null));
    });
  }

  /** Whether this session's script is no longer the one it started with. */
  scriptChanged(systemId: string, sessionId: string): boolean {
    return (this.store.connection(systemId, sessionId)?.script_changed ?? 0) === 1;
  }

  /** Writes `lost` for every session silent past the allowance. Returns how many. */
  sweep(): Promise<number> {
    return this.serially(async () => {
      const now = this.now().getTime();
      if (now - this.since <= this.lostAfterMs) return 0;
      let lost = 0;
      for (const session of this.store.openConnections()) {
        if (now - Date.parse(session.last_beat_at) <= this.lostAfterMs) continue;
        await this.store.recordConnection(
          { ...session, state: "lost" },
          receiptOf(session.system_id, CONNECTION.lost, session.last_beat_at, new Date(now).toISOString(), "error", "api"),
        );
        lost += 1;
      }
      return lost;
    });
  }

  /** Same shape as Checkpointer.start(): a timer the process does not wait on. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      // A signer that is away now is asked again at the next sweep.
      this.sweep().catch(() => undefined);
    }, SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private admitNewSession(systemId: string, now: number): void {
    const recent = (this.opened.get(systemId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= this.maxNewSessionsPerHour) {
      this.opened.set(systemId, recent);
      throw new TooManySessionsError(Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now) / 1000)));
    }
    recent.push(now);
    this.opened.set(systemId, recent);
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * How a system's connection stands now, for the web view. Lost while a loss
 * no later session made up for (the program started again after it) is
 * still outstanding, even with another copy of the agent beating; otherwise
 * the most recent session says. Null when no session ever beat (an agent
 * connected some other way, or an SDK older than the heartbeat).
 */
export function connectionStatus(
  store: ReceiptStore,
  systemId: string,
): { state: ConnectionRow["state"]; since: string } | null {
  const sessions = store.connectionsOf(systemId);
  const [latest] = sessions;
  if (latest === undefined) return null;
  const outstanding = sessions
    .filter((session) => session.state === "lost")
    .filter((lost) => !sessions.some((other) => other.state !== "lost" && other.started_at > lost.last_beat_at))
    .map((lost) => lost.last_beat_at)
    .sort();
  if (outstanding[0] !== undefined) return { state: "lost", since: outstanding[0] };
  return { state: latest.state, since: latest.state === "open" ? latest.started_at : latest.last_beat_at };
}

function receiptOf(systemId: string, name: string, tsEvent: string, tsReceived: string, outcome: Outcome, source: SourceType) {
  return {
    system_id: systemId,
    ts_event: tsEvent,
    ts_received: tsReceived,
    actor: { agent: "sigillo" },
    action: { kind: "agent_step" as const, name },
    input_hash: null,
    output_hash: null,
    outcome,
    source: { type: source },
  };
}
