# sigillo — Python SDK

Sends an AI agent's actions to a sigillo server, where they become signed,
chained receipts. One function to call, and nothing else in your code changes.

```python
import sigillo

sigillo.init(
    endpoint="https://sigillo.example",
    api_key="sigillo_...",
    system_id="acme-support-bot",
    instrument=["langchain"],
)
```


## Agents without a framework

An agent that calls its model with `urllib`, `requests` or `httpx` and writes
files with `pathlib` has no framework to instrument. Name `"stdlib"` and its model calls, its other web
requests and the files it writes are recorded, as digests only:

```python
sigillo.init(endpoint="https://sigillo.example/", api_key="sigillo_...",
             system_id="my-agent", instrument=["stdlib"])
```

Only the agent's own code is recorded, not the standard library's or an
installed package's. The model's answer is not (the agent reads it after the
request returns). It is on only when named.

## Install

```sh
pip install -e sdk-python                 # the package
pip install -e 'sdk-python[langchain]'    # with the LangChain instrumentation
pip install -e 'sdk-python[crewai]'       # with the CrewAI instrumentation
pip install -e 'sdk-python[openai]'       # with the OpenAI-client instrumentation
```

The `openai` extra is for agents that call an OpenAI-compatible server directly
— Ollama, vLLM, llama.cpp — without going through LangChain or CrewAI.

The package itself depends only on the OpenTelemetry SDK and its OTLP/HTTP
exporter. The instrumentations are optional: one that is not installed is
skipped with a warning, so a deployment that only uses LangChain does not have
to install CrewAI.

## What `init` does

It points OpenTelemetry at your sigillo server and turns on the OpenInference
instrumentations you asked for. After that, the spans your agent framework
already emits are exported to `POST /v1/traces`, and the server turns each one
that describes an AI action into a receipt.

`endpoint` may be the server's base URL or its full `/v1/traces` URL; both work.

`api_key` is what decides where receipts land: a key belongs to exactly one
system, and the server writes to that system's chain. `system_id` here is
reported as OpenTelemetry's `service.name`, which the server uses as the agent's
name when a span does not name one itself. Setting `system_id` to something
other than the key's system does not move the receipts.

`init` returns a handle:

```python
tracing = sigillo.init(...)
print(tracing.instrumented)   # ("langchain",) — what was actually turned on
tracing.flush()               # push what is buffered, before a short process exits
tracing.shutdown()
```

A long-running service does not need the handle. A script does: without a flush,
the last spans may never leave the process.

## Heartbeat

`init` also starts a heartbeat, on a thread of its own: once when it runs, every
`heartbeat_seconds` (60 by default) while the process runs, busy or idle, and a
last time on `shutdown()` or at the end of the process. The server writes a
receipt when the agent connects, when it closes normally, when it goes silent
without closing (three minutes without a beat: the code removed, the process
killed, the computer switched off, the network down) and when it comes back.
An ordinary beat writes nothing. See `POST /api/v1/heartbeat` in
`docs/API.md`.

Each beat also carries the SHA-256 of the agent's main script file and of the
recording libraries (never their content). If the script is edited while the
agent runs, or the agent restarts with a different one, the server writes
`script_changed` on the chain. The agent is never stopped for it: sigillo
records, it does not interrupt. To make the file read-only for the agent, run
the agent as another operating-system user than the file's owner.

A process stopped by `SIGTERM` (`systemctl stop`, a kill) does not run
Python's exit handlers, so it does not show as closed, unless the program
catches the signal and calls `shutdown()`: the server writes `lost` after three
minutes without a beat, "beats interrupted, reason not known". A computer
switched off is told apart by the time it was switched on, which every new
session sends.

## Write first, send after

Every batch of actions is written to a queue on disk before it is sent, and
deleted only once the server has it. A network cut, a server that is down or
busy, or an agent that stops before the batch went out loses nothing: what is
waiting is sent again by itself, in order, every 30 seconds and at the next
start. The server writes each action once, however many times it arrives. The
agent never waits for the network and is never stopped.

The queue and the customer key live in one folder per agent, under
`state_dir` (default: the `SIGILLO_STATE_DIR` environment variable, else
`~/.sigillo`). In a container, give that folder a persistent volume: a queue in
a folder that a restart wipes is lost with it. Where the folder cannot be
written at all, the queue is kept in memory, with a warning.

## Tool calls written by hand

The server reads a span the way OpenTelemetry defines its status: one that
ended with its status unset and no sign of failure is a success, `ERROR` or an
`error.type` attribute is a failure, and an `exception` event with no status is
*esito sconosciuto*, since the exception may have been caught. So a span you
open yourself is recorded correctly as long as a failure leaves a mark on it,
which `start_as_current_span` does for an exception that escapes the block.
`tracing.tool(...)` records a tool call explicitly, and keeps the exception's
text out of what is sent:

```python
with tracing.tool("scrivi_file", agent="agente-codice"):
    scrivi_file(percorso, testo)
```

A block that returns is `ok`. One that raises is `error`, with the exception's
class name as `error.type`; the exception goes on unchanged, and its message
and traceback are not sent, since they can quote the content this package keeps
here. `sigillo.artifact(...)` inside the block attaches to this call.

With your own tracer instead, set the status yourself before the span ends:
`span.set_status(StatusCode.OK)` on success, `StatusCode.ERROR` on failure
(`from opentelemetry.trace import StatusCode`).

## What is recorded

Nothing your agent said or received. Each receipt carries only metadata: which
agent, what kind of action, its name, whether it succeeded, and where it sits in
the chain, plus the digest of an input or an output, never the value. See
[docs/FORMAT.md](../docs/FORMAT.md).

That digest is computed right here, before anything is sent: the raw text
never travels to the server. `init` also drops every span attribute the server
does not read (a tool's docstring, a framework's own bookkeeping, the full text
of every message, and who the action was for, `user.id`, which is a person's
identifier), keeping which tool, which model and what kind of action.

## Your customer key

Each digest is **salted** with a nonce made here from your customer key and the
action's identifiers: SHA-256 of the nonce followed by the content. The key and
the nonce are **never sent**: the server receives the digest, and the word
`customer` where the nonce would be. Neither sigillo nor anyone who takes its
database can open a digest or test a guess against it ("score: 7"). You can,
at any time, with `sigillo.nonce_for(key, trace_id, span_id, "input")` and
`sigillo-verify open --nonce`.

There is one rule for where the key comes from: `init(customer_key=...)` if
you pass one, else the `SIGILLO_CUSTOMER_KEY` environment variable, else the
file `customer.key` in the agent's folder; and when there is none, a new one is
made the first time and saved there (readable by its owner only), with a
warning. **Keep a copy**: without it nobody can show what a digest was of, and
destroying it is how every digest it salted is erased for good. See
[docs/DATA-PROTECTION.md](../docs/DATA-PROTECTION.md).

## Seeing what leaves your computer

`sigillo.init(..., show_sent=True)` prints, on standard error, one line for
everything this package sends: each action as it is about to be exported
(name, attributes, status, events) and each heartbeat. What the agent said and
received appears there only as a digest. It is off by default; it exists so
that a customer can check, on their own machine and without taking sigillo's
word for it, that none of their content is sent.

```
[sigillo sends] action {"name": "leggi_curriculum", "attributes": {"tool.name": "leggi_curriculum", "sigillo.input.sha256": "9f2c…", "sigillo.input.nonce": "customer"}}
[sigillo sends] heartbeat {"session": "4be1…", "event": "beat"}
```

An exception is sent as its class only (`ValueError`): its message and
traceback, which can quote the content, stay in the process, and so does the
description OpenTelemetry writes into the status of a span an exception ended.

## Documents and model identity

`sigillo.artifact(data, role, label=None, media_type=None)` fingerprints a document
your agent used or produced, and attaches the fingerprint to the action being
recorded right now — call it while the tool call or step it belongs to is
still the active span. `data` is `bytes`, a `str` of exact text (hashed as its
UTF-8 bytes), or a path to read from; `role` is `"input"` or `"output"`;
`label` is a category you choose, such as `"curriculum"` — **never a
filename**, which can carry a person's name. Leave it out and the label is the
role and the media type, such as `"input application/pdf"`: the file's name is
never used. Hashing happens in this process;
only the digests leave it.

A plain text (a `str`, a `.txt` path, or any `media_type="text/plain"`) gets
two digests: the SHA-256 of its exact bytes, and its `sigillo-text/1`
fingerprint, which a copy of the same text with different spacing, line breaks
or invisible formatting characters shares, and a copy with any other
difference does not (`docs/FORMAT.md`, 2.5.1). That is what lets
"verifica un documento" recognise a pasted or reformatted copy. A PDF, an
image, a CSV or any other type gets the exact digest only.

```python
sigillo.artifact(open("cv.pdf", "rb").read(), role="input", label="curriculum")
# or, with a path:
sigillo.artifact(pathlib.Path("cv.pdf"), role="input", label="curriculum")
```

`sigillo.init(..., ollama_url="http://localhost:11434")` reads the installed
models once, from Ollama's own `GET /api/tags`, and adds the digest of the
model actually used to each LLM span. If Ollama does not answer, `init` still
succeeds — the digest is simply absent, and a warning is logged, not raised.

Both are optional, and either can be dropped without changing anything else:
a receipt with neither is exactly as informative as before phase 2.

## Example

`examples/langgraph_agent.py` is a minimal LangGraph agent with a fake model and
a fake tool. It calls no real model, so it costs nothing and is deterministic.

```sh
pip install -e sdk-python -r sdk-python/examples/requirements.txt
export SIGILLO_ENDPOINT=http://127.0.0.1:8080
export SIGILLO_API_KEY=sigillo_...
python sdk-python/examples/langgraph_agent.py
```

It produces seven spans — two model calls, one tool call and four graph steps —
which become seven receipts on the chain.

## Tests

The standard library's `unittest`, no test framework to install:

```sh
python -m unittest discover -s sdk-python/tests -t sdk-python
```

The end-to-end test starts a real signer, a real server and the example, then
checks the export with the open-source verifier. It skips itself if the Node
packages have not been built (`pnpm build`) or LangGraph is not installed.
