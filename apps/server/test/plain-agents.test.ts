import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { plainAgents } from "../src/config.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Agents with no framework, recorded from the standard library's own calls
 * (the SDK's "stdlib" instrumentation): new, so SIGILLO_PLAIN_AGENTS opens it
 * to the operator's own systems first, and to every account only on the
 * owner's word (CLAUDE.md rule 11). The file that "upload your agent" gives
 * back is offered the recording only where the account is opened, and the
 * server refuses the spans of one that is not.
 */

const NOW = "2026-10-08T12:00:00.000Z";
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
    ...(access === undefined ? {} : { plainAgents: access }),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
      agentUpload: "all",
    },
  });
  await app.ready();
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-plain-agents-"));
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

/** What the SDK's "stdlib" instrumentation sends for a model call over urllib, and for a file written. */
function traces(client: string | null): Record<string, unknown> {
  const span = (kind: string, attributes: Array<[string, string]>) => {
    spanCounter += 1;
    return {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: spanCounter.toString(16).padStart(16, "0"),
      name: "x",
      startTimeUnixNano: "1790000000000000000",
      endTimeUnixNano: "1790000001000000000",
      status: { code: 1 },
      attributes: [
        { key: "openinference.span.kind", value: { stringValue: kind } },
        ...attributes.map(([key, value]) => ({ key, value: { stringValue: value } })),
      ],
    };
  };
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "mondis" } },
            ...(client === null ? [] : [{ key: "sigillo.client", value: { stringValue: client } }]),
          ],
        },
        scopeSpans: [
          {
            spans: [
              span("LLM", [["llm.model_name", "qwen2.5:1.5b"], ["llm.system", "ollama"]]),
              span("TOOL", [["tool.name", "write_file"]]),
            ],
          },
        ],
      },
    ],
  };
}

const send = async (systemId: string, client: string | null = "stdlib") =>
  app!.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { authorization: `Bearer ${tokens[systemId]}`, "content-type": "application/json" },
    payload: traces(client),
  });

const newKey = async (viewer: Viewer, systemId: string): Promise<string> =>
  (
    await app!.inject({
      method: "POST",
      url: `/ui/systems/${systemId}/key`,
      headers: {
        cookie: `sigillo_session=${sessions.issue(viewer, Date.parse(NOW)).value}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "",
    })
  ).body;

describe("SIGILLO_PLAIN_AGENTS", () => {
  it("defaults to the operator's own systems, and opens to all only when told (rule 11)", () => {
    expect(plainAgents({})).toBe("operator");
    expect(plainAgents({ SIGILLO_PLAIN_AGENTS: "" })).toBe("operator");
    expect(plainAgents({ SIGILLO_PLAIN_AGENTS: "all" })).toBe("all");
    expect(plainAgents({ SIGILLO_PLAIN_AGENTS: "off" })).toBe("off");
    expect(() => plainAgents({ SIGILLO_PLAIN_AGENTS: "everyone" })).toThrow(/SIGILLO_PLAIN_AGENTS/);
  });
});

describe("spans from an agent recorded from the standard library", () => {
  it("are written for the operator's systems and refused for a customer's, by default", async () => {
    await start();
    expect((await send(OPERATOR_BOT)).statusCode).toBe(200);
    const kinds = store.readChain(OPERATOR_BOT).map((receipt) => receipt.action.kind);
    expect(kinds).toContain("llm_call");
    expect(kinds).toContain("tool_call");

    const customer = await send(ACME_BOT);
    expect(customer.statusCode).toBe(403);
    expect(store.readChain(ACME_BOT)).toHaveLength(1); // the genesis only
  });

  it("reach customers once opened to all, and nobody when off; other spans are never affected", async () => {
    await start("all");
    expect((await send(ACME_BOT)).statusCode).toBe(200);
    await start("off");
    expect((await send(OPERATOR_BOT)).statusCode).toBe(403);
    expect((await send(ACME_BOT, null)).statusCode).toBe(200);
  });
});

describe("the file that 'upload your agent' gives back", () => {
  it("is offered the recording on the operator's systems only, and on a customer's once opened", async () => {
    await start();
    expect(await newKey(OPERATOR, OPERATOR_BOT)).toContain('data-stdlib="1"');
    const customer = await newKey(ACME, ACME_BOT);
    expect(customer).toContain('id="sigillo-agent"'); // the upload itself is open to all here
    expect(customer).not.toContain("data-stdlib");
    await start("all");
    expect(await newKey(ACME, ACME_BOT)).toContain('data-stdlib="1"');
  });
});
