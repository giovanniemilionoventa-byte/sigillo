import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiptHashHex, verifyReceiptSignature } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { CONNECTION, ConnectionWatch, connectionStatus } from "../src/connection/watch.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The Python SDK's heartbeat, end to end through the HTTP endpoint: a receipt
 * on the chain at every change of state, none for an ordinary beat, and a
 * `lost` receipt once an agent has been silent past the allowance.
 */

const SYSTEM = "acme-support-bot";
const START = Date.parse("2026-10-05T14:00:00.000Z");
const SESSION = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const MINUTE = 60_000;

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let watch: ConnectionWatch;
let token: string;
let clock: number;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-connection-"));
  const databasePath = join(directory, "sigillo.db");
  clock = START;
  const now = (): Date => new Date(clock);
  signer = createTestSigner({ now });
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, new Date(START - MINUTE).toISOString());
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, new Date(START - MINUTE).toISOString()).token;
  watch = new ConnectionWatch({ store, now });
  app = buildServer({ store, keys, now, connections: watch });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const beat = (event: "start" | "beat" | "stop", session = SESSION, key = token, script_hash?: string | null) =>
  app.inject({
    method: "POST",
    url: "/api/v1/heartbeat",
    headers: { authorization: `Bearer ${key}` },
    payload: script_hash === undefined ? { session, event } : { session, event, script_hash },
  });

const names = (): string[] => store.readChain(SYSTEM).map((receipt) => receipt.action.name);

describe("the heartbeat endpoint", () => {
  it("writes a signed receipt when an agent connects and when it closes, and none for an ordinary beat", async () => {
    expect((await beat("start")).json()).toEqual({ recorded: { seq: 1, name: CONNECTION.start } });
    clock += MINUTE;
    expect((await beat("beat")).json()).toEqual({ recorded: null });
    clock += MINUTE;
    expect((await beat("stop")).json()).toEqual({ recorded: { seq: 2, name: CONNECTION.stop } });
    // A second stop (a retry) writes nothing more.
    expect((await beat("stop")).json()).toEqual({ recorded: null });

    const chain = store.readChain(SYSTEM);
    expect(chain.map((receipt) => receipt.action.name)).toEqual([SYSTEM, CONNECTION.start, CONNECTION.stop]);
    for (const [index, receipt] of chain.entries()) {
      expect(verifyReceiptSignature(receipt, signer.publicKey)).toBe(true);
      if (index > 0) expect(receipt.prev_hash).toBe(receiptHashHex(chain[index - 1]!));
    }
    const stop = chain[2]!;
    expect(stop.actor.agent).toBe("sigillo");
    expect(stop.action.kind).toBe("agent_step");
    expect(stop.source.type).toBe("sdk");
    expect(connectionStatus(store, SYSTEM)).toEqual({ state: "closed", since: stop.ts_received });
  });

  it("starts a session it hears of for the first time through a beat: the start was lost on the way", async () => {
    expect((await beat("beat")).json()).toEqual({ recorded: { seq: 1, name: CONNECTION.start } });
  });

  it("refuses a request without a valid key, or with a malformed session", async () => {
    expect((await beat("start", SESSION, "sigillo_0000000000000000_" + "0".repeat(64))).statusCode).toBe(401);
    expect((await beat("start", "not-a-session")).statusCode).toBe(400);
    expect(names()).toEqual([SYSTEM]);
  });
});

describe("silence", () => {
  it("writes `lost` once an open session misses its beats, dated at its last beat, and `restored` when it beats again", async () => {
    await beat("start");
    const lastBeat = new Date(clock).toISOString();

    // Within the allowance: nothing.
    clock += watch.lostAfterMs;
    expect(await watch.sweep()).toBe(0);
    expect(connectionStatus(store, SYSTEM)?.state).toBe("open");

    clock += 1;
    expect(await watch.sweep()).toBe(1);
    // Once is enough: a lost session is not lost again.
    clock += 10 * MINUTE;
    expect(await watch.sweep()).toBe(0);

    const lost = store.readChain(SYSTEM).at(-1)!;
    expect(lost.action.name).toBe(CONNECTION.lost);
    expect(lost.ts_event).toBe(lastBeat);
    expect(lost.outcome).toBe("error");
    expect(connectionStatus(store, SYSTEM)).toEqual({ state: "lost", since: lastBeat });

    expect((await beat("beat")).json()).toMatchObject({ recorded: { name: CONNECTION.restored } });
    expect(connectionStatus(store, SYSTEM)?.state).toBe("open");
    expect(names()).toEqual([SYSTEM, CONNECTION.start, CONNECTION.lost, CONNECTION.restored]);
  });

  it("does not blame an agent for the server's own silence: nobody is lost before the allowance has passed since the server started", async () => {
    await beat("start");
    clock += watch.lostAfterMs + MINUTE;
    // A server process started just now, with the same database.
    const restarted = new ConnectionWatch({ store, now: () => new Date(clock) });
    expect(await restarted.sweep()).toBe(0);
    clock += watch.lostAfterMs + 1;
    expect(await restarted.sweep()).toBe(1);
  });

  it("keeps a loss outstanding while another copy of the agent beats, until a session starts after it", async () => {
    await beat("start", SESSION);
    await beat("start", OTHER);
    const lastBeat = new Date(clock).toISOString();
    clock += watch.lostAfterMs - MINUTE;
    await beat("beat", OTHER);
    clock += 2 * MINUTE;
    expect(await watch.sweep()).toBe(1);
    expect(connectionStatus(store, SYSTEM)).toEqual({ state: "lost", since: lastBeat });

    // The program started again: a new session, after the loss.
    clock += MINUTE;
    await beat("start", "00000000000000000000000000000001");
    expect(connectionStatus(store, SYSTEM)?.state).toBe("open");
  });
});

describe("the names are the server's own", () => {
  it("refuses a connection name from the receipts API", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: { authorization: `Bearer ${token}` },
      payload: { actor: { agent: "planner" }, action: { kind: "agent_step", name: CONNECTION.restored }, outcome: "ok" },
    });
    expect(response.statusCode).toBe(400);
    expect(names()).toEqual([SYSTEM]);
  });

  it("drops a span by a connection name, as one that is no action", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e0001",
                    spanId: "00f067aa0ba90001",
                    name: CONNECTION.restored,
                    startTimeUnixNano: "1789971053648178106",
                    endTimeUnixNano: "1789971053648204813",
                    attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sigillo).toMatchObject({ accepted: 0, ignored: 1 });
    expect(names()).toEqual([SYSTEM]);
  });
});

describe("the traffic light", () => {
  it("is yellow while a loss is outstanding, and an idle agent that still beats is not called stale", async () => {
    const staleAfter = 30 * MINUTE;
    const monitor = new ChainHealthMonitor(store, signer.publicKey, staleAfter);
    await beat("start");
    await store.createCheckpoint(SYSTEM);

    // An hour without actions, beating all along: green.
    for (let minute = 0; minute < 60; minute += 1) {
      clock += MINUTE;
      await beat("beat");
    }
    monitor.check();
    expect(monitor.statusFor(SYSTEM, new Date(clock)).status).toBe("green");

    clock += watch.lostAfterMs + 1;
    await watch.sweep();
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(clock));
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("disconnected");
  });
});

describe("a client that invents sessions", () => {
  // Found in the security review of 2026-10-07: every session id never seen
  // before wrote a receipt, and the endpoint was never refused for the
  // monthly limit, so a fresh id per request wrote receipts without end.
  const session = (n: number): string => n.toString(16).padStart(32, "0");

  it("may open only so many sessions an hour per system; those already open go on beating", async () => {
    await app.close();
    watch = new ConnectionWatch({ store, now: () => new Date(clock), maxNewSessionsPerHour: 3 });
    app = buildServer({ store, keys, now: () => new Date(clock), connections: watch });
    await app.ready();

    for (let n = 1; n <= 3; n += 1) expect((await beat("start", session(n))).statusCode).toBe(200);
    const refused = await beat("start", session(4));
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Nor through a beat or a stop of a session never seen.
    expect((await beat("beat", session(5))).statusCode).toBe(429);
    expect((await beat("stop", session(6))).statusCode).toBe(429);
    expect(names().filter((name) => name === CONNECTION.start)).toHaveLength(3);
    expect(store.connectionsOf(SYSTEM)).toHaveLength(3);

    // The open ones are untouched.
    clock += MINUTE;
    expect((await beat("beat", session(1))).json()).toEqual({ recorded: null });
    expect((await beat("stop", session(2))).json()).toEqual({ recorded: { seq: 4, name: CONNECTION.stop } });

    // An hour on, the allowance is back.
    clock += 60 * MINUTE;
    expect((await beat("start", session(7))).statusCode).toBe(200);
  });

  it("opens no new session for an organization past its monthly limit, and keeps the open ones", async () => {
    await app.close();
    const ADMIN = { actor: "cli test", ts: new Date(START - MINUTE).toISOString() };
    await store.createOrganization("acme", "Acme", ADMIN, { approved: true });
    await store.createSystem("acme.bot", new Date(START - MINUTE).toISOString(), "acme");
    const acme = keys.issue("acme.bot", new Date(START - MINUTE).toISOString()).token;
    app = buildServer({ store, keys, now: () => new Date(clock), connections: watch, organizationMonthlyReceipts: 2 });
    await app.ready();

    expect((await beat("start", session(1), acme)).statusCode).toBe(200);
    expect((await beat("start", session(2), acme)).statusCode).toBe(200);
    expect((await beat("start", session(3), acme)).statusCode).toBe(429);
    clock += MINUTE;
    expect((await beat("stop", session(1), acme)).statusCode).toBe(200);
    expect(store.readChain("acme.bot").map((receipt) => receipt.action.name)).toEqual([
      "acme.bot",
      CONNECTION.start,
      CONNECTION.start,
      CONNECTION.stop,
    ]);
  });
});

const SCRIPT_A = "a".repeat(64);
const SCRIPT_B = "b".repeat(64);

describe("the script guard", () => {
  it("writes `script_changed` once when a running agent's script is not the one it started with, and says so in each answer", async () => {
    expect((await beat("start", SESSION, token, SCRIPT_A)).json()).toEqual({
      recorded: { seq: 1, name: CONNECTION.start },
      script_changed: false,
    });
    clock += MINUTE;
    expect((await beat("beat", SESSION, token, SCRIPT_A)).json()).toEqual({ recorded: null, script_changed: false });
    clock += MINUTE;
    expect((await beat("beat", SESSION, token, SCRIPT_B)).json()).toEqual({
      recorded: { seq: 2, name: CONNECTION.scriptChanged },
      script_changed: true,
    });
    // Once is enough: the same change is not written again, but it keeps being said.
    clock += MINUTE;
    expect((await beat("beat", SESSION, token, SCRIPT_B)).json()).toEqual({ recorded: null, script_changed: true });
    expect(names()).toEqual([SYSTEM, CONNECTION.start, CONNECTION.scriptChanged]);
    const receipt = store.readChain(SYSTEM).at(-1)!;
    expect(receipt.outcome).toBe("error");
    expect(verifyReceiptSignature(receipt, signer.publicKey)).toBe(true);
  });

  it("watches the sigillo package's hash with the script: a change of either is one `script_changed`", async () => {
    const send = (event: "start" | "beat", script_hash: string | null, sdk_hash: string | null) =>
      app.inject({
        method: "POST",
        url: "/api/v1/heartbeat",
        headers: { authorization: `Bearer ${token}` },
        payload: { session: SESSION, event, script_hash, sdk_hash },
      });
    expect((await send("start", SCRIPT_A, SCRIPT_A)).json()).toMatchObject({ script_changed: false });
    clock += MINUTE;
    expect((await send("beat", SCRIPT_A, SCRIPT_A)).json()).toEqual({ recorded: null, script_changed: false });
    clock += MINUTE;
    expect((await send("beat", SCRIPT_A, SCRIPT_B)).json()).toEqual({
      recorded: { seq: 2, name: CONNECTION.scriptChanged },
      script_changed: true,
    });
    expect(names()).toEqual([SYSTEM, CONNECTION.start, CONNECTION.scriptChanged]);
  });

  it("treats a package that can no longer be read (null) as a change, and refuses a malformed package hash", async () => {
    const send = (sdk_hash: string | null) =>
      app.inject({
        method: "POST",
        url: "/api/v1/heartbeat",
        headers: { authorization: `Bearer ${token}` },
        payload: { session: SESSION, event: "beat", script_hash: SCRIPT_A, sdk_hash },
      });
    await send(SCRIPT_A);
    expect((await send(null)).json()).toMatchObject({ script_changed: true });
    expect((await send("nope")).statusCode).toBe(400);
  });

  it("treats a script that can no longer be read (null) as a change", async () => {
    await beat("start", SESSION, token, SCRIPT_A);
    expect((await beat("beat", SESSION, token, null)).json()).toMatchObject({ script_changed: true });
    expect(names().at(-1)).toBe(CONNECTION.scriptChanged);
  });

  it("writes `script_changed` after the start of a new session whose script differs from the last session's", async () => {
    await beat("start", SESSION, token, SCRIPT_A);
    await beat("stop", SESSION, token, SCRIPT_A);
    clock += MINUTE;
    expect((await beat("start", OTHER, token, SCRIPT_B)).json()).toMatchObject({ script_changed: false });
    expect(names()).toEqual([SYSTEM, CONNECTION.start, CONNECTION.stop, CONNECTION.start, CONNECTION.scriptChanged]);
    // The same script again changes nothing.
    await beat("stop", OTHER, token, SCRIPT_B);
    await beat("start", "1".repeat(32), token, SCRIPT_B);
    expect(names().filter((name) => name === CONNECTION.scriptChanged)).toHaveLength(1);
  });

  it("writes nothing and says nothing when the agent sends no script hash (an older SDK, or a notebook)", async () => {
    await beat("start", SESSION, token, SCRIPT_A);
    expect((await beat("beat")).json()).toEqual({ recorded: null });
    expect(names()).toEqual([SYSTEM, CONNECTION.start]);
  });

  it("refuses a script hash that is not 64 lowercase hex characters", async () => {
    expect((await beat("start", SESSION, token, "nope")).statusCode).toBe(400);
  });

  it("is for the operator's own systems only until it is opened: an organization's heartbeat is as before", async () => {
    await store.createOrganization("acme", "Acme", { actor: "cli test", ts: new Date(START).toISOString() }, { approved: true });
    await store.createSystem("acme-bot", new Date(START).toISOString(), "acme");
    const orgToken = keys.issue("acme-bot", new Date(START).toISOString()).token;
    await beat("start", SESSION, orgToken, SCRIPT_A);
    expect((await beat("beat", SESSION, orgToken, SCRIPT_B)).json()).toEqual({ recorded: null });
    expect(store.readChain("acme-bot").map((r) => r.action.name)).toEqual(["acme-bot", CONNECTION.start]);
  });

  it("is off everywhere when the switch says off", async () => {
    await app.close();
    app = buildServer({ store, keys, now: () => new Date(clock), connections: watch, scriptGuard: "off" });
    await app.ready();
    expect((await beat("start", SESSION, token, SCRIPT_A)).json()).toEqual({ recorded: { seq: 1, name: CONNECTION.start } });
    expect((await beat("beat", SESSION, token, SCRIPT_B)).json()).toEqual({ recorded: null });
  });
});
