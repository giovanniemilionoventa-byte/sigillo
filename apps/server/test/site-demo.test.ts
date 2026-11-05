import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { FirebaseAuth } from "../src/auth/firebase.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { DEMO_SCRIPT } from "../src/http/site-demo.js";
import { ReceiptStore } from "../src/storage/store.js";
import { BROWSER_PATH, caddyfilePolicy } from "./helpers/browser.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * The live demo on the redesigned home (site-demo.ts): drawn by the server at
 * rest, in the reader's language, and brought to life by /demo.js in a real
 * browser under deploy/Caddyfile's policy, where tampering with a receipt is
 * caught by the page's own SHA-256.
 */

const NOW = "2026-11-04T10:00:00.000Z";

let directory: string;
let app: FastifyInstance;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-demo-"));
  app = make("sigillo.db");
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the live demo on the home", () => {
  it("is drawn at rest in the reader's language, with its script from this origin", async () => {
    const en = (await app.inject({ method: "GET", url: "/", headers: { "accept-language": "en" } })).body;
    const it_ = (await app.inject({ method: "GET", url: "/", headers: { "accept-language": "it" } })).body;
    for (const page of [en, it_]) {
      expect(page).toContain('id="demo"');
      expect(page).toContain('<script src="/demo.js" defer></script>');
      expect(page.match(/class="dm-row"/g)?.length).toBe(6);
      const data = page.slice(page.indexOf('id="dm-data">'), page.indexOf("</script>", page.indexOf('id="dm-data">')));
      expect(data).not.toContain("<");
    }
    expect(en).toContain("Watch an AI agent leave a record it can&#39;t rewrite");
    expect(en).not.toContain("rimborsa_pagamento");
    expect(it_).toContain("Ha provato «rimborsa_pagamento»");
    // It sits right under the opening, before the rest of the page.
    expect(en.indexOf('id="demo"')).toBeLessThan(en.indexOf('id="problema"'));

    const script = await app.inject({ method: "GET", url: "/demo.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toBe(DEMO_SCRIPT);
  });

  it.skipIf(BROWSER_PATH === undefined)("runs in a browser under the site's policy, and Verify finds a rewritten receipt", async () => {
    const policy = caddyfilePolicy();
    const live = make("sigillo-live.db");
    live.addHook("onSend", async (_request, reply) => {
      void reply.header("content-security-policy", policy);
    });
    await live.listen({ host: "127.0.0.1", port: 0 });
    const address = live.server.address();
    const base = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}`;
    const browser = await chromium.launch({ ...(BROWSER_PATH === undefined ? {} : { executablePath: BROWSER_PATH }), args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ reducedMotion: "reduce", extraHTTPHeaders: { "accept-language": "en" } });
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      page.on("pageerror", (error) => problems.push(error.message));
      await page.goto(`${base}/`);
      const loaded = new Set<string>();
      page.on("request", (request) => loaded.add(request.url()));

      // The page's SHA-256 is the real one.
      const sample = "sigillo «demo» ✓ " + "x".repeat(200);
      expect(await page.evaluate(`window.sigilloDemoSha256(${JSON.stringify(sample)})`)).toBe(
        createHash("sha256").update(sample, "utf8").digest("hex"),
      );

      await page.locator("#demo .dm-window").scrollIntoViewIfNeeded();
      const verify = page.locator("#dm-verify");
      await expect.poll(() => verify.isEnabled()).toBe(true);
      await verify.click();
      await expect.poll(() => page.locator("#dm-badge").textContent()).toBe("Intact");
      expect(await page.locator(".dm-verdict").textContent()).toContain("All 6 receipts check out.");

      await page.locator('.dm-row[data-seq="4"]').click();
      await page.locator("#dm-edit-open").click();
      await page.locator("#dm-edit-outcome").selectOption("done");
      await page.locator("#dm-edit button[type=submit]").click();
      await expect.poll(() => page.locator("#dm-badge").textContent()).toBe("Not checked since a change");
      await verify.click();
      await expect.poll(() => page.locator("#dm-badge").textContent()).toBe("Tampered");
      expect(await page.locator(".dm-verdict").textContent()).toContain("Receipt #4 was changed after it was sealed.");
      expect(await page.locator(".dm-seal.ok").count()).toBe(3);
      expect(await page.locator(".dm-seal.broken").count()).toBe(2);

      // Another agent, from the window's own menu (the one a phone shows).
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.locator(".dm-side").isVisible()).toBe(false);
      await page.locator("#dm-pick").selectOption("invoice");
      await expect.poll(() => page.locator("#dm-name").textContent()).toBe("Invoice approvals");
      await expect.poll(() => page.locator(".dm-row").count()).toBe(6);
      expect(await page.locator(".dm-step.now").textContent()).toContain("Open a receipt");

      // The site's backdrop grain (site-v2.ts, #backdrop::after) is a data: image
      // that img-src 'self' refuses; it is not the demo's, and it is followed up
      // on its own. Every other error counts.
      expect(problems.filter((p) => !p.includes("data:image/svg+xml"))).toEqual([]);
      // Nothing the visitor does in the demo reaches the network.
      expect([...loaded]).toEqual([]);
    } finally {
      await browser.close();
      await live.close();
    }
  }, 60_000);
});

/** A server with the redesigned site, as production runs it (SIGILLO_SITE_V2=all, with accounts). */
function make(file: string): FastifyInstance {
  const databasePath = join(directory, file);
  const signer = createTestSigner();
  const store = ReceiptStore.open(databasePath, signer);
  const keys = ApiKeyStore.open(databasePath);
  const live = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000),
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      consoleV2: "operator" as const,
      features: { siteV2: "all" } as never,
      accounts: {
        firebase: new FirebaseAuth({ apiKey: "AIzaSyTest", projectId: "sigillo-test" }, () => new Date(NOW), () => {
          throw new Error("the site never calls Firebase");
        }),
        publicUrl: "https://sigillo.example.com/",
      },
    },
  });
  live.addHook("onClose", async () => {
    keys.close();
    store.close();
  });
  return live;
}
