/**
 * The guard process `init` starts beside the agent (the port of
 * sdk-python/src/sigillo/_watchdog.py, without its local-model probe).
 *
 * It runs as a separate process, so code inside the agent cannot stop it by
 * stopping a timer; it can only kill it, and then the agent's beats end and
 * the server writes `lost`. Its jobs:
 *  - the agent's process ended without closing while the computer stayed on:
 *    it says `ended` to the server and exits;
 *  - a sleep (the clock jumped) or a network cut (the server unreachable) is
 *    reported as a `gap` once it is over;
 *  - in strict mode, it takes the hashes of the agent's main script and of this
 *    package again every few seconds, and on a difference tells the server and
 *    ends the agent.
 *
 * It learns the agent is gone when standard input closes. A normal close
 * writes `closed` first (the agent sent its own `stop`), or `exit` (the agent
 * is leaving without a chance to send it: the guard sends `stop`). Only node:
 * modules are imported, never the package it watches.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Config {
  url: string;
  apiKey: string;
  session: string;
  script: string | null;
  scriptHash: string | null;
  sdkHash: string | null;
  parent: number;
  beatEvery: number;
  strict: boolean;
  period: number;
}

const OFFLINE_MIN_SECONDS = 120;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function fileHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** SHA-256 over the names and bytes of the package's own files, in name order. */
export function packageHash(directory: string): string | null {
  try {
    const digest = createHash("sha256");
    const names = readdirSync(directory)
      .filter((name) => /\.(js|ts)$/.test(name) && !name.endsWith(".d.ts"))
      .sort();
    for (const name of names) {
      digest.update(Buffer.concat([Buffer.from(name), Buffer.from([0]), readFileSync(join(directory, name)), Buffer.from([0])]));
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

/** What the guard saw of the computer between two looks. Times are passed in, so it can be tested without waiting. */
export class Gaps {
  lastTick: number;
  lastOk: number;
  downSince: number | null = null;
  pending: Array<{ kind: "sleep" | "offline"; from: string }> = [];
  period: number;

  constructor(now: number, period: number) {
    this.period = period;
    this.lastTick = now;
    this.lastOk = now;
  }

  tick(now: number): void {
    if (now - this.lastTick > 3 * this.period + 15) {
      this.pending.push({ kind: "sleep", from: iso(this.lastTick) });
      this.downSince = null;
      this.lastOk = now;
    }
    this.lastTick = now;
  }

  reached(now: number, ok: boolean): void {
    if (!ok) {
      this.downSince ??= this.lastOk;
      return;
    }
    if (this.downSince !== null && now - this.downSince >= OFFLINE_MIN_SECONDS) {
      this.pending.push({ kind: "offline", from: iso(this.downSince) });
    }
    this.downSince = null;
    this.lastOk = now;
  }
}

/** Whether the server could be reached. An answer of any kind counts, even a refusal. */
async function post(config: Config, payload: Record<string, unknown>): Promise<boolean> {
  try {
    await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ session: config.session, ...payload }),
      signal: AbortSignal.timeout(10_000),
    });
    return true;
  } catch {
    return false;
  }
}

function end(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function main(): Promise<void> {
  let config: Config | null = null;
  let buffered = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (config === null) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      config = JSON.parse(buffered.slice(0, newline)) as Config;
      buffered = buffered.slice(newline + 1);
      void watch(config);
    }
  });
  process.stdin.on("end", () => {
    void (async () => {
      if (config === null) process.exit(0);
      const last = buffered.trim();
      if (last === "exit") await post(config, { event: "stop" });
      else if (last !== "closed") await post(config, { event: "ended" });
      process.exit(0);
    })();
  });
}

async function watch(config: Config): Promise<void> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const gaps = new Gaps(Date.now() / 1000, config.period);
  let nextPing = Date.now() / 1000 + config.beatEvery;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, config.period * 1000));
    const now = Date.now() / 1000;
    gaps.tick(now);
    if (now >= nextPing) {
      nextPing = now + config.beatEvery;
      gaps.reached(Date.now() / 1000, await post(config, { event: "ping" }));
    }
    const stillPending = [];
    for (const gap of gaps.pending) if (!(await post(config, { event: "gap", gap }))) stillPending.push(gap);
    gaps.pending = stillPending.slice(-50);
    if (!config.strict) continue;
    const script = config.script === null ? null : fileHash(config.script);
    const sdk = packageHash(directory);
    if (script !== config.scriptHash || sdk !== config.sdkHash) {
      await post(config, { event: "beat", sdk_hash: sdk, ...(config.script === null ? {} : { script_hash: script }) });
      process.stderr.write("sigillo: the agent's script or the sigillo package changed: ending the agent\n");
      end(config.parent);
      process.exit(0);
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) void main();
