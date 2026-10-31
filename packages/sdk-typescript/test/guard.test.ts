import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gaps } from "../src/guard.js";

/**
 * The guard process, for real: a child agent is started with the SDK, a small
 * HTTP server plays sigillo, and what the server hears is what the SDK's
 * promises come to. The child is killed, closed normally, or has its script
 * edited under it.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface Heard {
  event: string;
  session?: string;
  script_hash?: string | null;
}

let directory: string;
let server: Server;
let heard: Heard[];
let endpoint: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-guard-"));
  heard = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/api/v1/heartbeat") heard.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Heard);
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

const events = (): string[] => heard.map((beat) => beat.event);

async function until(condition: () => boolean, what: string, seconds = 20): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; heard ${JSON.stringify(events())}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function agent(body: string, options: string): { done: Promise<number | null>; path: string } {
  const path = join(directory, "agent.mts");
  writeFileSync(
    path,
    `import { init } from ${JSON.stringify(INDEX)};\nconst tracing = init({ endpoint: ${JSON.stringify(endpoint)}, apiKey: "k", systemId: "s", guardSeconds: 0.2, heartbeatSeconds: 0.3, ${options} });\n${body}\n`,
  );
  const child = spawn(TSX, [path], { stdio: ["ignore", "ignore", "ignore"] });
  return { path, done: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
}

describe("the guard process", () => {
  it("says `ended` when the agent is killed without closing", async () => {
    const { done } = agent(`setTimeout(() => process.kill(process.pid, "SIGKILL"), 1500); setInterval(() => {}, 1000);`, "");
    await until(() => events().includes("start"), "start");
    await done;
    await until(() => events().includes("ended"), "ended");
    expect(events()).not.toContain("stop");
  }, 40_000);

  it("says `stop` once, and not `ended`, when the agent closes normally", async () => {
    const { done } = agent(`await tracing.shutdown();`, "");
    await done;
    await until(() => events().includes("stop"), "stop");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(events().filter((event) => event === "stop")).toHaveLength(1);
    expect(events()).not.toContain("ended");
  }, 40_000);

  it("says `stop`, by the guard, when the agent leaves with process.exit()", async () => {
    const { done } = agent(`setTimeout(() => process.exit(0), 800); setInterval(() => {}, 1000);`, "");
    await done;
    await until(() => events().includes("stop"), "stop");
    expect(events()).not.toContain("ended");
  }, 40_000);

  it("in strict mode, ends an agent whose script was edited and tells the server", async () => {
    const { done, path } = agent(`setInterval(() => {}, 1000);`, "strict: true");
    await until(() => events().includes("start"), "start");
    const started = heard.find((beat) => beat.event === "start")?.script_hash;
    expect(started).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(path, `// edited\n${"x".repeat(10)}\nsetInterval(() => {}, 1000);\n`);
    const code = await done;
    expect(code).not.toBe(0);
    await until(() => heard.some((beat) => beat.event === "beat" && beat.script_hash !== undefined && beat.script_hash !== started), "a beat with the new hash");
  }, 40_000);
});

describe("gaps seen by the guard", () => {
  it("reports a sleep when the clock jumps, and an offline stretch once the server is back", () => {
    const gaps = new Gaps(1000, 5);
    gaps.tick(1005);
    expect(gaps.pending).toEqual([]);
    gaps.tick(5000);
    expect(gaps.pending).toHaveLength(1);
    expect(gaps.pending[0]?.kind).toBe("sleep");

    const network = new Gaps(0, 5);
    network.reached(60, false);
    network.reached(100, true);
    expect(network.pending).toEqual([]);
    network.reached(200, false);
    network.reached(400, true);
    expect(network.pending[0]?.kind).toBe("offline");
  });
});
