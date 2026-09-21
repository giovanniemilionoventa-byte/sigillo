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

## Install

```sh
pip install -e sdk-python                 # the package
pip install -e 'sdk-python[langchain]'    # with the LangChain instrumentation
pip install -e 'sdk-python[crewai]'       # with the CrewAI instrumentation
```

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

## What is recorded

Nothing your agent said or received. The server records the digest of an input
or an output, never the value, and each receipt carries only metadata: which
agent, what kind of action, its name, whether it succeeded, and where it sits in
the chain. See [docs/FORMAT.md](../docs/FORMAT.md).

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
