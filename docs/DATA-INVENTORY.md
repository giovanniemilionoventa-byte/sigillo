# What a receipt records in clear

This page lists every member of a receipt that holds text rather than a
digest: where its value comes from, what sigillo checks, and where it shows up
again. It is meant for whoever connects an agent to sigillo and has to decide
what goes into those fields. It describes what the software does. It is not a
statement of compliance with any regulation.

## The one thing to know first

Everything in a receipt is covered by its hash, its signature and the chain.
**Nothing recorded in a receipt can later be corrected or erased** without
breaking verification from that receipt onwards: that is the property sigillo
exists to provide. So data minimisation has to happen *before* a value reaches
sigillo, in the agent or its instrumentation. Nothing downstream can undo it.

## Field by field

| member | where the value comes from | what sigillo checks |
|---|---|---|
| `system_id` | the operator, when the system is created (CLI or web view) | 1–128 characters |
| `actor.agent` | native API: the caller. OTLP: `gen_ai.agent.name`, else `gen_ai.provider.name` / `gen_ai.system` (GenAI) or `llm.system` (OpenInference), else the resource's `service.name`, else `unknown`. The Python SDK sets `service.name` to the `system_id` | 1–256 |
| `actor.on_behalf_of` | native API: the caller. OTLP: the span attribute `user.id`, else `enduser.id`. Absent when neither is set | 1–256 |
| `action.name` | native API: the caller. OTLP: the tool name, the model name or the agent name, depending on the kind of action, else **the span's own name** | 1–256 |
| `artifacts[].label`, `artifacts[].media_type` | the `sigillo.artifact(...)` call in the agent's code | 1–256, 1–128 |
| `model.name`, `model.provider`, `model.digest` | OTLP: `gen_ai.request.model` / `llm.model_name`, the provider attributes above, `sigillo.model.digest` | 1–256 each |
| `source.trace_id`, `source.span_id` | the OpenTelemetry trace | hex of fixed length |

For every text member, sigillo checks only the length, and that the value is
well-formed Unicode. An over-long OTLP value is cut to fit, and a lone
surrogate from OTLP/JSON becomes U+FFFD. The native API refuses the request
instead. sigillo does **not** look at what the text says: it does not detect
names, email addresses, identifiers or sentences, and it would record any of
them as sent.

## Outside the receipts: the system's name and the administrative log

Two things the operator writes are not part of any receipt, and are not
covered by the property above.

- A system's **`display_name`**, the label the web view shows (1–128
  characters, no control characters). It can be changed or cleared at any
  time, and the old value is overwritten. An evidence file keeps the name the
  system had when it was exported, in `report.pdf` and `VERIFY.md`.
- The **administrative log** (`admin_log`), which records renames, archivals,
  reactivations and deletions of systems. Each entry holds who acted, as
  `web <client address>` or `cli <operating-system user>@<host>`, the
  names before and after a rename, and for a deletion the removed genesis's
  hash and the ids of the API keys removed with it. The log is append-only
  like the evidence: an address or a name written there stays. A name that
  should not be kept therefore should not be given to a system, not even for
  a moment.

`trace_id` and `span_id` are random, but they are designed to be looked up: in
whatever observability system produced the trace, they lead back to the full
span, payloads included if that system kept them.

## What the repository's own agents actually send

Measured on a real run of `demo/selezione-cv` (20 CVs) and
`sdk-python/examples/langgraph_agent.py` against a real server: 169 receipts.

| member | values seen |
|---|---|
| `actor.agent` | always the `system_id` (`selezione-cv`, `acme-support-bot`), from `service.name` |
| `actor.on_behalf_of` | `elena.rizzo` on 160 of 169 receipts: the recruiter the demo acts for, set as `user.id` |
| `action.name` | code identifiers only: graph nodes (`leggi`, `valuta`, `invia`, `LangGraph`), tools (`leggi_curriculum`, `invia_email`), model classes (`FakeRationaleModel`) |
| `artifacts[].label` | `curriculum`, `email di risposta` |

No candidate's name and no line of a CV appears anywhere in the database file:
those only ever reached sigillo inside payloads that were reduced to digests.
The one personal identifier in clear is the one the demo put in `user.id` on
purpose.

## Where the text shows up again

- **Database**: the whole receipt, in `receipts.canonical`. `action_name` is also
  a column of its own (indexed, searched with `LIKE` from the web view), and each
  artifact's `label` has a row in `artifacts`.
- **Web view**: every page that lists actions writes the agent, the action name,
  `on_behalf_of`, the model and the artifact labels into a sentence.
- **Export**: `receipts.jsonl` holds every member. `artifacts-index.jsonl` repeats
  each artifact's `label`. `report.pdf` names the system and counts actions by
  kind, and shows no other text member.
- **Server and Caddy logs**: request URLs, including a system's id in the path
  and web-view search terms in the query string.

## Digests are not anonymisation

`input_hash`, `output_hash` and `artifacts[].sha256` carry no content. But a
digest can be checked by anyone who holds, or can guess, the original.

- **A document**: whoever has the file can confirm it was used. That is the
  point of the feature.
- **A short or predictable value**: an outcome such as `"colloquio"` /
  `"non_idoneo"`, a score, a yes or no. The digest can be recovered by
  hashing each candidate value, because sigillo's digests are not salted.

## What travels to the server without being stored

The ingest adapter always reduces `input.value` and `output.value` to digests,
and discards every other payload attribute of a span (`llm.input_messages`,
tool parameters and so on): none of it is ever written to the database, the
export or the logs. Whether it reaches the server **at all** depends on where
the digest is computed.

**By default, since fase 9 of the pilot plan, it does not.** The Python SDK
hashes `input.value` / `output.value` in the caller's own process, and sends
only the digest (`sigillo.input.sha256` / `sigillo.output.sha256`) and an
allow-list of identifiers; the raw value never leaves the agent's machine.
Measured on the CV demo: with the filter on, no candidate's name and no line
of any CV appears anywhere in the traffic sent to sigillo (before, the demo
sent the full text of every CV — see `docs/PROPOSTA-FASE-8.md` §1 for the
measurement that led to this). This is `sigillo.init(..., redact_content=True)`,
the default; `redact_content=False` reverts to sending the raw value, which
the server still reduces to a digest, but only after receiving it.

An SDK that predates fase 9, or a caller of the OTLP endpoint that is not this
SDK, still sends the raw value, and the server hashes it there instead — in
its memory for the length of the request, never stored. The `rawContentHashed`
count in `POST /v1/traces`' response (see `docs/API.md`) is exactly this: how
many fields the server had to hash itself rather than receiving an
already-computed digest. It is a signal for the operator, not a block: such a
span is still recorded.

## Recommendations for an integration

- **`on_behalf_of`**: an opaque identifier, not a name or an email address. For
  example, the id of the user's account in the system the agent serves, whose
  meaning stays in that system. The Python SDK's `sigillo.pseudonym(value,
  key)` turns an existing identifier into one, with a key that stays with the
  caller and is never sent to sigillo.
- **Action names**: code identifiers such as tool names, node names or model
  names. Do not create spans whose *name* is built from data (`"reply to Mario
  Rossi"`): for an unrecognised tool or node, the span name is what becomes
  `action.name`.
- **`service.name`**: the `system_id`, as the SDK sets it. A hostname or a
  person's name here becomes `actor.agent`.
- **Artifact labels**: a category (`curriculum`), never a file name. A file name
  can carry a person's name.
- **Before going live**: export the first receipts and read `receipts.jsonl`.
  Whatever text is there will be in every receipt from then on.
