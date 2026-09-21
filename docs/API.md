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
working immediately.

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

The span's status becomes the receipt's outcome: `OK` → `ok`, `ERROR` →
`error`, and an unset status → `unknown`. An unset status is not read as
success: OpenTelemetry leaves it unset unless the source said otherwise.

Response `200`:

```json
{
  "partialSuccess": {},
  "sigillo": {
    "accepted": 5,
    "ignored": 1,
    "unknown": ["gen_ai.operation.name=rerank_documents"]
  }
}
```

`partialSuccess` is there because OTLP clients expect it. `sigillo` is the part
worth reading: how many receipts were written, how many spans were not AI
actions, and which convention values were unrecognised.

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

Returns `{"status":"ok"}`. No authentication, no information about any system.

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

An issued token is printed once and is not recoverable: the database holds only
its scrypt hash.
