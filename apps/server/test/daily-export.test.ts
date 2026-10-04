import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { DailyExporter, fileNameFor, isDailyExportOn, listDailyExports, runDailyExports, setDailyExport } from "../src/backup/daily-export.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The daily export: at 23:59 Italian time, a file per system with the day's
 * receipts, for the accounts that turned it on; kept on the server, served
 * only to the account whose systems they are.
 */

const PASSWORD = "an administrator password";
const ADMIN = { actor: "test", ts: "2026-10-01T08:00:00.000Z" };
// 2026-10-01 is summer time in Rome: 23:59 there is 21:59 UTC.
const BEFORE = new Date("2026-10-01T21:58:59.000Z");
const AT = new Date("2026-10-01T21:59:00.000Z");
const DAY = "2026-10-01";

let directory: string;
let backups: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-daily-"));
  backups = join(directory, "backups");
  mkdirSync(backups);
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner({ now: () => AT });
  store = ReceiptStore.open(databasePath, signer);
  keys = ApiKeyStore.open(databasePath);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createOrganization("globex", "Globex S.r.l.", ADMIN, { approved: true });
  await store.createSystem("mio-bot", "2026-10-01T08:00:00.000Z");
  await store.createSystem("acme-bot", "2026-10-01T09:00:00.000Z", "acme");
  await store.createSystem("globex-bot", "2026-10-01T09:30:00.000Z", "globex");
  await store.createSystem("ieri-bot", "2026-09-30T09:00:00.000Z", "acme");
});

afterEach(() => {
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const files = (): string[] =>
  readdirSync(join(backups, "exports"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".zip"))
    .sort();

describe("the daily export", () => {
  it("makes nothing before 23:59, and nothing for an account that did not turn it on", async () => {
    setDailyExport(backups, "acme", true);
    expect(await runDailyExports({ store, directory: backups, now: BEFORE })).toBe(0);
    expect(existsSync(join(backups, "exports"))).toBe(false);
    setDailyExport(backups, "acme", false);
    expect(await runDailyExports({ store, directory: backups, now: AT })).toBe(0);
  });

  it("writes one file per system of the accounts that turned it on, and skips a system with nothing that day", async () => {
    setDailyExport(backups, "acme", true);
    setDailyExport(backups, "", true);
    expect(await runDailyExports({ store, directory: backups, now: AT })).toBe(2);
    expect(files()).toEqual([`acme/${fileNameFor("acme-bot", DAY)}`, `operator/${fileNameFor("mio-bot", DAY)}`]);
    // globex did not turn it on; ieri-bot had no receipt on the 1st.
  });

  it("leaves a file that exists alone, so running again changes nothing", async () => {
    setDailyExport(backups, "acme", true);
    await runDailyExports({ store, directory: backups, now: AT });
    const path = join(backups, "exports", "acme", fileNameFor("acme-bot", DAY));
    writeFileSync(path, "kept");
    utimesSync(path, new Date(0), new Date(0));
    expect(await runDailyExports({ store, directory: backups, now: new Date(AT.getTime() + 20_000) })).toBe(0);
    expect(readdirSync(join(backups, "exports", "acme"))).toEqual([fileNameFor("acme-bot", DAY)]);
  });

  it("makes archives that are the day's receipts, as the Esporta button does", async () => {
    setDailyExport(backups, "", true);
    await runDailyExports({ store, directory: backups, now: AT });
    const [stored] = listDailyExports(backups, "", ["mio-bot"]);
    expect(stored).toMatchObject({ systemId: "mio-bot", day: DAY });
    expect(stored?.bytes).toBeGreaterThan(500);
  });

  it("removes the files older than 30 days and keeps the rest", async () => {
    setDailyExport(backups, "acme", true);
    const folder = join(backups, "exports", "acme");
    mkdirSync(folder, { recursive: true });
    for (const day of ["2026-08-30", "2026-09-01", "2026-09-30"]) writeFileSync(join(folder, fileNameFor("acme-bot", day)), "x");
    writeFileSync(join(folder, "notes.txt"), "not ours");
    await runDailyExports({ store, directory: backups, now: AT });
    expect(readdirSync(folder).sort()).toEqual([
      fileNameFor("acme-bot", "2026-09-01"),
      fileNameFor("acme-bot", "2026-09-30"),
      fileNameFor("acme-bot", DAY),
      "notes.txt",
    ]);
  });

  it("remembers who turned it on, in a file, and reads a missing or broken one as nobody", () => {
    expect(isDailyExportOn(backups, "acme")).toBe(false);
    setDailyExport(backups, "acme", true);
    setDailyExport(backups, "", true);
    expect([isDailyExportOn(backups, "acme"), isDailyExportOn(backups, ""), isDailyExportOn(backups, "globex")]).toEqual([true, true, false]);
    setDailyExport(backups, "acme", false);
    expect(isDailyExportOn(backups, "acme")).toBe(false);
    writeFileSync(join(backups, "daily-export.json"), "{not json");
    expect(isDailyExportOn(backups, "")).toBe(false);
  });

  it("is run by a timer object that reports a failure instead of throwing", async () => {
    const errors: string[] = [];
    setDailyExport(backups, "acme", true);
    const exporter = new DailyExporter({ store, directory: backups, now: () => AT, onError: (message) => errors.push(message) });
    expect(await exporter.tick()).toBe(1);
    // Closed store: the next look fails, and says so rather than throwing.
    store.close();
    expect(errors).toEqual([]);
    expect(await exporter.tick()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("daily export failed");
    store = ReceiptStore.open(join(directory, "sigillo.db"), signer);
  });
});

describe("the daily export, in the settings", () => {
  let app: FastifyInstance;
  let sessions: UiSessions;
  let operator: string;
  let acme: string;

  beforeEach(async () => {
    sessions = new UiSessions();
    const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
    app = buildServer({
      store,
      keys,
      now: () => AT,
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor,
        checkpointer: new Checkpointer({ store, now: () => AT }),
        sessions,
        backupDirectory: backups,
      },
    });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });
    operator = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    acme = `sigillo_session=${sessions.issue({ kind: "organization", organizationId: "acme" }, AT.getTime()).value}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const page = async (cookie: string): Promise<string> =>
    (await app.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie } })).body;
  const choose = (cookie: string, enabled: string) =>
    app.inject({
      method: "POST",
      url: "/ui/impostazioni/esportazione-giornaliera",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `enabled=${enabled}`,
    });

  it("starts off, and each account turns its own on and off", async () => {
    expect(await page(operator)).toContain('data-daily-export="off"');
    expect((await choose(acme, "on")).headers["location"]).toBe("/ui/impostazioni");
    expect(await page(acme)).toContain('data-daily-export="on"');
    expect(await page(acme)).toContain(UI.settings.dailyExport.stateOn);
    // The operator's own stays as it was.
    expect(await page(operator)).toContain('data-daily-export="off"');
    await choose(acme, "off");
    expect(await page(acme)).toContain('data-daily-export="off"');
    await choose(acme, "maybe");
    expect(isDailyExportOn(backups, "acme")).toBe(false);
  });

  it("lists an account's files and serves them to it alone", async () => {
    setDailyExport(backups, "acme", true);
    setDailyExport(backups, "globex", true);
    await runDailyExports({ store, directory: backups, now: AT });
    const mine = fileNameFor("acme-bot", DAY);
    const theirs = fileNameFor("globex-bot", DAY);
    expect(await page(acme)).toContain(`href="/ui/impostazioni/esportazioni/${mine}"`);
    expect(await page(acme)).not.toContain(theirs);

    const own = await app.inject({ method: "GET", url: `/ui/impostazioni/esportazioni/${mine}`, headers: { cookie: acme } });
    expect(own.statusCode).toBe(200);
    expect(own.headers["content-type"]).toBe("application/zip");
    expect(own.headers["content-disposition"]).toBe(`attachment; filename="sigillo-${mine}"`);
    expect(own.rawPayload.subarray(0, 2).toString()).toBe("PK");

    for (const [name, cookie] of [[theirs, acme], [mine, operator], ["../../sigillo.db", acme], ["notes.txt", acme]] as const) {
      const refused = await app.inject({ method: "GET", url: `/ui/impostazioni/esportazioni/${encodeURIComponent(name)}`, headers: { cookie } });
      expect(refused.statusCode, name).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/ui/impostazioni/esportazioni/${mine}` })).statusCode).toBe(302);
  });

  it("is not there when the server does not know where the backups are", async () => {
    const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
    const plain = buildServer({
      store,
      keys,
      now: () => AT,
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor,
        checkpointer: new Checkpointer({ store, now: () => AT }),
      },
    });
    await plain.ready();
    const login = await plain.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    expect((await plain.inject({ method: "GET", url: "/ui/impostazioni", headers: { cookie } })).body).not.toContain(
      UI.settings.dailyExport.heading,
    );
    expect(
      (await plain.inject({ method: "POST", url: "/ui/impostazioni/esportazione-giornaliera", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "enabled=on" })).statusCode,
    ).toBe(404);
    await plain.close();
  });
});
