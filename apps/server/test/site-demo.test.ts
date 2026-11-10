import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, parseReceipt, publicKeyFromRaw, receiptHashHex, verifyReceiptSignature } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { FirebaseAuth } from "../src/auth/firebase.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { DEMO_SCRIPT, DEMO_SCRIPT_URL } from "../src/http/site-demo.js";
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
      expect(page).toMatch(/<script src="\/demo\.js\?v=[0-9a-f]{12}" defer><\/script>/);
      expect(page.match(/class="dm-row"/g)?.length).toBe(6);
      const data = page.slice(page.indexOf('id="dm-data">'), page.indexOf("</script>", page.indexOf('id="dm-data">')));
      expect(data).not.toContain("<");
    }
    expect(en).toContain("Try to rewrite an AI agent&#39;s record");
    expect(en).not.toContain("rimborsa_pagamento");
    expect(it_).toContain("Prova a riscrivere il registro di un agente AI");
    // It sits right under the opening, before the rest of the page.
    expect(en.indexOf('id="demo"')).toBeLessThan(en.indexOf('id="problema"'));

    const script = await app.inject({ method: "GET", url: "/demo.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toBe(DEMO_SCRIPT);
    // The address changes with the script, so a browser that kept an older copy fetches the new one.
    expect(DEMO_SCRIPT_URL).toMatch(/^\/demo\.js\?v=[0-9a-f]{12}$/);
  });

  it.skipIf(BROWSER_PATH === undefined)("runs in a browser under the site's policy: real receipts, and Verify finds a rewritten one", async () => {
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
      // The page's own requests: the YouTube player embedded further down the
      // home loads its thumbnail and pings in its own frame, at its own pace,
      // and is not the demo.
      page.on("request", (request) => {
        if (request.frame() === page.mainFrame()) loaded.add(request.url());
      });

      // The page's SHA-256 is the real one.
      const sample = "sigillo «demo» ✓ " + "x".repeat(200);
      expect(await page.evaluate(`window.sigilloDemoSha256(${JSON.stringify(sample)})`)).toBe(
        createHash("sha256").update(sample, "utf8").digest("hex"),
      );

      await page.locator("#demo .dm-grid").scrollIntoViewIfNeeded();
      // The first agent starts by itself once the demo is in view.
      const verify = page.locator("#dm-verify");
      await expect.poll(() => verify.isEnabled()).toBe(true);
      expect(await page.locator("#dm-k").textContent()).toBe("Step 2 of 3");
      expect(await page.locator("button.dm-row").count()).toBe(6);

      // The receipts are sigillo's own: they parse as version 4, their hash is core's, their signature verifies under the key the page made.
      const made = (await page.evaluate(`(async () => {
        const s = window.sigilloDemo.state();
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw", s.key.pub));
        return { receipts: s.rows.map((x) => x.r), hashes: s.rows.map((x) => x.hash), key: Array.from(raw) };
      })()`)) as { receipts: unknown[]; hashes: string[]; key: number[] };
      const publicKey = publicKeyFromRaw(new Uint8Array(made.key));
      expect(made.receipts).toHaveLength(6);
      made.receipts.forEach((raw, index) => {
        const receipt = parseReceipt(raw);
        expect(receipt.v).toBe(4);
        expect(receipt.seq).toBe(index);
        expect(receiptHashHex(receipt)).toBe(made.hashes[index]);
        expect(verifyReceiptSignature(receipt, publicKey)).toBe(true);
        expect(receipt.prev_hash).toBe(index === 0 ? GENESIS_PREV_HASH : made.hashes[index - 1]);
      });

      // Step 3: open the decision (receipt 4) and rewrite it the way someone with database access could.
      await page.locator('button.dm-row[data-seq="4"]').click();
      await page.locator("#dm-edit-open").click();
      await page.locator("#dm-edit-name").fill("approve_everything");
      await page.locator('#dm-edit button[type="submit"]').click();
      await expect.poll(() => page.locator("#dm-badge").textContent()).toBe("Edited, not checked");
      expect(await page.locator("#dm-k").textContent()).toBe("Step 3 of 3");
      // Step 4: Verify.
      await verify.click();
      await expect.poll(() => page.locator("#dm-badge").textContent()).toBe("Tampered");
      expect(await page.locator("#dm-gbody").textContent()).toContain("Receipt no. 4 was changed after it was sealed.");
      expect(await page.locator("#dm-gbody").textContent()).toContain("receipt no. 5 no longer matches");
      expect(await page.locator("button.dm-row .dm-sl", { hasText: "Verified" }).count()).toBe(4);
      expect(await page.locator("button.dm-row.is-bad").count()).toBe(1);
      expect(await page.locator("button.dm-row.is-broken").count()).toBe(1);
      // The rewritten receipt, hashed by core, is not the sealed hash, and its signature no longer holds.
      const edited = (await page.evaluate(`window.sigilloDemo.state().rows[4].r`)) as unknown;
      const rewritten = parseReceipt(edited);
      expect(receiptHashHex(rewritten)).not.toBe(made.hashes[4]);
      expect(verifyReceiptSignature(rewritten, publicKey)).toBe(false);

      // Reset starts the agent again, and an untouched run verifies.
      await page.locator("#dm-reset").click();
      expect(await page.locator("#dm-badge").textContent()).toBe("Recording");
      await expect.poll(() => verify.isEnabled()).toBe(true);
      // Another sample agent can be chosen.
      await page.locator('.dm-chip[data-sc="invoice"]').click();
      await expect.poll(() => verify.isEnabled()).toBe(true);
      await verify.click();
      await expect.poll(() => page.locator("#dm-gbody").textContent()).toContain("All 6 receipts check out.");

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

  it.skipIf(BROWSER_PATH === undefined)("on a phone, a receipt can be tapped once the agent has run", async () => {
    const live = make("sigillo-phone.db");
    await live.listen({ host: "127.0.0.1", port: 0 });
    const address = live.server.address();
    const base = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}`;
    const browser = await chromium.launch({ ...(BROWSER_PATH === undefined ? {} : { executablePath: BROWSER_PATH }), args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
        extraHTTPHeaders: { "accept-language": "en" },
      });
      await page.goto(`${base}/`);
      await page.locator("#demo .dm-grid").scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator("#dm-verify").isEnabled()).toBe(true);
      // The page itself does not scroll sideways.
      expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
      const card = page.locator('button.dm-row[data-seq="3"]');
      await card.scrollIntoViewIfNeeded();
      await card.tap();
      await expect.poll(() => page.locator(".dm-title").first().textContent()).toContain("refund_payment");
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
