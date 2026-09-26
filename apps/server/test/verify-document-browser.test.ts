import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * "Verifica un documento" in a real browser: the page's own inline script,
 * run by Chromium under the Content-Security-Policy that deploy/Caddyfile
 * sends, against the real server and store, with a file chosen through the
 * page's file input. No part of the client is stood in for, which is the
 * point: the pilot's report (PROGRESS.md, session 6) was about what the page
 * does in a browser, and a test that bypasses the browser cannot see it.
 *
 * The document is demo/selezione-cv/curricula/candidato-07.txt, in the two
 * forms that matter: as the repository holds it (LF line endings) and as a
 * Windows checkout writes it (CRLF), which is what the agent read and what
 * the receipt's fingerprint is of.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PASSWORD = "an administrator password";
const SYSTEM = "sistema cv";
const CRLF_SHA256 = "ecfe08f13aba545b439aa4cbd6e09edddeec73ccd1dc024060793da0d9214347";
const LF_SHA256 = "d819ede88a6701f43f96b03c186db6c59ab8946a997f59cfa79cfeadcdbb204b";

/**
 * A Chromium or Chrome to drive. SIGILLO_TEST_BROWSER names one outright;
 * otherwise Playwright's own download, then the usual install locations. CI
 * must find one (GitHub's runners ship Google Chrome); on a machine without
 * any, the tests are skipped rather than failed.
 */
function findBrowser(): string | undefined {
  const candidates: (string | undefined)[] = [process.env.SIGILLO_TEST_BROWSER];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // no Playwright download on this machine
  }
  const downloads = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (downloads !== undefined && existsSync(downloads)) {
    for (const entry of readdirSync(downloads).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(join(downloads, entry, "chrome-linux64", "chrome"), join(downloads, entry, "chrome-linux", "chrome"));
    }
  }
  candidates.push(
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
  );
  return candidates.find((path) => path !== undefined && path !== "" && existsSync(path));
}

const BROWSER_PATH = findBrowser();
if (BROWSER_PATH === undefined && process.env.CI !== undefined) {
  throw new Error("no Chromium or Chrome found for the browser tests: set SIGILLO_TEST_BROWSER");
}

/** The policy exactly as deploy/Caddyfile writes it, so the browser enforces the production hash. */
function caddyfilePolicy(): string {
  const caddyfile = readFileSync(join(REPOSITORY_ROOT, "deploy", "Caddyfile"), "utf8");
  const policy = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1];
  if (policy === undefined) throw new Error("deploy/Caddyfile has no Content-Security-Policy line");
  return policy;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(BROWSER_PATH === undefined)("verifica un documento, in a real browser", { timeout: 30_000 }, () => {
  let directory: string;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let app: FastifyInstance;
  let browser: Browser;
  let base: string;
  let crlfPath: string;
  let lfPath: string;
  const policy = caddyfilePolicy();

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-verify-browser-"));
    lfPath = join(REPOSITORY_ROOT, "demo", "selezione-cv", "curricula", "candidato-07.txt");
    crlfPath = join(directory, "candidato-07.txt");
    writeFileSync(crlfPath, readFileSync(lfPath, "utf8").replace(/\n/g, "\r\n"));
    // The two fingerprints this whole story is about, from the bytes on disk.
    expect(sha256Hex(readFileSync(lfPath))).toBe(LF_SHA256);
    expect(sha256Hex(readFileSync(crlfPath))).toBe(CRLF_SHA256);

    const signer = createTestSigner();
    const databasePath = join(directory, "sigillo.db");
    store = ReceiptStore.open(databasePath, signer);
    keys = ApiKeyStore.open(databasePath);
    await store.createSystem(SYSTEM, "2026-09-25T20:00:00.000Z");
    await store.append({
      system_id: SYSTEM,
      ts_event: "2026-09-25T20:05:00.000Z",
      ts_received: "2026-09-25T20:05:00.100Z",
      actor: { agent: "selezione-cv", on_behalf_of: "elena.rizzo" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "otlp" },
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: CRLF_SHA256 }],
    });
    const now = (): Date => new Date("2026-09-26T08:00:00.000Z");
    app = buildServer({
      store,
      keys,
      now,
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
        checkpointer: new Checkpointer({ store, now }),
      },
    });
    // What Caddy adds in production.
    app.addHook("onSend", async (_request, reply) => {
      void reply.header("content-security-policy", policy);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    browser = await chromium.launch(BROWSER_PATH === undefined ? {} : { executablePath: BROWSER_PATH });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    keys?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A brand-new browser context (no cache, no cookies, no history), signed in. */
  async function signedInPage(): Promise<{ page: Page; problems: string[] }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`${error.name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    await page.goto(`${base}/ui/login`);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL(`${base}/ui`), page.click('button[type="submit"]')]);
    return { page, problems };
  }

  /** Presses Verifica and waits for the navigation the script makes. */
  async function verify(page: Page, expectedSha256: string): Promise<void> {
    await page.click("#sigillo-doc-button");
    await page.waitForURL((url) => url.searchParams.get("sha256") === expectedSha256, { timeout: 5_000 });
  }

  /** Pastes `text` into the text box with a real Ctrl+V, through the system clipboard. */
  async function paste(page: Page, text: string): Promise<void> {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    // A string, not a function: this project's TypeScript has no DOM types.
    await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`);
    await page.click("#sigillo-doc-text");
    await page.keyboard.press("ControlOrMeta+V");
  }

  const shownFingerprint = (page: Page): Promise<string | null> => page.locator("span.hash").textContent();

  it("serves the page under the Caddyfile's policy", async () => {
    const response = await fetch(`${base}/ui/verify-document`, { redirect: "manual" });
    expect(response.headers.get("content-security-policy")).toBe(policy);
  });

  it("finds the file the agent read, from a clean start", async () => {
    const { page, problems } = await signedInPage();
    await page.goto(`${base}/ui/verify-document`);
    await page.setInputFiles("#sigillo-doc-file", crlfPath);
    await verify(page, CRLF_SHA256);

    expect(await shownFingerprint(page)).toBe(CRLF_SHA256);
    expect(await page.locator("body").textContent()).toContain(`Questo documento è esattamente quello usato da ${SYSTEM}`);
    expect(problems).toEqual([]);
    await page.context().close();
  });

  it("hashes the newly chosen file when the address still holds an earlier fingerprint", async () => {
    const { page, problems } = await signedInPage();
    for (const earlier of ["ab".repeat(32), LF_SHA256]) {
      await page.goto(`${base}/ui/verify-document?sha256=${earlier}`);
      expect(await shownFingerprint(page)).toBe(earlier);
      await page.setInputFiles("#sigillo-doc-file", crlfPath);
      await verify(page, CRLF_SHA256);
      expect(await shownFingerprint(page)).toBe(CRLF_SHA256);
      expect(await page.locator("body").textContent()).toContain("esattamente quello usato");
    }
    expect(problems).toEqual([]);
    await page.context().close();
  });

  it("reads pasted text with LF line endings, so it cannot match the CRLF file", async () => {
    const { page, problems } = await signedInPage();
    await page.goto(`${base}/ui/verify-document`);
    await paste(page, readFileSync(crlfPath, "utf8"));
    await verify(page, LF_SHA256);

    expect(await shownFingerprint(page)).toBe(LF_SHA256);
    expect(await page.locator("body").textContent()).toContain("Nessuna azione registrata ha usato questo documento.");
    expect(problems).toEqual([]);
    await page.context().close();
  });

  it("says whether the fingerprint was computed on the chosen file or on the pasted text", async () => {
    const { page } = await signedInPage();
    await page.goto(`${base}/ui/verify-document`);
    await page.setInputFiles("#sigillo-doc-file", lfPath);
    await verify(page, LF_SHA256);
    expect(await page.locator("body").textContent()).toContain(UI.verifyDocument.fromFile);

    await page.fill("#sigillo-doc-text", "testo");
    await verify(page, sha256Hex(new TextEncoder().encode("testo")));
    expect(await page.locator("body").textContent()).toContain(UI.verifyDocument.fromText);
    await page.context().close();
  });

  /**
   * The pilot's screen: the address and the result of an earlier attempt
   * (text pasted, LF fingerprint, no match) while the file input shows the
   * newly chosen CRLF file. It is what the page looks like whenever pressing
   * Verifica does not end in a navigation: here the file changed on disk after
   * it was chosen, so the browser refuses to read it (NotReadableError).
   */
  it("does not leave an earlier attempt's result on screen when the chosen file cannot be read", async () => {
    const { page, problems } = await signedInPage();
    await page.goto(`${base}/ui/verify-document`);
    await paste(page, readFileSync(crlfPath, "utf8"));
    await verify(page, LF_SHA256);

    const chosen = join(directory, "candidato-07-scelto.txt");
    copyFileSync(crlfPath, chosen);
    await page.setInputFiles("#sigillo-doc-file", chosen);
    const later = new Date(Date.now() + 60_000);
    utimesSync(chosen, later, later);
    await page.click("#sigillo-doc-button");

    await page.getByRole("alert").waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator("span.hash").count()).toBe(0);
    expect(new URL(page.url()).searchParams.get("sha256")).toBeNull();
    expect(await page.getByRole("alert").textContent()).toContain("NotReadableError");
    expect(problems).toEqual([]);
    await page.context().close();
  });

  it("says so, and keeps Verifica disabled, when the browser does not run the script", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // A policy whose hash no longer matches the script: what a browser gets
    // when the script changed and Caddy still serves the previous Caddyfile.
    await page.route(`${base}/ui/verify-document**`, async (route) => {
      const response = await route.fetch();
      const stale = policy.replace(/'sha256-[^']+'/, `'sha256-${"A".repeat(43)}='`);
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": stale } });
    });
    await page.goto(`${base}/ui/login`);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL(`${base}/ui`), page.click('button[type="submit"]')]);
    await page.goto(`${base}/ui/verify-document?sha256=${LF_SHA256}`);

    expect(await page.locator("#sigillo-doc-button").isDisabled()).toBe(true);
    expect(await page.getByText(UI.verifyDocument.scriptInactive).isVisible()).toBe(true);
    await context.close();
  });
});
