import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { verifyBundle } from "@sigillo/verifier";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import type { Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import type { Access, ConsoleFeatures } from "../src/config.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { escape } from "../src/http/layout.js";
import { buildServer } from "../src/http/server.js";
import { SITE_CONTACT_EMAIL } from "../src/http/site.js";
import { IT } from "../src/http/strings-it.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The first steps of a new account (decided by the project owner on
 * 2026-11-11): the four steps, the example register beside them
 * (SIGILLO_SAMPLE_SYSTEM), the offer to connect the agent together, and the
 * few words shown once the agent's first receipts arrive.
 */

const NOW = "2026-11-11T12:00:00.000Z";
const ADMIN = { actor: "test", ts: NOW };
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const OTHER: Viewer = { kind: "organization", organizationId: "other" };
const OPERATOR: Viewer = { kind: "operator" };
const t = IT.ui;

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let healthMonitor: ChainHealthMonitor;
let checkpointer: Checkpointer;
let app: FastifyInstance;

async function start(sampleSystem: Access = "all", options: { maxSystems?: number } = {}): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), "sigillo-onboarding-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createOrganization("other", "Other S.r.l.", ADMIN, { approved: true });
  keys = ApiKeyStore.open(databasePath);
  healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
  checkpointer = new Checkpointer({ store, now: () => new Date(NOW), sleep: async () => undefined });
  sessions = new UiSessions();
  const features: ConsoleFeatures = {
    runs: "all",
    extraKeys: "all",
    exportRegister: "all",
    reportLanguage: "all",
    packReader: "all",
    siteV2: "all",
    sampleSystem,
  };
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ...(options.maxSystems === undefined ? {} : { organizationMaxSystems: options.maxSystems }),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer,
      sessions,
      consoleV2: "all",
      features,
    },
  });
  await app.ready();
}

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const cookieOf = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, new Date(NOW).getTime()).value}; sigillo_lang=it`;
const get = (viewer: Viewer, url: string) => app.inject({ method: "GET", url, headers: { cookie: cookieOf(viewer) } });
const post = (viewer: Viewer, url: string, payload = "") =>
  app.inject({ method: "POST", url, headers: { cookie: cookieOf(viewer), "content-type": "application/x-www-form-urlencoded" }, payload });

describe("the first steps", () => {
  it("offer the example and the call beside the four steps", async () => {
    await start();
    for (const viewer of [ACME, OPERATOR]) {
      const body = (await get(viewer, "/ui")).body;
      expect(body).toContain(t.home.welcome);
      expect(body).toContain(t.home.steps.sample);
      expect(body).toContain('action="/ui/esempio"');
      expect(body).toContain(t.home.steps.create);
      expect(body).toContain(t.home.steps.together);
      expect(body).toContain(`mailto:${SITE_CONTACT_EMAIL ?? ""}`);
    }
  });

  it("leave the example out when its switch is off, and refuse to make one", async () => {
    await start("off");
    const body = (await get(ACME, "/ui")).body;
    expect(body).toContain(t.home.welcome);
    expect(body).not.toContain(t.home.steps.sample);
    expect((await post(ACME, "/ui/esempio")).statusCode).toBe(404);
    expect(store.systemRecord("acme.esempio")).toBeNull();
  });

  it("give the example to the operator alone when the switch says operator", async () => {
    await start("operator");
    expect((await get(ACME, "/ui")).body).not.toContain(t.home.steps.sample);
    expect((await get(OPERATOR, "/ui")).body).toContain(t.home.steps.sample);
  });
});

describe("the example register", () => {
  it("is made once, as the account's own, with real receipts that pass the verifier", async () => {
    await start();
    const made = await post(ACME, "/ui/esempio");
    expect(made.statusCode).toBe(303);
    expect(made.headers.location).toBe("/ui/systems/acme.esempio");
    const record = store.systemRecord("acme.esempio");
    expect(record?.organization_id).toBe("acme");
    expect(record?.display_name).toBe(t.sample.name);
    expect(record?.receipts).toBe(10);
    // Asked again, the same one is opened, not a second run written.
    expect((await post(ACME, "/ui/esempio")).headers.location).toBe("/ui/systems/acme.esempio");
    expect(store.systemRecord("acme.esempio")?.receipts).toBe(10);
    // No key: no agent can write to it.
    expect(keys.list("acme.esempio")).toHaveLength(0);

    // Signed and chained: the chain health check, which verifies every signature, finds it green.
    healthMonitor.check();
    expect(healthMonitor.statusFor("acme.esempio", new Date(NOW)).status).toBe("green");

    // Sealed at once, and the evidence pack passes the verifier.
    await checkpointer.requestRun();
    expect(store.latestCheckpoint("acme.esempio")?.checkpoint.tree_size).toBe(10);
    const pack = await post(ACME, "/ui/export", "system_id=acme.esempio");
    expect(pack.statusCode).toBe(200);
    const files = new Map(readZip(new Uint8Array(pack.rawPayload)).map((entry) => [entry.name, new TextDecoder().decode(entry.data)]));
    const result = verifyBundle({
      manifestJson: files.get("manifest.json") ?? "",
      receiptsJsonl: files.get("receipts.jsonl") ?? "",
      checkpointsJsonl: files.get("checkpoints.jsonl") ?? "",
    });
    expect(result.ok).toBe(true);

    // What the made-up agent read and wrote is not in the database: only digests.
    const receipts = files.get("receipts.jsonl") ?? "";
    expect(receipts).not.toContain(t.sample.run.claim);
    expect(receipts).toContain(t.sample.run.pay);
  });

  it("says on every page that it is an example, and is hidden from there", async () => {
    await start();
    await post(ACME, "/ui/esempio");
    for (const url of ["/ui/systems/acme.esempio", "/ui/systems/acme.esempio/collega", "/ui/systems/acme.esempio/manage"]) {
      const body = (await get(ACME, url)).body;
      expect(body, url).toContain(escape(t.sample.banner));
      expect(body, url).toContain('action="/ui/systems/acme.esempio/archive"');
    }
    const hidden = await post(ACME, "/ui/systems/acme.esempio/archive");
    expect(hidden.headers.location).toBe("/ui");
    expect(store.systemRecord("acme.esempio")?.archived_at).not.toBeNull();
    expect((await get(ACME, "/ui/systems/acme.esempio")).body).not.toContain(t.sample.hide);
  });

  it("does not move the account past its first steps, and stays one click away", async () => {
    await start();
    await post(ACME, "/ui/esempio");
    const body = (await get(ACME, "/ui")).body;
    expect(body).toContain(t.home.welcome);
    expect(body).toContain('href="/ui/systems/acme.esempio"');
    expect(body).not.toContain('action="/ui/esempio"');
  });

  it("is nobody else's", async () => {
    await start();
    await post(ACME, "/ui/esempio");
    expect((await get(OTHER, "/ui/systems/acme.esempio")).statusCode).toBe(404);
    // Another account gets its own.
    expect((await post(OTHER, "/ui/esempio")).headers.location).toBe("/ui/systems/other.esempio");
    expect(store.systemRecord("other.esempio")?.organization_id).toBe("other");
  });

  it("keeps its name, gets no key, is not handed over, and does not count against the limit of systems", async () => {
    await start("all", { maxSystems: 1 });
    await post(ACME, "/ui/esempio");
    const named = await post(ACME, "/ui/sistemi", "display_name=Esempio&system_id=esempio");
    expect(named.statusCode).toBe(400);
    expect(named.body).toContain("riservato");
    const key = await post(ACME, "/ui/systems/acme.esempio/key");
    expect(key.statusCode).toBe(400);
    expect(key.body).toContain(t.sample.noKey);
    expect(keys.list("acme.esempio")).toHaveLength(0);
    expect((await get(ACME, "/ui/systems/acme.esempio/collega")).body).toContain(t.sample.noKey);
    expect((await post(ACME, "/ui/systems/acme.esempio/transfer")).statusCode).toBe(404);
    // The one system the limit allows is still there to create.
    expect((await post(ACME, "/ui/sistemi", "display_name=Agente+vero")).statusCode).toBe(200);
  });
});

describe("the first receipt of the account's own agent", () => {
  it("is greeted until the first seal, and the example's actions stay out of the figures", async () => {
    await start();
    await post(ACME, "/ui/esempio");
    await checkpointer.requestRun();
    await store.createSystem("acme.bot", NOW, "acme");
    await store.append({
      system_id: "acme.bot",
      ts_event: NOW,
      ts_received: NOW,
      actor: { agent: "screener" },
      action: { kind: "tool_call", name: "lookup" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "sdk" },
    });
    healthMonitor.check();

    const before = (await get(ACME, "/ui")).body;
    expect(before).not.toContain(t.home.welcome);
    expect(before).toContain(t.home.firstReceipt.title);
    // One action today, the agent's own: the example's nine are not counted, nor its blocked transfer listed.
    expect(before).toMatch(/<a class="fig" href="\/ui\/actions\?period=today"><strong>1<\/strong>/);
    expect(before).not.toContain(t.sample.run.mail);

    await store.createCheckpoint("acme.bot");
    expect((await get(ACME, "/ui")).body).not.toContain(t.home.firstReceipt.title);
  });
});
