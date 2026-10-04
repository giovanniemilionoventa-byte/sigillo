import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createZip, readZip } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { FirebaseAuth } from "../src/auth/firebase.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { buildArchive } from "../src/export/archive.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { byteRange, SITE_PATHS, SITE_SCRIPT, subripToWebVtt, VERIFY_SCRIPT } from "../src/http/site.js";
import { SITE_TEXTS } from "../src/http/site-strings.js";
import { ReceiptStore } from "../src/storage/store.js";
import { BROWSER_PATH, caddyfilePolicy } from "./helpers/browser.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * The public site at the root (site.ts): served where customers sign in, in
 * the reader's language, with the demo video in that language; and, without
 * customers' accounts, / still goes straight to the console.
 */

const NOW = "2026-10-04T10:00:00.000Z";
const PUBLIC_URL = "https://sigillo.example.com";
const REPOSITORY_ROOT = new URL("../../..", import.meta.url).pathname;

function server(directory: string, withAccounts: boolean): FastifyInstance {
  const databasePath = join(directory, `sigillo-${withAccounts ? "a" : "b"}.db`);
  const signer = createTestSigner();
  const store = ReceiptStore.open(databasePath, signer);
  const keys = ApiKeyStore.open(databasePath);
  const app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000),
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      ...(withAccounts
        ? {
            accounts: {
              firebase: new FirebaseAuth({ apiKey: "AIzaSyTest", projectId: "sigillo-test" }, () => new Date(NOW), () => {
                throw new Error("the site never calls Firebase");
              }),
              publicUrl: `${PUBLIC_URL}/`,
            },
          }
        : {}),
    },
  });
  app.addHook("onClose", async () => {
    keys.close();
    store.close();
  });
  return app;
}

let directory: string;
let app: FastifyInstance;
let operatorOnly: FastifyInstance;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-site-"));
  app = server(directory, true);
  operatorOnly = server(directory, false);
  await app.ready();
  await operatorOnly.ready();
});

afterAll(async () => {
  await app.close();
  await operatorOnly.close();
  rmSync(directory, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

describe("the public site", () => {
  it("is what / shows where customers sign in, and every page links to the console's sign-in", async () => {
    for (const path of SITE_PATHS) {
      const response = await get(path);
      expect(response.statusCode, path).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.body).toContain('href="/ui/login"');
      expect(response.body).toContain('href="/privacy"');
    }
  });

  it("shows the console's own dashboard on /, with sample data and a Sign in button, and the presentation on /about", async () => {
    const english = (await get("/")).body;
    expect(english).toContain('<div class="app">');
    expect(english).toContain(">Sign in</a>");
    expect(english).toContain(SITE_TEXTS.en.demo.note);
    expect(english).not.toContain('href="/ui"');
    expect(english).not.toContain("<video");
    const italian = (await get("/", { cookie: "sigillo_lang=it" })).body;
    expect(italian).toContain(">Accedi</a>");
    expect(italian).toContain("Assistente clienti");
    expect((await get("/about")).body).toContain("<video");
  });

  it("leaves / to the console where only the operator signs in", async () => {
    const response = await operatorOnly.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/ui");
    expect((await operatorOnly.inject({ method: "GET", url: "/pricing" })).statusCode).toBe(404);
  });

  it("speaks English by default, Italian to a browser that asks for it, and the language chosen in the cookie above both", async () => {
    expect((await get("/about")).body).toContain(SITE_TEXTS.en.home.heading);
    expect((await get("/about", { "accept-language": "it-IT,it;q=0.9,en;q=0.8" })).body).toContain(escapeHtml(SITE_TEXTS.it.home.heading));
    const chosen = await get("/about", { "accept-language": "it-IT", cookie: "sigillo_lang=en" });
    expect(chosen.body).toContain(SITE_TEXTS.en.home.heading);
    expect(chosen.body).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(chosen.headers["vary"]).toBe("Cookie, Accept-Language");
  });

  it("switches language through the console's own switch, and comes back to the same page of the site", async () => {
    const page = (await get("/pricing")).body;
    expect(page).toContain('<form class="sh-lang" method="post" action="/ui/lingua"><input type="hidden" name="lang" value="it"><input type="hidden" name="back" value="/pricing">');
    const response = await app.inject({
      method: "POST",
      url: "/ui/lingua",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "lang=it&back=%2Fpricing",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pricing");
    expect(String(response.headers["set-cookie"])).toMatch(/^sigillo_lang=it; /);
    // Anywhere else is still refused.
    for (const back of ["//evil.example", "https://evil.example/", "/pricing/../x", "/media/demo-en.mp4"]) {
      const refused = await app.inject({
        method: "POST",
        url: "/ui/lingua",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ lang: "en", back }).toString(),
      });
      expect(refused.headers.location, back).toBe("/ui");
    }
  });

  it("carries the theme the reader chose in the console", async () => {
    expect((await get("/", { cookie: "sigillo_theme=dark" })).body).toMatch(/^<!doctype html>\n<html lang="en" data-theme="dark">/);
    expect((await get("/")).body).toMatch(/^<!doctype html>\n<html lang="en">/);
  });

  it("shows the demo video in the reader's language, with its subtitles and its still", async () => {
    const english = (await get("/about")).body;
    expect(english).toContain('<video controls preload="none" poster="/media/poster-en.jpg"');
    expect(english).toContain('<source src="/media/demo-en.mp4" type="video/mp4">');
    expect(english).toContain('<track kind="subtitles" src="/media/demo-en.vtt" srclang="en"');
    const italian = (await get("/about", { cookie: "sigillo_lang=it" })).body;
    expect(italian).toContain('<source src="/media/demo-it.mp4" type="video/mp4">');
  });

  it("says where each command goes, one command per box, with the server's own address", async () => {
    const page = (await get("/connect")).body;
    const t = SITE_TEXTS.en.connect;
    expect(page).toContain(escapeHtml(t.installWhere));
    expect(page).toContain(escapeHtml(t.inCodeWhere));
    const boxes = [...page.matchAll(/<div class="code"><pre>([^]*?)<\/pre>/g)].map((match) => match[1] ?? "");
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toBe(
      "pip install &quot;sigillo[langchain] @ git+https://github.com/giovanniemilionoventa-byte/sigillo#subdirectory=sdk-python&quot;",
    );
    expect(boxes[1]).toContain(`endpoint=<span class="s">"${PUBLIC_URL}"</span>`);
    expect(boxes[3]).toContain(`curl -X POST ${PUBLIC_URL}/api/v1/receipts`);
    // The copy buttons stay hidden until the script shows them.
    expect(page.match(/<button type="button" class="copy" data-copied="Copied" hidden>Copy<\/button>/g)).toHaveLength(4);
  });

  it("asks for nothing from another origin", async () => {
    for (const path of SITE_PATHS) {
      const body = (await get(path)).body;
      for (const match of body.matchAll(/(?:src|href|poster|action)="([^"]*)"/g)) {
        const url = match[1] ?? "";
        // The repository is a link the reader follows, never a resource the page loads.
        if (url.startsWith("https://github.com/giovanniemilionoventa-byte/sigillo") || url.startsWith("mailto:")) continue;
        expect(url, `${path}: ${url}`).toMatch(/^(\/|#)/);
      }
    }
  });
});

describe("the site's media", () => {
  it("serves the still, and the subtitles as WebVTT", async () => {
    const still = await get("/media/poster-en.jpg");
    expect(still.statusCode).toBe(200);
    expect(still.headers["content-type"]).toBe("image/jpeg");
    expect(still.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const subtitles = await get("/media/demo-it.vtt");
    expect(subtitles.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(subtitles.body).toMatch(/^WEBVTT\n\n1\n00:00:00\.500 --> 00:00:05\.023\n/);
  });

  it("serves a video whole, or the one byte range a player asks for", async () => {
    const whole = readFileSync(join(REPOSITORY_ROOT, "video", "consegna", "en", "sigillo-demo-en.mp4"));
    const full = await get("/media/demo-en.mp4");
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(Number(full.headers["content-length"])).toBe(whole.length);
    const part = await get("/media/demo-en.mp4", { range: "bytes=100-199" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${whole.length}`);
    expect(part.rawPayload).toEqual(whole.subarray(100, 200));
    const past = await get("/media/demo-en.mp4", { range: `bytes=${whole.length}-` });
    expect(past.statusCode).toBe(416);
  });

  it("gives every browser the seal as its tab icon, with or without the site", async () => {
    for (const server of [app, operatorOnly]) {
      const icon = await server.inject({ method: "GET", url: "/favicon.ico" });
      expect(icon.statusCode).toBe(200);
      expect(icon.headers["content-type"]).toBe("image/svg+xml");
      expect(icon.body).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    }
  });

  it("serves only the files it names", async () => {
    for (const name of ["..%2Fpackage.json", "demo-en.srt", "x.mp4", "poster-fr.jpg"]) {
      expect((await get(`/media/${name}`)).statusCode, name).toBe(404);
    }
  });

  it("reads byte ranges as RFC 9110 writes them", () => {
    expect(byteRange(undefined, 1000)).toBeNull();
    expect(byteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=10-19", 1000)).toEqual({ start: 10, end: 19 });
    expect(byteRange("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
    expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=20-10", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(byteRange("items=0-1", 1000)).toBeNull();
  });

  it("turns SubRip into WebVTT", () => {
    expect(subripToWebVtt("﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello, world\r\n")).toBe(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello, world\n",
    );
  });
});

describe("the site in a browser, under deploy/Caddyfile's policy", () => {
  it.skipIf(BROWSER_PATH === undefined)("loads with nothing blocked, and its Copy buttons copy the command", async () => {
    const policy = caddyfilePolicy();
    const live = server(directory, true);
    live.addHook("onSend", async (_request, reply) => {
      void reply.header("content-security-policy", policy);
    });
    await live.listen({ host: "127.0.0.1", port: 0 });
    const address = live.server.address();
    const base = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}`;
    const browser = await chromium.launch({ ...(BROWSER_PATH === undefined ? {} : { executablePath: BROWSER_PATH }), args: ["--no-proxy-server"] });
    try {
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      const page = await context.newPage();
      const blocked: string[] = [];
      page.on("console", (message) => {
        if (/Content Security Policy|Refused/.test(message.text())) blocked.push(message.text());
      });
      await page.goto(`${base}/connect`);
      const first = page.locator("button.copy").first();
      await expect.poll(() => first.isVisible()).toBe(true);
      await first.click();
      await expect.poll(() => first.textContent()).toBe("Copied");
      expect(await page.evaluate("navigator.clipboard.readText()")).toBe(
        'pip install "sigillo[langchain] @ git+https://github.com/giovanniemilionoventa-byte/sigillo#subdirectory=sdk-python"',
      );
      await page.goto(`${base}/about`);
      // The browser fetches the video (whether this Chromium has the codec to
      // play it is another matter): a policy without media-src 'self' would
      // refuse the request outright, and say so on the console.
      const reached = page.waitForResponse((response) => response.url().endsWith("/media/demo-en.mp4"), { timeout: 15_000 });
      await page.evaluate('const video = document.querySelector("video"); video.preload = "metadata"; video.load();');
      expect([200, 206]).toContain((await reached).status());
      expect(await page.evaluate('document.querySelector("video").poster')).toBe(`${base}/media/poster-en.jpg`);
      expect(blocked).toEqual([]);
    } finally {
      await browser.close();
      await live.close();
    }
  }, 60_000);

  it.skipIf(BROWSER_PATH === undefined)("checks an evidence pack on the Verify page, without sending it anywhere", async () => {
    const zip = await evidencePack();
    const tampered = new Map(readZip(zip).map((entry) => [entry.name, entry.data]));
    const lines = new TextDecoder().decode(tampered.get("receipts.jsonl")).split("\n");
    lines[1] = (lines[1] ?? "").replace('"outcome":"ok"', '"outcome":"error"');
    tampered.set("receipts.jsonl", new TextEncoder().encode(lines.join("\n")));
    const doctored = createZip([...tampered].map(([name, data]) => ({ name, data })));

    const policy = caddyfilePolicy();
    const live = server(directory, true);
    live.addHook("onSend", async (_request, reply) => {
      void reply.header("content-security-policy", policy);
    });
    await live.listen({ host: "127.0.0.1", port: 0 });
    const address = live.server.address();
    const base = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}`;
    const browser = await chromium.launch({ ...(BROWSER_PATH === undefined ? {} : { executablePath: BROWSER_PATH }), args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ locale: "it-IT", extraHTTPHeaders: { "accept-language": "it-IT" } });
      const problems: string[] = [];
      const sent: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("request", (request) => {
        if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
      });
      await page.goto(`${base}/verify`);
      const result = page.locator("#result");
      const choose = async (name: string, buffer: Uint8Array) =>
        page.locator("#pack").setInputFiles({ name, mimeType: "application/zip", buffer: Buffer.from(buffer) });

      await choose("fascicolo.zip", zip);
      await expect.poll(() => result.locator("h3").textContent()).toBe("Integro");
      expect(await result.textContent()).toContain("3 ricevute di site-bot, firmate e in ordine.");
      expect(await result.locator("dl").textContent()).toContain("Firme3 su 3");

      await choose("fascicolo.zip", doctored);
      await expect.poll(() => result.locator("h3").textContent()).toBe("Alterato");
      expect(await result.textContent()).toContain("Una ricevuta è stata modificata.");
      expect(await result.locator("code").textContent()).toMatch(/^chain-link · receipts\.jsonl:3: /);

      await choose("note.zip", new TextEncoder().encode("not a zip"));
      await expect.poll(() => result.locator("h3").textContent()).toBe("Non è un fascicolo");

      expect(problems).toEqual([]);
      expect(sent).toEqual([]);
    } finally {
      await browser.close();
      await live.close();
    }
  }, 60_000);

  it("keeps its one script to what it says", () => {
    // Neither script sends anything anywhere or writes markup: the evidence
    // pack stays in the reader's browser.
    for (const script of [SITE_SCRIPT, VERIFY_SCRIPT]) {
      expect(script).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|eval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|import\(/);
    }
  });
});

/** A small real evidence pack: three receipts, one checkpoint, as the server exports them. */
async function evidencePack(): Promise<Uint8Array> {
  const signer = createTestSigner();
  const store = ReceiptStore.open(join(directory, "pack.db"), signer);
  try {
    await store.createSystem("site-bot", "2026-10-04T09:00:00.000Z");
    for (const index of [1, 2]) {
      await store.append({
        system_id: "site-bot",
        ts_event: `2026-10-04T09:0${index}:00.000Z`,
        ts_received: `2026-10-04T09:0${index}:00.005Z`,
        actor: { agent: "planner" },
        action: { kind: "tool_call", name: `call-${index}` },
        input_hash: null,
        output_hash: null,
        outcome: "ok",
        source: { type: "sdk" },
      });
    }
    await store.createCheckpoint("site-bot");
    const archive = await buildArchive({
      systemId: "site-bot",
      receipts: store.readChain("site-bot"),
      checkpoints: store.readCheckpoints("site-bot").map((stored) => ({ stored, timestamps: store.readTimestamps(stored.id) })),
      keys: [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }],
      exportedAt: NOW,
    });
    return archive.zip;
  } finally {
    store.close();
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
