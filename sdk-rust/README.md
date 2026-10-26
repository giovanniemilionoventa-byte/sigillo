# sigillo for Rust

The Rust counterpart of `sdk-python/`: it records what a Rust agent does as
receipts on a sigillo installation, without the agent's prompts, tool
arguments or outputs ever leaving the machine. Only their SHA-256 digests are
sent, salted the same way the Python SDK salts them (docs/FORMAT.md 2.7), and
`tests/vectors.rs` holds this crate to the same test vectors.

## Adding it to an agent

```toml
[dependencies]
sigillo = { git = "https://github.com/giovanniemilionoventa-byte/sigillo", branch = "main" }
```

```rust
fn main() {
    // First thing in main: in strict mode, init also runs the guard process.
    let sigillo = sigillo::init_from_env().expect("sigillo");

    let call = sigillo.tool("look_up_order");
    call.agent("support-bot").input(&question);
    let answer = call.run(|| look_up(&question))?;
}
```

`init_from_env` reads `SIGILLO_ENDPOINT`, `SIGILLO_API_KEY`, `SIGILLO_SYSTEM_ID`
and the optional `SIGILLO_CUSTOMER_KEY`, `SIGILLO_STRICT`, `SIGILLO_LOCAL_MODEL`,
`SIGILLO_SHOW_SENT`, `SIGILLO_HEARTBEAT_SECONDS`. `Config::new(...)` with its
builder methods does the same in code. The console's upload page writes these
lines into the uploaded `main.rs` and `Cargo.toml` by itself.

Calling `init` must be the first thing `main` does: the guard process in
strict mode, and the door in front of a local model, are this same program
started again with a variable set, and `init` is where they take over.

## What it does, as the Python SDK does

| measure | how |
|---|---|
| no plaintext sent | `input`/`output`/`artifact` are digested at once; the span never holds the text |
| salted digests | a random 32-byte nonce per value, or one derived with HMAC from `SIGILLO_CUSTOMER_KEY` so the customer can re-derive it |
| model gateway | the provider variables (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, ...) point at `/llm/<provider>/`, which the crates async-openai, rig and openai-api-rs read |
| heartbeat | `start`, a `beat` every minute, `stop`, with the SHA-256 of the running executable |
| strict mode | a guard process re-hashes the executable and ends the agent (status 70) when it changes, when the guard is killed, or after three missed beats |
| local model | a door in front of Ollama that only lets the sigillo key through (Bearer, `x-api-key`, or the key in the URL) and records each model call |

What it does not do: record by itself every call a library makes, the way
OpenInference does in Python. Tool calls are recorded where the agent marks
them with `tool(...)`, model calls through the gateway or the door.

An agent stopped with Ctrl-C ends without its `stop` beat, and the server
writes it as `lost`, as it would for a crash.

## An agent that is already compiled: `sigillo-run`

```text
cargo install --git https://github.com/giovanniemilionoventa-byte/sigillo sigillo
sigillo-run --env-file sigillo.env --strict -- ./my-agent --its-arguments
```

The launcher sends the heartbeat for the agent, with the hash of its
executable, enforces strict mode from outside, and gives it the gateway
variables. It cannot see the agent's own tool calls.

## Tests

```text
cargo test
```

The end-to-end tests run the built signer, server and verifier from this
repository (`pnpm build` first) and are skipped when that build is missing.
