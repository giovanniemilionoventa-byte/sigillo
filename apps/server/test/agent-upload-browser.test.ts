import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { BROWSER_PATH, caddyfilePolicy } from "./helpers/browser.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * "Upload your agent" with the model gateway, in a real browser under the
 * production Content-Security-Policy: the file is read first, what it uses is
 * said, the option for more security is offered only for a cloud model, and
 * the download comes after the choice.
 */

const NOW = "2026-10-09T12:00:00.000Z";
const SYSTEM = "operator-bot";
const OPENAI_KEY = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2";

describe.skipIf(BROWSER_PATH === undefined)("upload your agent, with the model gateway, in a real browser", { timeout: 30_000 }, () => {
  let directory: string;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let providerKeys: ProviderKeyStore;
  let app: FastifyInstance;
  let browser: Browser;
  let base: string;
  let sessions: UiSessions;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-upload-browser-"));
    const signer = createTestSigner();
    const databasePath = join(directory, "sigillo.db");
    store = ReceiptStore.open(databasePath, signer);
    keys = ApiKeyStore.open(databasePath);
    providerKeys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")));
    await store.createSystem(SYSTEM, NOW);
    sessions = new UiSessions();
    const now = (): Date => new Date(NOW);
    app = buildServer({
      store,
      keys,
      now,
      gateway: { keys: providerKeys, access: "all" },
      ui: {
        password: "an administrator password",
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
        checkpointer: new Checkpointer({ store, now }),
        sessions,
        agentUpload: "operator",
        agentProtection: "operator",
      },
    });
    const policy = caddyfilePolicy();
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
    providerKeys?.close();
    keys?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** The page that shows a new key, as a signed-in browser reaches it: by the form that makes one. */
  async function keyPage(): Promise<{ page: Page; problems: string[] }> {
    const context = await browser.newContext({ locale: "en-US", acceptDownloads: true });
    await context.addCookies([{ name: "sigillo_session", value: sessions.issue(OPERATOR, Date.parse(NOW)).value, url: base }]);
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`${error.name}: ${error.message}`));
    await page.goto(`${base}/ui`);
    await Promise.all([
      page.waitForURL(/\/key$/),
      page.evaluate(
        `(() => { const f = document.createElement("form"); f.method = "post"; f.action = "/ui/systems/${SYSTEM}/key"; document.body.appendChild(f); f.submit(); })()`,
      ),
    ]);
    return { page, problems };
  }

  const upload = (page: Page, name: string, text: string) =>
    page.setInputFiles("#sigillo-agent-file", { name, mimeType: "text/x-python", buffer: Buffer.from(text) });

  async function downloaded(page: Page): Promise<string> {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sigillo-agent-download")]);
    return readFileSync(await download.path(), "utf8");
  }

  it("reads the file first, says it calls a cloud model, and downloads only after the choice: unticked, the file keeps its key", async () => {
    const { page, problems } = await keyPage();
    await upload(page, "agent.py", `from openai import OpenAI\nclient = OpenAI(api_key="${OPENAI_KEY}")\n`);
    await page.locator("#sigillo-agent-choice").waitFor({ state: "visible" });
    expect(await page.locator("#sigillo-agent-analysis").textContent()).toContain("openai");
    expect(await page.locator("#sigillo-agent-secure-label").isVisible()).toBe(true);
    expect(await page.locator("#sigillo-agent-secure").isChecked()).toBe(false);
    expect(await page.locator("#sigillo-agent-done").isVisible()).toBe(false);
    const file = await downloaded(page);
    expect(file).toContain(OPENAI_KEY);
    expect(file).not.toContain("_BASE_URL");
    expect(await page.locator("#sigillo-agent-model").isVisible()).toBe(false);
    expect(problems).toEqual([]);
  });

  it("ticked: the file loses the model key and goes through sigillo, and the key is saved sealed from the form the page shows", async () => {
    const { page, problems } = await keyPage();
    await upload(page, "agent.py", `from openai import OpenAI\nclient = OpenAI(api_key="${OPENAI_KEY}")\n`);
    await page.locator("#sigillo-agent-choice").waitFor({ state: "visible" });
    await page.check("#sigillo-agent-secure");
    const file = await downloaded(page);
    expect(file).not.toContain(OPENAI_KEY);
    expect(file).toContain("OPENAI_BASE_URL");
    expect(await page.locator("#sigillo-agent-model").isVisible()).toBe(true);
    expect(await page.locator("#sigillo-agent-model input[name=key]").inputValue()).toBe(OPENAI_KEY);
    await Promise.all([page.waitForURL(/\/manage/), page.click("#sigillo-agent-model button")]);
    expect(providerKeys.get(SYSTEM, "openai")).toBe(OPENAI_KEY);
    expect(problems).toEqual([]);
  });

  it("offers no option to an agent that calls no cloud model", async () => {
    const { page } = await keyPage();
    await upload(page, "agent.py", "import requests\nprint(requests.get('http://localhost:11434').text)\n");
    await page.locator("#sigillo-agent-choice").waitFor({ state: "visible" });
    expect(await page.locator("#sigillo-agent-secure-label").isVisible()).toBe(false);
    const file = await downloaded(page);
    expect(file).not.toContain("_BASE_URL");
  });
});
