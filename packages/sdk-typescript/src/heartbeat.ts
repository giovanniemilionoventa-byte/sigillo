import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, packageHash } from "./guard.js";

/**
 * Tells the server, every `interval` seconds, that this agent is still
 * connected: `start` once, `beat` while the process runs (busy or idle),
 * `stop` when it closes normally. The same protocol as the Python SDK's
 * (docs/API.md, POST /api/v1/heartbeat); the server writes a receipt only
 * when the state changes. The timer is unref'd, so it never keeps a process
 * alive. A beat that does not get through is not retried: the next one says
 * the same thing.
 */

const STRICT_MISSED_BEATS = 3;
const here = dirname(fileURLToPath(import.meta.url));

export function heartbeatEndpoint(tracesUrl: string): string {
  return tracesUrl.replace(/\/v1\/traces$/, "/api/v1/heartbeat");
}

/** When this computer was switched on, as an ISO time, or null. */
export function bootTime(): string | null {
  try {
    if (process.platform === "linux") {
      for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
        if (line.startsWith("btime ")) return new Date(Number(line.split(" ")[1]) * 1000).toISOString();
      }
    }
    return new Date(Date.now() - uptime() * 1000).toISOString();
  } catch {
    return null;
  }
}

/** The file the agent was started with (`node agent.js`), absolute, or null for a REPL. */
export function mainScript(): string | null {
  const script = process.argv[1];
  return script === undefined ? null : resolve(script);
}

export interface HeartbeatOptions {
  url: string;
  apiKey: string;
  intervalSeconds: number;
  showSent: boolean;
  strict: boolean;
  onHalt: (reason: string) => void;
  guardPeriodSeconds: number;
  fetch?: typeof fetch;
  /** For tests: no guard process. */
  guard?: boolean;
}

export class Heartbeat {
  readonly session = randomBytes(16).toString("hex");
  readonly #options: HeartbeatOptions;
  readonly #script = mainScript();
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | undefined;
  #guard: ChildProcess | undefined;
  #missed = 0;
  #halted = false;
  #closed = false;
  /** Beats go out one at a time, in order: a `stop` must never overtake the `start`. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: HeartbeatOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  start(): void {
    if (this.#options.guard !== false) this.#startGuard();
    void this.#send("start");
    this.#timer = setInterval(() => void this.#send("beat"), this.#options.intervalSeconds * 1000);
    this.#timer.unref();
    // `exit` cannot wait for the network: the guard sends the `stop`.
    process.once("exit", this.#onExit);
  }

  #onExit = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#tellGuard("exit");
  };

  #startGuard(): void {
    const compiled = resolve(here, "guard.js");
    const guardPath = existsSync(compiled) ? compiled : resolve(here, "guard.ts");
    const config = {
      url: this.#options.url,
      apiKey: this.#options.apiKey,
      session: this.session,
      script: this.#script,
      scriptHash: this.#script === null ? null : fileHash(this.#script),
      sdkHash: packageHash(here),
      parent: process.pid,
      beatEvery: this.#options.intervalSeconds,
      strict: this.#options.strict,
      period: this.#options.guardPeriodSeconds,
    };
    try {
      const guard = spawn(process.execPath, [guardPath], { stdio: ["pipe", "ignore", "inherit"] });
      guard.on("error", () => {});
      guard.stdin?.on("error", () => {});
      guard.stdin?.write(`${JSON.stringify(config)}\n`);
      guard.unref();
      (guard.stdin as unknown as { unref?: () => void } | null)?.unref?.();
      this.#guard = guard;
    } catch {
      console.warn("sigillo: the guard process did not start");
    }
  }

  #tellGuard(word: "closed" | "exit"): void {
    try {
      this.#guard?.stdin?.end(`${word}\n`);
    } catch {
      // the guard is already gone
    }
  }

  /** A normal close: the `stop` is sent here, then the guard is told it need not say `ended`. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    process.removeListener("exit", this.#onExit);
    await this.#send("stop");
    this.#tellGuard("closed");
  }

  #send(event: "start" | "beat" | "stop"): Promise<void> {
    this.#queue = this.#queue.then(() => this.#deliver(event));
    return this.#queue;
  }

  async #deliver(event: "start" | "beat" | "stop"): Promise<void> {
    const payload: Record<string, unknown> = { session: this.session, event };
    if (event !== "stop") {
      const boot = bootTime();
      if (boot !== null) payload["boot"] = boot;
      if (this.#script !== null) payload["script_hash"] = fileHash(this.#script);
      payload["sdk_hash"] = packageHash(here);
      if (this.#guard !== undefined && this.#guard.exitCode !== null) this.#halt("the sigillo guard process is no longer running");
    }
    const body = JSON.stringify(payload);
    if (this.#options.showSent) process.stderr.write(`[sigillo sends] heartbeat ${body}\n`);
    try {
      const response = await this.#fetch(this.#options.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#options.apiKey}` },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      this.#missed = 0;
      const answer = (await response.json().catch(() => ({}))) as { script_changed?: unknown };
      if (answer.script_changed === true) this.#halt("this agent's script is not the one it started with");
    } catch (error) {
      console.warn(`sigillo: heartbeat ${event} not delivered: ${error instanceof Error ? error.name : "error"}`);
      if (event !== "stop") {
        this.#missed += 1;
        if (this.#missed >= STRICT_MISSED_BEATS) this.#halt(`sigillo could not record for ${this.#missed} heartbeats in a row`);
      }
    }
  }

  /** Strict mode only, and once: the agent is told to stop. */
  #halt(reason: string): void {
    if (!this.#options.strict || this.#halted) return;
    this.#halted = true;
    console.error(`sigillo strict mode: ${reason}`);
    this.#options.onHalt(reason);
  }
}

/** Python's default: print the reason to standard error and leave with status 70. */
export function haltProcess(reason: string): void {
  process.stderr.write(`sigillo: ${reason}: stopping the agent\n`);
  process.exit(70);
}
