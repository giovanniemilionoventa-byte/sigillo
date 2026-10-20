import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { agentProtection, agentUpload } from "../src/config.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
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
  instrument: string[];
  install: string;
}
type Result = Added | { status: "already" };

const SETTINGS = {
  endpoint: "https://get-sigillo.eu",
  key: "sigillo_abc_def",
  system: "cv-bot",
  url: "https://github.com/giovanniemilionoventa-byte/sigillo/archive/refs/heads/main.zip#subdirectory=sdk-python",
  stdlib: false,
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

/** The lines that install the SDK, or a newer one, the first time the file runs, for these instrumentations. */
const BOOTSTRAP = (extras: string, modules: string[]): string[] => [
  "try:",
  "    import sigillo",
  ...modules.map((name) => `    import openinference.instrumentation.${name}`),
  "    import importlib.metadata",
  '    if tuple(map(int, importlib.metadata.version("sigillo").split(".")[:2])) < (0, 4):',
  '        raise ImportError("sigillo is too old")',
  "except ImportError:",
  "    import os",
  "    import subprocess",
  "    import sys",
  "",
  '    if os.environ.get("SIGILLO_SETUP_DONE"):',
  "        raise",
  `    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "--upgrade", "sigillo${extras} @ ${SETTINGS.url}"])`,
  '    os.environ["SIGILLO_SETUP_DONE"] = "1"',
  "    raise SystemExit(subprocess.call([sys.executable, *sys.argv]))",
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
    const block = ["", ...BOOTSTRAP("[crewai]", ["crewai"]), ...INIT, '    instrument=["crewai"],'];
    expect(lines.slice(11, 11 + block.length)).toEqual(block);
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

  it("asks for no instrumentation where it finds no framework, and says the plain package", () => {
    const result = added("import requests\nprint(requests.get('https://example.com'))\n");
    expect(result.frameworks).toEqual([]);
    expect(result.text).toContain("    instrument=[],\n");
    expect(result.text).not.toContain("openinference");
    expect(result.text).toContain(`"--quiet", "--upgrade", "sigillo @ ${SETTINGS.url}"])`);
    expect(result.install).toBe(`pip install "sigillo @ ${SETTINGS.url}"`);
    if (python) expect(parses(result.text)).toBe(true);
  });

  it("records a framework-less agent from the standard library's calls, only where the account is opened to it", () => {
    const plain = "import urllib.request\nfrom pathlib import Path\n";
    const opened = setup(plain, { ...SETTINGS, stdlib: true });
    if (opened.status !== "added") throw new Error("expected added");
    expect(opened.text).toContain('    instrument=["stdlib"],\n');
    expect(opened.install).toBe(`pip install "sigillo @ ${SETTINGS.url}"`);
    if (python) expect(parses(opened.text)).toBe(true);
    // Not opened: as before, nothing is recorded but the connection.
    expect(added(plain).text).toContain("    instrument=[],\n");
    // A framework wins: it already records its own calls, so the standard library's are not hooked twice.
    const framework = setup("import langchain\n", { ...SETTINGS, stdlib: true });
    if (framework.status !== "added") throw new Error("expected added");
    expect(framework.text).toContain('    instrument=["langchain"],\n');
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
let providerKeys: ProviderKeyStore;

// A stand-in for the provider: it takes only the test's OpenAI key, as the
// real one takes only real keys, when the console checks a key it is given.
let provider: Server;
let providerUrl: string;
beforeAll(async () => {
  provider = createServer((request, response) => {
    response.statusCode = request.headers.authorization === `Bearer ${OPENAI_KEY}` ? 200 : 401;
    response.end("{}");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => provider.close(() => resolve())));

async function start(access?: "off" | "operator" | "all"): Promise<void> {
  if (app !== undefined) await app.close();
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    gateway: { keys: providerKeys, access: "all", upstream: { openai: providerUrl } },
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
  providerKeys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  providerKeys.close();
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

const OPENAI_KEY = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
const ANTHROPIC_KEY = "sk-ant-api03-" + "Z9y8X7w6V5u4T3s2R1q0P9o8";
const GATEWAY = "https://get-sigillo.eu/llm";

describe("an uploaded agent through the model gateway", () => {
  const through = (source: string): Added => {
    const result = setup(source, { ...SETTINGS, gateway: GATEWAY } as typeof SETTINGS);
    if (result.status !== "added") throw new Error("expected added");
    return result;
  };

  it("replaces the OpenAI key in the file by the sigillo key, points the client at the gateway, and hands the real key back", () => {
    const result = through(`from openai import OpenAI\nclient = OpenAI(api_key="${OPENAI_KEY}")\n`) as Added & { providers: Record<string, string> };
    expect(result.providers).toEqual({ openai: OPENAI_KEY });
    expect(result.text).not.toContain(OPENAI_KEY);
    expect(result.text).toContain('client = OpenAI(api_key="sigillo_abc_def")');
    expect(result.text.startsWith('import os\nos.environ["OPENAI_BASE_URL"] = "https://get-sigillo.eu/llm/openai/v1"\nos.environ["OPENAI_API_KEY"] = "sigillo_abc_def"\n\ntry:')).toBe(true);
    if (python) expect(parses(result.text)).toBe(true);
  });

  it("does the same for Anthropic, and tells the two apart", () => {
    const result = through(`import anthropic\nk = "${ANTHROPIC_KEY}"\n`) as Added & { providers: Record<string, string> };
    expect(result.providers).toEqual({ anthropic: ANTHROPIC_KEY });
    expect(result.text).toContain('os.environ["ANTHROPIC_BASE_URL"] = "https://get-sigillo.eu/llm/anthropic"');
    expect(result.text).not.toContain("OPENAI_BASE_URL");
  });

  it("routes a client whose key is not in the file too, with no key to hand back: the page asks for it", () => {
    const result = through("import openai\nclient = openai.OpenAI()\n") as Added & { providers: Record<string, string> };
    expect(result.providers).toEqual({ openai: "" });
    expect(result.text).toContain("OPENAI_BASE_URL");
  });

  it("leaves a file alone that uses no provider, and does not take 'task-' for a key", () => {
    const result = through('name = "task-manager-for-the-whole-team-today"\nprint(name)\n') as Added & { providers: Record<string, string> };
    expect(result.providers).toEqual({});
    expect(result.text).toContain("task-manager-for-the-whole-team-today");
    expect(result.text).not.toContain("_BASE_URL");
  });

  it("changes nothing without the gateway", () => {
    const result = added(`from openai import OpenAI\nOpenAI(api_key="${OPENAI_KEY}")\n`);
    expect(result.text).toContain(OPENAI_KEY);
    expect(result.text).not.toContain("_BASE_URL");
  });

  it("is offered with protection, and its form posts to the key route", async () => {
    await start("operator");
    const page = await newKey(OPERATOR, OPERATOR_BOT);
    expect(page).toContain('data-gateway="http://');
    expect(page).toContain(`action="/ui/systems/${OPERATOR_BOT}/llm-key"`);
    // Read first, then asked: the choice and the download button come after the file picker, hidden, unticked.
    expect(page).toContain('id="sigillo-agent-choice" hidden');
    expect(page).not.toMatch(/id="sigillo-agent-secure"[^>]*checked/);
    expect(page.indexOf('id="sigillo-agent-choice"')).toBeGreaterThan(page.indexOf('id="sigillo-agent-file"'));
    expect(page).toContain('id="sigillo-agent-download"');
    expect(await newKey(ACME, ACME_BOT)).not.toContain("data-gateway");
  });

  it("saves the key sealed, and refuses one that is not a key, and a customer's system until it is opened", async () => {
    await start("operator");
    const post = (viewer: Viewer, systemId: string, payload: string) =>
      app!.inject({
        method: "POST",
        url: `/ui/systems/${systemId}/llm-key`,
        headers: { cookie: cookie(viewer), "content-type": "application/x-www-form-urlencoded" },
        payload,
      });
    const saved = await post(OPERATOR, OPERATOR_BOT, `provider=openai&key=${OPENAI_KEY}`);
    expect(saved.statusCode).toBe(303);
    expect(providerKeys.get(OPERATOR_BOT, "openai")).toBe(OPENAI_KEY);
    expect((await post(OPERATOR, OPERATOR_BOT, "provider=openai&key=nope")).statusCode).toBe(400);
    expect((await post(OPERATOR, OPERATOR_BOT, "provider=other&key=" + OPENAI_KEY)).statusCode).toBe(400);
    expect((await post(ACME, ACME_BOT, `provider=openai&key=${OPENAI_KEY}`)).statusCode).toBe(404);
    expect(providerKeys.get(ACME_BOT, "openai")).toBeNull();
  });

  it("does not save a key the provider refuses, such as one that lost a character on the way, and says so", async () => {
    await start("operator");
    const refused = await app!.inject({
      method: "POST",
      url: `/ui/systems/${OPERATOR_BOT}/llm-key`,
      headers: { cookie: cookie(OPERATOR), "content-type": "application/x-www-form-urlencoded" },
      payload: `provider=openai&key=${OPENAI_KEY.slice(0, -1)}`,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("refused this key");
    expect(providerKeys.get(OPERATOR_BOT, "openai")).toBeNull();
  });
});

describe("agent protection: a model on the same computer", () => {
  type Settings = typeof SETTINGS & { protection?: boolean };
  const run = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: Settings) => Result;
  const OLLAMA = 'from openai import OpenAI\nclient = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")\n';

  const text = (source: string, settings: Settings): string => {
    const result = run(source, settings);
    if (result.status !== "added") throw new Error("expected the lines added");
    return result.text;
  };

  it("with protection, calls the model with the sigillo key, asks for the newer SDK and tells the guard", () => {
    const out = text(OLLAMA, { ...SETTINGS, protection: true });
    expect(out).toContain('api_key="sigillo_abc_def"');
    expect(out).not.toContain('"ollama"');
    expect(out).toContain('os.environ["OLLAMA_API_KEY"] = "sigillo_abc_def"');
    expect(out).toContain("    local_model=True,");
    expect(out).toContain("< (0, 5):");
    if (python) expect(parses(out)).toBe(true);
  });

  it("recognises the ollama library as well, and leaves a file with no local model alone", () => {
    expect(text("import ollama\nollama.chat(model='m')\n", { ...SETTINGS, protection: true })).toContain("local_model=True");
    const cloud = text("from openai import OpenAI\nOpenAI()\n", { ...SETTINGS, protection: true });
    expect(cloud).not.toContain("local_model");
    expect(cloud).toContain("< (0, 4):");
  });

  it("recognises the other local servers by their usual address, and names the port to the SDK", () => {
    const lmStudio = 'from openai import OpenAI\nclient = OpenAI(base_url="http://localhost:1234/v1", api_key="lm-studio")\n';
    const out = text(lmStudio, { ...SETTINGS, protection: true });
    expect(out).toContain('api_key="sigillo_abc_def"');
    expect(out).toContain("    local_model=1234,");
    expect(out).toContain("< (0, 7):");
    expect(out).not.toContain("OLLAMA_API_KEY");
    expect(text(lmStudio.replace("1234", "8080"), { ...SETTINGS, protection: true })).toContain("local_model=8080,");
    expect(text(lmStudio, { ...SETTINGS, protection: false })).not.toContain("local_model");
    if (python) expect(parses(out)).toBe(true);
  });

  it("does nothing about it where protection is off (rule 11)", () => {
    const out = text(OLLAMA, { ...SETTINGS, protection: false });
    expect(out).toContain('api_key="ollama"');
    expect(out).not.toContain("local_model");
    expect(out).not.toContain("OLLAMA_API_KEY");
  });
});

describe("agent protection: a plain agent that starts its own Ollama", () => {
  it("is recorded by the stdlib instrumentation even where plain agents are not opened, so that it can send the key", () => {
    const source = 'import json, urllib.request\nOLLAMA_HOST = "http://localhost:11434"\nurllib.request.urlopen(OLLAMA_HOST + "/api/tags")\n';
    const run = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloAgentSetup`) as (source: string, settings: typeof SETTINGS & { protection?: boolean }) => Result;
    const result = run(source, { ...SETTINGS, protection: true });
    if (result.status !== "added") throw new Error("expected the lines added");
    expect(result.text).toContain('instrument=["stdlib"]');
    expect(result.text).toContain("local_model=True");
    expect(result.text).toContain('OLLAMA_HOST = "http://localhost:11434"'); // the agent's own lines are untouched
  });
});

describe("an uploaded agent whose cloud key is in a .env file", () => {
  const through = (source: string) => {
    const result = setup(source, { ...SETTINGS, gateway: GATEWAY } as typeof SETTINGS);
    if (result.status !== "added") throw new Error("expected added");
    return result as Added & { providers: Record<string, string> };
  };

  it("is seen through LangChain, the key's variable or python-dotenv, and the page asks for the key", () => {
    const cases: Array<[string, string]> = [
      ["from langchain_anthropic import ChatAnthropic\nllm = ChatAnthropic(model='claude')\n", "anthropic"],
      ["from langchain_openai import ChatOpenAI\nllm = ChatOpenAI()\n", "openai"],
      ['import os\nfrom dotenv import load_dotenv\nload_dotenv()\nkey = os.getenv("ANTHROPIC_API_KEY")\n', "anthropic"],
      ['import os\nkey = os.environ["OPENAI_API_KEY"]\n', "openai"],
    ];
    for (const [source, provider] of cases) {
      const result = through(source);
      expect(result.providers).toEqual({ [provider]: "" });
      // Set before the file's own code runs: load_dotenv() does not override it.
      expect(result.text.indexOf(`os.environ["${provider.toUpperCase()}_API_KEY"] = "sigillo_abc_def"`)).toBeLessThan(result.text.indexOf("load_dotenv") >>> 0);
      if (python) expect(parses(result.text)).toBe(true);
    }
  });

  it("points an agent that calls the provider's address itself at the gateway", () => {
    const source =
      'import os, json, urllib.request\nreq = urllib.request.Request("https://api.anthropic.com/v1/messages", headers={"x-api-key": os.getenv("ANTHROPIC_API_KEY")})\n' +
      'other = "https://api.openai.com/v1/chat/completions"\n';
    const result = through(source);
    expect(result.providers).toEqual({ openai: "", anthropic: "" });
    expect(result.text).toContain('"https://get-sigillo.eu/llm/anthropic/v1/messages"');
    expect(result.text).toContain('"https://get-sigillo.eu/llm/openai/v1/chat/completions"');
    expect(result.text).not.toContain("api.anthropic.com");
    expect(result.text).not.toContain("api.openai.com");
  });
});

describe("an uploaded agent that calls Mistral by itself", () => {
  it("takes the key out of the file, points the address at the gateway, and hands the key back for sigillo to keep", () => {
    const realKey = "mstrl_" + "INpYbOBBvox4azineaU08E7LXgz";
    const source =
      'import os, urllib.request\nMISTRAL_API_KEY_DEFAULT = "' + realKey + '"\nMISTRAL_URL = "https://api.mistral.ai/v1/chat/completions"\n' +
      'os.environ.setdefault("MISTRAL_API_KEY", MISTRAL_API_KEY_DEFAULT)\n';
    const result = setup(source, { ...SETTINGS, gateway: GATEWAY } as typeof SETTINGS) as Added & { providers: Record<string, string> };
    expect(result.providers).toEqual({ mistral: realKey });
    expect(result.text).not.toContain(realKey);
    expect(result.text).toContain('MISTRAL_API_KEY_DEFAULT = "sigillo_abc_def"');
    expect(result.text).toContain('MISTRAL_URL = "https://get-sigillo.eu/llm/mistral/v1/chat/completions"');
    expect(result.text).toContain('os.environ["MISTRAL_API_KEY"] = "sigillo_abc_def"');
    if (python) expect(parses(result.text)).toBe(true);
  });
});

describe("an uploaded agent for any of the cloud providers in the catalog", () => {
  const through = (source: string) => {
    const result = setup(source, { ...SETTINGS, gateway: GATEWAY } as typeof SETTINGS);
    if (result.status !== "added") throw new Error("expected added");
    return result as Added & { providers: Record<string, string> };
  };
  const GEMINI_KEY = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW";
  const GROQ_KEY = "gsk_" + "Qw9eR8tY7uI6oP5aS4dF3gH2jK1l";
  const DEEPSEEK_KEY = "sk-" + "0123456789abcdef0123456789abcdef";

  it("routes Gemini's own client through the variables it reads, its key included", () => {
    const result = through(`from google import genai\nclient = genai.Client(api_key="${GEMINI_KEY}")\n`);
    expect(result.providers).toEqual({ gemini: GEMINI_KEY });
    expect(result.text).not.toContain(GEMINI_KEY);
    expect(result.text).toContain('os.environ["GOOGLE_GEMINI_BASE_URL"] = "https://get-sigillo.eu/llm/gemini"');
    expect(result.text).toContain('os.environ["GEMINI_API_BASE"] = "https://get-sigillo.eu/llm/gemini/v1beta"');
    // google-genai reads GOOGLE_API_KEY before GEMINI_API_KEY: both are the sigillo key.
    expect(result.text).toContain('os.environ["GOOGLE_API_KEY"] = "sigillo_abc_def"');
    expect(result.text).toContain('os.environ["GEMINI_API_KEY"] = "sigillo_abc_def"');
    if (python) expect(parses(result.text)).toBe(true);
  });

  it("does not take a Google key for Gemini's by itself, nor touch the older client it cannot point anywhere", () => {
    const maps = through(`MAPS = "${GEMINI_KEY}"\n`);
    expect(maps.providers).toEqual({});
    expect(maps.text).toContain(GEMINI_KEY);
    const old = through(`import google.generativeai as genai\ngenai.configure(api_key="${GEMINI_KEY}")\n`);
    expect(old.providers).toEqual({});
    expect(old.text).toContain(GEMINI_KEY);
  });

  it("takes the openai library's calls to another provider for that provider's, and an sk- key with them", () => {
    const groq = through(`from openai import OpenAI\nc = OpenAI(base_url="https://api.groq.com/openai/v1", api_key="${GROQ_KEY}")\n`);
    expect(groq.providers).toEqual({ groq: GROQ_KEY });
    expect(groq.text).toContain('base_url="https://get-sigillo.eu/llm/groq/openai/v1"');
    expect(groq.text).not.toContain("OPENAI_BASE_URL");
    const deepseek = through(`from openai import OpenAI\nc = OpenAI(base_url="https://api.deepseek.com", api_key="${DEEPSEEK_KEY}")\n`);
    expect(deepseek.providers).toEqual({ deepseek: DEEPSEEK_KEY });
    expect(deepseek.text).toContain('base_url="https://get-sigillo.eu/llm/deepseek"');
    expect(deepseek.text).not.toContain(DEEPSEEK_KEY);
    // The same key next to OpenAI's own address stays OpenAI's.
    const both = through(`x = "https://api.openai.com/v1"\ny = "https://api.deepseek.com"\nk = "${DEEPSEEK_KEY}"\n`);
    expect(both.providers).toEqual({ openai: DEEPSEEK_KEY, deepseek: "" });
  });

  it("knows a provider from the model a framework is told, as LiteLLM and PydanticAI take it", () => {
    const cases: Array<[string, string[]]> = [
      ['import litellm\nlitellm.completion(model="gemini/gemini-2.5-flash", messages=[])\n', ["gemini"]],
      ['from pydantic_ai import Agent\nagent = Agent("anthropic:claude-sonnet-4-5")\n', ["anthropic"]],
      ['from crewai import LLM\nllm = LLM(model="xai/grok-4")\n', ["xai"]],
      ['import litellm\nlitellm.completion(model="mistral/mistral-large-latest", messages=[])\n', ["mistral"]],
      ['import litellm\nlitellm.completion(model="deepseek/deepseek-chat", messages=[])\n', ["deepseek"]],
      ['from smolagents import LiteLLMModel\nm = LiteLLMModel(model_id="gpt-4o")\n', ["openai"]],
    ];
    for (const [source, names] of cases) {
      expect(Object.keys(through(source).providers)).toEqual(names);
    }
    expect(through('import ollama\nollama.chat(model="mistral-small", messages=[])\n').providers).toEqual({});
    expect(through('import ollama\nollama.chat(model="gpt-oss", messages=[])\n').providers).toEqual({});
  });

  it("gives LiteLLM and LangChain the variables they read, and asks for a newer sigillo for mistralai's own client", () => {
    const litellm = through('import os\nkey = os.environ["MISTRAL_API_KEY"]\n');
    expect(litellm.text).toContain('os.environ["MISTRAL_API_BASE"] = "https://get-sigillo.eu/llm/mistral/v1"');
    expect(litellm.text).toContain("< (0, 4):");
    const client = through("from mistralai import Mistral\nclient = Mistral()\n");
    expect(client.providers).toEqual({ mistral: "" });
    expect(client.text).toContain("< (0, 6):");
  });

  it("knows each of the others by the variable its key is read from", () => {
    const variables: Record<string, string> = {
      groq: "GROQ_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      xai: "XAI_API_KEY",
      together: "TOGETHER_API_KEY",
      fireworks: "FIREWORKS_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
      cohere: "CO_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      moonshot: "MOONSHOT_API_KEY",
      qwen: "DASHSCOPE_API_KEY",
      zai: "ZAI_API_KEY",
      nvidia: "NVIDIA_API_KEY",
      sambanova: "SAMBANOVA_API_KEY",
    };
    for (const [name, variable] of Object.entries(variables)) {
      const result = through(`import os\nkey = os.getenv("${variable}")\n`);
      expect(result.providers, variable).toEqual({ [name]: "" });
      expect(result.text).toContain(`os.environ["${variable}"] = "sigillo_abc_def"`);
      expect(result.text).toContain(`"https://get-sigillo.eu/llm/${name}`);
      if (python) expect(parses(result.text)).toBe(true);
    }
  });
});
