# @sigillo/sdk — TypeScript / Node SDK

Sends an AI agent's actions to a sigillo server, where they become signed,
chained receipts. The same promises as the Python SDK (`sdk-python/`), for
agents written in TypeScript or JavaScript on Node 22 or later. No
dependencies at all: hashing is `node:crypto`, the network is `fetch`.

```ts
import { init } from "@sigillo/sdk";

const tracing = init({
  endpoint: "https://sigillo.example",
  apiKey: "sigillo_...",
  systemId: "acme-support-bot",
});
```

That is the whole change to an agent. `init` makes sigillo the OpenTelemetry
tracer that frameworks find with `trace.getTracer()`, so a framework that emits
OpenTelemetry spans is recorded without anything else in your code changing.

## The Vercel AI SDK

```ts
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";

registerTelemetry(new OpenTelemetry());           // once, next to init()
await generateText({ model, prompt, telemetry: { isEnabled: true } });
```

Model calls, tool calls and the call that wraps them become `llm_call`,
`tool_call` and `agent_step` receipts. The older `experimental_telemetry` spans
(`ai.*` attributes, AI SDK 4 and 5) are translated to the same names.

## Another OpenTelemetry setup (LangChain.js, OpenInference, your own)

If something else already installed an OpenTelemetry provider, `init` leaves it
alone (`tracing.instrumented` is then empty) and you add sigillo's exporter to
its span processor. The exporter applies the same filtering as everything else:

```ts
import { SigilloSpanExporter } from "@sigillo/sdk";
new BatchSpanProcessor(new SigilloSpanExporter({ endpoint, apiKey, systemId }));
```

## Tool calls written by hand

```ts
await tracing.tool("write_file", () => writeFile(path, text));
```

A call that returns is `ok`; one that throws is `error`, with the exception's
class as `error.type`. Its message and stack stay in the process.

## What leaves your computer

Never what the agent said or received. An input or an output goes as a
SHA-256 digest made here, **salted** with a fresh 32-byte nonce, and every
span attribute the server does not read is dropped (`redactContent`, on by
default). An exception goes as its class only. `showSent: true` prints on
standard error everything that is sent, so you can check it without taking
anyone's word.

### Your own key

```ts
init({ ..., customerKey: process.env.SIGILLO_CUSTOMER_KEY });
```

The nonce of each digest is then made from your key and never sent: sigillo
receives the digest and the word `customer`. Neither sigillo nor anyone who
takes its database can test a guess against it. You can rebuild any nonce with
`nonceFor(key, traceId, spanId, "input")` and open the digest with
`sigillo-verify open --nonce`. Keep a copy of the key: without it nobody can
show what a digest was of, and destroying it erases them all for good. The
digests are the Python SDK's, bit for bit.

### Documents and people

```ts
import { artifact, pseudonym } from "@sigillo/sdk";
await tracing.tool("read_cv", () => artifact({ path: "cv.pdf" }, { role: "input", label: "curriculum" }));
const userId = pseudonym(realUserId, process.env.SIGILLO_PSEUDONYM_KEY!);
```

`artifact` attaches the document's SHA-256 (and, for `text/plain`, its
`sigillo-text/1` fingerprint) to the action; the document stays here.

## Heartbeat and guard

As in Python, the agent says when it starts, every `heartbeatSeconds` (60)
while it runs, and when it closes; the server writes a receipt at each change.
A guard process starts beside the agent and tells the server `ended` if the
agent's process dies while the computer stays on, `gap` after a sleep or a
network cut, and `stop` if the agent leaves with `process.exit()`.
`strict: true` makes the agent stop itself (exit status 70, or your `onHalt`)
if its script file or the SDK changes, or three beats in a row do not get
through.

A process ended by `SIGTERM` shows as `ended`, not `stop`, unless the program
catches the signal and calls `await tracing.shutdown()`.

## Not in this version

The Python SDK's local-model door (Ollama behind a key) and its stdlib
instrumentation have no counterpart here yet; the TypeScript SDK covers the
cloud-model and framework paths.
