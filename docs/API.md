# sigillo API

Two ways in, one way out. Everything an agent sends becomes a signed receipt on
the chain of exactly one system; everything an auditor gets comes out of an
export. The receipt format itself is in [FORMAT.md](FORMAT.md).

This document covers what is implemented. The export endpoint, the checkpoint
endpoints and the web interface are added as those milestones land.

## Three ways to connect an agent

There are two HTTP endpoints, below, and three real ways to reach them —
whichever fits what the agent already does:

1. **The Python SDK** (`sdk-python/`, `sigillo.init(...)`) — the least code, for
   an agent already built on LangChain, CrewAI, or a direct OpenAI-compatible
   client. It is a client of the OTLP endpoint below, not a protocol of its
   own: it turns on the matching OpenInference instrumentation and points its
   OTLP exporter here. See `sdk-python/README.md`.
2. **`POST /v1/traces` directly** — for anything already emitting OpenTelemetry
   traces, in any language: point its OTLP/HTTP exporter at this URL with the
   API key as a bearer header. No sigillo-specific library needed.
3. **`POST /api/v1/receipts`** — for code with no OpenTelemetry in it at all:
   one plain JSON request per receipt, in whatever language can make an HTTP
   call.

Since October 2026 the console and the public site offer only the first: its
heartbeat (`POST /api/v1/heartbeat`, below) is what lets sigillo say when an
agent was disconnected, and neither of the other two sends one. Both endpoints
still answer, and the SDK itself sends its spans to `/v1/traces`.

## Authentication

Every ingest request carries an API key:

```
Authorization: Bearer sigillo_<16 hex key id>_<64 hex secret>
```

A key belongs to one system and writes to that system's chain and no other. The
server stores only an scrypt hash of the secret, so a copy of the database does
not let anyone speak for a system. The key id is not a credential: it is a
lookup handle, stored in the clear, so that checking a token costs one scrypt
rather than one per key.

A request without a valid key gets `401`. A key that has been revoked stops
working on the next request, including on a server that is already running:
`sigillo-server key revoke` runs in a process of its own, and the server reads
whether a key is still live from the database on every request. The same is
true of a key whose system is **archived** (`sigillo-server system archive`,
or the "gestisci" page): every one of its keys is refused with `401`, exactly
as if revoked, until the system is unarchived — nothing is reissued, the same
keys work again at once. See `docs/SECURITY.md`, "Renaming, archiving and
deleting a system".

An address that sends too many wrong keys (`SIGILLO_INGEST_MAX_FAILURES` in a
minute, 20 by default) is locked out for a minute, doubling on each further
lockout up to 15 minutes. While it is locked out, a key the server has not
already checked is refused with the same `401`, without being checked; a key
the server has already accepted keeps working, so an agent sharing that
address carries on.

A request the server cannot complete because the signer is not reachable gets
`503`, which OTLP exporters retry. So does one the signer refused to sign: a
receipt time too far from the signer's clock, or a chain on which the signer
and the database disagree (the system is then red in the web view, and the
detail is in the administrative log; see SECURITY.md, "The signer's own record
of every chain"). Any other failure inside the server gets `500` with
`{"error":"internal error"}` and nothing more.

While writes are **paused for maintenance** (`SIGILLO_INGEST_PAUSED=true`, used
during an upgrade: `DEPLOY.md`), both ingest endpoints answer a request with a
valid key `503` with `Retry-After: 60` and
`{"error":"writes are paused for maintenance: retry later"}`, and write nothing.
The systems named in `SIGILLO_INGEST_PAUSE_EXCEPT` (comma-separated) keep
writing. A request without a valid key still gets `401`. OTLP exporters retry a
`503` for a while and then drop the batch, so a pause longer than that loses
events unless the agents are stopped or hold them.

A system that belongs to a customer organization over its **monthly limit**
(`SIGILLO_ORG_MONTHLY_RECEIPTS` receipts per calendar month, UTC) gets `429`
with `Retry-After` set to the start of next month and
`{"error":"this organization has reached its limit of N receipts this month: no receipt is written until YYYY-MM-01"}`,
on both endpoints, after its key is checked. Nothing is written.

## `POST /v1/traces` — OpenTelemetry ingest

Accepts an OTLP/HTTP trace export in either encoding:

| `Content-Type` | body |
|---|---|
| `application/x-protobuf` | `ExportTraceServiceRequest`, as the official Python exporter sends it |
| `application/json` | the same message in OTLP/JSON, with identifiers as hex or as base64 |

Nothing about this endpoint is Python-specific: it is a standard OTLP/HTTP trace
receiver, so any OpenTelemetry exporter, in any language, that can be pointed at
a custom endpoint and given a bearer header can send to it. The Python SDK
(below) is one client of it, not the only possible one. A minimal, self-contained
example with `curl` and OTLP/JSON — no OpenTelemetry library involved, to show
the wire format plainly:

```sh
curl -X POST https://sigillo.example/v1/traces \
  -H "Authorization: Bearer sigillo_<key id>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "resourceSpans": [{
      "resource": { "attributes": [
        { "key": "service.name", "value": { "stringValue": "acme-support-bot" } }
      ] },
      "scopeSpans": [{ "spans": [{
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "spanId": "00f067aa0ba902b7",
        "name": "cerca_ordine",
        "startTimeUnixNano": "1712000000000000000",
        "endTimeUnixNano": "1712000000500000000",
        "status": { "code": "STATUS_CODE_OK" },
        "attributes": [
          { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
          { "key": "gen_ai.tool.name", "value": { "stringValue": "cerca_ordine" } },
          { "key": "gen_ai.agent.name", "value": { "stringValue": "support-agent" } }
        ]
      }] }]
    }]
  }'
# 200 { "partialSuccess": {}, "sigillo": { "accepted": 1, "duplicates": 0, "ignored": 0, "unknown": [], "rawContentHashed": 0 } }
```

`gen_ai.operation.name: "execute_tool"` makes this a `tool_call` receipt, named
from `gen_ai.tool.name`, by `support-agent` (`gen_ai.agent.name`).

The payload carries no notion of a sigillo system, so the API key decides which
chain the spans join.

Spans are read in two dialects:

- **OpenTelemetry GenAI**: `gen_ai.operation.name` decides the action kind
  (`execute_tool` → `tool_call`, `chat`/`text_completion`/`generate_content`/
  `embeddings` → `llm_call`, `invoke_agent`/`create_agent` → `agent_step`). The
  agent is taken from `gen_ai.agent.name`, then `gen_ai.provider.name`, then the
  superseded `gen_ai.system`, then the resource's `service.name`.
- **OpenInference**: `openinference.span.kind` decides (`TOOL`, `LLM`, `AGENT`,
  `CHAIN`, `RETRIEVER`, `RERANKER`, `EMBEDDING`, `GUARDRAIL`, `EVALUATOR`), with
  the name from `tool.name` or `llm.model_name`, and `input.value` /
  `output.value` reduced to digests.

Neither convention is stable, so an operation or span kind the server does not
know is still recorded, as an `agent_step`, and reported back in the response.
A span that describes no AI action at all — an HTTP handler, a database query —
is ignored and counted.

A span may carry the digest already computed, instead of the raw value:
`sigillo.input.sha256` / `sigillo.output.sha256`, each 64 lowercase hex
characters, take the place of `input.value` / `output.value` (OpenInference)
or `gen_ai.input.messages` / `gen_ai.prompt` and `gen_ai.output.messages` /
`gen_ai.completion` (GenAI). This is what the Python SDK's `redact_content`
(on by default since fase 9 of the pilot plan) sends: the content is hashed in
the caller's own process, and the raw value never reaches this server at all.
A value there that is not a well-formed digest is not trusted as one, and
falls back to hashing the raw attribute exactly as before — counted in
`rawContentHashed` below, never rejected.

With `sigillo.input.nonce` / `sigillo.output.nonce` beside it (64 lowercase
hex, the 32-byte nonce), the digest is a **salted** one computed by the
client (FORMAT.md 2.7: SHA-256 of the nonce followed by the canonical JSON),
and is recorded as `salted`, its nonce kept in the server's `openings` table
like one the server made. This is what the Python SDK sends by default since
October 2026 (`salt_content`). A nonce that is not 64 lowercase hex makes the
digest unusable, and no digest is recorded for that field.

Whichever OTLP span carries a `trace_id` and a `span_id` that this system's
chain already has a receipt for is recognised as a duplicate — the same span,
sent again because the exporter never saw the first response — and is not
written a second time: no new `seq`, no new signature. `sigillo.duplicates`
below counts how many of a batch's spans this was true for.

Two members of the receipt format, both added in phase 2, are filled from the
same span, when present, and the resulting receipt is `v: 2` rather than `v: 1`:

- **`artifacts`**: one entry per `sigillo.artifact` span event (as the Python
  SDK's `sigillo.artifact(...)` attaches), read from that event's
  `sigillo.artifact.role`/`.label`/`.media_type`/`.sha256` attributes. A
  malformed event is skipped, not thrown on. Any span may carry these, not
  only an `llm_call`. An event that also carries
  `sigillo.artifact.text_canon` = `sigillo-text/1` and a well-formed
  `sigillo.artifact.text_sha256` gives its artifact a `text` member, and the
  receipt is then `v: 3` (`docs/FORMAT.md`, 2.5 and 2.5.1); any other
  `text_canon`, or a malformed digest, drops only `text`, never the artifact.
- **`model`**: for a recognised `llm_call` only, from `gen_ai.request.model` /
  `gen_ai.response.model` / `llm.model_name` for the name,
  `gen_ai.provider.name` / `gen_ai.system` / `llm.provider` / `llm.system` for
  the provider, and the SDK's own `sigillo.model.digest` for the digest — the
  latter present only when `sigillo.init(..., ollama_url=...)` could reach
  Ollama.

The span's status becomes the receipt's outcome: `OK` → `ok`, `ERROR` →
`error`. An unset status is read as OpenTelemetry defines it: instrumentations
leave a successful span unset and set only errors, so an unset span becomes
`ok`, unless it carries an `error.type` attribute, the semantic conventions'
failure marker (→ `error`), or an `exception` event without a status, which
may have been caught and handled (→ `unknown`).

Response `200`:

```json
{
  "partialSuccess": {},
  "sigillo": {
    "accepted": 5,
    "duplicates": 0,
    "ignored": 1,
    "unknown": ["gen_ai.operation.name=rerank_documents"],
    "rawContentHashed": 0
  }
}
```

`partialSuccess` is there because OTLP clients expect it. `sigillo` is the part
worth reading: how many receipts exist for this batch's spans (`accepted`,
whether newly written or already on the chain), how many of those were
duplicates rather than new writes, how many spans were not AI actions, which
convention values were unrecognised, and how many input/output fields had
their content hashed here rather than already hashed by the caller
(`rawContentHashed`; see above) — a number worth watching early in a pilot,
never a reason this endpoint refuses a request.

Response `400` with `{"error": "..."}` if the body is not an OTLP export.

## `POST /api/v1/receipts` — native ingest

For code that is not instrumented with OpenTelemetry, in any language: one
plain JSON receipt per request, over HTTP.

```sh
curl -X POST https://sigillo.example/api/v1/receipts \
  -H "Authorization: Bearer sigillo_<key id>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "actor": { "agent": "planner", "on_behalf_of": "urn:operator:night-shift" },
    "action": { "kind": "decision", "name": "refund.approve" },
    "outcome": "blocked",
    "ts_event": "2026-03-29T14:30:01.000Z",
    "input": { "amount": 120 },
    "source": { "type": "sdk", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736" }
  }'
# 201 { "seq": 11, "system_id": "acme-support-bot", "ts_received": "2026-03-29T15:00:00.000Z", "key_id": "a4d324060dbd98e0" }
```

| field | required | notes |
|---|---|---|
| `actor.agent` | yes | 1 to 256 characters |
| `actor.on_behalf_of` | no | the person the agent acted for. Recorded as a `psn_` pseudonym token; a value that already is one is kept as it is |
| `action.kind` | yes | `tool_call`, `llm_call`, `agent_step` or `decision`. Not `genesis` |
| `action.name` | yes | 1 to 256 characters |
| `outcome` | yes | `ok`, `error`, `blocked`, `unknown` |
| `ts_event` | no | ISO-8601 UTC with milliseconds. Defaults to the time of receipt |
| `source` | no | `{ type: "sdk" \| "api", trace_id?, span_id? }`, defaults to `api` |
| `input` / `output` | no | any JSON value. Digested on arrival with a fresh 32-byte nonce (`salted`), and discarded |
| `input_hash` / `output_hash` | no | a digest you computed yourself, 64 lowercase hex, recorded as `plain` |
| `input_nonce` / `output_nonce` | no | the 32-byte nonce, 64 lowercase hex, you salted `input_hash` / `output_hash` under: the digest is then recorded as `salted`, and the nonce kept by the server |
| `system_id` | no | if present, must be the system the key writes to |

Send either the value or its digest for a given field, never both. A caller that
would rather the server never see the value at all can compute the digest itself:
it is the SHA-256 of the RFC 8785 canonical JSON of the value, as FORMAT.md
section 3 defines it. It is then recorded as `plain`, and a short value can be
guessed back from it. Better: salt it yourself, SHA-256 of 32 random bytes
followed by that canonical JSON, and send the nonce as `input_nonce`; it is
then recorded as `salted`, exactly like a value the server receives and
digests under a nonce it keeps (FORMAT.md 2.7, SECURITY.md "Erasing a person").
Use a fresh nonce from a cryptographic random source every time: a nonce used
twice lets the two digests be compared.

`ts_received` is always stamped by the server. A caller cannot choose where in
the chain its receipt lands, nor when the server says it arrived. Response
`201` is shown inline in the example above.

Response `400` names the offending field. Response `403` if the body claims a
different system than the key writes to.

## `POST /api/v1/heartbeat` — the SDK's heartbeat

The Python SDK sends one when `init` runs, one a minute while the process runs
(whether the agent is working or idle), and one when it closes normally:

```json
{ "session": "0123456789abcdef0123456789abcdef", "event": "start" }
```

`session` is 32 lowercase hex characters, new for every process; `event` is
`start`, `beat` or `stop`. Same bearer key as the ingest endpoints.

The server writes a receipt on the key's chain at every change of a session's
state, and only then: an ordinary beat writes nothing. Each is an `agent_step`
by the agent `sigillo`, named

| `action.name` | when | `ts_event` |
| --- | --- | --- |
| `sigillo.connection.start` | a session is first heard from | when it was |
| `sigillo.connection.stop` | it closed normally | when it did |
| `sigillo.connection.lost` | no beat for 3 minutes, without a stop | its last beat |
| `sigillo.connection.restored` | a lost session beats again | when it did |
| `sigillo.connection.script_changed` | the script guard (below) saw a different script | when it did |

**Script guard.** A start or beat may also carry `"script_hash"`: the SHA-256
(64 lowercase hex characters) of the agent's main script file, read again at
every beat, or `null` when the file can no longer be read. The server keeps the
one a session started with and writes `script_changed` once if a later beat
differs, and once after the start of a session whose script differs from the
last session's that sent one. While a session's script differs, the answer
carries `"script_changed": true`, which an SDK started with `strict=True` takes
as its order to stop. Only the operator's own systems are watched until
`SIGILLO_SCRIPT_GUARD` is `all` (`off` disables it); for any other the field is
ignored and the answer is as before. The guard shows a changed script, it does
not prevent one: whoever can edit the file can also remove the SDK, and that
shows as `lost`.

`lost` covers every silence alike: sigillo's code removed from the agent, the
process killed, the computer switched off, the network cut. The server does not
tell them apart, and does not call a session lost until it has itself been up
for 3 minutes, so its own downtime is not blamed on the agent. A
`sigillo.connection.*` name is refused from `/api/v1/receipts` (400) and
dropped from `/v1/traces` (counted in `ignored`): only the server writes one.
A session already open is never refused for an organization's monthly limit:
its beats, its `stop` and its `lost` are written past it. A session not seen
before is: `429`, with `Retry-After`, once the organization is over its limit,
and once its system has opened 60 sessions in the last hour, so that a client
cannot write receipts without end by sending a new `session` every time.

Response `200` with `{"recorded": {"seq": 7, "name": "sigillo.connection.start"}}`,
or `{"recorded": null}` for a beat that changed nothing.

## `/llm/openai/v1/…`, `/llm/anthropic/v1/…`, `/llm/gemini/…` — the model gateway

An agent can call its cloud model through sigillo instead of directly. The
provider's key (OpenAI, Anthropic or Google Gemini) is held by sigillo; the agent
is given only the sigillo key of the system, and points its model client at
sigillo:

> **Not offered in the console since 2026-10-07.** The "AI model" block where
> a customer saved that key was removed on the project owner's instruction, so
> the Python SDK is the one way the console shows. The endpoints below still
> answer for keys saved before then; bringing the block back is a revert of
> that change.

| client | setting |
| --- | --- |
| OpenAI SDK, LangChain `ChatOpenAI`, anything OpenAI-compatible | `base_url="https://<server>/llm/openai/v1"`, `api_key="<the system key>"` |
| Anthropic SDK, Claude Code | `ANTHROPIC_BASE_URL=https://<server>/llm/anthropic`, `ANTHROPIC_API_KEY=<the system key>` |
| Google Gemini (`google-genai`, or its REST API) | `http_options={"base_url": "https://<server>/llm/gemini"}`, `api_key="<the system key>"` |
| Gemini's OpenAI-compatible API | `base_url="https://<server>/llm/gemini/v1beta/openai"`, `api_key="<the system key>"` |

The sigillo key is accepted as `Authorization: Bearer` (OpenAI's SDKs), as
`x-api-key` (Anthropic's), or as `x-goog-api-key` or `?key=` (Google's; the
`key` parameter is taken out of the query before it is forwarded). Whatever follows `/llm/<provider>/` is the
provider's own path and is forwarded unchanged, with the query string and the
headers the providers read (`anthropic-version`, `anthropic-beta`,
`openai-beta`, `openai-organization`, `openai-project`, `x-goog-api-client`,
`accept`), to `https://api.openai.com`, `https://api.anthropic.com` or
`https://generativelanguage.googleapis.com`, with the customer's key in place
of sigillo's. Gemini's paths start at `v1/` or `v1beta/` and may carry its
`:method` (`v1beta/models/gemini-2.5-flash:generateContent`). The provider's status, body and SDK-facing headers
(type, request id, rate limits, `retry-after`) come back as they are.

Every `POST` that reaches the provider writes a receipt on the system's chain:

| field | value |
| --- | --- |
| `action` | `{"kind": "llm_call", "name": "<the path, e.g. v1/chat/completions>"}` |
| `actor.agent` | the `x-sigillo-agent` header when the client sets it, else the system id |
| `model` | `{"name": "<the request's model>", "provider": "openai" \| "anthropic" \| "gemini", "digest": null}`; for Gemini's own API, the model named in the path |
| `input`, `output` | digests of the request body and of the answer, each under a fresh nonce |
| `outcome` | `ok` for a 2xx answer, `error` otherwise, `unknown` for a stream cut short |
| `source` | `{"type": "api"}` |

Where `SIGILLO_LLM_TOOL_REQUESTS` allows it (`off`, `operator` — the default —
or `all`), each tool the model asks for in a successful answer also gets a
receipt of its own, right after the call's: kind `tool_call`, name
`model_requested.<tool>` (for example `model_requested.send_email`), the
arguments digested under a nonce like any other input, `outcome` `unknown`, the
same agent and model. It is read out of the answer in each provider's own shape
(OpenAI chat and responses, Anthropic `tool_use`, Gemini `functionCall`), whole
or streamed. It records what the model **asked its agent to do**; whether the
agent then did it is not something the gateway can see (`docs/SECURITY.md`).

A plain answer is handed back only after its receipt is written: if the signer
cannot sign, the agent gets `503` and not the answer. A streamed answer
(`text/event-stream`) is passed on as it arrives and its receipt written when it
ends. `GET` (a model list) is forwarded and not recorded.

Errors of the gateway itself: `401` without a valid sigillo key, `403` when the
gateway is not open to the system's account, `404` for an unknown provider or a
path not under the provider's API version, `409` when the system has no key for that provider, `415`
for a body that is not JSON, `502` when the provider does not answer; plus the
`503` and `429` every ingest endpoint can give (signer away, writes paused,
monthly limit).

Who may use it is set by `SIGILLO_LLM_GATEWAY`: `operator` (the code's default)
for the administrator's own systems only, `all` for every account (the
deployment's `docker-compose.yml` sets it), `off` for none. The
console's block follows the same setting.

## `GET /healthz`

Returns `{"status":"ok"}` while the signer answers with the key the server
started with and every chain is intact. Otherwise `503`, with
`{"status":"signer unavailable"}` when the signer does not answer, or
`{"status":"a chain failed its check or disagrees with the signer"}` when a
system is red in the web view (a broken link or signature, or a chain on which
the signer and the database disagree). No authentication, and no information
about which system: that is in the web view and the administrative log. The server reconnects to a
restarted signer on its own; a signer that comes back with a different key is
refused until the server is restarted.

## Command line

The server and the signer are separate programs, and the signer is the only one
that ever touches a key.

```sh
# once, where the key will live
sigillo-signer keygen --key /var/lib/sigillo/signer.key
sigillo-signer serve  --key /var/lib/sigillo/signer.key --socket /run/sigillo/signer.sock \
  --state /var/lib/sigillo/signer-state [--clock-tolerance-seconds 300]

# once only, to upgrade a database whose chains predate the signer's own state,
# with the server and the signer stopped
sigillo-signer init-from-db --db /var/lib/sigillo/sigillo.db --state /var/lib/sigillo/signer-state

# register a system and open its chain, then issue a key for it
sigillo-server system create acme-support-bot --db /var/lib/sigillo/sigillo.db \
  --signer-socket /run/sigillo/signer.sock
sigillo-server key create acme-support-bot --db /var/lib/sigillo/sigillo.db

sigillo-server key list   --db /var/lib/sigillo/sigillo.db
sigillo-server key revoke <key id> --db /var/lib/sigillo/sigillo.db
sigillo-server system list --db /var/lib/sigillo/sigillo.db          # --all to include archived ones

# the name the web view shows (an empty string clears it); the system_id never changes
sigillo-server system rename acme-support-bot "Assistente clienti" --db /var/lib/sigillo/sigillo.db
# take a system off the main listings, and put it back; its chain is untouched
sigillo-server system archive   acme-support-bot --db /var/lib/sigillo/sigillo.db
sigillo-server system unarchive acme-support-bot --db /var/lib/sigillo/sigillo.db
# delete a system whose chain holds only its genesis; refused for any other
sigillo-server system delete test-bot --confirm test-bot --db /var/lib/sigillo/sigillo.db
# who renamed, archived or deleted what, and when
sigillo-server admin-log --db /var/lib/sigillo/sigillo.db

# a person's pseudonym token, and their erasure (the log keeps only the token)
sigillo-server subject find elena.rizzo --db /var/lib/sigillo/sigillo.db
sigillo-server subject erase --identifier elena.rizzo --db /var/lib/sigillo/sigillo.db
# cut receipts off from their content: by position, or by a candidate's CV
sigillo-server openings erase acme-support-bot --seq 4 --seq 7-9 --confirm acme-support-bot --db /var/lib/sigillo/sigillo.db
sigillo-server openings erase --document cv.pdf --confirm selezione-cv --db /var/lib/sigillo/sigillo.db

sigillo-server serve --db /var/lib/sigillo/sigillo.db \
  --signer-socket /run/sigillo/signer.sock --port 8080

# an export, and an independent check of it
sigillo-server export acme-support-bot --db /var/lib/sigillo/sigillo.db \
  --signer-socket /run/sigillo/signer.sock --out ./fascicolo
sigillo-verify ./fascicolo
# by choice only: name the person behind a token, and disclose some nonces
sigillo-server export acme-support-bot --subject psn_<32 hex> --open 4 --open 7-9 ...
# open a digest, given its content (the nonce from --nonce or openings.jsonl)
sigillo-verify open ./fascicolo 4 input --text 'score: 7'
```

`system list` prints one line per system: the `system_id`, the number of
receipts, `active` or `archived <when>`, and the display name, tab-separated.
None of `rename`, `archive`, `unarchive`, `delete` and `admin-log` needs the
signer: they sign nothing. `system delete` exits with 1, and changes nothing,
for a system with any receipt beyond its genesis, whatever `--confirm` says
(`docs/SECURITY.md`, "Renaming, archiving and deleting a system"). A deleted
`system_id` cannot be created again. Every change made by these commands is
written to the administrative log, with the operating system's user and host.
The same operations are in the web view, under "sistemi" → "gestisci". There
is no HTTP API for them: ingest keys cannot manage systems.

`sigillo-server` also reads `SIGILLO_DB`, `SIGILLO_SIGNER_SOCKET`,
`SIGILLO_HOST` and `SIGILLO_PORT`, so the flags can be left out in a container.

`serve` reads the rest of its configuration from the environment, and checks
all of it before it opens anything: a value that is not what it should be stops
it, with the variable's name in the message.

| variable | default | meaning |
|---|---|---|
| `SIGILLO_ADMIN_PASSWORD` or `SIGILLO_ADMIN_PASSWORD_FILE` | unset: no web view | the web view's password, at least 12 characters; the `_FILE` form names a file holding it |
| `SIGILLO_CHECKPOINT_MINUTES` | 60 | how often each chain is checkpointed |
| `SIGILLO_STALE_AFTER_MINUTES` | 1440 | inactivity before a system's light turns yellow |
| `SIGILLO_TSA_RETRY_MINUTES` | 5 | how soon a timestamp the authority did not give is asked for again |
| `SIGILLO_MAX_ANCHOR_DELAY_MINUTES` | 60 | how long a checkpoint may wait for its timestamp, or how late the authority may date it, before the light turns yellow; match it to the `--max-anchor-delay` auditors use with `sigillo-verify` |
| `SIGILLO_LOGIN_MAX_FAILURES` | 5 | wrong passwords allowed per address within the window |
| `SIGILLO_LOGIN_WINDOW_MINUTES` | 15 | that window |
| `SIGILLO_LOGIN_LOCKOUT_MINUTES` | 5 | the first lockout; each further one doubles |
| `SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES` | 60 | the longest lockout |
| `SIGILLO_INGEST_MAX_FAILURES` | 20 | wrong API keys allowed per address per minute |
| `SIGILLO_TRUST_PROXY` | unset: none | addresses of the reverse proxies whose `X-Forwarded-For` and `-Proto` to believe (`uniquelocal` behind the supplied Compose file); `true` and hop counts are refused |
| `SIGILLO_COOKIE_SECURE` | `auto` | `true`, `false`, or `auto`: `Secure` whenever the browser came over HTTPS |
| `TSA_URL`, `TSA_USERNAME`, `TSA_PASSWORD` or `TSA_PASSWORD_FILE` | no authority | the RFC 3161 authority and its credentials |

The web view's password attempts are limited per address: after
`SIGILLO_LOGIN_MAX_FAILURES` wrong ones in the window, the address waits, and
while it waits every attempt, the right password included, gets the same page
and the same `401` as a wrong password. Nothing in the answer says which of the
two happened.

An issued token is printed once and is not recoverable: the database holds only
its scrypt hash.
