# The sigillo receipt format, version 1

This document defines the receipt: the unit of evidence sigillo produces. It is
written so that a second implementation can verify a sigillo log without reading
the sigillo source. Everything a verifier must check is stated here.

Status: receipt schema version `1`. Merkle checkpoints, RFC 3161 timestamp
anchoring and the export archive are defined in later sections of this document
as those parts of the system are built (milestones M7 and M8).

## 1. What a receipt is

A receipt records one action taken by an AI system: a tool call, a model call, a
step of an agent loop, a decision, or the opening of a chain. Receipts belonging
to one `system_id` form a single chain, ordered by `seq`, where each receipt
carries the digest of the one before it.

A receipt never carries the content of a prompt, a tool argument, or a result.
It carries digests of them. A receipt is metadata plus hashes, and it is meant
to be shown to an auditor.

## 2. The receipt object

A receipt is a JSON object with exactly these members. There are no other
members: a receipt carrying an unknown member is invalid and MUST be rejected.

| member | type | constraint |
|---|---|---|
| `v` | integer | exactly `1` for this version |
| `system_id` | string | 1 to 128 characters; identifies the AI system, and therefore the chain |
| `seq` | integer | `>= 0`; position in the chain, no gaps, no repeats |
| `ts_event` | string | time declared by the source; see 2.1. Not trusted |
| `ts_received` | string | time the server accepted the event; see 2.1 |
| `actor` | object | see 2.2 |
| `action` | object | see 2.3 |
| `input_hash` | string or null | 64 lowercase hex characters, or `null` when no input was available |
| `output_hash` | string or null | 64 lowercase hex characters, or `null` when no output was available |
| `outcome` | string | one of `ok`, `error`, `blocked`, `unknown` |
| `source` | object | see 2.4 |
| `prev_hash` | string | 64 lowercase hex characters; digest of the previous receipt, or 64 `0` characters for the first |
| `key_id` | string | 16 lowercase hex characters; identifies the signing key, see 5 |
| `sig` | string | 88 characters of standard base64; the signature, see 5 |

### 2.1 Timestamps

Both timestamps are ISO-8601 in UTC with exactly three fractional digits and a
literal `Z`:

```
YYYY-MM-DDTHH:MM:SS.sssZ
```

matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, and denoting a real
calendar instant. No other spelling of the same instant is valid: not `+00:00`,
not a missing fractional part, not microseconds. This is the form JavaScript's
`Date.prototype.toISOString` emits, and the restriction exists so that two
implementations never disagree about the bytes being hashed.

`ts_event` comes from the instrumented system and is not trusted: a source can
claim any time. `ts_received` is written by the sigillo server when it accepts
the event, and is the time an auditor should rely on, bounded from above by the
timestamp token that anchors the checkpoint covering the receipt.

### 2.2 `actor`

```json
{ "agent": "planner", "on_behalf_of": "urn:operator:night-shift" }
```

- `agent`: string, 1 to 256 characters. The agent that took the action.
- `on_behalf_of`: string, 1 to 256 characters, optional. The person or system
  the agent acted for. Where a human is in the loop (AI Act art. 14), this is
  where they are named. Omit the member entirely when there is none; it is never
  present with a `null` or empty value.

### 2.3 `action`

```json
{ "kind": "tool_call", "name": "payments.charge" }
```

- `kind`: one of `tool_call`, `llm_call`, `agent_step`, `decision`, `genesis`.
- `name`: string, 1 to 256 characters. The tool, operation or decision name.

The cap on `name` is deliberate: a name is metadata, and the cap keeps a caller
from smuggling a prompt into the chain in the clear.

### 2.4 `source`

```json
{ "type": "otlp", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" }
```

- `type`: one of `otlp` (an OpenTelemetry span), `sdk` (the sigillo SDK), `api`
  (the native receipt API).
- `trace_id`: optional, exactly 32 lowercase hex characters.
- `span_id`: optional, exactly 16 lowercase hex characters.

Both identifiers are omitted when absent, never null.

## 3. Canonical form

The canonical form of a receipt is its RFC 8785 (JSON Canonicalization Scheme)
serialisation **with the `sig` member removed**. In full:

1. Take the receipt object and drop the `sig` member. Every other member stays,
   including `key_id`.
2. Serialise per RFC 8785:
   - object members sorted by member name, compared as sequences of UTF-16 code
     units (all member names in this format are ASCII, so sorting by code point
     gives the same order);
   - no whitespace between tokens;
   - strings escaped as JSON requires: `"` as `\"`, `\` as `\\`, backspace as
     `\b`, form feed as `\f`, line feed as `\n`, carriage return as `\r`, tab as
     `\t`, any other character below U+0020 as `\u00xx` with lowercase hex
     digits; every other character, including all non-ASCII text, emitted
     literally;
   - integers serialised without a sign, a fractional part or an exponent;
   - `null` serialised as `null`.
3. Encode the result as UTF-8. Those bytes are the canonical form.

A member whose value is absent is simply not serialised. `undefined` is not a
JSON value: an optional member is either present with a value or not present at
all, and the two cases produce different bytes.

## 4. Receipt hash

```
receipt_hash = SHA-256(canonical form)
```

The 32 raw bytes are what the signature covers. Wherever the hash appears as
text — in `prev_hash`, in an inclusion proof, in an export manifest — it is the
64-character lowercase hex encoding of those bytes.

Because the canonical form excludes `sig`, a receipt's hash can be computed
before it is signed, and recomputing it later never depends on the signature.
This is what lets the chain position be assigned and the receipt be signed as
two separable steps.

## 5. Signature

- Algorithm: Ed25519 (RFC 8032), as provided by `node:crypto`.
- The signature is computed over the **32 raw bytes of the receipt hash**, not
  over the canonical form and not over a re-hash of those bytes. In Node terms:
  `crypto.sign(null, receiptHash, privateKey)`.
- `sig` is the 64-byte signature in standard base64 with padding (RFC 4648
  section 4): 88 characters, ending in `==`. Not base64url.
- `key_id` is the first 16 characters of the lowercase hex SHA-256 digest of the
  **raw 32-byte public key**, that is, the key without any DER or PEM framing.

To verify a receipt:

1. Validate it against section 2.
2. Compute its canonical form (section 3) and its hash (section 4).
3. Look up the public key whose `key_id` matches, and check the Ed25519
   signature in `sig` against the 32-byte hash.

A verifier MUST refuse a receipt whose `key_id` it cannot resolve to a public
key. Knowing a key's identifier is not knowing the key.

## 6. Chain rules

For each `system_id`:

- The first receipt has `seq` 0, `action.kind` `genesis`, `action.name` equal to
  `system_id`, and `prev_hash` equal to 64 `0` characters.
- Every later receipt has `seq` exactly one greater than its predecessor, and
  `prev_hash` equal to the hex receipt hash of that predecessor.
- Chains for different `system_id` values are independent and never interleave.

A verifier checks, in order: every receipt is well formed; `seq` runs from 0
upward with no gap and no duplicate; every `prev_hash` matches the recomputed
hash of the preceding receipt; every signature verifies under a known key.

## 7. Worked example

The genesis receipt of a system called `acme-support-bot`:

```json
{
  "v": 1,
  "system_id": "acme-support-bot",
  "seq": 0,
  "ts_event": "2026-03-29T14:30:00.123Z",
  "ts_received": "2026-03-29T14:30:00.456Z",
  "actor": { "agent": "acme-support-bot" },
  "action": { "kind": "genesis", "name": "acme-support-bot" },
  "input_hash": null,
  "output_hash": null,
  "outcome": "ok",
  "source": { "type": "api" },
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "key_id": "3f2a1c9d8e7b6a5f",
  "sig": "..."
}
```

Its canonical form is these 399 bytes, on one line:

```
{"action":{"kind":"genesis","name":"acme-support-bot"},"actor":{"agent":"acme-support-bot"},"input_hash":null,"key_id":"3f2a1c9d8e7b6a5f","outcome":"ok","output_hash":null,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":0,"source":{"type":"api"},"system_id":"acme-support-bot","ts_event":"2026-03-29T14:30:00.123Z","ts_received":"2026-03-29T14:30:00.456Z","v":1}
```

and its hash is

```
f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543
```

which you can reproduce with nothing but a shell, passing the canonical line
above with no trailing newline:

```sh
printf '%s' "$(cat canonical.txt)" | openssl dgst -sha256
```

## 8. Test vectors

`packages/core/test/vectors.json` carries a set of receipts with their canonical
form and digest recorded alongside. They cover the genesis receipt, every action
kind and outcome, present and absent optional members, JSON escaping, non-ASCII
and astral-plane text, control characters, calendar edge cases, the field length
caps, and the largest exactly representable integer as a `seq`.

The `sig` values in that file are a fixed placeholder, chosen so it decodes to
readable text: the vectors pin the wire format, not signatures.

`scripts/crosscheck_vectors.py` re-derives every canonical form and digest in
the file using only the Python standard library, with no sigillo code involved.
It runs in CI. If it ever disagrees with the Node implementation, this document
is what decides which one is wrong.

## 9. Relationship to draft-sharif-agent-audit-trail

The IETF Internet-Draft "Agent Audit Trail: A Standard Logging Format for
Autonomous AI Systems" (`draft-sharif-agent-audit-trail`) addresses the same
problem and cites the same regulation. Revision -04 was read on 2026-09-21; it
is an individual draft, not adopted by a working group, and its field names are
not stable. sigillo does not claim conformance with it. The differences below
are recorded so the two can be compared, and so a future alignment is a known
piece of work rather than a discovery.

Where the two agree: JSON records, RFC 8785 canonicalisation, SHA-256, a
hash chain over the previous record, RFC 6962 Merkle construction with
`0x00`/`0x01` domain separation for batch anchoring, RFC 3161 external
timestamps, and hashing inputs and outputs instead of storing them.

Where they differ:

| topic | sigillo v1 | draft -04 |
|---|---|---|
| what `prev_hash` covers | the previous receipt **without** its `sig` | the complete previous record **including** its signature, with the detached `batch` object removed |
| first record | `prev_hash` is 64 zeros, `action.kind` is `genesis` | `prev_hash` and `parent_record_id` are `null` |
| ordering | explicit `seq`, contiguous per chain | implicit, via `parent_record_id` pointing at the previous `record_id` |
| identity of a record | `system_id` plus `seq` | `record_id` (UUIDv4), `session_id` (UUIDv4) |
| signature algorithm | Ed25519, standard base64 | ES256 by default, optionally ML-DSA-65, base64url, hybrid mode with two signatures |
| key identifier | 16 hex characters of SHA-256 over the raw public key | `signer_kid`, an RFC 7638 JWK thumbprint in base64url |
| signature coverage | the 32-byte receipt hash | the 32-byte hash of the record minus the signature fields and `batch` |
| outcomes | `ok`, `error`, `blocked`, `unknown` | `success`, `failure`, `timeout`, `denied`, `escalated` |
| action taxonomy | `tool_call`, `llm_call`, `agent_step`, `decision`, `genesis` | `tool_call`, `tool_response`, `decision`, `delegation`, `escalation`, `error`, `lifecycle` |
| mandatory fields sigillo has no equivalent for | — | `agent_version`, `trust_level` (L0 to L4), `record_phase` (pre/post/concurrent), `action_detail` |
| anchoring | separate signed checkpoints over the whole chain, each anchored by one RFC 3161 token | optional per-record `external_timestamp`, optional detached `batch` object carrying a Merkle root |
| who writes the record | always an independent server; the agent never signs | self-recording or independent recording, distinguished by `recording_component` |

The difference in what `prev_hash` covers is the substantive one. sigillo
chains content only, so a receipt's identity exists before it is signed: the
server assigns `seq` and `prev_hash` inside one database transaction and asks a
separate signing process for a signature afterwards, without the chain ever
depending on the signer being reachable. Chaining the signature as well, as the
draft does, would make the chain depend on the signature and remove that
separation. Both constructions are tamper-evident.

### Possible alignments, for decision

These are not implemented. They are recorded here as proposals:

1. **Outcome vocabulary.** Publish a mapping table between the two vocabularies
   and emit it in the export manifest, rather than changing `outcome`. `blocked`
   maps to `denied`; `error` covers both `failure` and `timeout`. Cheap, and it
   costs nothing in the chain.
2. **`record_phase`.** The draft's distinction between a record written before
   an action ran and one written after it is genuinely useful under AI Act
   art. 14: it is what makes `blocked` mean "stopped" rather than "failed".
   Adding it would require receipt version 2.
3. **Trust level.** `trust_level` presumes the draft's companion identity
   framework. It is not meaningful for sigillo as specified and is not proposed.
4. **Record size limit.** The draft requires rejecting records above 256 KB.
   sigillo caps each free-text field instead, which bounds a receipt well below
   that. No change proposed, recorded for comparison.
