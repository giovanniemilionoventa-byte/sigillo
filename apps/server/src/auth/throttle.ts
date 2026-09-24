import { ConfigError, positiveInteger, type Environment } from "../config.js";

/**
 * How many failed attempts a client may make before it has to wait.
 *
 * After `maxFailures` failures within `windowMs`, the client is locked out for
 * `lockoutMs`; each further lockout of the same client doubles, up to
 * `maxLockoutMs`. A success forgets the client. While a client is locked out
 * its attempts are not evaluated at all, and they do not count: a lockout ends
 * when it was set to end, however hard it was knocked on meanwhile.
 *
 * Everything is in memory, which is enough for one server process and costs a
 * restart's worth of forgetting. The number of clients remembered is bounded,
 * so that a stream of new addresses cannot grow it without limit.
 *
 * Time is always passed in, in milliseconds, so that the behaviour can be
 * tested without waiting for it.
 */

export interface ThrottleSettings {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  maxLockoutMs: number;
}

export interface ThrottleOptions extends ThrottleSettings {
  /** How long a client's past lockouts are held against it. Default: 24 hours. */
  forgetAfterMs?: number;
  /** How many clients are remembered at most. Default: 10000. */
  maxEntries?: number;
}

interface Entry {
  /** When each failure inside the current window happened. */
  failures: number[];
  lockedUntil: number;
  /** How many times this client has been locked out, for the doubling. */
  lockouts: number;
  lastFailure: number;
}

const DAY_MS = 24 * 60 * 60_000;

export class AttemptThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly forgetAfterMs: number;
  private readonly maxEntries: number;

  constructor(private readonly options: ThrottleOptions) {
    this.forgetAfterMs = options.forgetAfterMs ?? DAY_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** How many clients are remembered right now. */
  get size(): number {
    return this.entries.size;
  }

  isLocked(client: string, now: number): boolean {
    const entry = this.entries.get(client);
    return entry !== undefined && now < entry.lockedUntil;
  }

  recordFailure(client: string, now: number): void {
    let entry = this.entries.get(client);
    if (entry !== undefined && now - entry.lastFailure > this.forgetAfterMs) {
      this.entries.delete(client);
      entry = undefined;
    }
    if (entry === undefined) {
      this.makeRoom(now);
      entry = { failures: [], lockedUntil: 0, lockouts: 0, lastFailure: now };
      this.entries.set(client, entry);
    }
    if (now < entry.lockedUntil) return;

    entry.lastFailure = now;
    entry.failures = entry.failures.filter((at) => now - at < this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockouts += 1;
      const doubled = this.options.lockoutMs * 2 ** Math.min(entry.lockouts - 1, 30);
      entry.lockedUntil = now + Math.min(doubled, this.options.maxLockoutMs);
      entry.failures = [];
    }
  }

  recordSuccess(client: string): void {
    this.entries.delete(client);
  }

  /** Drop clients with nothing left to hold against them, then the oldest if still full. */
  private makeRoom(now: number): void {
    if (this.entries.size < this.maxEntries) return;
    for (const [client, entry] of this.entries) {
      if (now >= entry.lockedUntil && now - entry.lastFailure > this.options.windowMs) {
        this.entries.delete(client);
      }
    }
    // Map iteration is insertion order: the first keys are the oldest.
    for (const client of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(client);
    }
  }
}

const MINUTE_MS = 60_000;

/** The web view's login limits, from SIGILLO_LOGIN_* or their defaults. */
export function parseThrottleSettings(env: Environment): ThrottleSettings {
  const settings = {
    maxFailures: positiveInteger("SIGILLO_LOGIN_MAX_FAILURES", env["SIGILLO_LOGIN_MAX_FAILURES"], 5, 1000),
    windowMs:
      positiveInteger("SIGILLO_LOGIN_WINDOW_MINUTES", env["SIGILLO_LOGIN_WINDOW_MINUTES"], 15, 7 * 24 * 60) *
      MINUTE_MS,
    lockoutMs:
      positiveInteger("SIGILLO_LOGIN_LOCKOUT_MINUTES", env["SIGILLO_LOGIN_LOCKOUT_MINUTES"], 5, 7 * 24 * 60) *
      MINUTE_MS,
    maxLockoutMs:
      positiveInteger(
        "SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES",
        env["SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES"],
        60,
        7 * 24 * 60,
      ) * MINUTE_MS,
  };
  if (settings.maxLockoutMs < settings.lockoutMs) {
    throw new ConfigError(
      "SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES must be at least SIGILLO_LOGIN_LOCKOUT_MINUTES",
    );
  }
  return settings;
}

/**
 * The ingest endpoints' limit on failed API keys. Agents retry on their own,
 * so the window is short and the lockout brief; what it stops is a stream of
 * guesses, each of which would otherwise cost the server one scrypt.
 */
export function parseIngestThrottleSettings(env: Environment): ThrottleSettings {
  return {
    maxFailures: positiveInteger("SIGILLO_INGEST_MAX_FAILURES", env["SIGILLO_INGEST_MAX_FAILURES"], 20, 100_000),
    windowMs: MINUTE_MS,
    lockoutMs: MINUTE_MS,
    maxLockoutMs: 15 * MINUTE_MS,
  };
}
