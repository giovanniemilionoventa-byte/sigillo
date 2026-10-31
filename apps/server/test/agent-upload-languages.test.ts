import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { FastifyInstance } from "fastify";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { ConnectionWatch } from "../src/connection/watch.js";
import { AGENT_DETECT_SOURCE } from "../src/http/agent-detect.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * "Upload your agent" for every language: the file is recognised (Python,
 * TypeScript/JavaScript, Java, .NET and the framework), the TypeScript file
 * comes back with sigillo in it and, run for real, installs the SDK from this
 * server's own download and connects; Java and .NET get the OpenTelemetry
 * settings. The functions run from the very characters the browser runs.
 */

interface Detected {
  language: "python" | "node" | "java" | "dotnet" | null;
  framework: string;
}
interface Settings {
  endpoint: string;
  key: string;
  system: string;
  sdkUrl: string;
  customerKey?: string;
  protection?: boolean;
}
interface Added {
  status: "added";
  text: string;
  framework: string;
  module: string;
  install: string;
}

const api = runInNewContext(`${AGENT_DETECT_SOURCE}; ({ detect: sigilloDetectAgent, node: sigilloAgentSetupNode, otel: sigilloConnectOtel })`) as {
  detect: (name: string, text: string) => Detected;
  node: (name: string, source: string, settings: Settings) => Added | { status: "already" };
  otel: (language: string, framework: string, settings: Settings) => { env: string[]; text: string };
};

const SETTINGS: Settings = { endpoint: "https://get-sigillo.eu", key: "sigillo_abc_def", system: "cv-bot", sdkUrl: "https://get-sigillo.eu/sigillo-sdk.tgz", customerKey: "a".repeat(64) };

describe("recognising the agent", () => {
  const cases: Array<[string, string, Detected]> = [
    ["agent.py", "from langchain_openai import ChatOpenAI\n", { language: "python", framework: "langchain" }],
    ["agent.py", "import crewai\n", { language: "python", framework: "crewai" }],
    ["agent.py", "print('hi')\n", { language: "python", framework: "none" }],
    ["agent.ts", 'import { generateText } from "ai";\n', { language: "node", framework: "vercel-ai" }],
    ["agent.mjs", 'import { ChatOpenAI } from "@langchain/openai";\n', { language: "node", framework: "langchain" }],
    ["agent.js", 'const OpenAI = require("openai");\n', { language: "node", framework: "openai" }],
    ["Agent.java", "import dev.langchain4j.model.openai.OpenAiChatModel;\n", { language: "java", framework: "langchain4j" }],
    ["Agent.java", "import org.springframework.ai.chat.client.ChatClient;\n", { language: "java", framework: "spring-ai" }],
    ["Agent.cs", "using Microsoft.SemanticKernel;\n", { language: "dotnet", framework: "semantic-kernel" }],
    ["Agent.cs", "using OpenTelemetry.Trace;\n", { language: "dotnet", framework: "opentelemetry" }],
    ["notes.txt", "hello", { language: null, framework: "none" }],
  ];
  for (const [name, text, expected] of cases) {
    it(`${name}: ${expected.language} / ${expected.framework}`, () => {
      expect(api.detect(name, text)).toEqual(expected);
    });
  }
});

describe("the TypeScript file that comes back", () => {
  const added = (name: string, source: string): Added => {
    const result = api.node(name, source, SETTINGS);
    if (result.status !== "added") throw new Error("expected lines added");
    return result;
  };

  it("keeps a #! line, comments and 'use strict' first, and the agent after the block", () => {
    const result = added("agent.cjs", '#!/usr/bin/env node\n// my agent\n"use strict";\nconst x = 1;\nconsole.log(x);\n');
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[2]).toBe('"use strict";');
    expect(result.text.endsWith("const x = 1;\nconsole.log(x);\n")).toBe(true);
    expect(result.module).toBe("cjs");
  });

  it("writes the key, the customer key and the install address, and refuses a file that already uses sigillo", () => {
    const result = added("agent.mjs", 'console.log("x");\n');
    expect(result.text).toContain('apiKey: "sigillo_abc_def"');
    expect(result.text).toContain(`customerKey: "${"a".repeat(64)}"`);
    expect(result.text).toContain('npm install \\"https://get-sigillo.eu/sigillo-sdk.tgz\\"');
    expect(api.node("agent.mjs", result.text, SETTINGS)).toEqual({ status: "already" });
  });

  it("preserves Windows line endings", () => {
    expect(added("agent.mjs", 'a();\r\nb();\r\n').text).not.toMatch(/[^\r]\n/);
  });

  it("registers the AI SDK's telemetry for a Vercel AI SDK file", () => {
    const result = added("agent.ts", 'import { generateText } from "ai";\n');
    expect(result.framework).toBe("vercel-ai");
    expect(result.text).toContain("registerTelemetry");
    expect(result.text).toContain("catch (error: any)"); // lint-allow-any: the string is the TypeScript the browser writes into a user file
    expect(added("agent.cts", 'import { generateText } from "ai";\n').text).toContain("// @ts-ignore");
  });
});

describe("Java and .NET", () => {
  it("get OpenTelemetry settings that point at sigillo and switch off message content", () => {
    for (const language of ["java", "dotnet"]) {
      const result = api.otel(language, "none", SETTINGS);
      expect(result.env).toContain("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://get-sigillo.eu/v1/traces");
      expect(result.env).toContain("OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer sigillo_abc_def");
      expect(result.env).toContain("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false");
      expect(result.text).toContain(language === "java" ? "-javaagent" : "AddOtlpExporter");
    }
  });
});

describe("a TypeScript agent, run for real against this server", { timeout: 120_000 }, () => {
  const SYSTEM = "uploaded-ts-agent";
  let directory: string;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let app: FastifyInstance;
  let token: string;
  let endpoint: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-upload-languages-"));
    const databasePath = join(directory, "sigillo.db");
    const signer = createTestSigner();
    store = ReceiptStore.open(databasePath, signer);
    await store.createSystem(SYSTEM, new Date().toISOString());
    keys = ApiKeyStore.open(databasePath);
    token = keys.issue(SYSTEM, new Date().toISOString()).token;
    app = buildServer({ store, keys, connections: new ConnectionWatch({ store }), ui: { password: "an administrator password", signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }, healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000), checkpointer: new Checkpointer({ store, now: () => new Date() }) } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    keys.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("serves the SDK as an npm tarball with the compiled files and the guard", async () => {
    const response = await app.inject({ method: "GET", url: "/sigillo-sdk.tgz" });
    expect(response.statusCode).toBe(200);
    const tar = gunzipSync(response.rawPayload).toString("latin1");
    for (const name of ["package/package.json", "package/dist/index.js", "package/dist/guard.js", "package/README.md"]) expect(tar).toContain(name);
    expect(tar).not.toContain("hunter2");
  });

  for (const [file, source] of [
    ["agent.mjs", 'await new Promise((resolve) => setTimeout(resolve, 1500));\nconsole.log("agent done");\n'],
    ["agent.cjs", 'setTimeout(() => console.log("agent done"), 2500);\n'],
  ] as const) {
    it(`installs the SDK by itself the first time ${file} runs, and connects`, async () => {
      const result = api.node(file, source, { ...SETTINGS, endpoint, key: token, system: SYSTEM, sdkUrl: `${endpoint}/sigillo-sdk.tgz`, protection: false });
      if (result.status !== "added") throw new Error("expected lines added");
      writeFileSync(join(directory, file), result.text);
      writeFileSync(join(directory, "package.json"), '{"name":"uploaded","private":true}\n');
      // Asynchronously: this process is the server the agent downloads from.
      const run = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [file], {
          cwd: directory,
          env: { PATH: process.env["PATH"] ?? "", HOME: directory, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve({ stdout, stderr });
        });
      });
      expect(run.stdout, run.stderr).toContain("agent done");
      expect(existsSync(join(directory, "node_modules", "@sigillo", "sdk", "dist", "index.js"))).toBe(true);
      expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).dependencies["@sigillo/sdk"]).toContain("sigillo-sdk.tgz");
      // The agent left; give the server a moment for the last beat to be written.
      for (let i = 0; i < 50 && !store.readChain(SYSTEM).some((r) => r.action.name === "sigillo.connection.stop"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const names = store.readChain(SYSTEM).map((receipt) => receipt.action.name);
      expect(names).toContain("sigillo.connection.start");
      expect(names.some((name) => name === "sigillo.connection.stop" || name === "sigillo.connection.ended")).toBe(true);
    });
  }
});
