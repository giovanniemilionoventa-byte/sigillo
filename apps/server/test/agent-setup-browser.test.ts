import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { BROWSER_PATH, caddyfilePolicy } from "./helpers/browser.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * "Upload your agent" in a real browser, under the policy Caddy sends: the
 * script runs, the file comes back as a download with the sigillo lines and
 * the key in it, and the install command follows the framework the file uses.
 * Nothing about the file reaches the server.
 */

const PASSWORD = "an administrator password";
const SYSTEM = "cv-bot";

describe.skipIf(BROWSER_PATH === undefined)("upload your agent, in a real browser", { timeout: 30_000 }, () => {
  let directory: string;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let app: FastifyInstance;
  let browser: Browser;
  let base: string;
  const requests: string[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-agent-browser-"));
    const signer = createTestSigner();
    const databasePath = join(directory, "sigillo.db");
    store = ReceiptStore.open(databasePath, signer);
    keys = ApiKeyStore.open(databasePath);
    await store.createSystem(SYSTEM, "2026-10-06T18:00:00.000Z");
    const now = (): Date => new Date("2026-10-06T18:00:00.000Z");
    app = buildServer({
      store,
      keys,
      now,
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
        checkpointer: new Checkpointer({ store, now }),
        agentUpload: "operator",
      },
    });
    const policy = caddyfilePolicy();
    app.addHook("onSend", async (_request, reply) => {
      void reply.header("content-security-policy", policy);
    });
    app.addHook("onRequest", async (request) => {
      requests.push(`${request.method} ${request.url}`);
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

  it("gives the agent's file back with sigillo in it, and the matching install command", async () => {
    const context = await browser.newContext({ locale: "en-GB", acceptDownloads: true });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`${error.name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    await page.goto(`${base}/ui/login`);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL(`${base}/ui`), page.click('button[type="submit"]')]);

    await page.goto(`${base}/ui/systems/${SYSTEM}/manage#nuova-chiave`);
    await Promise.all([page.waitForURL(`${base}/ui/systems/${SYSTEM}/key`), page.click('form[action$="/key"] button[type="submit"]')]);
    const key = (await page.textContent("code.keybox"))?.trim() ?? "";
    expect(key).toMatch(/^sigillo_/);
    expect(await page.isVisible("#sigillo-agent-file")).toBe(true);

    const agent = join(directory, "my_agent.py");
    writeFileSync(agent, '"""My agent."""\nfrom crewai import Agent\n\nAgent(role="x")\n');
    requests.length = 0;
    const [download] = await Promise.all([page.waitForEvent("download"), page.setInputFiles("#sigillo-agent-file", agent)]);
    expect(download.suggestedFilename()).toBe("my_agent.py");
    const saved = join(directory, "downloaded.py");
    await download.saveAs(saved);
    const text = readFileSync(saved, "utf8");
    expect(text.startsWith('"""My agent."""\n\nimport sigillo\n\nsigillo.init(\n')).toBe(true);
    expect(text).toContain(`    api_key="${key}",\n`);
    expect(text).toContain(`    system_id="${SYSTEM}",\n`);
    expect(text).toContain('    instrument=["crewai"],\n');
    expect(text.endsWith(')\n\nfrom crewai import Agent\n\nAgent(role="x")\n')).toBe(true);

    expect(await page.isVisible("#sigillo-agent-done")).toBe(true);
    expect(await page.textContent("#sigillo-agent-done")).toContain("my_agent.py");
    expect(await page.textContent(".code.install")).toMatch(/^pip install "sigillo\[crewai\] @ https:\/\/github\.com\//);
    // The file went nowhere: no request at all while it was handled.
    expect(requests).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });
});
