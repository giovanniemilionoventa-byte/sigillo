import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { readOffsiteSettings, STATUS_FILE } from "../src/backup/offsite.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { escape } from "../src/http/layout.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { identifierFrom } from "../src/http/ui.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * What the simple design added beside the pages it redrew: the settings
 * (account, appearance, the administrative log, the signing key), the theme
 * chosen without a script, a system created from its name alone, the page
 * that connects an agent, and a new key for a system.
 */

const SYSTEM = "assistente";
const PASSWORD = "an administrator password";
const NOW = "2026-10-01T12:44:00.000Z";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-settings-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner({ now: () => new Date(NOW) });
  store = ReceiptStore.open(databasePath, signer);
  keys = ApiKeyStore.open(databasePath);
  await store.createSystem(SYSTEM, "2026-10-01T08:00:00.000Z");
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
  healthMonitor.check();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
    },
  });
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `password=${encodeURIComponent(PASSWORD)}`,
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const get = (url: string, session = cookie) => app.inject({ method: "GET", url, headers: { cookie: session } });
const post = (url: string, payload: string, session = cookie) =>
  app.inject({ method: "POST", url, headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, payload });

describe("the settings page", () => {
  it("says who is signed in, with a way out, and shows the signing key and the administrative log", async () => {
    await store.renameSystem(SYSTEM, "Assistente", { actor: "web 192.0.2.10", ts: NOW });
    const response = await get("/ui/impostazioni");
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain(`<strong>${UI.settings.operator}</strong><span>${escape(UI.settings.operatorDetail)}</span>`);
    expect(body).toContain(`<code class="line-text keyid">${signer.keyId}</code>`);
    expect(body).toContain("nome cambiato: da nessun nome a «Assistente»");
    expect(body).toContain('<a class="end" href="/ui/impostazioni/registro">');
    // The operator has no organization, and so no monthly limit to show.
    expect(body).not.toContain('role="progressbar"');
  });

  it("says plainly when the administrative log is empty", async () => {
    expect((await get("/ui/impostazioni")).body).toContain(UI.settings.adminLogEmpty);
    expect((await get("/ui/impostazioni/registro")).body).toContain(UI.settings.adminLogEmpty);
  });

  it("is behind the sign-in, like every other page", async () => {
    for (const url of ["/ui/impostazioni", "/ui/impostazioni/registro", "/ui/sistemi/nuovo", `/ui/systems/${SYSTEM}/collega`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(302);
      expect(response.headers["location"], url).toBe("/ui/login");
    }
    const anonymous = await app.inject({
      method: "POST",
      url: "/ui/impostazioni/tema",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "theme=dark",
    });
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers["set-cookie"]).toBeUndefined();
  });
});

describe("the theme, chosen without a script", () => {
  it("is kept in a cookie and written on the page by the server, and follows the system again when asked", async () => {
    // By default the page follows the system: no attribute, the media query decides.
    expect((await get("/ui")).body).toContain('<html lang="it">');

    const dark = await post("/ui/impostazioni/tema", "theme=dark");
    expect(dark.statusCode).toBe(303);
    expect(dark.headers["location"]).toBe("/ui/impostazioni");
    const set = String(dark.headers["set-cookie"]);
    expect(set).toMatch(/^sigillo_theme=dark; /);
    expect(set).toContain("HttpOnly");
    const theme = set.split(";")[0] ?? "";

    const settings = (await get("/ui/impostazioni", `${cookie}; ${theme}`)).body;
    expect(settings).toContain('<html lang="it" data-theme="dark">');
    expect(settings).toContain(`<button type="submit" name="theme" value="dark" aria-pressed="true">${UI.settings.themes.dark}</button>`);
    expect(settings).toContain(`<button type="submit" name="theme" value="system" aria-pressed="false">`);
    // Every page of the view, and the sign-in pages too.
    expect((await get(`/ui/systems/${SYSTEM}`, `${cookie}; ${theme}`)).body).toContain('data-theme="dark"');
    expect((await app.inject({ method: "GET", url: "/ui/login", headers: { cookie: theme } })).body).toContain('data-theme="dark"');

    const system = await post("/ui/impostazioni/tema", "theme=system", `${cookie}; ${theme}`);
    expect(String(system.headers["set-cookie"])).toMatch(/^sigillo_theme=; .*Max-Age=0/);
  });

  it("writes only the two values it knows, whatever the cookie says", async () => {
    for (const value of ["blue", "%22%3E%3Cscript%3E", "DARK"]) {
      const body = (await get("/ui", `${cookie}; sigillo_theme=${value}`)).body;
      expect(body, value).toContain('<html lang="it">');
      expect(body, value).not.toContain("<script");
    }
    expect((await get("/ui", `${cookie}; sigillo_theme=light`)).body).toContain('<html lang="it" data-theme="light">');
  });
});

describe("creating a system from its name", () => {
  it("makes the identifier from the name", () => {
    expect(identifierFrom("Assistente vendite")).toBe("assistente-vendite");
    expect(identifierFrom("  Selezione CV — 2026! ")).toBe("selezione-cv-2026");
    expect(identifierFrom("Però è già così")).toBe("pero-e-gia-cosi");
    expect(identifierFrom("!!!")).toBe("");
    expect(identifierFrom("a".repeat(80))).toHaveLength(64);
  });

  it("asks only for the name, and keeps the identifier under a disclosure for whoever wants to choose it", async () => {
    const body = (await get("/ui/sistemi/nuovo")).body;
    expect(body).toContain('name="display_name"');
    expect(body).toMatch(/<details[^>]*>[^]*name="system_id"[^]*<\/details>/);
  });

  it("refuses an empty name and a name taken by another system, and says why", async () => {
    const empty = await post("/ui/sistemi", "display_name=%20");
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain(UI.systemsPage.nameRequired);
    const taken = await post("/ui/sistemi", `display_name=${SYSTEM}`);
    expect(taken.statusCode).toBe(400);
    expect(taken.body).toContain('<p class="notice bad" role="alert">');
    expect(store.listSystemRecords()).toHaveLength(1);
  });
});

describe("connecting an agent", () => {
  it("waits for the first receipt, refreshing itself, and then says it arrived", async () => {
    const waiting = (await get(`/ui/systems/${SYSTEM}/collega`)).body;
    expect(waiting).toContain('<meta http-equiv="refresh" content="10">');
    expect(waiting).toContain(UI.connect.waiting);
    // No key on this page: it was shown once, when it was made.
    expect(waiting).not.toMatch(/sigillo_[0-9a-f]{16}_[0-9a-f]{64}/);
    expect(waiting).toContain("&lt;la-chiave-del-sistema&gt;");

    await store.append({
      system_id: SYSTEM,
      ts_event: "2026-10-01T12:40:00.000Z",
      ts_received: "2026-10-01T12:40:00.000Z",
      actor: { agent: "agente" },
      action: { kind: "decision", name: "prima" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "api" },
    });
    const arrived = (await get(`/ui/systems/${SYSTEM}/collega`)).body;
    expect(arrived).not.toContain('http-equiv="refresh"');
    expect(arrived).toContain(UI.connect.arrived("Oggi, 14:40"));
    expect(arrived).toContain(`<a class="button primary end" href="/ui/systems/${SYSTEM}">`);
  });

  it("answers 404 for a system that is not there", async () => {
    expect((await get("/ui/systems/mai-creato/collega")).statusCode).toBe(404);
  });
});

describe("a new key for a system", () => {
  it("revokes the key in use and shows the new one once", async () => {
    const old = keys.issue(SYSTEM, "2026-10-01T08:00:00.000Z");
    const manage = (await get(`/ui/systems/${SYSTEM}/manage`)).body;
    expect(manage).toContain(`sigillo_${old.keyId}_••••`);
    expect(manage).not.toContain(old.token);

    const response = await post(`/ui/systems/${SYSTEM}/key`, "");
    expect(response.statusCode).toBe(200);
    const token = /<code class="keybox">(sigillo_[0-9a-f]{16}_[0-9a-f]{64})<\/code>/.exec(response.body)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(token).not.toBe(old.token);
    expect(response.body).toContain(UI.connect.newKey(SYSTEM));

    expect(await keys.verify(old.token)).toBeNull();
    expect(await keys.verify(token)).toBe(SYSTEM);
    const listed = keys.list(SYSTEM);
    expect(listed.filter((record) => record.revokedAt === null)).toHaveLength(1);
    // Shown once: the manage page names the new key without its secret.
    expect((await get(`/ui/systems/${SYSTEM}/manage`)).body).not.toContain(token);
  });

  it("is refused for a system that is not there, and without a session", async () => {
    expect((await post("/ui/systems/mai-creato/key", "")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/key` })).statusCode).toBe(302);
    expect(keys.list(SYSTEM)).toEqual([]);
  });
});

describe("countReceiptsByOutcome", () => {
  it("counts each outcome under the filters, leaving out the opening of the register", async () => {
    const append = (outcome: "ok" | "blocked" | "error", at: string) =>
      store.append({
        system_id: SYSTEM,
        ts_event: at,
        ts_received: at,
        actor: { agent: "agente" },
        action: { kind: "tool_call", name: "x" },
        input_hash: null,
        output_hash: null,
        outcome,
        source: { type: "api" },
      });
    await append("ok", "2026-10-01T09:00:00.000Z");
    await append("ok", "2026-10-01T10:00:00.000Z");
    await append("blocked", "2026-10-01T11:00:00.000Z");
    await append("error", "2026-10-01T12:00:00.000Z");
    expect(store.countReceiptsByOutcome({ systemId: SYSTEM })).toEqual({ ok: 2, blocked: 1, error: 1 });
    expect(store.countReceiptsByOutcome({ systemId: SYSTEM, from: "2026-10-01T10:30:00.000Z" })).toEqual({ blocked: 1, error: 1 });
  });
});

describe("the off-site backup, in the settings", () => {
  async function withBackups(backupDirectory: string): Promise<{ app: FastifyInstance; cookie: string }> {
    const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
    const backupsApp = buildServer({
      store,
      keys,
      now: () => new Date(NOW),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor,
        checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
        backupDirectory,
      },
    });
    await backupsApp.ready();
    const login = await backupsApp.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });
    return { app: backupsApp, cookie: String(login.headers["set-cookie"]).split(";")[0] ?? "" };
  }
  const seconds = (iso: string): number => Date.parse(iso) / 1000;
  const status = (fields: object): void =>
    writeFileSync(join(directory, STATUS_FILE), JSON.stringify({ last_success: null, last_failure: null, ...fields }));

  it("is not there when the server does not know where the backups are", async () => {
    expect((await get("/ui/impostazioni")).body).not.toContain(UI.settings.offsite.heading);
    expect((await post("/ui/impostazioni/backup", "enabled=off")).statusCode).toBe(404);
  });

  it("starts on, every hour, and says the server has not tried yet", async () => {
    const backups = await withBackups(directory);
    try {
      const body = (await backups.app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie: backups.cookie } })).body;
      expect(body).toContain(UI.settings.offsite.heading);
      expect(body).toContain('data-offsite="never-ran"');
      expect(body).toContain(`name="enabled" value="on" aria-pressed="true"`);
      expect(body).toContain(`name="every" value="1" aria-pressed="true"`);
    } finally {
      await backups.app.close();
    }
  });

  it("saves one choice at a time, keeping the other, and hides the frequency while off", async () => {
    const backups = await withBackups(directory);
    const send = (payload: string) =>
      backups.app.inject({
        method: "POST",
        url: "/ui/impostazioni/backup",
        headers: { cookie: backups.cookie, "content-type": "application/x-www-form-urlencoded" },
        payload,
      });
    try {
      expect((await send("every=6")).headers["location"]).toBe("/ui/impostazioni");
      expect(readOffsiteSettings(directory)).toEqual({ enabled: true, everyHours: 6 });
      await send("enabled=off");
      expect(readOffsiteSettings(directory)).toEqual({ enabled: false, everyHours: 6 });
      const off = (await backups.app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie: backups.cookie } })).body;
      expect(off).toContain('data-offsite="off"');
      expect(off).not.toContain('name="every"');
      // Anything else is left as it was.
      await send("every=5&enabled=maybe");
      expect(readOffsiteSettings(directory)).toEqual({ enabled: false, everyHours: 6 });
      await send("enabled=on");
      expect(readOffsiteSettings(directory)).toEqual({ enabled: true, everyHours: 6 });
      expect(
        (await backups.app.inject({ method: "POST", url: "/ui/impostazioni/backup", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "enabled=off" }))
          .statusCode,
      ).toBe(302);
      expect(readOffsiteSettings(directory).enabled).toBe(true);
    } finally {
      await backups.app.close();
    }
  });

  it("shows what the script last reported, the most urgent first", async () => {
    const backups = await withBackups(directory);
    const state = async (): Promise<string> => {
      const body = (await backups.app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie: backups.cookie } })).body;
      return /data-offsite="([a-z-]+)"/.exec(body)?.[1] ?? "";
    };
    try {
      status({ checked: seconds("2026-10-01T12:00:00Z"), drive: false });
      expect(await state()).toBe("not-connected");
      status({ checked: seconds("2026-10-01T12:00:00Z"), drive: true });
      expect(await state()).toBe("waiting");
      status({ checked: seconds("2026-10-01T12:00:00Z"), drive: true, last_success: seconds("2026-10-01T12:00:00Z") });
      expect(await state()).toBe("ok");
      expect((await backups.app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie: backups.cookie } })).body).toContain(
        UI.settings.offsite.states.ok("oggi alle 14:00"),
      );
      status({
        checked: seconds("2026-10-01T12:00:00Z"),
        drive: true,
        last_success: seconds("2026-10-01T11:00:00Z"),
        last_failure: seconds("2026-10-01T12:00:00Z"),
      });
      expect(await state()).toBe("failed");
      // Three hours of silence: the hourly runs have stopped.
      status({ checked: seconds("2026-10-01T09:30:00Z"), drive: true, last_success: seconds("2026-10-01T09:30:00Z") });
      expect(await state()).toBe("not-running");
    } finally {
      await backups.app.close();
    }
  });
});
