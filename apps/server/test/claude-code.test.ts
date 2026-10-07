import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { claudeCode } from "../src/config.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The Claude Code connector (sdk-python/src/sigillo/claude_code.py) names
 * itself on the span's resource, sigillo.client=claude-code. It is new, so
 * the server takes its spans, and the console offers it, only where
 * SIGILLO_CLAUDE_CODE opens it: the operator's own systems by default
 * (CLAUDE.md rule 11).
 */

const NOW = "2026-10-07T12:00:00.000Z";
const ADMIN = { actor: "cli test", ts: NOW };
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const OPERATOR_BOT = "operator-bot";
const ACME_BOT = "acme.cv-bot";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let app: FastifyInstance | undefined;
let tokens: Record<string, string>;

async function start(access?: "off" | "operator" | "all"): Promise<void> {
  if (app !== undefined) await app.close();
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ...(access === undefined ? {} : { claudeCode: access }),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
    },
  });
  await app.ready();
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-claude-code-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createSystem(OPERATOR_BOT, NOW);
  await store.createSystem(ACME_BOT, NOW, "acme");
  keys = ApiKeyStore.open(databasePath);
  tokens = { [OPERATOR_BOT]: keys.issue(OPERATOR_BOT, NOW).token, [ACME_BOT]: keys.issue(ACME_BOT, NOW).token };
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let spanCounter = 0;

/** One tool span, from Claude Code when `client` says so. */
function traces(client: string | null): Record<string, unknown> {
  spanCounter += 1;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
            ...(client === null ? [] : [{ key: "sigillo.client", value: { stringValue: client } }]),
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: spanCounter.toString(16).padStart(16, "0"),
                name: "Bash",
                startTimeUnixNano: "1791374400000000000",
                endTimeUnixNano: "1791374401000000000",
                attributes: [
                  { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
                  { key: "tool.name", value: { stringValue: "Bash" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const send = async (systemId: string, client: string | null = "claude-code") =>
  app!.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { authorization: `Bearer ${tokens[systemId]}`, "content-type": "application/json" },
    payload: traces(client),
  });

const cookie = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, Date.parse(NOW)).value}`;
const newKey = async (viewer: Viewer, systemId: string): Promise<string> =>
  (
    await app!.inject({
      method: "POST",
      url: `/ui/systems/${systemId}/key`,
      headers: { cookie: cookie(viewer), "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    })
  ).body;

describe("SIGILLO_CLAUDE_CODE", () => {
  it("defaults to the operator's own systems, and opens to all only when told (rule 11)", () => {
    expect(claudeCode({})).toBe("operator");
    expect(claudeCode({ SIGILLO_CLAUDE_CODE: "" })).toBe("operator");
    expect(claudeCode({ SIGILLO_CLAUDE_CODE: "all" })).toBe("all");
    expect(claudeCode({ SIGILLO_CLAUDE_CODE: "off" })).toBe("off");
    expect(() => claudeCode({ SIGILLO_CLAUDE_CODE: "everyone" })).toThrow(/SIGILLO_CLAUDE_CODE/);
  });
});

describe("spans from Claude Code", () => {
  it("are written for the operator's systems and refused for a customer's, by default", async () => {
    await start();
    const operator = await send(OPERATOR_BOT);
    expect(operator.statusCode).toBe(200);
    expect(store.readChain(OPERATOR_BOT).at(-1)?.action).toEqual({ kind: "tool_call", name: "Bash" });
    expect(store.readChain(OPERATOR_BOT).at(-1)?.actor).toEqual({ agent: "claude-code" });

    const customer = await send(ACME_BOT);
    expect(customer.statusCode).toBe(403);
    expect(customer.json()).toEqual({ error: "Claude Code is not enabled for this account yet" });
    expect(store.readChain(ACME_BOT)).toHaveLength(1); // the genesis only
  });

  it("reach customers once opened to all, and nobody when off", async () => {
    await start("all");
    expect((await send(ACME_BOT)).statusCode).toBe(200);
    await start("off");
    expect((await send(OPERATOR_BOT)).statusCode).toBe(403);
  });

  it("leave every other span as it was", async () => {
    await start("off");
    expect((await send(ACME_BOT, null)).statusCode).toBe(200);
    expect((await send(ACME_BOT, "something-else")).statusCode).toBe(200);
  });
});

describe("the connect page", () => {
  it("offers Claude Code to the operator, with the key in the command, and to no customer", async () => {
    await start();
    const page = await newKey(OPERATOR, OPERATOR_BOT);
    expect(page).toContain('id="way-claude"');
    const key = /--key (sigillo_[A-Za-z0-9_-]+)/.exec(page)?.[1];
    expect(key).toBeDefined();
    expect(page).toContain(`python -m sigillo.claude_code connect --endpoint http://localhost:80 --key ${key}`);
    // One line per system. PowerShell 5 has no &&, so Windows joins with ;.
    expect(page).toContain("main.zip#subdirectory=sdk-python&quot;; python -m sigillo.claude_code connect");
    expect(page).toContain("main.zip#subdirectory=sdk-python&quot; &amp;&amp; python3 -m sigillo.claude_code connect");
    expect(page).toContain("python -m pip install --upgrade &quot;sigillo @ https://");
    for (const title of ["Windows (PowerShell)", "macOS (Terminal)", "Linux (terminal)", "Claude Code in the cloud"]) {
      expect(page).toContain(title);
    }
    expect(await newKey(ACME, ACME_BOT)).not.toContain('id="way-claude"');
  });

  it("reaches customers once opened to all, and nobody when off", async () => {
    await start("all");
    expect(await newKey(ACME, ACME_BOT)).toContain('id="way-claude"');
    await start("off");
    expect(await newKey(OPERATOR, OPERATOR_BOT)).not.toContain('id="way-claude"');
  });
});
