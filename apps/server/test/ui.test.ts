import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_TEXT_SOURCE, documentFingerprints, readZip, receiptHashHex, TEXT_CANON_1 } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { FONT_FILES, STATE_ICONS, STYLE } from "../src/http/style.js";
import { VERIFY_DOCUMENT_SCRIPT } from "../src/http/ui.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";
const NOW = "2026-03-29T16:00:00.000Z";
const ONE_DAY_MS = 24 * 60 * 60_000;

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let healthMonitor: ChainHealthMonitor;
let checkpointer: Checkpointer;
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
            healthMonitor,
            checkpointer,
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
  healthMonitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
  healthMonitor.check();
  checkpointer = new Checkpointer({ store, now: () => new Date(NOW) });
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
        healthMonitor,
        checkpointer,
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
    const response = await app.inject({ method: "POST", url: "/ui/logout", headers: { cookie } });
    expect(response.statusCode).toBe(303);
    expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

describe("the main page: È tutto a posto?", () => {
  it("lists each system with a semaphore and a word, not colour alone", async () => {
    healthMonitor.check();
    const cookie = await signIn();
    const response = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    const body = response.body;
    expect(body).toContain(SYSTEM);
    // Not anchored yet: yellow, as a light in the sidebar and as a pill with its word on the page.
    expect(body).toContain(`<span class="light yellow" aria-hidden="true"></span><span class="sr">${UI.chain.yellow}: </span>`);
    expect(body).toContain(`<span class="pill yellow" data-chain="yellow">${STATE_ICONS.warn}${UI.chain.yellow}</span>`);
    // Today's five actions, the opening of the register aside.
    expect(body).toContain(`<div class="card tile"><strong>5</strong><span>${UI.home.tiles.today}</span></div>`);
    // The reason is spelled out in words on the system's page.
    expect((await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}`, headers: { cookie } })).body).toContain("non è ancora stato sigillato");
  });

  it("states the situation in one sentence, and pairs each state with an icon of its own shape", async () => {
    healthMonitor.check();
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    // The line carries the worst state's own icon, and says where to look.
    expect(body).toContain(
      `<div class="status yellow" role="status" data-status="yellow">${STATE_ICONS.warn}<span>${UI.home.summary.yellow(1)}</span><a href="/ui/systems/${SYSTEM}">${UI.home.summary.why}</a></div>`,
    );
    // The yellow icon is the triangle: its path starts at the apex.
    expect(STATE_ICONS.warn).toMatch(/^<svg[^>]*><path d="M10 2\.25/);
  });

  it("marks each receipt in the history as anchored or waiting, with its outcome and fingerprint", async () => {
    const cookie = await signIn();
    const history = async (): Promise<string> =>
      (await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}?ricevuta=1`, headers: { cookie } })).body;
    const before = await history();
    expect(before).toContain(`<span class="wait">${UI.inspector.sealWaiting}</span>`);
    expect(before).not.toContain('<span class="ok">');
    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint !== null) {
      await store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), "2026-03-29T15:00:05.000Z");
    }
    const after = await history();
    expect(after).toContain(`<span class="ok">${UI.inspector.sealedAt("")}`);
    expect(after).not.toContain('<span class="wait">');
    const receipt = store.readChain(SYSTEM)[1];
    expect(receipt).toBeDefined();
    if (receipt !== undefined) expect(after).toContain(receiptHashHex(receipt));
    expect(after).toContain(`data-outcome="ok">${STATE_ICONS.ok}Completato</span>`);
  });

  it("turns green once a checkpoint anchors the chain", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint !== null) {
      await store.recordTimestamp(
        checkpoint.id,
        "https://freetsa.org/tsr",
        Buffer.from([0x30, 0x03]).toString("base64"),
        "2026-03-29T15:00:05.000Z",
      );
    }
    healthMonitor.check();
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).toContain(`<div class="status green" role="status" data-status="green">`);
    expect(body).toContain(`<span class="pill green" data-chain="green">${STATE_ICONS.ok}${UI.chain.green}</span>`);
  });

  it("turns red when a chain no longer verifies", async () => {
    // Same technique as chain-health.test.ts: the append-only trigger stops a
    // live connection, not one that drops the trigger first, which is exactly
    // the "attacker with the file itself" scenario SECURITY.md describes.
    const raw = new Database(join(directory, "sigillo.db"));
    raw.exec("DROP TRIGGER receipts_no_update");
    const row = raw
      .prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = 1")
      .get(SYSTEM) as { canonical: string };
    const tampered = JSON.parse(row.canonical) as { outcome: string };
    tampered.outcome = tampered.outcome === "ok" ? "error" : "ok";
    raw
      .prepare("UPDATE receipts SET canonical = ? WHERE system_id = ? AND seq = 1")
      .run(JSON.stringify(tampered), SYSTEM);
    raw.close();

    // A fresh monitor, so its first check scans from the beginning: the
    // shared one from beforeEach already verified (and cached) seq 1 before
    // it was tampered with, and being incremental it would not look again.
    const freshMonitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    freshMonitor.check();
    const freshApp = buildServer({
      store,
      keys,
      now: () => new Date(NOW),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: freshMonitor,
        checkpointer,
      },
    });
    await freshApp.ready();
    try {
      const cookie = await signIn(freshApp);
      const body = (await freshApp.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
      expect(body).toContain(`<div class="status red" role="status" data-status="red">`);
      expect(body).toContain(`<span class="pill red" data-chain="red">${STATE_ICONS.bad}${UI.chain.red}</span>`);
    } finally {
      await freshApp.close();
    }
  });

  it("shows nothing to look at, plainly, when there are no systems", async () => {
    const bareStore = ReceiptStore.open(join(directory, "empty.db"), signer);
    const bareMonitor = new ChainHealthMonitor(bareStore, signer.publicKey, ONE_DAY_MS);
    const bareCheckpointer = new Checkpointer({ store: bareStore, now: () => new Date(NOW) });
    const bareApp = buildServer({
      store: bareStore,
      keys,
      now: () => new Date(NOW),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: bareMonitor,
        checkpointer: bareCheckpointer,
      },
    });
    await bareApp.ready();
    try {
      const cookie = await signIn(bareApp);
      const body = (await bareApp.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
      // A newcomer: the first steps instead of an empty register.
      expect(body).toContain(UI.home.welcome);
      expect(body).toContain(UI.home.steps.create);
      expect(body).toContain('href="/ui/sistemi/nuovo"');
    } finally {
      await bareApp.close();
      bareStore.close();
    }
  });
});

describe("checkpointing on demand", () => {
  it("offers a button", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).toContain('action="/ui/checkpoint"');
    expect(body).toContain(UI.home.checkpointNow);
  });

  it("refuses the request without a session", async () => {
    const response = await app.inject({ method: "POST", url: "/ui/checkpoint" });
    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toBe("/ui/login");
  });

  it("checkpoints every system that has new receipts, then redirects back with a confirmation", async () => {
    expect(store.latestCheckpoint(SYSTEM)).toBeNull();
    const cookie = await signIn();

    const response = await app.inject({ method: "POST", url: "/ui/checkpoint", headers: { cookie } });
    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe("/ui?checkpoint=1");
    expect(store.latestCheckpoint(SYSTEM)).not.toBeNull();

    const body = (
      await app.inject({ method: "GET", url: "/ui?checkpoint=1", headers: { cookie } })
    ).body;
    expect(body).toContain(UI.home.checkpointDone);
  });

  it("says nothing extra when the page was not just reached from that button", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).not.toContain(UI.home.checkpointDone);
  });
});

describe("the main page: Cosa ha fatto l'AI?", () => {
  it("shows recent actions as short sentences, each opening its receipt", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).toContain("Ha usato «call-5»");
    // Each action opens its receipt in the system's history, with its time and its system beside it.
    expect(body).toContain(`<a class="line" href="/ui/systems/${SYSTEM}?ricevuta=5#r-5"><span class="line-time">16:35</span>`);
    expect(body).toContain(`<span class="line-aside system">${SYSTEM}</span>`);
  });
});

describe("the main page: Mi prepari le prove?", () => {
  it("offers a system, a period and a generate button", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).toContain('<select name="system_id">');
    expect(body).toContain(`<option value="${SYSTEM}">`);
    expect(body).toContain('type="date" name="from"');
    expect(body).toContain('type="date" name="to"');
    expect(body).toContain(UI.home.generate);
  });

  it("generates an archive for the chosen system from the main page", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: "/ui/export",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `system_id=${encodeURIComponent(SYSTEM)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
  });

  it("narrows the export to the chosen period", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: "/ui/export",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `system_id=${encodeURIComponent(SYSTEM)}&from=2026-03-29&to=2026-03-29`,
    });
    expect(response.statusCode).toBe(200);
    const names = readZip(new Uint8Array(response.rawPayload)).map((entry) => entry.name);
    expect(names).toContain("receipts.jsonl");
  });
});

describe("the sistemi page", () => {
  it("lists existing systems, and keeps the signing key in the settings", async () => {
    const cookie = await signIn();
    const response = await app.inject({ method: "GET", url: "/ui/sistemi", headers: { cookie } });
    expect(response.body).toContain(SYSTEM);
    const settings = await app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie } });
    expect(settings.body).toContain(signer.keyId);
  });

  it("creates a system and shows the key exactly once, with copyable code", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: "/ui/sistemi",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: "system_id=nuovo-sistema",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("sigillo_");
    expect(response.body).toContain("sigillo.init(");
    expect(response.body).toContain("nuovo-sistema");
    expect(response.body).toContain(UI.connect.keyNote);

    // The system is real: the ordinary systems listing knows about it too.
    const list = await app.inject({ method: "GET", url: "/ui/sistemi", headers: { cookie } });
    expect(list.body).toContain("nuovo-sistema");
  });

  it("fails gracefully, without a stack trace, for a system that already exists", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: "/ui/sistemi",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `system_id=${encodeURIComponent(SYSTEM)}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("at Object");
  });
});

describe("the receipts page: Cosa ha fatto l'AI? for one system", () => {
  it("shows the receipts of one system as readable sentences", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("call-1");
    expect(response.body).toContain("call-5");
    expect(response.body).toContain("Tutte<span class=\"count\">6</span>");
    expect(response.body).toContain("Ha usato «call-1»");
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
    expect(byName.body.match(/<a class="row"/g)).toHaveLength(1);

    const byKind = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}?kind=genesis`,
      headers: { cookie },
    });
    expect(byKind.body.match(/<a class="row"/g)).toHaveLength(1);
    expect(byKind.body).toContain('<span class="row-title">Registro aperto</span>');
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

  it("keeps every fingerprint out of the list and the title: they are in the inspector's technical details", async () => {
    await store.append(event(9, { input_hash: "a".repeat(64), output_hash: "b".repeat(64) }));
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}`, headers: { cookie } })).body;
    const start = body.indexOf('<aside class="inspector"');
    const end = body.indexOf("</aside>", start);
    expect(start).toBeGreaterThan(-1);
    const hexHash = /\b[0-9a-f]{64}\b/g;
    let match: RegExpExecArray | null;
    let found = 0;
    while ((match = hexHash.exec(body)) !== null) {
      found += 1;
      expect(match.index).toBeGreaterThan(start);
      expect(match.index).toBeLessThan(end);
    }
    // Its own fingerprint, the previous one, and input and output.
    expect(found).toBe(4);
    const title = /<h2 class="insp-title" id="dettaglio-titolo">([^<]*)<\/h2>/.exec(body)?.[1] ?? "";
    expect(title).toBe("Strumento: call-9");
    // Every fingerprint only once the technical details are opened.
    const details = body.slice(body.indexOf('<details class="tech">'), end);
    expect(body.slice(start, body.indexOf('<details class="tech">'))).not.toMatch(/[0-9a-f]{64}/);
    expect(details).toContain("a".repeat(64));
    expect(details).toContain("b".repeat(64));
  });

  it("shows an artifact as a readable label in the inspector, and what it was to the action", async () => {
    await store.append(
      event(9, {
        action: { kind: "tool_call", name: "leggi_curriculum" },
        artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) }],
      }),
    );
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/systems/${SYSTEM}`,
      headers: { cookie },
    });
    expect(response.body).toContain('<span class="file-name">curriculum<span class="sub">usato in input</span></span>');
    expect(response.body).toContain('<a href="/ui/verify-document">');
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
    expect(response.body).toContain(UI.checkpoints.none);
  });

  it("shows each checkpoint and whether a timestamp covers it", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM);
    const cookie = await signIn();

    let body = (
      await app.inject({
        method: "GET",
        url: `/ui/systems/${SYSTEM}/checkpoints`,
        headers: { cookie },
      })
    ).body;
    expect(body).toContain(`${UI.checkpoints.waiting}</span>`);
    expect(body).toContain(checkpoint?.checkpoint.root_hash ?? "");

    if (checkpoint !== null) {
      await store.recordTimestamp(
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
    expect(body).not.toContain(`${UI.checkpoints.waiting}</span>`);
    expect(body).toContain(`${UI.checkpoints.stamped}</span>`);
    expect(body).toContain("freetsa.org");
  });
});

describe("keyboard accessibility", () => {
  it("gives every text input and select an associated label", async () => {
    const cookie = await signIn();
    for (const url of ["/ui", "/ui/sistemi", `/ui/systems/${SYSTEM}`, `/ui/systems/${SYSTEM}/manage`, "/ui/verify-document"]) {
      const body = (await app.inject({ method: "GET", url, headers: { cookie } })).body;
      const inputs = [...body.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)];
      for (const [tag] of inputs) {
        if (/type="hidden"/.test(tag)) continue;
        // Every one of them is written inside a <label>...<input>...</label> in this view.
        const before = body.slice(0, body.indexOf(tag));
        const opened = Math.max(before.lastIndexOf("<label>"), before.lastIndexOf("<label "));
        expect(opened, `${url}: ${tag}`).toBeGreaterThan(before.lastIndexOf("</label>"));
      }
    }
  });

  it("uses real buttons and links, never a div with a click handler", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).not.toContain("onclick=");
    expect(body).not.toMatch(/<div[^>]*role="button"/);
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

describe("the verify-document page", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const response = await app.inject({ method: "GET", url: "/ui/verify-document" });
    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toBe("/ui/login");
  });

  it("shows the form and the privacy sentence, with no result section yet", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: "/ui/verify-document",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("non lascia il tuo computer");
    expect(response.body).toContain('id="sigillo-doc-file"');
    expect(response.body).toContain('id="sigillo-doc-text"');
    expect(response.body).toContain("<script>");
    expect(response.body).toContain(UI.verifyDocument.placeholder);
    expect(response.body).not.toContain('id="sigillo-doc-result"');
  });

  it("finds a document that a receipt names, by its fingerprint alone", async () => {
    const sha256 = "a".repeat(64);
    await store.append(
      event(9, {
        action: { kind: "tool_call", name: "leggi_curriculum" },
        artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256 }],
      }),
    );
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/verify-document?sha256=${sha256}`,
      headers: { cookie },
    });

    expect(response.body).toContain('id="sigillo-doc-result"');
    expect(response.body).toContain(SYSTEM);
    expect(response.body).toContain("curriculum");
    expect(response.body).toContain("leggi_curriculum");
    expect(response.body).toContain("Non è stato modificato");
  });

  it("says plainly when nothing matches, without pretending to have searched on garbage input", async () => {
    const cookie = await signIn();
    const found = await app.inject({
      method: "GET",
      url: `/ui/verify-document?sha256=${"b".repeat(64)}`,
      headers: { cookie },
    });
    expect(found.body).toContain("Nessuna azione registrata");

    const garbage = await app.inject({
      method: "GET",
      url: "/ui/verify-document?sha256=not-a-digest",
      headers: { cookie },
    });
    expect(garbage.body).not.toContain('id="sigillo-doc-result"');
  });

  it("escapes a label and an action name in the result, so neither can become markup", async () => {
    const sha256 = "c".repeat(64);
    await store.append(
      event(9, {
        action: { kind: "tool_call", name: '<script>alert("x")</script>' },
        artifacts: [
          { role: "input", label: '<b>label</b>', media_type: "text/plain", sha256 },
        ],
      }),
    );
    const cookie = await signIn();
    const response = await app.inject({
      method: "GET",
      url: `/ui/verify-document?sha256=${sha256}`,
      headers: { cookie },
    });
    expect(response.body).not.toContain("<script>alert");
    expect(response.body).not.toContain("<b>label</b>");
    expect(response.body).toContain("&lt;script&gt;");
  });

  it("says which input the fingerprint came from, for the two values the script sends and no others", async () => {
    const cookie = await signIn();
    const page = async (query: string): Promise<string> =>
      (await app.inject({ method: "GET", url: `/ui/verify-document?sha256=${"e".repeat(64)}${query}`, headers: { cookie } })).body;
    expect(await page("&from=file")).toContain(UI.verifyDocument.fromFile);
    expect(await page("&from=text")).toContain(UI.verifyDocument.fromText);
    for (const other of ["", "&from=%3Cb%3Ex%3C%2Fb%3E", "&from=FILE"]) {
      const body = await page(other);
      expect(body).not.toContain(UI.verifyDocument.fromFile);
      expect(body).not.toContain(UI.verifyDocument.fromText);
      expect(body).not.toContain("<b>x</b>");
    }
  });

  it("serves Verifica disabled under a warning, for the script to enable", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui/verify-document", headers: { cookie } })).body;
    expect(body).toContain('<button type="button" id="sigillo-doc-button" class="big" disabled>');
    expect(body).toContain(`<p class="notice warn" id="sigillo-doc-inactive">${UI.verifyDocument.scriptInactive.replace(/'/g, "&#39;")}</p>`);
  });

  it("embeds core's DOCUMENT_TEXT_SOURCE verbatim: the browser runs the reference rule, not a copy", () => {
    expect(VERIFY_DOCUMENT_SCRIPT).toContain(DOCUMENT_TEXT_SOURCE);
    expect(VERIFY_DOCUMENT_SCRIPT).toContain("sigilloFingerprintInputs(bytes)");
  });

  it("is in the sidebar's tools, marked as the current page when open", async () => {
    const cookie = await signIn();
    const entry = /<a class="side-item" href="\/ui\/verify-document"( aria-current="page")?>[^]*?Verifica documento<\/span><\/a>/;
    for (const url of ["/ui", "/ui/sistemi", `/ui/systems/${SYSTEM}`]) {
      const body = (await app.inject({ method: "GET", url, headers: { cookie } })).body;
      expect(entry.exec(body)?.[1], url).toBeUndefined();
      expect(body.indexOf(UI.nav.tools), url).toBeLessThan(body.indexOf('href="/ui/verify-document"'));
    }
    const own = (await app.inject({ method: "GET", url: "/ui/verify-document", headers: { cookie } })).body;
    expect(entry.exec(own)?.[1]).toBe(' aria-current="page"');
  });

  it("finds a v3 text by its text fingerprint and says it is the same text, not the same bytes", async () => {
    const recorded = new TextEncoder().encode("Gentile candidata,\r\nla ringraziamo.\r\n");
    const fingerprints = documentFingerprints(recorded);
    await store.append(
      event(9, {
        action: { kind: "tool_call", name: "invia_email" },
        artifacts: [{
          role: "output",
          label: "email di risposta",
          media_type: "text/plain",
          sha256: fingerprints.bytes,
          text: { canon: TEXT_CANON_1, sha256: fingerprints.text ?? "" },
        }],
      }),
    );
    const cookie = await signIn();
    const pasted = documentFingerprints(new TextEncoder().encode("Gentile candidata, la ringraziamo."));
    const body = (
      await app.inject({ method: "GET", url: `/ui/verify-document?sha256=${pasted.bytes}&text=${pasted.text ?? ""}`, headers: { cookie } })
    ).body;
    expect(body).toContain('data-match="text"');
    expect(body).toContain("ha lo stesso testo di quello usato");
    expect(body).toContain("I byte non sono identici");
    expect(body).toContain(`<span class="hash text-hash">${pasted.text ?? ""}</span>`);
    expect(body).not.toContain("Non è stato modificato");
  });

  it("says a file has no text fingerprint when it has none", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: `/ui/verify-document?sha256=${"b".repeat(64)}`, headers: { cookie } })).body;
    expect(body).toContain(UI.verifyDocument.noTextFingerprint);
  });

  it("searches only well-formed digests, and at most eight of each list", async () => {
    const legacy = "d".repeat(64);
    await store.append(
      event(9, { artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: legacy }] }),
    );
    const cookie = await signIn();
    const page = async (query: string): Promise<string> =>
      (await app.inject({ method: "GET", url: `/ui/verify-document?sha256=${"e".repeat(64)}${query}`, headers: { cookie } })).body;
    expect(await page(`&lines=zz,${legacy}`)).toContain('data-match="lines"');
    expect(await page(`&lines=${Array.from({ length: 8 }, () => "0".repeat(64)).join(",")},${legacy}`)).not.toContain("data-match");
    expect(await page(`&text=${legacy.toUpperCase()}`)).not.toContain("data-match");
  });

  it("keeps deploy/Caddyfile's CSP hash in step with the script it actually allows", () => {
    const caddyfile = readFileSync(join(REPOSITORY_ROOT, "deploy", "Caddyfile"), "utf8");
    const actualHash = createHash("sha256").update(VERIFY_DOCUMENT_SCRIPT, "utf8").digest("base64");
    expect(caddyfile).toContain(`'sha256-${actualHash}'`);
  });
});

describe("managing a system: display name (M1)", () => {
  const form = { "content-type": "application/x-www-form-urlencoded" };

  it("renames from the manage page, and shows the name everywhere, the system_id on the manage page", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${SYSTEM}/rename`,
      headers: { cookie, ...form },
      payload: `display_name=${encodeURIComponent("Assistente clienti")}`,
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(`/ui/systems/${SYSTEM}/manage?fatto=nome`);
    expect(store.systemRecord(SYSTEM)?.display_name).toBe("Assistente clienti");

    for (const url of ["/ui", "/ui/sistemi", `/ui/systems/${SYSTEM}`, `/ui/systems/${SYSTEM}/checkpoints`, `/ui/systems/${SYSTEM}/manage`]) {
      const body = (await app.inject({ method: "GET", url, headers: { cookie } })).body;
      expect(body, url).toContain("Assistente clienti");
    }
    const manage = (await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}/manage`, headers: { cookie } })).body;
    expect(manage).toContain(`<code class="keybox">${SYSTEM}</code>`);
    const home = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(home).toContain(`<option value="${SYSTEM}">Assistente clienti</option>`);
  });

  it("records the rename in the administrative log, with the address it came from", async () => {
    const cookie = await signIn();
    await app.inject({
      method: "POST",
      url: `/ui/systems/${SYSTEM}/rename`,
      headers: { cookie, ...form },
      payload: "display_name=Primo",
    });
    const [entry] = store.adminLog();
    expect(entry).toMatchObject({ action: "system.rename", system_id: SYSTEM, ts: NOW });
    expect(entry?.actor).toMatch(/^web /);
    for (const url of ["/ui/impostazioni", "/ui/impostazioni/registro"]) {
      const body = (await app.inject({ method: "GET", url, headers: { cookie } })).body;
      expect(body, url).toContain("nome cambiato: da nessun nome a «Primo»");
    }
  });

  it("refuses a name it cannot store, and says why, without changing anything", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${SYSTEM}/rename`,
      headers: { cookie, ...form },
      payload: `display_name=${encodeURIComponent("due\nrighe")}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("control characters");
    expect(store.systemRecord(SYSTEM)?.display_name).toBeNull();
  });

  it("can give a new system its name when it is created", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: "/ui/sistemi",
      headers: { cookie, ...form },
      payload: `system_id=nuovo&display_name=${encodeURIComponent("Il nuovo")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(store.systemRecord("nuovo")?.display_name).toBe("Il nuovo");
    expect(store.readChain("nuovo")[0]?.action.name).toBe("nuovo");
  });

  it("puts the name at export time into the evidence file, and not into its manifest", async () => {
    await store.renameSystem(SYSTEM, "Nome di allora", { actor: "test", ts: NOW });
    const cookie = await signIn();
    const response = await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/export`, headers: { cookie } });
    const files = new Map(
      readZip(new Uint8Array(response.rawPayload)).map((entry) => [entry.name, new TextDecoder().decode(entry.data)]),
    );
    expect(files.get("VERIFY.md")).toContain('"Nome di allora"');
    expect(files.get("manifest.json")).not.toContain("Nome di allora");
  });

  it("names the system by its label in a document match, with the system_id beside it", async () => {
    await store.renameSystem(SYSTEM, "Selezione", { actor: "test", ts: NOW });
    const sha256 = "f".repeat(64);
    await store.append(
      event(9, {
        artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256 }],
      }),
    );
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: `/ui/verify-document?sha256=${sha256}`, headers: { cookie } })).body;
    expect(body).toContain(`usato da «Selezione» (sistema ${SYSTEM})`);
  });
});

describe("managing a system: archiving (M2)", () => {
  it("takes an archived system off the main page and the default list, and back again", async () => {
    const cookie = await signIn();
    const archived = await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/archive`, headers: { cookie } });
    expect(archived.statusCode).toBe(303);
    expect(store.systemRecord(SYSTEM)?.archived_at).toBe(NOW);

    const home = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(home).not.toContain(`href="/ui/systems/${SYSTEM}"`);
    // Still offered for an evidence file.
    expect(home).toContain(`<optgroup label="${UI.home.archivedGroup}"><option value="${SYSTEM}">`);

    const active = (await app.inject({ method: "GET", url: "/ui/sistemi", headers: { cookie } })).body;
    expect(active).not.toContain(`href="/ui/systems/${SYSTEM}"`);
    expect(active).toContain('<a href="/ui/sistemi?vista=archiviati">Archiviati<span class="count">1</span></a>');
    for (const view of ["archiviati", "tutti"]) {
      const body = (await app.inject({ method: "GET", url: `/ui/sistemi?vista=${view}`, headers: { cookie } })).body;
      expect(body, view).toContain(`<a class="line" href="/ui/systems/${SYSTEM}">`);
    }

    const unarchived = await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/unarchive`, headers: { cookie } });
    expect(unarchived.statusCode).toBe(303);
    const back = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(back).toContain(`<a class="line" href="/ui/systems/${SYSTEM}">`);
    expect(store.adminLog().map((entry) => entry.action)).toEqual(["system.unarchive", "system.archive"]);
  });

  it("keeps an archived system's history, checkpoints and evidence file one click away", async () => {
    await store.archiveSystem(SYSTEM, { actor: "test", ts: NOW });
    const cookie = await signIn();
    const history = await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}`, headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain('Tutte<span class="count">6</span>');
    expect(history.body).toContain(`<span class="pill" data-chain="archived">${STATE_ICONS.archived}${UI.systemsPage.archivedBadge}</span>`);
    const exported = await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/export`, headers: { cookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/zip");
  });

  it("still shows an archived system on the main page when it keeps receiving actions", async () => {
    await store.archiveSystem(SYSTEM, { actor: "test", ts: "2026-03-29T15:00:00.000Z" });
    await store.append(event(1, { ts_received: "2026-03-29T15:30:00.000Z" }));
    const cookie = await signIn();
    const home = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(home).toContain(`<a class="line" href="/ui/systems/${SYSTEM}">`);
    expect(home).toContain("Ha ricevuto azioni dopo l&#39;archiviazione");
    expect(home).toContain('data-chain="archived"');
  });
});

describe("managing a system: archiving never hides a broken chain", () => {
  it("shows an archived system on the main page when its chain fails verification", async () => {
    await store.archiveSystem(SYSTEM, { actor: "test", ts: NOW });
    const raw = new Database(join(directory, "sigillo.db"));
    raw.exec("DROP TRIGGER receipts_no_update");
    const row = raw.prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = 2").get(SYSTEM) as {
      canonical: string;
    };
    raw.prepare("UPDATE receipts SET canonical = ? WHERE system_id = ? AND seq = 2").run(
      row.canonical.replace('"outcome":"ok"', '"outcome":"error"'),
      SYSTEM,
    );
    raw.close();

    const freshMonitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    freshMonitor.check();
    const freshApp = buildServer({
      store,
      keys,
      now: () => new Date(NOW),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: freshMonitor,
        checkpointer,
      },
    });
    await freshApp.ready();
    try {
      const cookie = await signIn(freshApp);
      const home = (await freshApp.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
      expect(home).toContain(`<a class="line" href="/ui/systems/${SYSTEM}">`);
      expect(home).toContain(`<span class="pill red" data-chain="red">`);
      expect(home).toContain("La verifica è fallita");
    } finally {
      await freshApp.close();
    }
  });
});

describe("managing a system: deleting (M3)", () => {
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const EMPTY = "sistema-di-prova";

  beforeEach(async () => {
    await store.createSystem(EMPTY, "2026-03-29T15:00:00.000Z");
  });

  it("offers no delete form for a system with recorded actions, and says why", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}/manage`, headers: { cookie } })).body;
    expect(body).not.toContain(`action="/ui/systems/${SYSTEM}/delete"`);
    expect(body).toContain(UI.manage.deleteRefused(6));
  });

  it("refuses on the server a system with recorded actions, even when asked directly with the right confirmation", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${SYSTEM}/delete`,
      headers: { cookie, ...form },
      payload: `confirm=${SYSTEM}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain(UI.manage.deleteRefused(6));
    expect(store.readChain(SYSTEM)).toHaveLength(6);
    expect(store.adminLog()).toEqual([]);
  });

  it("asks for the exact system_id, typed out, and does nothing on anything else", async () => {
    const cookie = await signIn();
    const manage = (await app.inject({ method: "GET", url: `/ui/systems/${EMPTY}/manage`, headers: { cookie } })).body;
    expect(manage).toContain(`action="/ui/systems/${EMPTY}/delete"`);
    expect(manage).toContain(`placeholder="${UI.manage.deleteConfirmLabel(EMPTY)}"`);

    for (const payload of ["", "confirm=", "confirm=si", `confirm=${EMPTY.toUpperCase()}`, `confirm=${EMPTY}%20`]) {
      const response = await app.inject({
        method: "POST",
        url: `/ui/systems/${EMPTY}/delete`,
        headers: { cookie, ...form },
        payload,
      });
      expect(response.statusCode, payload).toBe(400);
      expect(response.body).toContain(UI.manage.confirmMismatch.replace(/'/g, "&#39;"));
    }
    expect(store.hasSystem(EMPTY)).toBe(true);
  });

  it("deletes an empty system, logs it, and says so on the systems page", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${EMPTY}/delete`,
      headers: { cookie, ...form },
      payload: `confirm=${EMPTY}`,
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(`/ui/sistemi?eliminato=${EMPTY}`);
    expect(store.hasSystem(EMPTY)).toBe(false);
    expect(store.readChain(EMPTY)).toEqual([]);

    const [entry] = store.adminLog();
    expect(entry).toMatchObject({ action: "system.delete", system_id: EMPTY, ts: NOW });
    expect(entry?.actor).toMatch(/^web /);

    const page = (await app.inject({ method: "GET", url: `/ui/sistemi?eliminato=${EMPTY}`, headers: { cookie } })).body;
    expect(page).toContain(UI.systemsPage.deleted(EMPTY));
    const settings = (await app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie } })).body;
    expect(settings).toContain(`${EMPTY} eliminato`);
    expect((await app.inject({ method: "GET", url: `/ui/systems/${EMPTY}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("does not claim a deletion the log does not hold", async () => {
    const cookie = await signIn();
    for (const name of [SYSTEM, "never-created"]) {
      const page = (await app.inject({ method: "GET", url: `/ui/sistemi?eliminato=${name}`, headers: { cookie } })).body;
      expect(page).not.toContain("è stato eliminato");
    }
  });

  it("decides on what the database holds when the button is pressed, not on the page it was pressed on", async () => {
    const cookie = await signIn();
    const manage = (await app.inject({ method: "GET", url: `/ui/systems/${EMPTY}/manage`, headers: { cookie } })).body;
    expect(manage).toContain(`action="/ui/systems/${EMPTY}/delete"`);
    // An agent writes between the page being drawn and the button being pressed.
    await store.append(event(1, { system_id: EMPTY }));
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${EMPTY}/delete`,
      headers: { cookie, ...form },
      payload: `confirm=${EMPTY}`,
    });
    expect(response.statusCode).toBe(409);
    expect(store.readChain(EMPTY)).toHaveLength(2);
    expect(response.body).not.toContain(`action="/ui/systems/${EMPTY}/delete"`);
  });

  it("refuses a delete posted from another site", async () => {
    const cookie = await signIn();
    const response = await app.inject({
      method: "POST",
      url: `/ui/systems/${EMPTY}/delete`,
      headers: { cookie, ...form, "sec-fetch-site": "cross-site" },
      payload: `confirm=${EMPTY}`,
    });
    expect(response.statusCode).toBe(403);
    expect(store.hasSystem(EMPTY)).toBe(true);
  });

  it("refuses every management action without a session", async () => {
    for (const action of ["rename", "archive", "unarchive", "delete"]) {
      const response = await app.inject({ method: "POST", url: `/ui/systems/${EMPTY}/${action}` });
      expect(response.statusCode, action).toBe(302);
    }
    expect((await app.inject({ method: "GET", url: `/ui/systems/${EMPTY}/manage` })).statusCode).toBe(302);
  });
});

describe("the typefaces", () => {
  it("names no web font: direction B uses the system's own", () => {
    expect(STYLE).not.toContain("@font-face");
    expect(STYLE).not.toMatch(/url\(/);
    expect(STYLE).toContain("-apple-system");
  });

  it("still serves the files of direction Registro, from this origin, before any sign-in", async () => {
    const named = FONT_FILES.map((name) => `/fonts/${name}`);
    expect(named.length).toBe(7);
    for (const url of named) {
      expect(url, url).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
      const response = await app.inject({ method: "GET", url: url ?? "" });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"], url).toBe("font/woff2");
      expect(response.rawPayload.subarray(0, 4).toString("latin1"), url).toBe("wOF2");
      const onDisk = readFileSync(join(REPOSITORY_ROOT, "apps", "server", "assets", "fonts", (url ?? "").slice("/fonts/".length)));
      expect(response.rawPayload.equals(onDisk), url).toBe(true);
    }
  });

  it("serves nothing else under /fonts/", async () => {
    for (const url of ["/fonts/LICENSE-newsreader.txt", "/fonts/..%2F..%2Fpackage.json", "/fonts/missing.woff2"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });

  it("ships the licence of every family beside its files", () => {
    for (const family of ["newsreader", "public-sans", "ibm-plex-mono"]) {
      const licence = readFileSync(join(REPOSITORY_ROOT, "apps", "server", "assets", "fonts", `LICENSE-${family}.txt`), "utf8");
      expect(licence, family).toContain("SIL Open Font License, Version 1.1");
    }
  });

  it("is allowed by deploy/Caddyfile's CSP from this origin only", () => {
    const caddyfile = readFileSync(join(REPOSITORY_ROOT, "deploy", "Caddyfile"), "utf8");
    const policy = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1] ?? "";
    expect(policy.split("; ")).toContain("font-src 'self'");
    expect(STYLE).not.toMatch(/https?:\/\//);
  });
});

describe("the shell: sidebar and sign-in (Interfaccia B, B1)", () => {
  const sidebarOf = (body: string): string => /<div class="sidebar" id="menu">([^]*?)<main id="main"/.exec(body)?.[1] ?? "";

  it("lists each system shown on the main page with its real chain state, as a light and a word, and its receipts", async () => {
    healthMonitor.check();
    const cookie = await signIn();
    const side = sidebarOf((await app.inject({ method: "GET", url: "/ui/sistemi", headers: { cookie } })).body);
    // Not anchored yet: the monitor says yellow, and so does the sidebar.
    expect(healthMonitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("yellow");
    expect(side).toContain(
      `<a class="side-item" href="/ui/systems/${SYSTEM}"><span class="light yellow" aria-hidden="true"></span>`,
    );
    expect(side).toContain(`<span class="sr">${UI.chain.yellow}: </span><span class="side-label">${SYSTEM}</span><span class="side-count">6</span>`);
  });

  it("follows the chain check, not a fixed word: a tampered chain is red in the sidebar", async () => {
    const raw = new Database(join(directory, "sigillo.db"));
    raw.exec("DROP TRIGGER receipts_no_update");
    const row = raw.prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = 2").get(SYSTEM) as { canonical: string };
    raw.prepare("UPDATE receipts SET canonical = ? WHERE system_id = ? AND seq = 2").run(
      row.canonical.replace('"outcome":"ok"', '"outcome":"error"'),
      SYSTEM,
    );
    raw.close();
    const freshMonitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    freshMonitor.check();
    const freshApp = buildServer({
      store,
      keys,
      now: () => new Date(NOW),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: freshMonitor,
        checkpointer,
      },
    });
    await freshApp.ready();
    try {
      const cookie = await signIn(freshApp);
      const side = sidebarOf((await freshApp.inject({ method: "GET", url: "/ui/persone", headers: { cookie } })).body);
      expect(side).toContain('<span class="light red" aria-hidden="true"></span>');
      expect(side).toContain(`<span class="sr">${UI.chain.red}: </span>`);
    } finally {
      await freshApp.close();
    }
  });

  it("has the register, the systems with a + to create one, all systems, the tools, the settings, the account and a POST sign-out", async () => {
    await store.createSystem("vecchio", "2026-03-29T15:00:00.000Z");
    await store.archiveSystem("vecchio", { actor: "test", ts: NOW });
    const cookie = await signIn();
    const side = sidebarOf((await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body);
    expect(side).toContain('<a class="side-item" href="/ui" aria-current="page">');
    expect(side).toContain(`<a class="side-add" href="/ui/sistemi/nuovo" aria-label="${UI.nav.newSystem}">`);
    // An archived system is not in the list: it is on the systems page.
    expect(side).not.toContain('href="/ui/systems/vecchio"');
    expect(side).toContain('<a class="side-item" href="/ui/sistemi">');
    expect(side).toContain(UI.nav.allSystems);
    expect(side).toContain('href="/ui/persone"');
    expect(side).toContain('href="/ui/impostazioni"');
    expect(side).toContain(`<strong>${UI.settings.operator}</strong>`);
    expect(side).toMatch(/<form method="post" action="\/ui\/logout"><button type="submit" class="icon-button" aria-label="[^"]+"/);
  });

  it("marks the system being looked at, and the systems views, as the current entry", async () => {
    const cookie = await signIn();
    for (const [url, marked] of [
      [`/ui/systems/${SYSTEM}`, `href="/ui/systems/${SYSTEM}" aria-current="page"`],
      [`/ui/systems/${SYSTEM}/manage`, `href="/ui/systems/${SYSTEM}" aria-current="page"`],
      ["/ui/sistemi", 'href="/ui/sistemi" aria-current="page"'],
      ["/ui/sistemi?vista=archiviati", 'href="/ui/sistemi" aria-current="page"'],
      ["/ui/sistemi?vista=tutti", 'href="/ui/sistemi" aria-current="page"'],
      ["/ui/persone", 'href="/ui/persone" aria-current="page"'],
      ["/ui/impostazioni", 'href="/ui/impostazioni" aria-current="page"'],
    ] as const) {
      const side = sidebarOf((await app.inject({ method: "GET", url, headers: { cookie } })).body);
      expect(side, url).toContain(marked);
      expect(side.match(/aria-current="page"/g), url).toHaveLength(1);
    }
  });

  it("opens the sidebar on a phone as a menu, with a link and :target, and no script", async () => {
    const cookie = await signIn();
    const body = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    expect(body).toContain(`<a class="menu-open" href="#menu" aria-label="${UI.nav.menu}">`);
    expect(body).toContain('<div class="sidebar" id="menu">');
    expect(body).toContain(`<a class="menu-close" href="#main" aria-label="${UI.nav.close}">`);
    expect(STYLE).toContain(".sidebar:target {");
    expect(body).not.toContain("<script");
  });

  it("puts the sign-in in the middle, with nothing beside it but the seal and a title", async () => {
    const body = (await app.inject({ method: "GET", url: "/ui/login" })).body;
    expect(body).toContain(`<h1>${UI.login.title}</h1>`);
    expect(body).toContain('<form method="post" action="/ui/login">');
    expect(body).toContain(
      `<label><span class="sr">${UI.login.label}</span><input type="password" name="password" autocomplete="current-password" autofocus required placeholder="${UI.login.placeholder}"></label>`,
    );
    expect(body).not.toContain('role="alert"');
    expect(body).not.toContain('required aria-invalid="true"');
  });

  it("marks the field and says why when the password is wrong, with the same words as a lockout", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=wrong",
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain(`autofocus required placeholder="${UI.login.placeholder}" aria-invalid="true" aria-describedby="login-error">`);
    expect(response.body).toContain(`<p class="field-error" id="login-error" role="alert">`);
    expect(response.body).toContain(escapeHtml(UI.login.wrong));
  });
});

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("'", "&#39;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
