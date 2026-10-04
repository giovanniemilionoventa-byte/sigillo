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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, devices } from "playwright-core";
import { documentFingerprints, TEXT_CANON_1 } from "../packages/core/src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "apps", "server");
const serverModule = (relative: string): string => pathToFileURL(join(SERVER, relative)).href;

const { ReceiptStore } = await import(serverModule("src/storage/store.ts"));
const { ApiKeyStore } = await import(serverModule("src/auth/api-keys.ts"));
const { Checkpointer } = await import(serverModule("src/checkpoint/checkpointer.ts"));
const { ChainHealthMonitor } = await import(serverModule("src/health/chain-health.ts"));
const { buildServer } = await import(serverModule("src/http/server.ts"));
const { UiSessions } = await import(serverModule("src/auth/sessions.ts"));
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
// The checkpoints are signed now, as the local authority stamps them: the demo is then sealed in time, and green.
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
// The demo's real CVs, with both fingerprints, as the current SDK records a
// text file: page 09 then looks one of them up for real.
const cv = (index: number): Uint8Array =>
  new Uint8Array(readFileSync(join(ROOT, "demo", "selezione-cv", "curricula", `candidato-0${index}.txt`)));
for (let index = 1; index <= 3; index += 1) {
  const fingerprints = documentFingerprints(cv(index));
  await store.append(
    event("selezione-cv", 30 + index * 3, {
      actor: { agent: "screener" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      artifacts: [
        {
          role: "input",
          label: `candidato-0${index}.txt`,
          media_type: "text/plain",
          sha256: fingerprints.bytes,
          ...(fingerprints.text === null ? {} : { text: { canon: TEXT_CANON_1, sha256: fingerprints.text } }),
        },
      ],
    }),
  );
}
// Candidate 2's CV as someone would paste it from an email: every line break
// and run of spaces turned into one space. The page finds it as the same text.
const pasted = documentFingerprints(
  new TextEncoder().encode(new TextDecoder().decode(cv(2)).replace(/\s+/g, " ").trim()),
);
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

// A customer, approved, with one system just created and nothing sent yet:
// what a newcomer sees. And one waiting for the operator, for "Clienti".
await store.registerOrganization({ uid: "demoRossi0001", email: "anna@rossitrasporti.it" }, "Rossi Trasporti S.r.l.", admin);
const rossi = store.userByUid("demoRossi0001")?.organization_id ?? "";
await store.approveOrganization(rossi, admin);
await store.createSystem("rossi-assistente", at(60), rossi);
await store.renameSystem("rossi-assistente", "Assistente spedizioni", admin);
await store.registerOrganization({ uid: "demoBianchi001", email: "giulia@studiobianchi.it" }, "Studio Bianchi", admin);

const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
healthMonitor.check();

// Accounts on, as in production: the sign-in page is the customers' one, and
// the operator's password is at /ui/admin. Firebase itself is never reached:
// no page below signs in through it.
const sessions = new UiSessions();
// The off-site copy as Impostazioni shows it once it works: on, every 6
// hours, the last copy made an hour ago (deploy/backup-offsite.sh writes this).
const backupDirectory = join(directory, "backups");
mkdirSync(backupDirectory);
writeFileSync(join(backupDirectory, "offsite-settings.json"), '{"enabled":true,"every_hours":6}\n');
const lastCopy = Math.floor(Date.now() / 1000) - 3600;
writeFileSync(
  join(backupDirectory, "offsite-status.json"),
  `{"checked":${lastCopy + 3000},"drive":true,"last_success":${lastCopy},"last_failure":null}\n`,
);
const app = buildServer({
  store,
  keys,
  organizationMonthlyReceipts: 10_000,
  ui: {
    password: "password-di-prova",
    signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
    healthMonitor,
    checkpointer,
    sessions,
    accounts: { firebase: {} as never, publicUrl: "https://get-sigillo.eu" },
    backupDirectory,
  },
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });

const browser = await chromium.launch({ executablePath: browserPath });

async function signedInPage(
  contextOptions: Parameters<typeof browser.newContext>[0],
): Promise<{ context: Awaited<ReturnType<typeof browser.newContext>>; page: Awaited<ReturnType<typeof browser.newPage>> }> {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(`${address}/ui/admin`);
  await page.fill('input[name="password"]', "password-di-prova");
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  return { context, page };
}

/** A customer's member, signed in: the session cookie the sign-in would have set. */
async function customerPage(
  contextOptions: Parameters<typeof browser.newContext>[0],
): Promise<{ context: Awaited<ReturnType<typeof browser.newContext>>; page: Awaited<ReturnType<typeof browser.newPage>> }> {
  const context = await browser.newContext(contextOptions);
  const session = sessions.issue({ kind: "organization", organizationId: rossi, userId: "demoRossi0001" }, Date.now());
  await context.addCookies([{ name: "sigillo_session", value: session.value, url: address }]);
  return { context, page: await context.newPage() };
}

type Page = Awaited<ReturnType<typeof browser.newPage>>;
type Action = (page: Page) => Promise<void>;

// Every page of the view, as design/proposta-semplice/README.md maps the
// mockups to routes. An action reaches a state a plain address cannot: a
// form posted, a disclosure opened.
const pages: [name: string, url: string, action?: Action][] = [
  ["01-registro", "/ui"],
  ["02-cronologia", "/ui/systems/acme-support-bot"],
  ["03-cronologia-strumenti-bloccato", "/ui/systems/acme-support-bot?kind=tool_call&ricevuta=3#r-3"],
  ["04-cronologia-modelli", "/ui/systems/acme-support-bot?kind=llm_call&ricevuta=2#r-2"],
  ["05-cronologia-selezione-cv", "/ui/systems/selezione-cv?ricevuta=2#r-2"],
  ["06-cronologia-apertura", "/ui/systems/prova-per-errore?kind=genesis"],
  [
    "07-cronologia-dettagli-tecnici",
    "/ui/systems/acme-support-bot?ricevuta=4#r-4",
    async (page) => {
      await page.locator("details.tech > summary").click();
    },
  ],
  ["08-fascicolo", "/ui/systems/acme-support-bot#fascicolo"],
  ["09-sigilli", "/ui/systems/selezione-cv/checkpoints"],
  ["10-impostazioni-sistema-con-azioni", "/ui/systems/acme-support-bot/manage"],
  ["11-impostazioni-sistema-vuoto", "/ui/systems/prova-per-errore/manage"],
  ["12-nuova-chiave", "/ui/systems/prova-per-errore/manage#nuova-chiave"],
  ["13-sistemi", "/ui/sistemi"],
  ["14-sistemi-archiviati", "/ui/sistemi?vista=archiviati"],
  ["15-nuovo-sistema", "/ui/sistemi/nuovo"],
  ["16-collega", "/ui/systems/prova-per-errore/collega"],
  ["17-verifica-documento", "/ui/verify-document"],
  ["18-verifica-documento-trovato", `/ui/verify-document?sha256=${pasted.bytes}&text=${pasted.text ?? ""}&from=text`],
  [
    "19-persone",
    "/ui/persone",
    async (page) => {
      await page.fill('input[name="identifier"]', "cliente-4821");
      await Promise.all([page.waitForNavigation(), page.click('form[action="/ui/persone"] button[type="submit"]')]);
    },
  ],
  ["20-clienti", "/ui/clienti"],
  ["21-impostazioni", "/ui/impostazioni"],
  ["22-registro-amministrativo", "/ui/impostazioni/registro"],
  ["23-non-trovato", "/ui/systems/sistema-inesistente"],
];

/** The same pages as a customer sees them. */
const customerPages: [name: string, url: string][] = [
  ["30-cliente-primi-passi", "/ui"],
  ["31-cliente-impostazioni", "/ui/impostazioni"],
];

// Full-page screenshots at 2x would quadruple the pixels of every phone
// shot for no reason a reader of the documentation needs; 1x is plenty
// crisp on screen and keeps the repository small.
const variants: [name: string, options: Parameters<typeof browser.newContext>[0]][] = [
  ["desktop", { viewport: { width: 1280, height: 860 }, colorScheme: "light" }],
  ["desktop-scuro", { viewport: { width: 1280, height: 860 }, colorScheme: "dark" }],
  ["telefono", { ...devices["iPhone 13"], deviceScaleFactor: 1, colorScheme: "light" }],
];

let written = 0;
async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  // Nothing under the pointer: a hover is not part of the page.
  await page.mouse.move(0, 0);
  const path = join(outputDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage });
  compress(path);
  written += 1;
}

for (const [variantName, contextOptions] of variants) {
  // The sign-in pages: the address first, then the password, then a wrong one; and the operator's.
  {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(`${address}/ui/login`);
    await shoot(page, `00-accesso-${variantName}`, false);
    await page.fill('input[name="email"]', "anna@rossitrasporti.it");
    await Promise.all([page.waitForNavigation(), page.click('form[action="/ui/login/email"] button[type="submit"]')]);
    await shoot(page, `00-accesso-password-${variantName}`, false);
    await page.goto(`${address}/ui/registrati`);
    await shoot(page, `00-registrazione-${variantName}`, false);
    await page.goto(`${address}/ui/admin`);
    await page.fill('input[name="password"]', "password-sbagliata");
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    await shoot(page, `00-accesso-amministratore-errore-${variantName}`, false);
    await context.close();
  }
  {
    const { context, page } = await signedInPage(contextOptions);
    for (const [name, url, action] of pages) {
      await page.goto(`${address}${url}`);
      if (action) await action(page);
      await shoot(page, `${name}-${variantName}`);
    }
    if (variantName === "telefono") {
      await page.goto(`${address}/ui/systems/acme-support-bot#menu`);
      await shoot(page, "24-menu-telefono", false);
    }
    await context.close();
  }
  {
    const { context, page } = await customerPage(contextOptions);
    for (const [name, url] of customerPages) {
      await page.goto(`${address}${url}`);
      await shoot(page, `${name}-${variantName}`);
    }
    await context.close();
  }
}

// Last, because it adds a system that every later page would list: the page
// that shows a new system's key, the only time it is shown.
for (const [variantName, contextOptions] of variants) {
  const { context, page } = await signedInPage(contextOptions);
  await page.goto(`${address}/ui/sistemi/nuovo`);
  await page.fill('input[name="display_name"]', `Nuovo assistente ${variantName}`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/ui/sistemi"] button[type="submit"]')]);
  await shoot(page, `25-sistema-creato-${variantName}`);
  await page.locator('label[for="way-otel"]').click();
  await shoot(page, `26-sistema-creato-opentelemetry-${variantName}`);
  await context.close();
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
