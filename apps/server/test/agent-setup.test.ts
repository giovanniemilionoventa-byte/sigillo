import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { agentProtection, agentUpload } from "../src/config.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { AGENT_SETUP_SCRIPT, AGENT_SETUP_SOURCE } from "../src/http/agent-setup.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * "Upload your agent": the browser adds the sigillo lines to an agent's .py
 * file. The function is run here from the very characters the browser runs,
 * and what it writes is parsed by Python itself where Python is installed.
 */

interface Added {
  status: "added";
  text: string;
  frameworks: string[];
  install: string;
}
type Result = Added | { status: "already" };

const SETTINGS = {
  endpoint: "https://get-sigillo.eu",
  key: "sigillo_abc_def",
  system: "cv-bot",
  url: "https://github.com/giovanniemilionoventa-byte/sigillo/archive/refs/heads/main.zip#subdirectory=sdk-python",
};

const setup = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: typeof SETTINGS) => Result;

function added(source: string): Added {
  const result = setup(source, SETTINGS);
  if (result.status !== "added") throw new Error(`expected the lines added, got ${result.status}`);
  return result;
}

const python = spawnSync("python3", ["--version"]).status === 0;

/** Whether Python parses `text`, as it would run it. */
function parses(text: string): boolean {
  return spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: text }).status === 0;
}

/** The lines that install the SDK the first time the file runs, for these instrumentations. */
const BOOTSTRAP = (extras: string, modules: string[]): string[] => [
  "try:",
  "    import sigillo",
  ...modules.map((name) => `    import openinference.instrumentation.${name}`),
  "except ImportError:",
  "    import importlib",
  "    import subprocess",
  "    import sys",
  "",
  `    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "sigillo${extras} @ ${SETTINGS.url}"])`,
  "    importlib.invalidate_caches()",
  "    import sigillo",
  "",
];

const INIT = [
  "sigillo.init(",
  '    endpoint="https://get-sigillo.eu",',
  '    api_key="sigillo_abc_def",',
  '    system_id="cv-bot",',
];

describe("adding sigillo to an agent's file", () => {
  it("puts the lines first in a plain file, with the LangChain instrumentation it uses", () => {
    const result = added("from langchain_openai import ChatOpenAI\n\nllm = ChatOpenAI()\n");
    expect(result.text).toBe([...BOOTSTRAP("[langchain]", ["langchain"]), ...INIT, '    instrument=["langchain"],', ")", "", "from langchain_openai import ChatOpenAI", "", "llm = ChatOpenAI()", ""].join("\n"));
    expect(result.frameworks).toEqual(["langchain"]);
    expect(result.install).toBe(`pip install "sigillo[langchain] @ ${SETTINGS.url}"`);
  });

  it("keeps the #! line, the encoding line, the docstring and __future__ imports first, as Python requires", () => {
    const source = [
      "#!/usr/bin/env python3",
      "# -*- coding: utf-8 -*-",
      '"""The CV agent.',
      "",
      "Reads three CVs.",
      '"""',
      "",
      "from __future__ import (",
      "    annotations,",
      ")",
      "from __future__ import division",
      "",
      "import crewai",
      "",
    ].join("\n");
    const result = added(source);
    const lines = result.text.split("\n");
    expect(lines.slice(0, 11)).toEqual(source.split("\n").slice(0, 11));
    expect(lines.slice(11, 29)).toEqual(["", ...BOOTSTRAP("[crewai]", ["crewai"]), ...INIT, '    instrument=["crewai"],']);
    expect(result.text.endsWith(")\n\nimport crewai\n")).toBe(true);
    if (python) expect(parses(result.text)).toBe(true);
  });

  it("handles a one-line docstring and a file of nothing but comments", () => {
    expect(added("'''One line.'''\nimport os\n").text.startsWith("'''One line.'''\n\ntry:\n    import sigillo\n")).toBe(true);
    const comments = added("# nothing yet\n").text;
    expect(comments.startsWith("# nothing yet\n\ntry:\n    import sigillo\n")).toBe(true);
    if (python) expect(parses(comments)).toBe(true);
  });

  it("keeps Windows line endings and a byte-order mark", () => {
    const result = added("\uFEFFimport openai\r\nclient = openai.OpenAI()\r\n");
    expect(result.text.startsWith("\uFEFFtry:\r\n    import sigillo\r\n")).toBe(true);
    expect(result.text).not.toMatch(/[^\r]\n/);
    expect(result.frameworks).toEqual(["openai"]);
  });

  it("adds the OpenAI instrumentation only where LangChain and CrewAI are absent, so no call is recorded twice", () => {
    expect(added("import openai\nfrom langgraph.graph import StateGraph\n").frameworks).toEqual(["langchain"]);
    expect(added("from crewai import Agent\nimport langchain\n").frameworks).toEqual(["langchain", "crewai"]);
    expect(added("from openai import OpenAI\n").install).toBe(`pip install "sigillo[openai] @ ${SETTINGS.url}"`);
  });

  it("leaves the instrumentations to the SDK's default where it finds none, and says the plain package", () => {
    const result = added("import requests\nprint(requests.get('https://example.com'))\n");
    expect(result.frameworks).toEqual([]);
    expect(result.text).not.toContain("instrument=");
    expect(result.text).not.toContain("openinference");
    expect(result.text).toContain(`"--quiet", "sigillo @ ${SETTINGS.url}"])`);
    expect(result.install).toBe(`pip install "sigillo @ ${SETTINGS.url}"`);
    if (python) expect(parses(result.text)).toBe(true);
  });

  it("changes nothing in a file that already uses sigillo", () => {
    expect(setup("import os\nimport sigillo\n", SETTINGS).status).toBe("already");
    expect(setup("x = 1\nsigillo.init(endpoint='e', api_key='k', system_id='s')\n", SETTINGS).status).toBe("already");
  });

  it("writes the values as Python string literals, whatever they hold", () => {
    const result = setup('print("hi")\n', { ...SETTINGS, system: 'odd"name\\' });
    if (result.status !== "added") throw new Error("expected added");
    expect(result.text).toContain('system_id="odd\\"name\\\\",');
    if (python) expect(parses(result.text)).toBe(true);
  });

  it("is the code the browser runs", () => {
    expect(AGENT_SETUP_SCRIPT).toContain(AGENT_SETUP_SOURCE);
  });
});

const NOW = "2026-10-06T18:00:00.000Z";
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

async function start(access?: "off" | "operator" | "all"): Promise<void> {
  if (app !== undefined) await app.close();
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
      ...(access === undefined ? {} : { agentUpload: access, agentProtection: access }),
    },
  });
  await app.ready();
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-agent-setup-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createSystem(OPERATOR_BOT, NOW);
  await store.createSystem(ACME_BOT, NOW, "acme");
  keys = ApiKeyStore.open(databasePath);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const cookie = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, Date.parse(NOW)).value}`;
/** A new key for the system: the page that shows it, where the upload is offered. */
const newKey = async (viewer: Viewer, systemId: string): Promise<string> =>
  (
    await app!.inject({
      method: "POST",
      url: `/ui/systems/${systemId}/key`,
      headers: { cookie: cookie(viewer), "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    })
  ).body;

describe("who is offered the upload", () => {
  it("defaults to the operator's own systems, and opens to all only when told (rule 11)", () => {
    expect(agentUpload({})).toBe("operator");
    expect(agentUpload({ SIGILLO_AGENT_UPLOAD: "" })).toBe("operator");
    expect(agentUpload({ SIGILLO_AGENT_UPLOAD: "all" })).toBe("all");
    expect(agentUpload({ SIGILLO_AGENT_UPLOAD: "off" })).toBe("off");
    expect(() => agentUpload({ SIGILLO_AGENT_UPLOAD: "everyone" })).toThrow(/SIGILLO_AGENT_UPLOAD/);
  });

  it("shows it to the operator beside the new key, carrying that key, and to no customer", async () => {
    await start("operator");
    const page = await newKey(OPERATOR, OPERATOR_BOT);
    expect(page).toContain('id="sigillo-agent"');
    expect(page).toContain('<script src="/ui/agent-setup.js" defer></script>');
    // Two separate ways: the upload on top, the two commands below it.
    const commands = page.indexOf('<pre class="code python install">');
    expect(page.indexOf('id="sigillo-agent"')).toBeGreaterThan(-1);
    expect(page.indexOf('id="sigillo-agent"')).toBeLessThan(commands);
    expect(commands).toBeLessThan(page.indexOf('<pre class="code python">'));
    const key = /data-key="(sigillo_[^"]+)"/.exec(page)?.[1];
    expect(key).toBeDefined();
    expect(page).toContain(`data-key="${key}"`);
    expect(page).toContain('data-system="operator-bot"');
    expect(await newKey(ACME, ACME_BOT)).not.toContain("sigillo-agent");
  });

  it("is not on the later connect page, where the key is no longer shown", async () => {
    await start("all");
    const page = await app!.inject({ method: "GET", url: `/ui/systems/${OPERATOR_BOT}/collega`, headers: { cookie: cookie(OPERATOR) } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("sigillo-agent");
  });

  it("reaches customers once opened to all, and nobody when off or not configured", async () => {
    await start("all");
    expect(await newKey(ACME, ACME_BOT)).toContain('id="sigillo-agent"');
    await start("off");
    expect(await newKey(OPERATOR, OPERATOR_BOT)).not.toContain("sigillo-agent");
    await start();
    expect(await newKey(OPERATOR, OPERATOR_BOT)).not.toContain("sigillo-agent");
  });

  it("serves the script from this origin, which script-src 'self' allows", async () => {
    await start("operator");
    const script = await app!.inject({ method: "GET", url: "/ui/agent-setup.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(script.body).toBe(AGENT_SETUP_SCRIPT);
  });
});

describe("agent protection: strict mode when uploaded", () => {
  it("defaults to operator's own systems, and opens to all only when told (rule 11)", () => {
    expect(agentProtection({})).toBe("operator");
    expect(agentProtection({ SIGILLO_AGENT_PROTECTION: "" })).toBe("operator");
    expect(agentProtection({ SIGILLO_AGENT_PROTECTION: "all" })).toBe("all");
    expect(agentProtection({ SIGILLO_AGENT_PROTECTION: "off" })).toBe("off");
    expect(() => agentProtection({ SIGILLO_AGENT_PROTECTION: "invalid" })).toThrow(/SIGILLO_AGENT_PROTECTION/);
  });

  it("adds strict=True to sigillo.init when protection is enabled", () => {
    const source = "from langchain_openai import ChatOpenAI\nllm = ChatOpenAI()\n";
    const setupWithoutProtection = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: typeof SETTINGS & { protection?: boolean }) => Result;
    const setupWithProtection = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: typeof SETTINGS & { protection?: boolean }) => Result;
    
    const withoutProtection = setupWithoutProtection(source, { ...SETTINGS, protection: false });
    const withProtection = setupWithProtection(source, { ...SETTINGS, protection: true });
    
    if (withoutProtection.status !== "added" || withProtection.status !== "added") {
      throw new Error("Expected added status");
    }

    expect(withoutProtection.text).not.toContain("strict=True");
    expect(withProtection.text).toContain("strict=True");
    
    // With protection, strict mode line should be just before the closing paren
    const strictLine = withProtection.text.split("\n").find(line => line.includes("strict=True"));
    expect(strictLine).toBeDefined();
    const nextLine = withProtection.text.split("\n")[withProtection.text.split("\n").indexOf(strictLine!) + 1];
    expect(nextLine).toBe(")");
  });

  it("adds strict=True after instrument when both are present", () => {
    const source = "from langchain_openai import ChatOpenAI\nllm = ChatOpenAI()\n";
    const setup = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: typeof SETTINGS & { protection?: boolean }) => Result;
    const result = setup(source, { ...SETTINGS, protection: true });
    
    if (result.status !== "added") {
      throw new Error("Expected added status");
    }

    const lines = result.text.split("\n");
    const instrumentIndex = lines.findIndex(line => line.includes("instrument="));
    const strictIndex = lines.findIndex(line => line.includes("strict=True"));
    
    expect(instrumentIndex).toBeGreaterThan(-1);
    expect(strictIndex).toBeGreaterThan(-1);
    expect(strictIndex).toBeGreaterThan(instrumentIndex);
  });

  if (python) {
    it("produces valid Python when protection is enabled", () => {
      const source = "from langchain_openai import ChatOpenAI\nllm = ChatOpenAI()\n";
      const setup = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: typeof SETTINGS & { protection?: boolean }) => Result;
      const result = setup(source, { ...SETTINGS, protection: true });
      
      if (result.status !== "added") {
        throw new Error("Expected added status");
      }

      expect(parses(result.text)).toBe(true);
    });
  }
});
