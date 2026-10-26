import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { AGENT_SETUP_SCRIPT, AGENT_SETUP_SOURCE } from "../src/http/agent-setup.js";
import { RUST_DEPENDENCY, RUST_REPOSITORY } from "../src/http/pages.js";

/**
 * "Upload your agent" for an agent written in Rust: the browser adds the call
 * to `sigillo::init` at the start of `fn main`, and the dependency to
 * Cargo.toml. The function is run here from the very characters the browser
 * runs; what it writes is compiled by Cargo against the real crate
 * (sdk-rust/) where Cargo is installed, so a block that would not build fails
 * here, not on a customer's computer.
 */

interface File {
  name: string;
  text: string;
}
interface Added {
  status: "added";
  files: File[];
  language: "rust";
  install: string;
  dependency: string;
  providers: Record<string, string>;
  labels: Record<string, string>;
  localPort: number;
  guarded: boolean;
  cargo: boolean;
}
type Result = Added | { status: "already"; name: string } | { status: "nomain" };

interface Settings {
  endpoint: string;
  key: string;
  system: string;
  crate: string;
  crateRepository: string;
  customerKey?: string;
  protection?: boolean;
  gateway?: string;
}

const SETTINGS: Settings = {
  endpoint: "https://get-sigillo.eu",
  key: "sigillo_abc_def",
  system: "cv-bot",
  crate: RUST_DEPENDENCY,
  crateRepository: RUST_REPOSITORY,
};
const GATEWAY = "https://get-sigillo.eu/llm";

const setup = runInNewContext(`${AGENT_SETUP_SOURCE}; sigilloRustSetup`) as (files: File[], settings: Settings) => Result;

const MAIN = 'use std::error::Error;\n\nfn main() -> Result<(), Box<dyn Error>> {\n    let question = "dov\'è il mio ordine?";\n    println!("{question}");\n    Ok(())\n}\n';
const CARGO = '[package]\nname = "agente"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n';

function added(files: File[], settings: Partial<Settings> = {}): Added {
  const result = setup(files, { ...SETTINGS, ...settings });
  if (result.status !== "added") throw new Error(`expected the lines added, got ${result.status}`);
  return result;
}

function fileNamed(result: Added, name: string): string {
  const file = result.files.find((candidate) => candidate.name === name);
  if (file === undefined) throw new Error(`${name} was not given back`);
  return file.text;
}

describe("adding sigillo to an agent written in Rust", () => {
  it("puts the call first in main, and the dependency in Cargo.toml", () => {
    const result = added([{ name: "main.rs", text: MAIN }, { name: "Cargo.toml", text: CARGO }]);
    expect(fileNamed(result, "main.rs")).toBe(
      [
        "use std::error::Error;",
        "",
        "fn main() -> Result<(), Box<dyn Error>> {",
        "    // sigillo: what this agent does becomes signed receipts; only digests leave this computer.",
        "    let _sigillo = sigillo::init(",
        '        sigillo::Config::new("https://get-sigillo.eu", "sigillo_abc_def", "cv-bot"),',
        "    )",
        '    .expect("sigillo");',
        '    let question = "dov\'è il mio ordine?";',
        '    println!("{question}");',
        "    Ok(())",
        "}",
        "",
      ].join("\n"),
    );
    expect(fileNamed(result, "Cargo.toml")).toBe(CARGO.replace("[dependencies]\n", `[dependencies]\nsigillo = ${RUST_DEPENDENCY}\n`));
    expect(result.cargo).toBe(true);
    expect(result.install).toBe(`cargo add sigillo --git ${RUST_REPOSITORY}`);
  });

  it("writes the customer key and strict mode into the call", () => {
    const customerKey = "0f".repeat(32);
    const text = fileNamed(added([{ name: "main.rs", text: MAIN }], { customerKey, protection: true }), "main.rs");
    expect(text).toContain(`            .customer_key("${customerKey}")\n            .strict(true),\n    )\n    .expect("sigillo");`);
  });

  it("finds main in whichever .rs file holds it, and keeps CRLF line endings", () => {
    const lib = { name: "lib.rs", text: "pub fn help() {}\n" };
    const main = { name: "main.rs", text: "fn main() {\r\n\tagente::help();\r\n}\r\n" };
    const text = fileNamed(added([lib, main]), "main.rs");
    expect(text.startsWith("fn main() {\r\n\t// sigillo:")).toBe(true);
    expect(text).toContain('\t.expect("sigillo");\r\n\tagente::help();\r\n}');
    expect(text.split("\n").every((line, index, lines) => index === lines.length - 1 || line.endsWith("\r"))).toBe(true);
  });

  it("opens a main written on one line", () => {
    const text = fileNamed(added([{ name: "main.rs", text: 'fn main() { println!("ciao"); }\n' }]), "main.rs");
    expect(text).toBe(
      'fn main() {\n    // sigillo: what this agent does becomes signed receipts; only digests leave this computer.\n    let _sigillo = sigillo::init(\n        sigillo::Config::new("https://get-sigillo.eu", "sigillo_abc_def", "cv-bot"),\n    )\n    .expect("sigillo");\n    println!("ciao"); }\n',
    );
  });

  it("works for an async main, as #[tokio::main] writes it", () => {
    const source = '#[tokio::main]\nasync fn main() {\n    run().await;\n}\n';
    const text = fileNamed(added([{ name: "main.rs", text: source }]), "main.rs");
    expect(text).toMatch(/^#\[tokio::main\]\nasync fn main\(\) \{\n {4}\/\/ sigillo:[^]*\.expect\("sigillo"\);\n {4}run\(\)\.await;\n\}\n$/);
  });

  it("adds a [dependencies] table to a Cargo.toml that has none, and leaves one that has sigillo alone", () => {
    const bare = '[package]\nname = "agente"\nversion = "0.1.0"\n';
    expect(fileNamed(added([{ name: "main.rs", text: MAIN }, { name: "Cargo.toml", text: bare }]), "Cargo.toml")).toBe(
      `${bare}\n[dependencies]\nsigillo = ${RUST_DEPENDENCY}\n`,
    );
    const already = `${CARGO}sigillo = "0.1"\n`;
    const result = added([{ name: "main.rs", text: MAIN }, { name: "Cargo.toml", text: already }]);
    expect(result.files.map((file) => file.name)).toEqual(["main.rs"]);
  });

  it("says when there is nothing to add, and when there is no main", () => {
    const using = 'fn main() {\n    let _s = sigillo::init(sigillo::Config::new("a", "b", "c")).unwrap();\n}\n';
    expect(setup([{ name: "main.rs", text: using }], SETTINGS)).toEqual({ status: "already", name: "main.rs" });
    expect(setup([{ name: "lib.rs", text: "pub fn help() {}\n" }, { name: "Cargo.toml", text: CARGO }], SETTINGS)).toEqual({ status: "nomain" });
    expect(setup([{ name: "Cargo.toml", text: CARGO }], SETTINGS)).toEqual({ status: "nomain" });
  });

  it("writes Rust string literals, escaping what Rust escapes", () => {
    const text = fileNamed(added([{ name: "main.rs", text: MAIN }], { system: 'agente "uno"\\due' }), "main.rs");
    expect(text).toContain('"agente \\"uno\\"\\\\due"');
  });
});

describe("a Rust agent that calls a cloud model, with the model gateway", () => {
  const AGENT = [
    "use async_openai::{config::OpenAIConfig, Client};",
    "",
    "#[tokio::main]",
    "async fn main() {",
    '    let config = OpenAIConfig::new().with_api_key("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");',
    "    let client = Client::with_config(config);",
    "}",
    "",
  ].join("\n");

  it("takes the key out, points the client at the gateway through its variables, and says which provider", () => {
    const result = added([{ name: "main.rs", text: AGENT }, { name: "Cargo.toml", text: `${CARGO}async-openai = "0.42"\n` }], { gateway: GATEWAY });
    const text = fileNamed(result, "main.rs");
    expect(result.providers).toEqual({ openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(result.labels).toEqual({ openai: "OpenAI" });
    expect(text).not.toContain("sk-proj-");
    expect(text).toContain('.with_api_key("sigillo_abc_def")');
    expect(text).toContain('            .env("OPENAI_BASE_URL", "https://get-sigillo.eu/llm/openai/v1")');
    expect(text).toContain('            .env("OPENAI_API_BASE", "https://get-sigillo.eu/llm/openai/v1")');
    expect(text).toContain('            .env("OPENAI_API_KEY", "sigillo_abc_def"),');
  });

  it("finds the provider from the crate alone, in the code or in Cargo.toml", () => {
    const viaRig = 'use rig::providers::anthropic;\n\nfn main() {\n    let client = anthropic::Client::from_env();\n}\n';
    expect(added([{ name: "main.rs", text: viaRig }], { gateway: GATEWAY }).providers).toEqual({ anthropic: "" });
    const viaCargo = "fn main() {\n    run();\n}\n";
    expect(added([{ name: "main.rs", text: viaCargo }, { name: "Cargo.toml", text: `${CARGO}async-openai = "0.42"\n` }], { gateway: GATEWAY }).providers).toEqual({ openai: "" });
    // A dependency on rig alone does not say which provider it calls.
    expect(added([{ name: "main.rs", text: viaCargo }, { name: "Cargo.toml", text: `${CARGO}rig-core = "0.46"\n` }], { gateway: GATEWAY }).providers).toEqual({});
  });

  it("leaves the file's own key where there is no gateway", () => {
    const text = fileNamed(added([{ name: "main.rs", text: AGENT }]), "main.rs");
    expect(text).toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain(".env(");
  });
});

describe("a Rust agent that calls a model on this computer", () => {
  const OLLAMA = [
    "use ollama_rs::Ollama;",
    "",
    "fn main() {",
    '    let ollama = Ollama::new("http://localhost".to_string(), 11434);',
    "}",
    "",
  ].join("\n");

  it("with protection: the door is started, and the key goes in the address, for a client with no key setting", () => {
    const result = added([{ name: "main.rs", text: OLLAMA }], { protection: true });
    const text = fileNamed(result, "main.rs");
    expect(result.localPort).toBe(11434);
    expect(result.guarded).toBe(true);
    expect(text).toContain('Ollama::new("http://sigillo:sigillo_abc_def@localhost".to_string(), 11434)');
    expect(text).toContain("            .strict(true)\n            .local_model(11434),");
  });

  it("an OpenAI-compatible client at LM Studio: its placeholder key becomes the sigillo key", () => {
    const source = 'fn main() {\n    let config = OpenAIConfig::new().with_api_base("http://127.0.0.1:1234/v1").with_api_key("lm-studio");\n}\n';
    const result = added([{ name: "main.rs", text: source }], { protection: true, gateway: GATEWAY });
    const text = fileNamed(result, "main.rs");
    expect(result.providers).toEqual({});
    expect(result.localPort).toBe(1234);
    expect(text).toContain('.with_api_key("sigillo_abc_def")');
    expect(text).toContain('"http://sigillo:sigillo_abc_def@127.0.0.1:1234/v1"');
    expect(text).toContain(".local_model(1234),");
  });

  it("without protection, nothing about the model changes", () => {
    const result = added([{ name: "main.rs", text: OLLAMA }]);
    expect(result.guarded).toBe(false);
    expect(fileNamed(result, "main.rs")).toContain('Ollama::new("http://localhost".to_string(), 11434)');
  });
});

describe("the page's script", () => {
  it("carries the Rust function, and still sends nothing anywhere", () => {
    expect(AGENT_SETUP_SCRIPT).toContain("function sigilloRustSetup(files, settings)");
    expect(AGENT_SETUP_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
    expect(() => new Function(AGENT_SETUP_SCRIPT)).not.toThrow();
  });
});

const cargo = spawnSync("cargo", ["--version"]).status === 0;
const crate = resolve(__dirname, "../../../sdk-rust");

describe.skipIf(!cargo)("what the page writes compiles against the real crate", () => {
  it("builds, plain and with every option", { timeout: 600_000 }, () => {
    const work = mkdtempSync(join(tmpdir(), "sigillo-rust-setup-"));
    try {
      const sources = [
        added([{ name: "main.rs", text: MAIN }, { name: "Cargo.toml", text: CARGO.replace('serde = "1"\n', "") }]),
        added(
          [
            { name: "main.rs", text: 'fn main() {\n    let base = "http://127.0.0.1:1234/v1";\n    let key = "lm-studio";\n    println!("{base} {key} {}", "https://api.openai.com/v1");\n}\n' },
            { name: "Cargo.toml", text: CARGO.replace('serde = "1"\n', "") },
          ],
          { customerKey: "ab".repeat(32), protection: true, gateway: GATEWAY },
        ),
      ];
      sources.forEach((result, index) => {
        const project = join(work, `agente${index}`);
        mkdirSync(join(project, "src"), { recursive: true });
        // The dependency as the page writes it, pointed at this checkout instead of GitHub.
        writeFileSync(join(project, "Cargo.toml"), fileNamed(result, "Cargo.toml").replace(RUST_DEPENDENCY, `{ path = ${JSON.stringify(crate)} }`));
        writeFileSync(join(project, "src", "main.rs"), fileNamed(result, "main.rs"));
        const built = spawnSync("cargo", ["check", "--quiet"], {
          cwd: project,
          env: { ...process.env, CARGO_TARGET_DIR: join(crate, "target") },
          encoding: "utf8",
          timeout: 600_000,
        });
        expect(built.status, built.stderr).toBe(0);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
