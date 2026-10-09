/**
 * "Upload your agent" on the connect page: the customer picks the agent's .py
 * file, and the browser gives it back with the sigillo lines already in it,
 * the key included. Those lines install the SDK, with the instrumentation for
 * the framework the file uses, the first time the file runs: nothing else to
 * type. The page offers the two commands below it as the other way, by hand. The
 * file is read and rewritten in the browser: it is never sent to the server.
 *
 * AGENT_SETUP_SOURCE is the part that decides what the new file says, a pure
 * function with no access to the page, so apps/server/test/agent-setup.test.ts
 * runs the very characters the browser runs. AGENT_SETUP_SCRIPT wraps it with
 * the page's side: reading the file, offering the download, showing the result.
 * It is served as /ui/agent-setup.js, a script file of this origin, which the
 * Content-Security-Policy's `script-src 'self'` already allows.
 */

export const AGENT_SETUP_SOURCE = `function sigilloAgentSetup(source, settings) {
  var eol = source.indexOf("\\r\\n") >= 0 ? "\\r\\n" : "\\n";
  var bom = source.charAt(0) === "\\uFEFF" ? "\\uFEFF" : "";
  var lines = source.slice(bom.length).split(/\\r?\\n/);

  if (/^\\s*(import sigillo\\b|sigillo\\.init\\()/m.test(source)) return { status: "already" };

  // The model gateway (settings.gateway, an address): the provider keys in the
  // file are replaced by the system's sigillo key, and the OpenAI and
  // Anthropic clients are pointed at the gateway through the variables they
  // read themselves, set before anything else runs. The real keys come back
  // in \`providers\` so that the page can offer to save them in sigillo; the
  // new file has none of them. A key not in the file (a .env, the shell) is
  // not seen here: the page asks for it.
  var providers = {};
  var gatewayLines = [];
  if (settings.gateway) {
    var shapes = [
      ["anthropic", /\\bsk-ant-[A-Za-z0-9_-]{20,}/g],
      ["openai", /\\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
    ];
    shapes.forEach(function (shape) {
      var found = source.match(shape[1]);
      if (found !== null) providers[shape[0]] = found[0];
      source = source.replace(shape[1], settings.key);
    });
    lines = source.slice(bom.length).split(/\\r?\\n/);
    var via = [
      ["openai", "OPENAI", "/openai/v1"],
      ["anthropic", "ANTHROPIC", "/anthropic"],
    ];
    via.forEach(function (provider) {
      var uses = Object.prototype.hasOwnProperty.call(providers, provider[0]) ||
        new RegExp("^\\\\s*(from|import)\\\\s+" + provider[0] + "\\\\b", "m").test(source);
      if (!uses) return;
      if (!Object.prototype.hasOwnProperty.call(providers, provider[0])) providers[provider[0]] = "";
      gatewayLines.push(
        "os.environ[" + JSON.stringify(provider[1] + "_BASE_URL") + "] = " + JSON.stringify(settings.gateway + provider[2]),
        "os.environ[" + JSON.stringify(provider[1] + "_API_KEY") + "] = " + JSON.stringify(settings.key),
      );
    });
    if (gatewayLines.length > 0) gatewayLines.unshift("import os");
  }

  // Which instrumentation: LangChain and LangGraph, CrewAI, or the OpenAI
  // client on its own. The first two already record the model calls they make,
  // so the OpenAI one is added only where neither is used, never twice.
  var imported = function (pattern) {
    return new RegExp("^\\\\s*(from|import)\\\\s+(" + pattern + ")\\\\b", "m").test(source);
  };
  var frameworks = [];
  if (imported("langchain\\\\w*|langgraph\\\\w*")) frameworks.push("langchain");
  if (imported("crewai\\\\w*")) frameworks.push("crewai");
  if (frameworks.length === 0 && imported("openai")) frameworks.push("openai");

  // Where Python allows the lines: after the comments the file opens with
  // (a #! line, an encoding line), its docstring, and any
  // \`from __future__\` import, which must stay first.
  var at = 0;
  var skipBlank = function () {
    while (at < lines.length && /^\\s*(#.*)?$/.test(lines[at])) at += 1;
  };
  skipBlank();
  var docstring = at < lines.length ? /^[rRuU]?("""|''')/.exec(lines[at]) : null;
  if (docstring !== null) {
    var quote = docstring[1];
    var rest = lines[at].slice(docstring[0].length);
    if (rest.indexOf(quote) < 0) {
      at += 1;
      while (at < lines.length && lines[at].indexOf(quote) < 0) at += 1;
    }
    at += 1;
  } else if (at < lines.length && /^[rRuU]?("[^"]*"|'[^']*')\\s*$/.test(lines[at])) {
    at += 1;
  }
  for (;;) {
    var before = at;
    skipBlank();
    if (at < lines.length && /^from\\s+__future__\\s+import\\b/.test(lines[at])) {
      if (lines[at].indexOf("(") >= 0) {
        while (at < lines.length && lines[at].indexOf(")") < 0) at += 1;
      }
      at += 1;
    } else {
      at = before;
      break;
    }
  }
  while (at > 0 && /^\\s*$/.test(lines[at - 1])) at -= 1;

  // The file installs what it needs by itself, the first time it runs, with
  // the same Python that runs it: downloading it is the whole installation.
  var extras = frameworks.length > 0 ? "[" + frameworks.join(",") + "]" : "";
  var requirement = "sigillo" + extras + " @ " + settings.url;
  var block = gatewayLines.concat(gatewayLines.length > 0 ? [""] : [], ["try:", "    import sigillo"]);
  frameworks.forEach(function (name) {
    block.push("    import openinference.instrumentation." + name);
  });
  block.push(
    "except ImportError:",
    "    import importlib",
    "    import subprocess",
    "    import sys",
    "",
    '    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", ' + JSON.stringify(requirement) + "])",
    "    importlib.invalidate_caches()",
    "    import sigillo",
    "",
    "sigillo.init(",
  );
  block.push(
    "    endpoint=" + JSON.stringify(settings.endpoint) + ",",
    "    api_key=" + JSON.stringify(settings.key) + ",",
    "    system_id=" + JSON.stringify(settings.system) + ",",
  );
  if (frameworks.length > 0) block.push("    instrument=" + JSON.stringify(frameworks).replace(/,/g, ", ") + ",");
  if (settings.protection) block.push("    strict=True,");
  block.push(")");
  var head = lines.slice(0, at);
  var tail = lines.slice(at);
  while (tail.length > 1 && /^\\s*$/.test(tail[0])) tail.shift();
  var parts = head.length > 0 ? head.concat([""], block) : block.slice();
  if (tail.length > 0) parts = parts.concat([""], tail);
  return {
    status: "added",
    text: bom + parts.join(eol),
    frameworks: frameworks,
    install: 'pip install "' + requirement + '"',
    providers: providers,
  };
}`;

export const AGENT_SETUP_SCRIPT = `(function () {
${AGENT_SETUP_SOURCE}

  var box = document.getElementById("sigillo-agent");
  if (box === null) return;
  var input = document.getElementById("sigillo-agent-file");
  var done = document.getElementById("sigillo-agent-done");
  var problem = document.getElementById("sigillo-agent-problem");
  var choice = document.getElementById("sigillo-agent-choice");
  box.classList.add("ready");
  var show = function (element, text) {
    done.hidden = true;
    problem.hidden = true;
    element.querySelector("span").textContent = text;
    element.hidden = false;
  };
  var base = {
    endpoint: box.dataset.endpoint,
    key: box.dataset.key,
    system: box.dataset.system,
    url: box.dataset.url,
    protection: box.dataset.protection === "true",
  };
  var give = function (name, result) {
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([result.text], { type: "text/x-python" }));
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    show(done, (result.frameworks.length > 0 ? box.dataset.done : box.dataset.doneNoFramework).replace("{file}", name));
  };
  input.addEventListener("change", async function () {
    var file = input.files[0];
    if (file === undefined) return;
    if (choice !== null) choice.hidden = true;
    if (!/\\.py$/i.test(file.name) || file.size > 1048576) {
      show(problem, box.dataset.notPython);
      return;
    }
    var text = await file.text();
    var plain = sigilloAgentSetup(text, base);
    if (plain.status === "already") {
      show(problem, box.dataset.already.replace("{file}", file.name));
      return;
    }
    input.value = "";
    if (choice === null) {
      give(file.name, plain);
      return;
    }
    // The model gateway: the file is read first, and what it uses is said
    // before anything is downloaded. Only an agent that calls a cloud model
    // is offered the choice; the file keeps its own key unless it is ticked.
    var routed = sigilloAgentSetup(text, Object.assign({ gateway: box.dataset.gateway }, base));
    var names = Object.keys(routed.providers);
    var tick = document.getElementById("sigillo-agent-secure");
    var label = document.getElementById("sigillo-agent-secure-label");
    var save = document.getElementById("sigillo-agent-model");
    save.hidden = true;
    done.hidden = true;
    problem.hidden = true;
    tick.checked = false;
    label.hidden = names.length === 0;
    document.getElementById("sigillo-agent-analysis").textContent = names.length > 0
      ? box.dataset.analysisCloud.replace("{providers}", names.join(", "))
      : box.dataset.analysisOther;
    choice.hidden = false;
    document.getElementById("sigillo-agent-download").onclick = function () {
      var result = tick.checked ? routed : plain;
      give(file.name, result);
      choice.hidden = true;
      if (tick.checked) {
        // The key found in the file (or none) goes into a form the person
        // submits, since this page may not make requests of its own.
        var pick = names.filter(function (name) { return routed.providers[name] !== ""; })[0] || names[0];
        save.elements.provider.value = pick;
        save.elements.key.value = routed.providers[pick];
        save.hidden = false;
      }
    };
  });
})();
`;
