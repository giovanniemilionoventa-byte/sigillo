import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiKeyStore } from "../../src/auth/api-keys.js";
import { UiSessions } from "../../src/auth/sessions.js";
import { Checkpointer } from "../../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../../src/health/chain-health.js";
import { buildServer } from "../../src/http/server.js";
import { ReceiptStore } from "../../src/storage/store.js";
import { createLocalTsa } from "./local-tsa.js";
import { createTestSigner } from "./signer.js";

/**
 * The dashboard the public site shows before anyone signs in
 * (apps/server/src/http/site.ts), made from the real web view: a demo
 * company's registry is built in a real store with real signatures, the
 * console renders its main page for it, and what comes out is kept as a file
 * (apps/server/assets/site/demo-en.html, demo-it.html). The site serves those
 * files as they are, so the demo is the console itself, not a drawing of it,
 * and never touches a customer's data, a key or a server.
 *
 * Everything that varies is fixed (the clock, the times of the receipts, the
 * agents' names), so that the same code makes the same bytes: a test
 * (demo-snapshot.test.ts) regenerates the files and fails when the console
 * has changed under them. `pnpm tsx scripts/demo-snapshot.ts` writes them
 * again.
 */

export type DemoLanguage = "en" | "it";

/** A Sunday evening, after the last seal of the day. */
export const DEMO_NOW = "2026-10-04T16:50:00.000Z";

const NAMES: Record<DemoLanguage, { company: string; systems: [string, string, string] }> = {
  en: { company: "Demo company", systems: ["CV screening — junior backend", "Customer assistant", "Shipping assistant"] },
  it: { company: "Azienda demo", systems: ["Selezione CV — backend junior", "Assistente clienti", "Assistente spedizioni"] },
};

const at = (minutes: number): string => new Date(Date.parse("2026-10-04T07:00:00.000Z") + minutes * 60_000).toISOString();

/** The fragment of the main page between the sidebar's frame and the end of the app: sidebar and content. */
function appOf(html: string): string {
  const match = /<div class="app">\n([^]*)\n<\/div>\n<\/body><\/html>/.exec(html);
  if (match === null) throw new Error("the console's page no longer has the shape the demo expects");
  return match[1] ?? "";
}

/**
 * The main page for the demo company, as a fragment of the console's own
 * markup. Every link and every form is sent to the sign-in page: the demo
 * looks at the registry, it does not act on one.
 */
async function render(language: DemoLanguage): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "sigillo-demo-"));
  const databasePath = join(directory, "sigillo.db");
  let clock = new Date(at(0));
  const signer = createTestSigner({ now: () => clock });
  const store = ReceiptStore.open(databasePath, signer);
  const keys = ApiKeyStore.open(databasePath);
  const tsa = createLocalTsa();
  let app: FastifyInstance | undefined;
  try {
    const names = NAMES[language];
    const admin = { actor: "demo", ts: at(0) };
    await store.registerOrganization({ uid: "demoUid0001", email: "demo@example.com" }, names.company, admin);
    const organization = store.userByUid("demoUid0001")?.organization_id ?? "";
    await store.approveOrganization(organization, admin);

    const systems = [
      { id: "cv-screening", name: names.systems[0], agent: "screener", actions: ["read_cv", "evaluate_candidate", "shortlist", "send_email"], count: 24 },
      { id: "customer-assistant", name: names.systems[1], agent: "support-agent", actions: ["search_order", "answer_customer", "refund_payment"], count: 18 },
      { id: "shipping-assistant", name: names.systems[2], agent: "dispatcher", actions: ["plan_route", "book_courier"], count: 9 },
    ] as const;
    let minute = 10;
    for (const system of systems) {
      clock = new Date(at(minute));
      await store.createSystem(system.id, at(minute), organization);
      await store.renameSystem(system.id, system.name, { actor: "demo", ts: at(minute) });
      for (let index = 1; index < system.count; index += 1) {
        minute += 3;
        clock = new Date(at(minute));
        const name = system.actions[index % system.actions.length] ?? "step";
        await store.append({
          system_id: system.id,
          ts_event: at(minute),
          ts_received: at(minute),
          actor: { agent: system.agent },
          action: { kind: name.startsWith("answer") || name === "shortlist" ? "decision" : "tool_call", name },
          input_hash: "a".repeat(64),
          output_hash: "b".repeat(64),
          outcome: name === "refund_payment" && index > 8 ? "blocked" : "ok",
          source: { type: "sdk" },
        });
      }
      minute += 5;
    }
    // One seal over everything, dated by the authority a few seconds later.
    clock = new Date(at(minute));
    for (const system of systems) {
      const checkpoint = await store.createCheckpoint(system.id);
      if (checkpoint === null) throw new Error("no checkpoint");
      const stamped = new Date(Date.parse(checkpoint.checkpoint.ts) + 5000).toISOString();
      await store.recordTimestamp(checkpoint.id, "http://tsa.demo/", tsa.stampAt(checkpoint.checkpoint.root_hash, stamped).toString("base64"), stamped);
    }

    const now = new Date(DEMO_NOW);
    const monitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
    monitor.check();
    const sessions = new UiSessions();
    app = buildServer({
      store,
      keys,
      now: () => now,
      ui: {
        password: "not used by the demo",
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: monitor,
        checkpointer: new Checkpointer({ store, now: () => now }),
        sessions,
        accounts: { firebase: {} as never, publicUrl: "https://get-sigillo.eu" },
      },
    });
    const session = sessions.issue({ kind: "organization", organizationId: organization, userId: "demoUid0001" }, now.getTime());
    const response = await app.inject({
      method: "GET",
      url: "/ui",
      headers: { cookie: `sigillo_session=${session.value}; sigillo_lang=${language}` },
    });
    if (response.statusCode !== 200) throw new Error(`the console answered ${response.statusCode} for the demo`);
    return appOf(response.body);
  } finally {
    await app?.close();
    keys.close();
    store.close();
    tsa.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The demo, made fit for a visitor who has not signed in. */
export async function demoFragment(language: DemoLanguage): Promise<string> {
  return render(language)
    .then((fragment) =>
      fragment
        // Everything leads to signing in.
        .replace(/href="\/ui[^"]*"/g, 'href="/ui/login"')
        .replace(/method="post" action="\/ui[^"]*"/g, 'method="get" action="/ui/login"')
        // The visitor's own phone menu and account: the site's header says who they are and where to sign in.
        .replace(/<header class="topbar">[^]*?<\/header>\n/, "")
        .replace(/<div class="account">[^]*?<\/form><\/div>\n/, ""),
    )
    .then((fragment) => `${fragment}\n`);
}
