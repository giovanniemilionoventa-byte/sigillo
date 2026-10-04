import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { FirebaseAuth } from "../src/auth/firebase.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { currentLanguage, languageFor, withLanguage } from "../src/http/locale.js";
import { buildServer } from "../src/http/server.js";
import { EN } from "../src/http/strings-en.js";
import { IT } from "../src/http/strings-it.js";
import { describeReceipt, formatCount, formatDayHeading, formatListTime, formatTs, formatWhenInline, UI } from "../src/http/strings.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * English is the view's first language and Italian its second: the browser's
 * Accept-Language picks between them on a first visit, and the switch on the
 * sign-in pages and in Impostazioni keeps the reader's choice in a cookie.
 * The other UI tests check the Italian text word for word (helpers/italian.ts).
 */

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";
const NOW = "2026-03-29T16:00:00.000Z";

describe("the language of a request", () => {
  it("is the one chosen, else the browser's first of English and Italian, else English", () => {
    expect(languageFor("it", "en-GB,en")).toBe("it");
    expect(languageFor("en", "it-IT,it")).toBe("en");
    expect(languageFor(undefined, undefined)).toBe("en");
    expect(languageFor(undefined, "it-IT,it;q=0.9,en;q=0.8")).toBe("it");
    expect(languageFor(undefined, "de-DE,de;q=0.9,it;q=0.8,en;q=0.7")).toBe("it");
    expect(languageFor(undefined, "en;q=0.5,it;q=0.9")).toBe("it");
    expect(languageFor(undefined, "fr-FR,fr")).toBe("en");
    expect(languageFor(undefined, "it;q=0,en")).toBe("en");
    expect(languageFor("de", "de")).toBe("en");
  });

  it("is English outside a request, and the one it is given inside", () => {
    expect(currentLanguage()).toBe("en");
    expect(withLanguage("it", "/ui", () => UI.nav.esci)).toBe("Esci");
    expect(UI.nav.esci).toBe("Sign out");
  });

  it("follows the language even through text taken aside before it was chosen", () => {
    const account = UI.account;
    const waiting = UI.account.waiting;
    expect(withLanguage("it", "/ui", () => account.google)).toBe("Continua con Google");
    expect(withLanguage("it", "/ui", () => waiting("Acme"))).toContain("in attesa di approvazione");
    expect(account.google).toBe("Continue with Google");
    expect(Object.keys(UI.settings.themes)).toEqual(["light", "dark", "system"]);
  });
});

/** Every key of an object of strings, nested ones as "a.b", functions included. */
function keysOf(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, inner]) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner) ? keysOf(inner as object, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

describe("the two languages", () => {
  it("have the same strings, and no English string is left in Italian or the other way round", () => {
    expect(keysOf(EN.ui).sort()).toEqual(keysOf(IT.ui).sort());
    expect(EN.ui.home.summary.green).not.toBe(IT.ui.home.summary.green);
  });

  it("write a receipt, a count and a time in English", () => {
    const receipt = {
      v: 3,
      action: { kind: "tool_call", name: "lookup_order" },
      actor: { agent: "support", on_behalf_of: "customer-4821" },
      outcome: "blocked",
    } as unknown as Receipt;
    expect(describeReceipt(receipt)).toBe("The agent «support» tried the tool «lookup_order» on behalf of «customer-4821» — blocked.");
    expect(formatCount(10000)).toBe("10,000");
    expect(formatTs("2026-10-02T17:54:37Z")).toBe("2 Oct 2026, 19:54:37 CEST");
    const now = new Date("2026-10-01T12:00:00Z");
    expect(formatDayHeading("2026-10-01T10:00:00Z", now)).toBe("Today · Thursday 1 October");
    expect(formatWhenInline("2026-09-29T16:03:00Z", now)).toBe("on 29 Sep 2026 at 18:03");
    expect(formatWhenInline("2026-09-30T16:03:00Z", now)).toBe("yesterday at 18:03");
    expect(formatListTime("2026-10-01T10:00:00Z", now)).toBe("12:00");
    expect(formatListTime("2026-09-30T10:00:00Z", now)).toBe("Yesterday");
    expect(formatListTime("2026-09-29T10:00:00Z", now)).toBe("29 Sep");
    expect(withLanguage("it", "/ui", () => formatListTime("2026-09-30T10:00:00Z", now))).toBe("Ieri");
  });
});

describe("the web view, in English and in Italian", () => {
  let directory: string;
  let signer: TestSigner;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-language-"));
    const databasePath = join(directory, "sigillo.db");
    signer = createTestSigner();
    store = ReceiptStore.open(databasePath, signer);
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    keys = ApiKeyStore.open(databasePath);
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
  });

  afterEach(async () => {
    await app.close();
    keys.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const get = async (url: string, headers: Record<string, string> = {}): Promise<string> =>
    (await app.inject({ method: "GET", url, headers })).body;

  const signIn = async (): Promise<string> => {
    const response = await app.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });
    return String(response.headers["set-cookie"]).split(";")[0] ?? "";
  };

  it("answers in English when the browser asks for neither language, and says so on <html>", async () => {
    const page = await get("/ui/login", { "accept-language": "de-DE,de" });
    expect(page).toContain('<html lang="en" data-theme="light">');
    expect(page).toContain("<h1>Sign in to sigillo</h1>");
    expect(page).not.toContain("Accedi");
  });

  it("answers in Italian a browser that asks for Italian first", async () => {
    const page = await get("/ui/login", { "accept-language": "it-IT,it;q=0.9,en;q=0.8" });
    expect(page).toContain('<html lang="it" data-theme="light">');
    expect(page).toContain("<h1>Accedi a sigillo</h1>");
  });

  it("offers both languages on the sign-in page, each in its own words, the current one pressed", async () => {
    const page = await get("/ui/login");
    expect(page).toContain('<form method="post" action="/ui/lingua" class="auth-lang" aria-label="Language"><input type="hidden" name="back" value="/ui/login">');
    expect(page).toContain('<button type="submit" name="lang" value="en" lang="en" aria-pressed="true">English</button>');
    expect(page).toContain('<button type="submit" name="lang" value="it" lang="it" aria-pressed="false">Italiano</button>');
  });

  it("keeps the choice in a cookie that outweighs the browser, and returns to the page it came from", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ui/lingua",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "lang=it&back=%2Fui%2Flogin",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe("/ui/login");
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/^sigillo_lang=it; HttpOnly; SameSite=Strict; Path=\//);
    const page = await get("/ui/login", { cookie: cookie.split(";")[0] ?? "", "accept-language": "en" });
    expect(page).toContain("<h1>Accedi a sigillo</h1>");
  });

  it("returns only to a page of the view, and ignores a language it does not know", async () => {
    for (const back of ["https://example.com/", "//example.com/ui", "/uix", "/ui/../etc"]) {
      const response = await app.inject({
        method: "POST",
        url: "/ui/lingua",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `lang=en&back=${encodeURIComponent(back)}`,
      });
      expect(response.headers["location"], back).toBe("/ui");
    }
    const unknown = await app.inject({
      method: "POST",
      url: "/ui/lingua",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "lang=de&back=%2Fui%2Fimpostazioni",
    });
    expect(unknown.headers["location"]).toBe("/ui/impostazioni");
    expect(unknown.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses the switch from another site, like every other form of the view", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ui/lingua",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      payload: "lang=it&back=%2Fui",
    });
    expect(response.statusCode).toBe(403);
  });

  it("writes every page of the console in the language chosen, and offers the switch in the settings", async () => {
    const session = await signIn();
    const english = await get("/ui", { cookie: session });
    expect(english).toContain(">Ledger<");
    expect(english).toContain('aria-label="Sign out"');
    const italian = await get("/ui", { cookie: `${session}; sigillo_lang=it` });
    expect(italian).toContain(">Registro<");
    expect(italian).toContain('aria-label="Esci"');
    const settings = await get("/ui/impostazioni", { cookie: `${session}; sigillo_lang=it` });
    expect(settings).toContain('<h2 id="lingua">Lingua</h2>');
    expect(settings).toContain('<input type="hidden" name="back" value="/ui/impostazioni">');
    expect(settings).toContain('value="it" lang="it" aria-pressed="true">Italiano</button>');
  });

  it("keeps the chosen theme next to the language on <html>", async () => {
    const page = await get("/ui/login", { cookie: "sigillo_theme=dark; sigillo_lang=it" });
    expect(page).toContain('<html lang="it" data-theme="dark">');
  });
});

describe("Firebase's emails", () => {
  it("ask for the reader's language", async () => {
    const sent: (string | undefined)[] = [];
    const fetch = async (_url: string, init?: { headers?: Record<string, string> }) => {
      sent.push(init?.headers?.["x-firebase-locale"]);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    };
    const firebase = new FirebaseAuth({ apiKey: "a-web-api-key", projectId: "a-project" }, () => new Date(NOW), fetch);
    await firebase.sendPasswordReset("a@example.com", "it");
    await firebase.sendPasswordReset("a@example.com", "en");
    await firebase.sendPasswordReset("a@example.com");
    expect(sent).toEqual(["it", "en", undefined]);
  });
});
