/**
 * Generates docs/screenshots/: the real web view, with demo data, driven by
 * a real Chromium through playwright-core — the same tool and the same
 * browser-discovery convention as
 * apps/server/test/verify-document-browser.test.ts (CLAUDE.md, "Approved
 * dependencies", Node dev). Not part of any package's own dependencies and
 * not run by any test, on the project owner's instruction of 2026-09-26
 * (PROGRESS.md, session 8).
 *
 * It reuses the test helpers that build a real signer and a real local RFC
 * 3161 authority (apps/server/test/helpers/*) so the data behind the
 * screenshots is exactly what the tests already exercise, not a stand-in.
 *
 * PNG output is post-processed with `pngquant`, if it is on PATH, purely to
 * keep the repository small: screenshots of flat UI colours and text lose
 * nothing visible to it. Without pngquant the script still runs; it prints a
 * note and leaves the PNGs as Playwright wrote them.
 *
 * Run with: pnpm tsx scripts/screenshots.ts [output directory]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, devices } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "apps", "server");
const serverModule = (relative: string): string => pathToFileURL(join(SERVER, relative)).href;

const { ReceiptStore } = await import(serverModule("src/storage/store.ts"));
const { ApiKeyStore } = await import(serverModule("src/auth/api-keys.ts"));
const { Checkpointer } = await import(serverModule("src/checkpoint/checkpointer.ts"));
const { ChainHealthMonitor } = await import(serverModule("src/health/chain-health.ts"));
const { buildServer } = await import(serverModule("src/http/server.ts"));
const { createTestSigner } = await import(serverModule("test/helpers/signer.ts"));
const { createLocalTsa } = await import(serverModule("test/helpers/local-tsa.ts"));

/** Same discovery as verify-document-browser.test.ts: no browser is ever downloaded here. */
function findBrowser(): string | undefined {
  const candidates: (string | undefined)[] = [process.env["SIGILLO_TEST_BROWSER"]];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // no Playwright download on this machine
  }
  const downloads = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (downloads !== undefined && existsSync(downloads)) {
    for (const entry of readdirSync(downloads).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(
        join(downloads, entry, "chrome-linux64", "chrome"),
        join(downloads, entry, "chrome-linux", "chrome"),
      );
    }
  }
  candidates.push(
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
  );
  return candidates.find((path) => path !== undefined && path !== "" && existsSync(path));
}

const browserPath = findBrowser();
if (browserPath === undefined) {
  throw new Error("no Chromium or Chrome found: set SIGILLO_TEST_BROWSER");
}

/** Whether pngquant is on PATH, checked once. */
function hasPngquant(): boolean {
  try {
    execFileSync("pngquant", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const canCompress = hasPngquant();
if (!canCompress) {
  process.stdout.write("pngquant not found: screenshots will be written uncompressed\n");
}

/** Shrinks a PNG in place with pngquant, if it is available. A no-op otherwise. */
function compress(path: string): void {
  if (!canCompress) return;
  execFileSync("pngquant", ["--quality=65-90", "--speed", "1", "--strip", "--force", "--output", path, path]);
}

const outputDirectory = process.argv[2] ?? join(ROOT, "docs", "screenshots");
mkdirSync(outputDirectory, { recursive: true });

const directory = mkdtempSync(join(tmpdir(), "sigillo-shots-"));
const databasePath = join(directory, "sigillo.db");
const signer = createTestSigner();
const store = ReceiptStore.open(databasePath, signer);
const keys = ApiKeyStore.open(databasePath);
const tsa = createLocalTsa();
const tsaUrl = await tsa.listen();

// A plausible week of activity, so the pages look like a real registry
// rather than an empty demo.
const base = Date.now() - 6 * 3600_000;
const at = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();
const admin = { actor: "web 192.0.2.10", ts: at(10) };

function event(systemId: string, minutes: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    system_id: systemId,
    ts_event: at(minutes),
    ts_received: at(minutes),
    actor: { agent: "support-agent" },
    action: { kind: "tool_call", name: "x" },
    input_hash: "a".repeat(64),
    output_hash: "b".repeat(64),
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

await store.createSystem("acme-support-bot", at(0));
await store.renameSystem("acme-support-bot", "Assistente clienti", admin);
await store.append(
  event("acme-support-bot", 20, {
    actor: { agent: "support-agent", on_behalf_of: "cliente-4821" },
    action: { kind: "tool_call", name: "cerca_ordine" },
  }),
);
await store.append(
  event("acme-support-bot", 21, {
    action: { kind: "llm_call", name: "chat" },
    model: { name: "llama3.1:8b", provider: "ollama", digest: null },
  }),
);
await store.append(
  event("acme-support-bot", 23, { action: { kind: "tool_call", name: "rimborsa_pagamento" }, outcome: "blocked" }),
);
await store.append(event("acme-support-bot", 24, { action: { kind: "decision", name: "escalation_operatore" } }));

await store.createSystem("selezione-cv", at(30));
await store.renameSystem("selezione-cv", "Selezione CV — backend junior", admin);
for (let index = 1; index <= 3; index += 1) {
  await store.append(
    event("selezione-cv", 30 + index * 3, {
      actor: { agent: "screener" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      artifacts: [
        { role: "input", label: `candidato-0${index}.txt`, media_type: "text/plain", sha256: String(index).repeat(64) },
      ],
    }),
  );
}
await store.append(
  event("selezione-cv", 45, { actor: { agent: "screener" }, action: { kind: "decision", name: "shortlist" } }),
);

await store.createSystem("vecchio-bot-2025", at(1));
await store.append(event("vecchio-bot-2025", 2, { action: { kind: "agent_step", name: "saluto" } }));
await store.archiveSystem("vecchio-bot-2025", { ...admin, ts: at(5) });

const checkpointer = new Checkpointer({ store, now: () => new Date(at(50)), tsa: { url: tsaUrl } });
await checkpointer.runOnce();

await store.createSystem("prova-per-errore", at(55));

await store.append(
  event("selezione-cv", 300, { actor: { agent: "screener" }, action: { kind: "tool_call", name: "invia_email" }, outcome: "error" }),
);
await checkpointer.runOnce();

await store.createSystem("prova-per-errore-2", at(56));
await store.deleteEmptySystem("prova-per-errore-2", { ...admin, ts: at(57) });

const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
healthMonitor.check();

const app = buildServer({
  store,
  keys,
  ui: {
    password: "password-di-prova",
    signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
    healthMonitor,
    checkpointer,
  },
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });

const browser = await chromium.launch({ executablePath: browserPath });

async function signedInPage(
  contextOptions: Parameters<typeof browser.newContext>[0],
): Promise<{ context: Awaited<ReturnType<typeof browser.newContext>>; page: Awaited<ReturnType<typeof browser.newPage>> }> {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(`${address}/ui/login`);
  await page.fill('input[name="password"]', "password-di-prova");
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  return { context, page };
}

type Action = (page: Awaited<ReturnType<typeof browser.newPage>>) => Promise<void>;
const pages: [name: string, url: string, action?: Action][] = [
  ["01-registro", "/ui"],
  ["02-cronologia", "/ui/systems/selezione-cv"],
  [
    "03-cronologia-dettagli-tecnici",
    "/ui/systems/acme-support-bot",
    async (page) => {
      await page.locator("details summary").nth(1).click();
    },
  ],
  ["04-sistemi", "/ui/sistemi"],
  ["05-sistemi-archiviati", "/ui/sistemi?vista=archiviati"],
  ["06-gestisci-sistema-con-azioni", "/ui/systems/acme-support-bot/manage"],
  ["07-gestisci-sistema-vuoto", "/ui/systems/prova-per-errore/manage"],
  ["08-checkpoint", "/ui/systems/selezione-cv/checkpoints"],
  ["09-verifica-documento", `/ui/verify-document?sha256=${"2".repeat(64)}&from=file`],
];

// Full-page screenshots at 2x would quadruple the pixels of every phone
// shot for no reason a reader of the documentation needs; 1x is plenty
// crisp on screen and keeps the repository small.
const variants: [name: string, options: Parameters<typeof browser.newContext>[0], dark: boolean][] = [
  ["desktop", { viewport: { width: 1280, height: 900 }, colorScheme: "light" }, true],
  ["telefono", { ...devices["iPhone 13"], deviceScaleFactor: 1, colorScheme: "light" }, true],
];

// Dark variants only for the pages that matter most: enough to show the
// theme works everywhere, without doubling every screenshot.
const DARK_PAGES = new Set(["01-registro", "04-sistemi", "07-gestisci-sistema-vuoto"]);

let written = 0;
for (const [variantName, contextOptions, includeDark] of variants) {
  for (const scheme of ["light", "dark"] as const) {
    if (scheme === "dark" && !includeDark) continue;
    const { context, page } = await signedInPage({ ...contextOptions, colorScheme: scheme });
    for (const [name, url, action] of pages) {
      if (scheme === "dark" && !DARK_PAGES.has(name)) continue;
      await page.goto(`${address}${url}`);
      if (action) await action(page);
      const fileName = `${name}-${variantName}${scheme === "dark" ? "-scuro" : ""}.png`;
      const path = join(outputDirectory, fileName);
      await page.screenshot({ path, fullPage: true });
      compress(path);
      written += 1;
    }
    await context.close();
  }
}

// The login page, desktop only: it is the same page at every size and theme,
// and it carries no data worth repeating.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${address}/ui/login`);
  const path = join(outputDirectory, "00-accesso-desktop.png");
  await page.screenshot({ path });
  compress(path);
  written += 1;
  await page.close();
}

await browser.close();
await app.close();
tsa.close();
store.close();
keys.close();

const totalBytes = readdirSync(outputDirectory)
  .filter((name) => name.endsWith(".png"))
  .reduce((sum, name) => sum + statSync(join(outputDirectory, name)).size, 0);
process.stdout.write(
  `wrote ${written} screenshots to ${outputDirectory} (${(totalBytes / 1024 / 1024).toFixed(2)} MB total)${
    canCompress ? "" : " — install pngquant for a much smaller result"
  }\n`,
);
