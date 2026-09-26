/**
 * Static, self-contained HTML snapshots of the main web view pages, for
 * opening and tweaking the look by hand — colours, spacing, typography —
 * without running the server or touching TypeScript.
 *
 * Every page's CSS is inline (apps/server/src/http/style.ts, injected as
 * <style>${STYLE}</style> by apps/server/src/http/ui.ts's page()), and the
 * only image is an inline SVG: there is no external stylesheet, script or
 * image for the CSP to allow or a saved file to lose. So, unlike
 * scripts/screenshots.ts, this does not need a browser at all — it fetches
 * the exact bytes the server sends over plain HTTP and writes them to disk
 * as-is.
 *
 * It reuses the same real-signer, real-local-TSA setup as
 * scripts/screenshots.ts and the browser tests (apps/server/test/helpers/*),
 * so the data behind the snapshots is produced the same way the tests
 * already exercise, not stood in for. dev-only: not part of any package's
 * dependencies, and not run by any test (project owner's instruction,
 * PROGRESS.md).
 *
 * Run with: pnpm tsx scripts/frontend-snapshots.ts [output directory]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const outputDirectory = process.argv[2] ?? join(ROOT, "docs", "frontend-preview");
mkdirSync(outputDirectory, { recursive: true });

const PASSWORD = "password-di-prova";

const directory = mkdtempSync(join(tmpdir(), "sigillo-frontend-preview-"));
const databasePath = join(directory, "sigillo.db");
const signer = createTestSigner();
const store = ReceiptStore.open(databasePath, signer);
const keys = ApiKeyStore.open(databasePath);
const tsa = createLocalTsa();
const tsaUrl = await tsa.listen();

// The same seed shape as the selezione-cv demo (demo/selezione-cv/agent.py):
// a system reading curricula and replying to candidates, plus a second,
// unrelated system so the pages that list several systems look real.
const base = Date.now() - 5 * 3600_000;
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
  event("acme-support-bot", 5, {
    actor: { agent: "support-agent", on_behalf_of: "cliente-4821" },
    action: { kind: "tool_call", name: "cerca_ordine" },
  }),
);
await store.append(
  event("acme-support-bot", 6, {
    action: { kind: "llm_call", name: "chat" },
    model: { name: "llama3.1:8b", provider: "ollama", digest: null },
  }),
);
await store.append(
  event("acme-support-bot", 8, { action: { kind: "decision", name: "escalation_operatore" } }),
);

await store.createSystem("selezione-cv", at(20));
await store.renameSystem("selezione-cv", "Selezione CV — backend junior", admin);
for (let index = 1; index <= 3; index += 1) {
  await store.append(
    event("selezione-cv", 20 + index * 3, {
      actor: { agent: "screener" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      artifacts: [
        {
          role: "input",
          label: `candidato-0${index}.txt`,
          media_type: "text/plain",
          sha256: String(index).repeat(64),
        },
      ],
    }),
  );
}
await store.append(
  event("selezione-cv", 35, { actor: { agent: "screener" }, action: { kind: "decision", name: "shortlist" } }),
);

await store.createSystem("vecchio-bot-2025", at(1));
await store.append(event("vecchio-bot-2025", 2, { action: { kind: "agent_step", name: "saluto" } }));
await store.archiveSystem("vecchio-bot-2025", { ...admin, ts: at(3) });

const checkpointer = new Checkpointer({ store, now: () => new Date(at(40)), tsa: { url: tsaUrl } });
await checkpointer.runOnce();

const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
healthMonitor.check();

const app = buildServer({
  store,
  keys,
  ui: {
    password: PASSWORD,
    signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
    healthMonitor,
    checkpointer,
  },
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });

// A plain HTTP login: no Origin or Sec-Fetch-Site header, exactly what the
// preHandler CSRF guard in ui.ts already lets through (it only ever refuses,
// never requires, one of those headers — see the comment there).
const loginResponse = await fetch(`${address}/ui/login`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: `password=${encodeURIComponent(PASSWORD)}`,
  redirect: "manual",
});
const setCookie = loginResponse.headers.get("set-cookie");
if (setCookie === null) {
  throw new Error("login did not set a session cookie");
}
const cookie = setCookie.split(";", 1)[0] ?? setCookie;

async function fetchPage(path: string, withCookie: boolean): Promise<string> {
  const response = await fetch(`${address}${path}`, {
    headers: withCookie ? { cookie } : {},
  });
  if (response.status !== 200) {
    throw new Error(`GET ${path} returned ${response.status}, expected 200`);
  }
  return await response.text();
}

const pages: [name: string, path: string, withCookie: boolean][] = [
  ["00-login", "/ui/login", false],
  ["01-registro", "/ui", true],
  ["02-sistemi", "/ui/sistemi", true],
  ["03-gestisci-selezione-cv", "/ui/systems/selezione-cv/manage", true],
  ["04-cronologia-selezione-cv", "/ui/systems/selezione-cv", true],
];

let written = 0;
for (const [name, path, withCookie] of pages) {
  const html = await fetchPage(path, withCookie);
  writeFileSync(join(outputDirectory, `${name}.html`), html, "utf8");
  written += 1;
}

await app.close();
tsa.close();
store.close();
keys.close();

process.stdout.write(`wrote ${written} HTML snapshots to ${outputDirectory}\n`);
