# sigillo API

Two ways in, one way out. Everything an agent sends becomes a signed receipt on
the chain of exactly one system; everything an auditor gets comes out of an
export. The receipt format itself is in [FORMAT.md](FORMAT.md).

This document covers what is implemented. The export endpoint, the checkpoint
endpoints and the web interface are added as those milestones land.

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
whether a key is still live from the database on every request.

An address that sends too many wrong keys (`SIGILLO_INGEST_MAX_FAILURES` in a
minute, 20 by default) is locked out for a minute, doubling on each further
lockout up to 15 minutes. While it is locked out, a key the server has not
already checked is refused with the same `401`, without being checked; a key
the server has already accepted keeps working, so an agent sharing that
address carries on.

A request the server cannot complete because the signer is not reachable gets
`503`, which OTLP exporters retry. Any other failure inside the server gets
`500` with `{"error":"internal error"}` and nothing more.

## `POST /v1/traces` — OpenTelemetry ingest

Accepts an OTLP/HTTP trace export in either encoding:

| `Content-Type` | body |
|---|---|
| `application/x-protobuf` | `ExportTraceServiceRequest`, as the official Python exporter sends it |
| `application/json` | the same message in OTLP/JSON, with identifiers as hex or as base64 |

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
  only an `llm_call`.
- **`model`**: for a recognised `llm_call` only, from `gen_ai.request.model` /
  `gen_ai.response.model` / `llm.model_name` for the name,
  `gen_ai.provider.name` / `gen_ai.system` / `llm.provider` / `llm.system` for
  the provider, and the SDK's own `sigillo.model.digest` for the digest — the
  latter present only when `sigillo.init(..., ollama_url=...)` could reach
  Ollama.

The span's status becomes the receipt's outcome: `OK` → `ok`, `ERROR` →
`error`, and an unset status → `unknown`. An unset status is not read as
success: OpenTelemetry leaves it unset unless the source said otherwise.

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

For code that is not instrumented with OpenTelemetry. One receipt per request.

```json
{
  "actor": { "agent": "planner", "on_behalf_of": "urn:operator:night-shift" },
  "action": { "kind": "decision", "name": "refund.approve" },
  "outcome": "blocked",
  "ts_event": "2026-03-29T14:30:01.000Z",
  "input": { "amount": 120 },
  "source": { "type": "sdk", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736" }
}
```

| field | required | notes |
|---|---|---|
| `actor.agent` | yes | 1 to 256 characters |
| `actor.on_behalf_of` | no | the person the agent acted for |
| `action.kind` | yes | `tool_call`, `llm_call`, `agent_step` or `decision`. Not `genesis` |
| `action.name` | yes | 1 to 256 characters |
| `outcome` | yes | `ok`, `error`, `blocked`, `unknown` |
| `ts_event` | no | ISO-8601 UTC with milliseconds. Defaults to the time of receipt |
| `source` | no | `{ type: "sdk" \| "api", trace_id?, span_id? }`, defaults to `api` |
| `input` / `output` | no | any JSON value. Hashed on arrival and discarded |
| `input_hash` / `output_hash` | no | a digest you computed yourself, 64 lowercase hex |
| `system_id` | no | if present, must be the system the key writes to |

Send either the value or its digest for a given field, never both. A caller that
would rather the server never see the value at all can compute the digest itself:
it is the SHA-256 of the RFC 8785 canonical JSON of the value, as FORMAT.md
section 3 defines it.

`ts_received` is always stamped by the server. A caller cannot choose where in
the chain its receipt lands, nor when the server says it arrived.

Response `201`:

```json
{ "seq": 11, "system_id": "acme-support-bot", "ts_received": "2026-03-29T15:00:00.000Z", "key_id": "a4d324060dbd98e0" }
```

Response `400` names the offending field. Response `403` if the body claims a
different system than the key writes to.

## `GET /healthz`

Returns `{"status":"ok"}` while the signer answers with the key the server
started with, and `503 {"status":"signer unavailable"}` otherwise. No
authentication, no information about any system. The server reconnects to a
restarted signer on its own; a signer that comes back with a different key is
refused until the server is restarted.

## Command line

The server and the signer are separate programs, and the signer is the only one
that ever touches a key.

```sh
# once, where the key will live
sigillo-signer keygen --key /var/lib/sigillo/signer.key
sigillo-signer serve  --key /var/lib/sigillo/signer.key --socket /run/sigillo/signer.sock

# register a system and open its chain, then issue a key for it
sigillo-server system create acme-support-bot --db /var/lib/sigillo/sigillo.db \
  --signer-socket /run/sigillo/signer.sock
sigillo-server key create acme-support-bot --db /var/lib/sigillo/sigillo.db

sigillo-server key list   --db /var/lib/sigillo/sigillo.db
sigillo-server key revoke <key id> --db /var/lib/sigillo/sigillo.db
sigillo-server system list --db /var/lib/sigillo/sigillo.db

sigillo-server serve --db /var/lib/sigillo/sigillo.db \
  --signer-socket /run/sigillo/signer.sock --port 8080

# an export, and an independent check of it
sigillo-server export acme-support-bot --db /var/lib/sigillo/sigillo.db \
  --signer-socket /run/sigillo/signer.sock --out ./fascicolo
sigillo-verify ./fascicolo
```

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
