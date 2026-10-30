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
 *   sigillo.connection.ended     the agent's process ended without closing
 *                                while the computer stayed on: the SDK's guard
 *                                process (sdk-python _watchdog.py) saw it go and
 *                                said so. The agent is dead, the machine is not.
 *   sigillo.connection.restored  the same session beats again after a loss
 *
 * What the guard saw on the computer itself (it keeps running through a
 * network cut or a sleep, so it can tell the agent afterwards):
 *
 *   sigillo.connection.sleep     the computer was asleep from..to: the agent
 *                                could not act (outcome ok)
 *   sigillo.connection.offline   the network was down from..to while the
 *                                computer was awake: the agent may have acted
 *                                unobserved (outcome error)
 *   sigillo.connection.power_off a new session started on a computer with a
 *                                newer boot time than the previous session's:
 *                                the computer was switched off or restarted in
 *                                between, so the silence before it was that
 *                                (outcome ok; a clean shutdown and a cut of
 *                                power look the same)
 *
 * `lost` and `ended` together tell a computer switched off or cut off (only
 * `lost`: nobody was left to say anything) from an agent that died on a
 * computer that kept running (`ended`, at once).
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
  ended: `${CONNECTION_PREFIX}ended`,
  restored: `${CONNECTION_PREFIX}restored`,
  scriptChanged: `${CONNECTION_PREFIX}script_changed`,
  sleep: `${CONNECTION_PREFIX}sleep`,
  offline: `${CONNECTION_PREFIX}offline`,
  powerOff: `${CONNECTION_PREFIX}power_off`,
} as const;

export type HeartbeatEvent = "start" | "beat" | "stop" | "ended" | "ping" | "gap";

/** A stretch of time the guard reports after the fact: it began at `from` and ends when this is received. */
export interface Gap {
  kind: "sleep" | "offline";
  from: string;
}

/** What else a heartbeat may carry besides the script hash. */
export interface HeartbeatExtras {
  /** When the computer was switched on (ISO time). */
  boot?: string | null | undefined;
  gap?: Gap | undefined;
}

/** Two boot times closer than this are the same boot: clocks drift and are adjusted. */
const SAME_BOOT_MS = 120_000;
/** How many gaps one session may report an hour. */
export const MAX_GAPS_PER_HOUR = 24;

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
  /** When each session reported its gaps of the last hour. In memory, like `opened`. */
  private readonly gaps = new Map<string, number[]>();
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
    extras: HeartbeatExtras = {},
  ): Promise<Receipt | null> {
    return this.serially(async () => {
      const at = this.now().toISOString();
      const known = this.store.connection(systemId, sessionId);
      // A ping only shows the network is up: nothing is written or changed.
      if (event === "ping") return null;
      if (event === "gap") return this.gap(systemId, known, at, extras.gap);
      if (event === "ended") {
        // Said by the guard process once the agent is gone. Only an open
        // session is ended: a normal stop came first, a lost one already says
        // more (or less), and an unknown one was never ours to end.
        if (known?.state !== "open") return null;
        return this.store.recordConnection(
          { ...known, state: "lost" },
          receiptOf(systemId, CONNECTION.ended, at, at, "error", "sdk"),
        );
      }
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
        boot_at: known === null ? (extras.boot ?? null) : known.boot_at,
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
        // The latest session before this one, to see whether the computer was
        // switched off in between (read before this one is saved).
        const previous = extras.boot == null ? undefined : this.store.connectionsOf(systemId).find((s) => s.boot_at !== null);
        const started = await this.store.recordConnection(row("open"), receiptOf(systemId, CONNECTION.start, at, at, "ok", "sdk"));
        if (previous !== undefined && previous.state !== "closed" && extras.boot != null && previous.boot_at !== null) {
          if (Math.abs(Date.parse(extras.boot) - Date.parse(previous.boot_at)) > SAME_BOOT_MS) {
            await this.store.recordConnection(row("open"), receiptOf(systemId, CONNECTION.powerOff, previous.last_beat_at, at, "ok", "sdk"));
          }
        }
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

  /** A gap the guard reports: written for an open or lost session, at most MAX_GAPS_PER_HOUR an hour. */
  private async gap(systemId: string, known: ConnectionRow | null, at: string, gap: Gap | undefined): Promise<Receipt | null> {
    if (known === null || known.state === "closed" || gap === undefined) return null;
    const now = Date.parse(at);
    const recent = (this.gaps.get(known.session_id) ?? []).filter((time) => now - time < HOUR_MS);
    if (recent.length >= MAX_GAPS_PER_HOUR) return null;
    recent.push(now);
    this.gaps.set(known.session_id, recent);
    // Never earlier than the session began, never later than now.
    const from = new Date(Math.min(now, Math.max(Date.parse(gap.from), Date.parse(known.started_at)))).toISOString();
    const name = gap.kind === "sleep" ? CONNECTION.sleep : CONNECTION.offline;
    return this.store.recordConnection(known, receiptOf(systemId, name, from, at, gap.kind === "sleep" ? "ok" : "error", "sdk"));
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
