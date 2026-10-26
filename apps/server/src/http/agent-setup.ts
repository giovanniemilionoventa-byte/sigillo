/**
 * "Upload your agent" on the connect page: the customer picks the agent's .py
 * file (or, for an agent written in Rust, its main.rs and Cargo.toml), and the
 * browser gives it back with the sigillo lines already in it, the key included. Those lines install the SDK, with the instrumentation for
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

import { fileCatalog } from "../gateway/catalog.js";

/**
 * The model gateway, for either language: which cloud providers a file uses,
 * the file with their addresses pointed at the gateway and their keys replaced
 * by the system's sigillo key, and the variables the clients read their
 * address and key from. `importsIn(pattern, text)` says whether the file
 * imports a library; `field` names the catalog's list of them for the
 * language (`libraries` for Python, `crates` for Rust).
 */
const ROUTE_SOURCE =
  String.raw`function sigilloRoute(source, settings, onComputer, importsIn, field) {
  // The model gateway (settings.gateway, an address): every cloud provider
  // the file uses (catalog.ts) is pointed at the gateway, and its keys in the
  // file are replaced by the system's sigillo key. A provider is used when the
  // file imports its library (on its own or through LangChain), names the
  // variable its key is read from (from the environment or a .env file, which
  // the lines below set first and python-dotenv does not override), calls its
  // address directly, holds one of its keys, or names one of its models, as
  // LiteLLM, PydanticAI and CrewAI are told them. Its clients find the gateway
  // through the variables they read themselves, set before anything else runs.
  // The real keys come back in "providers" so that the page can offer to save
  // them in sigillo; the new file has none of them. A key not in the file (a
  // .env, the shell) is not seen here: the page asks for it.
  var providers = {};
  var labels = {};
  var variables = [];
  var mistral = false;
  var catalog = ` +
  JSON.stringify(fileCatalog()) +
  String.raw`;
  var has = function (pattern, flags) {
    return new RegExp(pattern, flags || "").test(source);
  };
  var imports = function (pattern) {
    return Boolean(pattern) && importsIn(pattern, source);
  };
  var addressOf = function (entry) {
    var escaped = entry.addresses.map(function (address) {
      return address.replace(/[.*+?^$(){}|[\]\\\/]/g, "\\$&");
    });
    return new RegExp("(" + escaped.join("|") + ")(?![\\w.-])", "g");
  };
  var namedOf = function (entry) {
    return new RegExp("(\\b\\w*(?:" + entry.named + ")\\w*key\\w*\\s*[=:]\\s*)([\"'])([A-Za-z0-9_.-]{20,})\\2", "gi");
  };
  // Model names tell the provider only where no address does, and never
  // beside a model on this computer, which has a "mistral-small" of its own.
  var anyAddress = catalog.some(function (entry) { return has(addressOf(entry).source); });
  var byModel = !anyAddress && !/\b11434\b/.test(source) && !/ollama/i.test(source);
  var signs = {};
  catalog.forEach(function (entry) {
    if (field === "libraries" && entry.unreachable && imports(entry.unreachable)) return;
    var own = entry.keyVariables.filter(function (name) {
      return (entry.sharedVariables || []).indexOf(name) < 0;
    });
    signs[entry.name] = {
      address: has(addressOf(entry).source),
      variable: own.some(function (name) { return source.indexOf(name) >= 0; }),
      library: imports(entry[field]),
      model: byModel && Boolean(entry.models) && has("[\"'](?:" + entry.models + ")[\"']"),
      named: Boolean(entry.named) && has(namedOf(entry).source, "i"),
      key: Boolean(entry.key) && has(entry.key) && !entry.keyNeedsMore,
    };
  });
  // The openai library also calls the providers that speak OpenAI's API:
  // next to another provider's address, it is that provider's client, and
  // next to a model on this computer, that model's. So is an "sk-" key, in
  // a file that names one such provider and not OpenAI.
  var openai = signs.openai;
  if (openai !== undefined) {
    openai.library = openai.library && !onComputer && !catalog.some(function (entry) {
      return entry.name !== "openai" && signs[entry.name] !== undefined && signs[entry.name].address;
    });
  }
  var used = function (name) {
    var sign = signs[name];
    return sign !== undefined && (sign.address || sign.variable || sign.library || sign.model || sign.named || sign.key);
  };
  var shaped = catalog.filter(function (entry) { return entry.openaiShaped && used(entry.name); });
  var openaiOwn = openai !== undefined && (openai.address || openai.variable || openai.library || openai.model);
  var skOwner = !openaiOwn && shaped.length === 1 ? shaped[0].name : "openai";
  if (skOwner !== "openai") openai.key = false;
  var openaiKey = catalog.filter(function (entry) { return entry.name === "openai"; })[0].key;

  catalog.forEach(function (entry) {
    if (!used(entry.name)) return;
    var name = entry.name;
    var found = null;
    if (entry.named) {
      source = source.replace(namedOf(entry), function (all, before, quote, key) {
        if (found === null) found = key;
        return before + quote + settings.key + quote;
      });
    }
    var shape = entry.key;
    if (name === skOwner && name !== "openai") shape = openaiKey;
    if (name === "openai" && skOwner !== "openai") shape = null;
    if (shape) {
      var keys = source.match(new RegExp(shape, "g"));
      if (keys !== null && found === null) found = keys[0];
      source = source.replace(new RegExp(shape, "g"), settings.key);
    }
    source = source.replace(addressOf(entry), settings.gateway + "/" + name);
    providers[name] = found === null ? "" : found;
    labels[name] = entry.label;
    var addresses = Object.assign({}, entry.addressVariables, field === "crates" ? entry.crateAddressVariables || {} : {});
    Object.keys(addresses).forEach(function (variable) {
      variables.push([variable, settings.gateway + "/" + name + addresses[variable]]);
    });
    entry.keyVariables.forEach(function (variable) {
      variables.push([variable, settings.key]);
    });
    // mistralai's own client reads no address: the sigillo package gives it one (0.6 on).
    if (name === "mistral" && imports("mistralai")) mistral = true;
  });
  return { source: source, providers: providers, labels: labels, variables: variables, mistral: mistral };
}
`;

const PYTHON_SETUP_SOURCE = `function sigilloAgentSetup(source, settings) {
  var eol = source.indexOf("\\r\\n") >= 0 ? "\\r\\n" : "\\n";
  var bom = source.charAt(0) === "\\uFEFF" ? "\\uFEFF" : "";
  var lines = source.slice(bom.length).split(/\\r?\\n/);

  if (/^\\s*(import sigillo\\b|sigillo\\.init\\()/m.test(source)) return { status: "already" };

  // A model on this computer (Ollama and the like) with protection on: the
  // file calls it with the system's sigillo key, which the door
  // (python -m sigillo.door) asks for and Ollama ignores, so the file works
  // with or without the door. The guard is told to watch the model's address.
  // A model on this computer is found with or without protection: through
  // the gateway, the openai library that calls it is not a cloud model.
  var onComputer = false;
  var localPort = 11434;
  if (/\\b11434\\b/.test(source) || /^\\s*(from|import)\\s+ollama\\b/m.test(source)) {
    onComputer = true;
  } else {
    // The other usual local servers, found by the address they are called at
    // (LM Studio 1234, llama.cpp 8080, vLLM 8000, Jan 1337).
    var other = /(?:localhost|127\\.0\\.0\\.1):(1234|8080|8000|1337)\\b/.exec(source);
    if (other) {
      onComputer = true;
      localPort = Number(other[1]);
    }
  }
  var local = Boolean(settings.protection) && onComputer;
  if (local) {
    source = source.replace(/\\bapi_key\\s*=\\s*(["'])(ollama|lm-studio|not-needed|sk-no-key-required|EMPTY|none)\\1/gi, "api_key=" + JSON.stringify(settings.key));
    lines = source.slice(bom.length).split(/\\r?\\n/);
  }

` +
  String.raw`  // The model gateway (sigilloRoute, above): its variables are set first of all.
  var providers = {};
  var labels = {};
  var gatewayLines = [];
  var sdkMinor = local ? (localPort === 11434 ? 5 : 7) : 4;
  if (settings.gateway) {
    var routed = sigilloRoute(source, settings, onComputer, function (pattern, text) {
      return new RegExp("^\\s*(from|import)\\s+(" + pattern + ")\\b", "m").test(text);
    }, "libraries");
    source = routed.source;
    providers = routed.providers;
    labels = routed.labels;
    routed.variables.forEach(function (pair) {
      gatewayLines.push("os.environ[" + JSON.stringify(pair[0]) + "] = " + JSON.stringify(pair[1]));
    });
    if (routed.mistral) sdkMinor = 6;
    lines = source.slice(bom.length).split(/\r?\n/);
  }
` +
  `  if (local && localPort === 11434) gatewayLines.push("os.environ[" + JSON.stringify("OLLAMA_API_KEY") + "] = " + JSON.stringify(settings.key));
  if (gatewayLines.length > 0) gatewayLines.unshift("import os");

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
  // The OpenAI instrumentation names no provider for a model on this
  // computer; the SDK names it from 0.8 on, so the receipt does not say OpenAI.
  if (onComputer && frameworks.indexOf("openai") >= 0) sdkMinor = 8;

  // An agent with no framework at all (urllib to reach its model, pathlib to
  // write its files) has no library to record it from. Where the account is
  // opened to it, the SDK's "stdlib" instrumentation records those calls
  // themselves: a model server, any other address, a file written.
  var instrument = frameworks.slice();
  // A file that talks to a model on this computer needs it too, to send the door the key.
  if (frameworks.length === 0 && (settings.stdlib === true || local)) instrument.push("stdlib");

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
  // the same Python that runs it: downloading it is the whole installation. An
  // SDK installed earlier but older than 0.4 (0.5 for a local model, 0.7 for one that is not Ollama, 0.6 for
  // mistralai through the gateway, 0.8 for the openai library on a local model) is replaced the same way, and the
  // file then runs itself again, so that nothing from the old one stays
  // loaded. SIGILLO_SETUP_DONE stops that from repeating if the install did not help.
  // The customer's own key (made by the page in this browser): the SDK salts
  // every digest under a nonce made from it, and never sends the nonce. 0.9 knows it.
  if (settings.customerKey) sdkMinor = Math.max(sdkMinor, 9);
  // 0.10: a local model that was already open no longer ends the agent.
  if (local) sdkMinor = Math.max(sdkMinor, 10);
  var extras = frameworks.length > 0 ? "[" + frameworks.join(",") + "]" : "";
  var requirement = "sigillo" + extras + " @ " + settings.url;
  var block = gatewayLines.concat(gatewayLines.length > 0 ? [""] : [], ["try:", "    import sigillo"]);
  frameworks.forEach(function (name) {
    block.push("    import openinference.instrumentation." + name);
  });
  block.push(
    "    import importlib.metadata",
    '    if tuple(map(int, importlib.metadata.version("sigillo").split(".")[:2])) < (0, ' + sdkMinor + "):",
    '        raise ImportError("sigillo is too old")',
    "except ImportError:",
    "    import os",
    "    import subprocess",
    "    import sys",
    "",
    '    if os.environ.get("SIGILLO_SETUP_DONE"):',
    "        raise",
    '    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "--upgrade", ' + JSON.stringify(requirement) + "])",
    '    os.environ["SIGILLO_SETUP_DONE"] = "1"',
    "    raise SystemExit(subprocess.call([sys.executable, *sys.argv]))",
    "",
    "sigillo.init(",
  );
  block.push(
    "    endpoint=" + JSON.stringify(settings.endpoint) + ",",
    "    api_key=" + JSON.stringify(settings.key) + ",",
    "    system_id=" + JSON.stringify(settings.system) + ",",
  );
  if (settings.customerKey) block.push("    customer_key=" + JSON.stringify(settings.customerKey) + ",");
  // Always said, even when empty: left out, the SDK would try every
  // instrumentation, which is how a plain agent came to be told about crewai.
  block.push("    instrument=" + JSON.stringify(instrument).replace(/,/g, ", ") + ",");
  if (settings.protection) block.push("    strict=True,");
  if (local) block.push("    local_model=" + (localPort === 11434 ? "True" : localPort) + ",");
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
    instrument: instrument,
    install: 'pip install "' + requirement + '"',
    providers: providers,
    labels: labels,
    localPort: onComputer ? localPort : 0,
    guarded: local,
  };
}`;

/**
 * The same for an agent written in Rust: its `main.rs` (whichever .rs file
 * holds `fn main`) gets the call to `sigillo::init` as the first thing `main`
 * does, and its `Cargo.toml`, when given, the dependency, so that the next
 * `cargo run` or `cargo build` fetches and compiles the sigillo crate by
 * itself (sdk-rust/). Without a Cargo.toml, `install` is the one command
 * that adds it. The gateway and the local model are handled as for Python,
 * with the crate's `Config::env` in place of `os.environ`, and the key of a
 * model on this computer written into its address, which is how a client
 * with no setting for a key (ollama-rs) still sends it to the door.
 */
const RUST_SETUP_SOURCE = String.raw`function sigilloRustSetup(files, settings) {
  var main = null;
  var cargo = null;
  files.forEach(function (file) {
    if (/(^|[\\/])Cargo\.toml$/i.test(file.name)) {
      if (cargo === null) cargo = file;
    } else if (/\.rs$/i.test(file.name) && main === null && /\bfn\s+main\s*\(\s*\)/.test(file.text)) {
      main = file;
    }
  });
  if (main === null) return { status: "nomain" };
  var source = main.text;
  if (/\bsigillo::init(_from_env)?\s*\(/.test(source)) return { status: "already", name: main.name };
  var eol = source.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  var manifest = cargo === null ? "" : cargo.text;

  // A crate is "imported" when the code names it (use x, x::...) or Cargo.toml depends on it.
  var dependencies = [];
  var section = "";
  manifest.split(/\r?\n/).forEach(function (line) {
    var header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim();
      return;
    }
    var name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (name && /(^|\.)(dev-|build-)?dependencies$/.test(section)) dependencies.push(name[1].replace(/-/g, "_"));
    var table = /^(?:target\..*\.)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
    if (table && dependencies.indexOf(table[1].replace(/-/g, "_")) < 0) dependencies.push(table[1].replace(/-/g, "_"));
  });
  var importsIn = function (pattern, text) {
    if (new RegExp("(^|[^\\w:])(" + pattern + ")::").test(text)) return true;
    if (new RegExp("^\\s*(pub\\s+)?use\\s+(" + pattern + ")\\b", "m").test(text)) return true;
    return dependencies.some(function (name) {
      return new RegExp("^(?:" + pattern + ")$").test(name);
    });
  };

  // A model on this computer: Ollama by its port or its crate, the other
  // usual servers by the address they are called at.
  var onComputer = false;
  var localPort = 11434;
  if (/\b11434\b/.test(source) || importsIn("ollama_rs", source)) {
    onComputer = true;
  } else {
    var other = /(?:localhost|127\.0\.0\.1):(1234|8080|8000|1337)\b/.exec(source);
    if (other) {
      onComputer = true;
      localPort = Number(other[1]);
    }
  }
  var local = Boolean(settings.protection) && onComputer;
  if (local) {
    // The door asks for the sigillo key: a placeholder key becomes it, and so
    // does the address, for a client that sends no key of its own.
    source = source.replace(/(\b\w*api_key\w*\s*(?:\(\s*|[=:]\s*))"(ollama|lm-studio|not-needed|sk-no-key-required|EMPTY|none)"/gi, function (all, before) {
      return before + rustString(settings.key);
    });
    source = source.replace(/"http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g, function (all, host, port) {
      return '"http://sigillo:' + settings.key + "@" + host + (port || "");
    });
  }

  var providers = {};
  var labels = {};
  var variables = [];
  if (settings.gateway) {
    var routed = sigilloRoute(source, settings, onComputer, importsIn, "crates");
    source = routed.source;
    providers = routed.providers;
    labels = routed.labels;
    variables = routed.variables;
  }

  // The call, first thing in main: on the line after main's opening brace,
  // indented as main's own first line is.
  var signature = /\bfn\s+main\s*\(\s*\)/.exec(source);
  var brace = source.indexOf("{", signature.index + signature[0].length);
  if (brace < 0) return { status: "nomain" };
  var after = source.slice(brace + 1);
  var next = /^[ \t]*\r?\n([ \t]*)\S/.exec(after);
  var indent = next ? next[1] : "    ";
  if (indent.length === 0) indent = "    ";
  var block = [
    "// sigillo: what this agent does becomes signed receipts; only digests leave this computer.",
    "let _sigillo = sigillo::init(",
    "    sigillo::Config::new(" + rustString(settings.endpoint) + ", " + rustString(settings.key) + ", " + rustString(settings.system) + ")",
  ];
  if (settings.customerKey) block.push("        .customer_key(" + rustString(settings.customerKey) + ")");
  if (settings.protection) block.push("        .strict(true)");
  if (local) block.push("        .local_model(" + localPort + ")");
  variables.forEach(function (pair) {
    block.push("        .env(" + rustString(pair[0]) + ", " + rustString(pair[1]) + ")");
  });
  block[block.length - 1] += ",";
  block.push(")", '.expect("sigillo");');
  var inserted = block.map(function (line) { return indent + line; }).join(eol);
  var rest = after.replace(/^[ \t]*(?=\r?\n)/, "");
  var text = source.slice(0, brace + 1) + eol + inserted + eol + (/^\r?\n/.test(rest) ? rest.replace(/^\r?\n/, "") : indent + rest.replace(/^\s+/, ""));

  var result = [{ name: main.name, text: text }];
  var dependency = "sigillo = " + settings.crate;
  if (cargo !== null) {
    var cargoEol = manifest.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    if (dependencies.indexOf("sigillo") < 0) {
      var header = /^[ \t]*\[dependencies\][ \t]*(\r?\n|$)/m.exec(manifest);
      var updated = header
        ? manifest.slice(0, header.index + header[0].length) + (header[1] ? "" : cargoEol) + dependency + cargoEol + manifest.slice(header.index + header[0].length)
        : manifest.replace(/\s*$/, "") + cargoEol + cargoEol + "[dependencies]" + cargoEol + dependency + cargoEol;
      result.push({ name: cargo.name, text: updated });
    }
  }
  return {
    status: "added",
    files: result,
    language: "rust",
    install: "cargo add sigillo --git " + settings.crateRepository,
    dependency: dependency,
    providers: providers,
    labels: labels,
    localPort: onComputer ? localPort : 0,
    guarded: local,
    cargo: cargo !== null,
  };

  // A Rust string literal: what JSON writes, with Rust's own escape for the rest.
  function rustString(value) {
    return '"' + String(value).replace(/[\\"\u0000-\u001f\u007f]/g, function (character) {
      if (character === "\\") return "\\\\";
      if (character === '"') return '\\"';
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return "\\u{" + character.charCodeAt(0).toString(16) + "}";
    }) + '"';
  }
}`;

export const AGENT_SETUP_SOURCE = `${ROUTE_SOURCE}
${PYTHON_SETUP_SOURCE}

${RUST_SETUP_SOURCE}`;

export const AGENT_SETUP_SCRIPT = `(function () {
${AGENT_SETUP_SOURCE}

  var box = document.getElementById("sigillo-agent");
  if (box === null) return;
  var typed = document.querySelectorAll(".sigillo-customer-key");
  var input = document.getElementById("sigillo-agent-file");
  var done = document.getElementById("sigillo-agent-done");
  var problem = document.getElementById("sigillo-agent-problem");
  var choice = document.getElementById("sigillo-agent-choice");
  var drop = box.querySelector(".drop");
  box.classList.add("ready");
  // The chosen file stays in the box, by name, with its language's icon: the
  // input itself is emptied after each read, so that the same file can be
  // chosen again, and would say that no file is selected.
  var picked = function (name) {
    drop.classList.add("picked");
    drop.querySelector("strong").textContent = name;
    drop.querySelector("small").textContent = box.dataset.another;
  };
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
    stdlib: box.dataset.stdlib === "1",
    // Made here, in the browser, and written only into the file it gives back:
    // sigillo never receives it.
    customerKey: Array.prototype.map
      .call(crypto.getRandomValues(new Uint8Array(32)), function (byte) {
        return (byte < 16 ? "0" : "") + byte.toString(16);
      })
      .join(""),
  };
  // The same key in the code to paste by hand, so that either way gets one.
  Array.prototype.forEach.call(typed, function (slot) {
    slot.textContent = base.customerKey;
  });
  var download = function (name, text) {
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: /\\.py$/i.test(name) ? "text/x-python" : "text/plain" }));
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  var give = function (result) {
    result.files.forEach(function (file) {
      download(file.name, file.text);
    });
    var names = result.files.map(function (file) { return file.name; }).join(", ");
    var message = result.language === "rust"
      ? (result.cargo ? box.dataset.doneRust : box.dataset.doneRustNoCargo.replace("{install}", result.install))
      : result.instrument.length > 0 ? box.dataset.done : box.dataset.doneNoFramework;
    show(done, message.replace("{file}", names));
  };
  input.addEventListener("change", async function () {
    var chosen = Array.prototype.slice.call(input.files);
    if (chosen.length === 0) return;
    if (choice !== null) choice.hidden = true;
    // Python: the agent's .py file. Rust: its main.rs, with its Cargo.toml beside it if it likes.
    var rust = chosen.some(function (file) { return /\\.rs$|(^|[\\\\/])Cargo\\.toml$/i.test(file.name); });
    var tooBig = chosen.some(function (file) { return file.size > 1048576; });
    if (tooBig || (!rust && !/\\.py$/i.test(chosen[0].name))) {
      show(problem, box.dataset.notPython);
      return;
    }
    drop.classList.toggle("rust", rust);
    picked(chosen.map(function (file) { return file.name; }).join(", "));
    var texts = await Promise.all(chosen.map(function (file) { return file.text(); }));
    var files = chosen.map(function (file, index) { return { name: file.name, text: texts[index] }; });
    var analyse = function (settings) {
      if (rust) {
        return sigilloRustSetup(files, Object.assign({ crate: box.dataset.crate, crateRepository: box.dataset.crateRepository }, settings));
      }
      var result = sigilloAgentSetup(files[0].text, settings);
      if (result.status === "added") {
        result.files = [{ name: files[0].name, text: result.text }];
        result.language = "python";
      }
      return result;
    };
    var plain = analyse(base);
    if (plain.status === "already") {
      show(problem, box.dataset.already.replace("{file}", plain.name || files[0].name));
      return;
    }
    if (plain.status === "nomain") {
      show(problem, box.dataset.noMain);
      return;
    }
    input.value = "";
    if (choice === null) {
      give(plain);
      return;
    }
    // The model gateway: the file is read first, and what it uses is said
    // before anything is downloaded. Only an agent that calls a cloud model
    // is offered the choice; the file keeps its own key unless it is ticked.
    var routed = analyse(Object.assign({ gateway: box.dataset.gateway }, base));
    var names = Object.keys(routed.providers);
    var tick = document.getElementById("sigillo-agent-secure");
    var label = document.getElementById("sigillo-agent-secure-label");
    var save = document.getElementById("sigillo-agent-model");
    save.hidden = true;
    done.hidden = true;
    problem.hidden = true;
    tick.checked = false;
    label.hidden = names.length === 0;
    var servers = { 11434: "Ollama", 1234: "LM Studio", 8080: "llama.cpp", 8000: "vLLM", 1337: "Jan" };
    document.getElementById("sigillo-agent-analysis").textContent = names.length > 0
      ? box.dataset.analysisCloud.replace("{providers}", names.map(function (name) { return routed.labels[name]; }).join(", "))
      : routed.localPort > 0
        ? (plain.guarded ? box.dataset.analysisLocalGuarded : box.dataset.analysisLocal).replace("{server}", servers[routed.localPort])
        : box.dataset.analysisOther;
    choice.hidden = false;
    document.getElementById("sigillo-agent-download").onclick = function () {
      var result = tick.checked ? routed : plain;
      give(result);
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
