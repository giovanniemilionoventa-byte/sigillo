/**
 * "Upload your agent" on the connect page: the customer picks the agent's .py
 * file, and the browser gives it back with the sigillo lines already in it,
 * the key included, plus the install command for the framework it uses. The
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

  var block = [
    "import sigillo",
    "",
    "sigillo.init(",
    "    endpoint=" + JSON.stringify(settings.endpoint) + ",",
    "    api_key=" + JSON.stringify(settings.key) + ",",
    "    system_id=" + JSON.stringify(settings.system) + ",",
  ];
  if (frameworks.length > 0) block.push("    instrument=" + JSON.stringify(frameworks).replace(/,/g, ", ") + ",");
  block.push(")");
  var head = lines.slice(0, at);
  var tail = lines.slice(at);
  while (tail.length > 1 && /^\\s*$/.test(tail[0])) tail.shift();
  var parts = head.length > 0 ? head.concat([""], block) : block.slice();
  if (tail.length > 0) parts = parts.concat([""], tail);
  var extras = frameworks.length > 0 ? "[" + frameworks.join(",") + "]" : "";
  return {
    status: "added",
    text: bom + parts.join(eol),
    frameworks: frameworks,
    install: 'pip install "sigillo' + extras + " @ " + settings.url + '"',
  };
}`;

export const AGENT_SETUP_SCRIPT = `(function () {
${AGENT_SETUP_SOURCE}

  var box = document.getElementById("sigillo-agent");
  if (box === null) return;
  var input = document.getElementById("sigillo-agent-file");
  var done = document.getElementById("sigillo-agent-done");
  var problem = document.getElementById("sigillo-agent-problem");
  var install = document.querySelector(".code.install");
  box.classList.add("ready");
  var show = function (element, text) {
    done.hidden = true;
    problem.hidden = true;
    element.querySelector("span").textContent = text;
    element.hidden = false;
  };
  input.addEventListener("change", async function () {
    var file = input.files[0];
    if (file === undefined) return;
    if (!/\\.py$/i.test(file.name) || file.size > 1048576) {
      show(problem, box.dataset.notPython);
      return;
    }
    var result = sigilloAgentSetup(await file.text(), {
      endpoint: box.dataset.endpoint,
      key: box.dataset.key,
      system: box.dataset.system,
      url: box.dataset.url,
    });
    if (result.status === "already") {
      show(problem, box.dataset.already.replace("{file}", file.name));
      return;
    }
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([result.text], { type: "text/x-python" }));
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (install !== null) install.textContent = result.install;
    show(done, (result.frameworks.length > 0 ? box.dataset.done : box.dataset.doneNoFramework).replace("{file}", file.name));
    input.value = "";
  });
})();
`;
