import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";
const NOW = "2026-03-29T16:00:00.000Z";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;

async function start(withUi = true): Promise<FastifyInstance> {
  const server = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ...(withUi
      ? {
          ui: {
            password: PASSWORD,
            signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
          },
        }
      : {}),
  });
  await server.ready();
  return server;
}

function event(index: number, overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: `2026-03-29T14:3${index % 10}:01.005Z`,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-ui-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  for (let index = 1; index < 6; index += 1) {
    await store.append(event(index));
  }
  keys = ApiKeyStore.open(databasePath);
  app = await start();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function signIn(server = app): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `password=${encodeURIComponent(PASSWORD)}`,
  });
  expect(response.statusCode).toBe(302);
  const cookie = response.headers["set-cookie"];
  expect(cookie).toBeDefined();
  return String(cookie).split(";")[0] ?? "";
}

describe("when no password is configured", () => {
  it("does not mount the view at all", async () => {
    const bare = await start(false);
    try {
      for (const url of ["/ui", "/ui/login", "/"]) {
        expect((await bare.inject({ method: "GET", url })).statusCode).toBe(404);
      }
      // Ingest is unaffected.
      expect((await bare.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe("signing in", () => {
  it("sends an anonymous visitor to the login page", async () => {
    for (const url of ["/ui", "/ui/systems/acme-support-bot", "/ui/systems/acme-support-bot/checkpoints"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(302);
      expect(response.headers["location"]).toBe("/ui/login");
    }
    expect((await app.inject({ method: "GET", url: "/" })).headers["location"]).toBe("/ui");
  });

  it("refuses the wrong password and hands out no session", async () => {
    for (const password of ["", "wrong", `${PASSWORD} `, PASSWORD.toUpperCase()]) {
      const response = await app.inject({
        method: "POST",
        url: "/ui/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `password=${encodeURIComponent(password)}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("sets a session cookie that is HttpOnly and same-site", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(PASSWORD);
  });

  it("refuses a session cookie that was not signed by this server", async () => {
    const forged = `sigillo_session=${Date.now() + 100000}.${"a".repeat(64)}`;
    const response = await app.inject({ method: "GET", url: "/ui", headers: { cookie: forged } });
    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toBe("/ui/login");
  });

  it("refuses a session that has run out", async () => {
    const cookie = await signIn();
    const later = buildServer({
      store,
      keys,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      },
    });
    await later.ready();
    try {
      const response = await later.inject({ method: "GET", url: "/ui", headers: { cookie } });
      expect(response.statusCode).toBe(302);
    } finally {
      await later.close();
    }
  });

  it("signs out", async () => {
    const cookie = await signIn();
    const response = await app.inject({ method: "GET", url: "/ui/logout", headers: { cookie } });
    expect(response.statusCode).toBe(302);
    expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

describe("the systems page", () => {
  it("lists each system with the state of its chain", async () => {
    const cookie = await signIn();
    const response = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    const body = response.body;
    expect(body).toContain(SYSTEM);
    expect(body).toContain("6"); // genesis plus five
    expect(body).toContain("no checkpoint");
    expect(body).toContain(signer.keyId);
  });

  it("shows a checkpoint once there is one, and whether it is anchored", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM, "2026-03-29T15:00:00.000Z");
    const cookie = await signIn();

    let body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).toContain("6 of 6");
    expect(body).toContain("not anchored");

    if (checkpoint !== null) {
      store.recordTimestamp(
        checkpoint.id,
        "https://freetsa.org/tsr",
        Buffer.from([0x30, 0x03]).toString("base64"),
        "2026-03-29T15:00:05.000Z",
      );
    }
    body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).not.toContain("not anchored");
    expect(body).toContain("2026-03-29T15:00:00.000Z");
  });
});

describe("the receipts page", () => {
  it("shows the receipts of one system", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("call-1");
    expect(response.body).toContain("call-5");
    expect(response.body).toContain("6 receipts");
  });

  it("filters by action name and by kind", async () => {
    const cookie = await signIn();

    const byName = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}?name=call-3`,
      headers: { cookie },
    });
    expect(byName.body).toContain("call-3");
    expect(byName.body).not.toContain("call-4");
    expect(byName.body).toContain("1 receipt<");

    const byKind = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}?kind=genesis`,
      headers: { cookie },
    });
    expect(byKind.body).toContain("1 receipt<");
  });

  it("filters by the time the server received the receipt", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}?from=2026-03-29T14:33:00.000Z`,
      headers: { cookie },
    });
    expect(response.body).toContain("call-3");
    expect(response.body).not.toContain("call-1<");
  });

  it("answers for a system that does not exist", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: "/ui/systems/never-created",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("escapes what came from outside, so a name cannot become markup", async () => {
    await store.append(
      event(9, { action: { kind: "tool_call", name: '<script>alert("x")</script>' } }),
    );
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}`,
      headers: { cookie },
    });

    expect(response.body).not.toContain("<script>alert");
    expect(response.body).toContain("&lt;script&gt;");
  });

  it("does not leak a filter back into the page as markup", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}?name=${encodeURIComponent('"><script>alert(1)</script>')}`,
      headers: { cookie },
    });
    expect(response.body).not.toContain("<script>alert(1)");
    expect(response.body).toContain("&lt;script&gt;");
  });
});

describe("the checkpoints page", () => {
  it("says plainly when there is nothing to show", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}/checkpoints`,
      headers: { cookie },
    });
    expect(response.body).toContain("No checkpoint yet");
  });

  it("shows each checkpoint and whether a timestamp covers it", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM, "2026-03-29T15:00:00.000Z");
    const cookie = await signIn();

    let body = (
      await app.inject({
        method: "GET",
        url: `/ui/systems/${SYSTEM}/checkpoints`,
        headers: { cookie },
      })
    ).body;
    expect(body).toContain("waiting for a timestamp");
    expect(body).toContain(checkpoint?.checkpoint.root_hash ?? "");

    if (checkpoint !== null) {
      store.recordTimestamp(
        checkpoint.id,
        "https://freetsa.org/tsr",
        Buffer.from([0x30, 0x03]).toString("base64"),
        "2026-03-29T15:00:05.000Z",
      );
    }
    body = (
      await app.inject({
        method: "GET",
        url: `/ui/systems/${SYSTEM}/checkpoints`,
        headers: { cookie },
      })
    ).body;
    expect(body).not.toContain("waiting for a timestamp");
    expect(body).toContain("freetsa.org");
  });
});

describe("generating the evidence file", () => {
  it("returns a zip that holds the whole file", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${SYSTEM}/export`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(String(response.headers["content-disposition"])).toContain(
      `sigillo-${SYSTEM}-2026-03-29.zip`,
    );

    const names = readZip(new Uint8Array(response.rawPayload)).map((entry) => entry.name);
    expect(names).toContain("receipts.jsonl");
    expect(names).toContain("manifest.json");
    expect(names).toContain("report.pdf");
    expect(names).toContain("VERIFY.md");
  }, 20_000);

  it("refuses without a session", async () => {
    const response = await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/export` });
    expect(response.statusCode).toBe(302);
  });
});
