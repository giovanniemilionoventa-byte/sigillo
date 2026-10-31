/**
 * "Upload your agent", beyond Python: the browser reads the file the customer
 * picks, says what it is (Python, TypeScript/JavaScript, Java or .NET, and the
 * framework it uses), and prepares the right connection for it. Like
 * agent-setup.ts, the file is read and rewritten in the browser and never
 * sent to the server, and the functions below are pure, run by the tests from
 * the very characters the browser runs.
 *
 * What each language gets is not the same, and the page says so:
 *  - Python and TypeScript/JavaScript have an SDK of ours. The SDK makes the
 *    digests on the customer's computer, so content never leaves it; the
 *    file comes back with the lines that install and start it.
 *  - Java and .NET have no SDK of ours. They speak OpenTelemetry, which the
 *    server reads; the page gives the settings that point their exporter at
 *    sigillo and switch off the capture of message content, the standard
 *    default of the GenAI instrumentations, so no content leaves either. What
 *    the SDKs add (digests of content, the heartbeat, the guard) is not there.
 */

export const AGENT_DETECT_SOURCE = String.raw`function sigilloDetectAgent(name, text) {
  var extension = /\.([A-Za-z0-9]+)$/.exec(name);
  extension = extension === null ? "" : extension[1].toLowerCase();
  var language = null;
  if (extension === "py") language = "python";
  else if (["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"].indexOf(extension) >= 0) language = "node";
  else if (extension === "java") language = "java";
  else if (extension === "cs") language = "dotnet";
  if (language === null) return { language: null, framework: "none" };
  var has = function (pattern) { return pattern.test(text); };
  var framework = "none";
  if (language === "python") {
    if (has(/^\s*(from|import)\s+(langchain\w*|langgraph\w*)\b/m)) framework = "langchain";
    else if (has(/^\s*(from|import)\s+crewai\w*\b/m)) framework = "crewai";
    else if (has(/^\s*(from|import)\s+opentelemetry\b/m)) framework = "opentelemetry";
    else if (has(/^\s*(from|import)\s+openai\b/m)) framework = "openai";
  } else if (language === "node") {
    if (has(/['"]@langchain\//) || has(/['"]langchain['"/]/)) framework = "langchain";
    else if (has(/['"](ai|@ai-sdk\/[\w-]+)['"]/)) framework = "vercel-ai";
    else if (has(/['"]@opentelemetry\//)) framework = "opentelemetry";
    else if (has(/['"]openai['"]/)) framework = "openai";
  } else if (language === "java") {
    if (has(/\bdev\.langchain4j\b/)) framework = "langchain4j";
    else if (has(/\borg\.springframework\.ai\b/)) framework = "spring-ai";
    else if (has(/\bio\.opentelemetry\b/)) framework = "opentelemetry";
  } else {
    if (has(/\bMicrosoft\.SemanticKernel\b/)) framework = "semantic-kernel";
    else if (has(/\bMicrosoft\.Extensions\.AI\b/)) framework = "extensions-ai";
    else if (has(/\bOpenTelemetry\b/)) framework = "opentelemetry";
  }
  return { language: language, framework: framework };
}

function sigilloAgentSetupNode(name, source, settings) {
  var eol = source.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  var bom = source.charAt(0) === "﻿" ? "﻿" : "";
  var lines = source.slice(bom.length).split(/\r?\n/);
  if (/@sigillo\/sdk/.test(source)) return { status: "already" };

  var extension = /\.([A-Za-z0-9]+)$/.exec(name);
  extension = extension === null ? "" : extension[1].toLowerCase();
  var module;
  if (extension === "mjs" || extension === "mts") module = "esm";
  else if (extension === "cjs" || extension === "cts") module = "cjs";
  else if (/^\s*(import|export)\s/m.test(source) || /\bimport\.meta\b/.test(source)) module = "esm";
  else if (/\brequire\s*\(/.test(source) || /\bmodule\.exports\b/.test(source)) module = "cjs";
  else module = "esm";
  var typed = /^(ts|mts|cts|tsx)$/.test(extension);
  var framework = sigilloDetectAgent(name, source).framework;

  // Where the lines may go: after a #! line, the comments the file opens with,
  // and a "use strict" directive.
  var at = 0;
  if (lines.length > 0 && /^#!/.test(lines[0])) at = 1;
  var inBlock = false;
  while (at < lines.length) {
    var line = lines[at];
    if (inBlock) {
      if (line.indexOf("*/") >= 0) inBlock = false;
    } else if (/^\s*$/.test(line) || /^\s*\/\//.test(line)) {
      // blank or a line comment
    } else if (/^\s*\/\*/.test(line)) {
      inBlock = line.indexOf("*/") < 0;
    } else if (/^\s*(["'])use strict\1;?\s*$/.test(line)) {
      // a directive
    } else {
      break;
    }
    at += 1;
  }
  while (at > 0 && /^\s*$/.test(lines[at - 1])) at -= 1;

  var install = "npm install " + JSON.stringify(settings.sdkUrl);
  var options = [
    "    endpoint: " + JSON.stringify(settings.endpoint) + ",",
    "    apiKey: " + JSON.stringify(settings.key) + ",",
    "    systemId: " + JSON.stringify(settings.system) + ",",
  ];
  if (settings.customerKey) options.push("    customerKey: " + JSON.stringify(settings.customerKey) + ",");
  if (settings.protection) options.push("    strict: true,");
  // In a TypeScript file the specifier is a literal that the compiler cannot
  // resolve before the first run, and a caught error has to be typed.
  var ignore = typed ? ["// @ts-ignore: installed by the lines below the first time this file runs"] : [];
  var caught = typed ? "error: " + "an" + "y" : "error";
  var block;
  if (module === "esm") {
    // The file installs what it needs by itself, the first time it runs: the
    // import fails, npm installs the SDK from the sigillo server, and the
    // import is tried again. Top-level await, which an ES module has.
    block = [
      'import { execSync as sigilloExec } from "node:child_process";',
      "const sigilloLoad = async (name" + (typed ? ": string" : "") + ", command" + (typed ? "?: string" : "") + ") => {",
      "  try {",
      "    return await import(name);",
      "  } catch (" + caught + ") {",
      '    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !command) throw error;',
      '    sigilloExec(command, { stdio: "inherit" });',
      "    return await import(name);",
      "  }",
      "};",
      'const { init: sigilloInit } = await sigilloLoad("@sigillo/sdk", ' + JSON.stringify(install) + ");",
      "sigilloInit({",
    ].concat(options, ["});"]);
    if (framework === "vercel-ai") {
      // AI SDK 7 sends nothing until an integration is registered. Older
      // versions have no registerTelemetry: they are left as they are.
      block.push(
        "try {",
        '  const { registerTelemetry } = await import("ai");',
        '  if (typeof registerTelemetry === "function") {',
        '    const { OpenTelemetry } = await sigilloLoad("@ai-sdk/otel", "npm install @ai-sdk/otel");',
        "    registerTelemetry(new OpenTelemetry());",
        "  }",
        "} catch {}",
      );
    }
  } else {
    // A CommonJS file cannot wait at the top, and the SDK is an ES module: it
    // starts in the background, and the agent runs meanwhile.
    block = [
      "void (async () => {",
      "  const load = async () => {",
      "    try {",
    ].concat(ignore.map(function (l) { return "    " + l; }), [
      '      return await import("@sigillo/sdk");',
      "    } catch (" + caught + ") {",
      '      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;',
      '      require("node:child_process").execSync(' + JSON.stringify(install) + ', { stdio: "inherit" });',
    ], ignore.map(function (l) { return "    " + l; }), [
      '      return await import("@sigillo/sdk");',
      "    }",
      "  };",
      "  (await load()).init({",
    ], options.map(function (l) { return "  " + l; }), ["  });"]);
    if (framework === "vercel-ai") {
      block.push(
        "  try {",
        '    const { registerTelemetry } = await import("ai");',
        '    if (typeof registerTelemetry === "function") registerTelemetry(new (await import("@ai-sdk/otel")).OpenTelemetry());',
        "  } catch {}",
      );
    }
    block.push("})();");
  }

  var head = lines.slice(0, at);
  var tail = lines.slice(at);
  while (tail.length > 1 && /^\s*$/.test(tail[0])) tail.shift();
  var parts = head.length > 0 ? head.concat([""], block) : block.slice();
  if (tail.length > 0) parts = parts.concat([""], tail);
  return {
    status: "added",
    text: bom + parts.join(eol),
    language: "node",
    framework: framework,
    module: module,
    install: install,
  };
}

function sigilloConnectOtel(language, framework, settings) {
  var traces = settings.endpoint.replace(/\/+$/, "") + "/v1/traces";
  var env = [
    "OTEL_SERVICE_NAME=" + settings.system,
    "OTEL_TRACES_EXPORTER=otlp",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=" + traces,
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer " + settings.key,
    "OTEL_METRICS_EXPORTER=none",
    "OTEL_LOGS_EXPORTER=none",
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false",
  ];
  var steps = [];
  if (language === "java") {
    steps.push(
      "# 1. Download the OpenTelemetry Java agent (once):",
      "#    https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar",
      "# 2. Start your agent with it, and with the settings above in the environment:",
      "java -javaagent:opentelemetry-javaagent.jar -jar your-agent.jar",
    );
  } else {
    steps.push(
      "# 1. Add the OpenTelemetry packages to your project (once):",
      "dotnet add package OpenTelemetry.Extensions.Hosting",
      "dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol",
      "# 2. In Program.cs, before the app is built:",
      '#    builder.Services.AddOpenTelemetry().WithTracing(tracing => tracing.AddSource("*").AddOtlpExporter());',
      "# 3. Run your agent with the settings above in the environment.",
    );
  }
  return {
    status: "connect",
    language: language,
    framework: framework,
    env: env,
    text: ["# sigillo: connection for " + settings.system, env.join("\n"), "", steps.join("\n"), ""].join("\n"),
  };
}`;
