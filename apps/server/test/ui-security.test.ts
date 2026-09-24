import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer, type ServerOptions } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The web view's defences around the password: the limit on attempts, and the
 * session cookie (review points 10 and 12). Real SQLite, real Ed25519, the
 * real Fastify server; only the clock is ours, so that a lockout can run its
 * course without the test waiting for it.
 */

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";
const MINUTE = 60_000;
const LIMITS = { maxFailures: 3, windowMs: 10 * MINUTE, lockoutMs: 5 * MINUTE, maxLockoutMs: 20 * MINUTE };

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let clock: number;
let app: FastifyInstance;

async function start(overrides: Partial<ServerOptions> = {}, ui: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const server = buildServer({
    store,
    keys,
    now: () => new Date(clock),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * MINUTE),
      checkpointer: new Checkpointer({ store, now: () => new Date(clock) }),
      loginLimits: LIMITS,
      ...ui,
    },
    ...overrides,
  });
  await server.ready();
  return server;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-ui-security-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  keys = ApiKeyStore.open(databasePath);
  clock = Date.parse("2026-03-29T16:00:00.000Z");
  app = await start();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function login(
  password: string,
  headers: Record<string, string> = {},
  server = app,
): Promise<LightMyRequestResponse> {
  return server.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: `password=${encodeURIComponent(password)}`,
  });
}

function sessionOf(response: LightMyRequestResponse): string {
  return String(response.headers["set-cookie"]).split(";")[0] ?? "";
}

describe("the limit on password attempts", () => {
  it("refuses the attempt after N failures, even with the right password", async () => {
    for (let i = 0; i < LIMITS.maxFailures; i += 1) {
      expect((await login("wrong password")).statusCode).toBe(401);
    }
    const blocked = await login(PASSWORD);
    expect(blocked.statusCode).toBe(401);
    expect(blocked.headers["set-cookie"]).toBeUndefined();
  });

  it("gives a locked-out attempt exactly the answer a wrong password gets", async () => {
    const wrong = await login("wrong password");
    for (let i = 1; i < LIMITS.maxFailures; i += 1) await login("wrong password");
    const lockedWithWrong = await login("wrong password");
    const lockedWithRight = await login(PASSWORD);

    for (const response of [lockedWithWrong, lockedWithRight]) {
      expect(response.statusCode).toBe(wrong.statusCode);
      expect(response.body).toBe(wrong.body);
      expect(response.headers["retry-after"]).toBeUndefined();
      expect(response.headers["content-type"]).toBe(wrong.headers["content-type"]);
    }
  });

  it("unlocks when the lockout has passed, and the right password then works at once", async () => {
    for (let i = 0; i < LIMITS.maxFailures; i += 1) await login("wrong password");
    clock += LIMITS.lockoutMs - 1;
    expect((await login(PASSWORD)).statusCode).toBe(401);

    clock += 1;
    const response = await login(PASSWORD);
    expect(response.statusCode).toBe(302);
    const cookie = sessionOf(response);
    expect((await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).statusCode).toBe(200);
  });

  it("locks out the client that failed, not everyone", async () => {
    const trusting = await start({ trustProxy: "127.0.0.1" });
    try {
      const attacker = { "x-forwarded-for": "203.0.113.7" };
      const operator = { "x-forwarded-for": "198.51.100.20" };
      for (let i = 0; i < LIMITS.maxFailures; i += 1) await login("wrong password", attacker, trusting);
      expect((await login(PASSWORD, attacker, trusting)).statusCode).toBe(401);
      expect((await login(PASSWORD, operator, trusting)).statusCode).toBe(302);
    } finally {
      await trusting.close();
    }
  });

  it("ignores X-Forwarded-For unless told to trust a proxy", async () => {
    // Otherwise a client would pick a new address for every guess.
    for (let i = 0; i < LIMITS.maxFailures; i += 1) {
      await login("wrong password", { "x-forwarded-for": `203.0.113.${i}` });
    }
    expect((await login(PASSWORD, { "x-forwarded-for": "198.51.100.20" })).statusCode).toBe(401);
  });
});

describe("the session cookie", () => {
  it("is Secure when the browser reached the server over HTTPS", async () => {
    const trusting = await start({ trustProxy: "127.0.0.1" });
    try {
      const overHttps = await login(PASSWORD, { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.20" }, trusting);
      expect(String(overHttps.headers["set-cookie"])).toMatch(/;\s*Secure/);
      const overHttp = await login(PASSWORD, { "x-forwarded-for": "198.51.100.21" }, trusting);
      expect(String(overHttp.headers["set-cookie"])).not.toMatch(/;\s*Secure/);
    } finally {
      await trusting.close();
    }
  });

  it("is always Secure when the configuration says so", async () => {
    const strict = await start({}, { cookieSecure: true });
    try {
      expect(String((await login(PASSWORD, {}, strict)).headers["set-cookie"])).toMatch(/;\s*Secure/);
    } finally {
      await strict.close();
    }
  });

  it("stops working on the server once its holder signs out, even if it was copied", async () => {
    const cookie = sessionOf(await login(PASSWORD));
    const out = await app.inject({ method: "POST", url: "/ui/logout", headers: { cookie } });
    expect(out.statusCode).toBe(303);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");

    const replayed = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    expect(replayed.statusCode).toBe(302);
    expect(replayed.headers["location"]).toBe("/ui/login");
  });

  it("is not ended by a GET, which any page could trigger", async () => {
    const cookie = sessionOf(await login(PASSWORD));
    await app.inject({ method: "GET", url: "/ui/logout", headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).statusCode).toBe(200);
  });
});

describe("the pages behind the password", () => {
  it("are never stored by a browser or a proxy", async () => {
    const cookie = sessionOf(await login(PASSWORD));
    for (const url of ["/ui", "/ui/sistemi", `/ui/systems/${SYSTEM}`, "/ui/verify-document", "/ui/login"]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.headers["cache-control"], url).toBe("no-store");
    }
    // Including the page that shows a new API key, the one time it is shown.
    const created = await app.inject({
      method: "POST",
      url: "/ui/sistemi",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: "system_id=another-system",
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).toMatch(/sigillo_[0-9a-f]{16}_[0-9a-f]{64}/);
    expect(created.headers["cache-control"]).toBe("no-store");
  });

  it("refuse a form posted from another site", async () => {
    const cookie = sessionOf(await login(PASSWORD));
    const foreign = await app.inject({
      method: "POST",
      url: "/ui/sistemi",
      headers: {
        cookie,
        host: "sigillo.example.com",
        origin: "https://evil.example.net",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "system_id=planted",
    });
    expect(foreign.statusCode).toBe(403);
    expect(store.hasSystem("planted")).toBe(false);

    const own = await app.inject({
      method: "POST",
      url: "/ui/sistemi",
      headers: {
        cookie,
        host: "sigillo.example.com",
        origin: "https://sigillo.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "system_id=welcome",
    });
    expect(own.statusCode).toBe(200);
    expect(store.hasSystem("welcome")).toBe(true);
  });

  it("refuse a login posted from another site", async () => {
    const response = await login(PASSWORD, { host: "sigillo.example.com", origin: "https://evil.example.net" });
    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
