# The sigillo receipt format

This document defines the receipt: the unit of evidence sigillo produces. It is
written so that a second implementation can verify a sigillo log without reading
the sigillo source. Everything a verifier must check is stated here.

Status: two schema versions are current, `1` and `2`. Version 1 was **confirmed
as final by the project owner on 2026-09-21**: no receipt it accepts is ever
rejected by a later version of this document. Version 2 was added on
2026-09-22 (phase 2) to carry document fingerprints and model identity; it is
purely additive, described in section 2.5 and 2.6. A verifier applies the
rules of the version each receipt actually declares, so one chain, and one
export, may freely mix `v: 1` and `v: 2` receipts.

The canonical-base64 rule of section 5 was added after version 1 was already in
use, and the version was deliberately not incremented: the rule only rejects
spellings sigillo never produced, so every receipt ever written by sigillo
remains valid under it. A future change that a previously valid receipt could
fail must increment `v`. Version 2 was measured against the same test:
`artifacts` and `model` are both new and both optional, so nothing that was
valid under version 1 is affected by version 2 existing.

## 1. What a receipt is

A receipt records one action taken by an AI system: a tool call, a model call, a
step of an agent loop, a decision, or the opening of a chain. Receipts belonging
to one `system_id` form a single chain, ordered by `seq`, where each receipt
carries the digest of the one before it.

A receipt never carries the content of a prompt, a tool argument, or a result.
It carries digests of them. A receipt is metadata plus hashes, and it is meant
to be shown to an auditor.

## 2. The receipt object

A receipt is a JSON object with exactly these members for the version it
declares. There are no other members: a receipt carrying an unknown member is
invalid and MUST be rejected — including a version 1 receipt that carries
`artifacts` or `model`, which are version 2 members only.

| member | type | constraint |
|---|---|---|
| `v` | integer | `1` or `2` |
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
| `artifacts` | array, optional | version 2 only; see 2.5 |
| `model` | object, optional | version 2 only; see 2.6 |

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

### 2.5 `artifacts` (version 2 only)

```json
[
  { "role": "input", "label": "curriculum", "media_type": "text/plain", "sha256": "…" },
  { "role": "output", "label": "email di risposta", "media_type": "text/plain", "sha256": "…" }
]
```

The documents an action touched, as fingerprints only. Optional; when present,
a non-empty array. A receipt with nothing to attach omits the member entirely,
never an empty array — the same discipline as `actor.on_behalf_of`.

- `role`: `input` or `output`.
- `label`: string, 1 to 256 characters. A category the developer chose, such as
  `"curriculum"` — **never a filename**, which can carry a person's name.
- `media_type`: string, 1 to 128 characters, such as `"application/pdf"`.
- `sha256`: 64 lowercase hex characters. The digest of the artifact's **exact
  raw bytes** — not of any canonical form, since a document is not JSON. For
  text, this means its exact UTF-8 bytes: one extra space or line ending
  changes the digest. Computing it is exactly `openssl dgst -sha256 <file>`,
  nothing more.

Order is preserved: an array is never reordered by canonicalisation (section
3 sorts object *members*, not array elements), so two artifacts of the same
receipt keep whatever order the caller gave them.

### 2.6 `model` (version 2 only)

```json
{ "name": "qwen2.5:3b", "provider": "ollama", "digest": "sha256:…" }
```

The model identity behind an `llm_call`. Optional at the receipt level, for an
action where no model information is available at all; when present, `name` is
required and `provider`/`digest` are **nullable, not optional members** — the
member is always there, and is `null` when unknown, because unlike
`on_behalf_of` a model name on its own is still meaningful evidence.

- `name`: string, 1 to 256 characters, such as `"qwen2.5:3b"` or `"gpt-4o"`.
- `provider`: string, 1 to 256 characters, or `null`, such as `"ollama"`,
  `"openai"`, `"vllm"`.
- `digest`: string, 1 to 256 characters, or `null`. The model file's own
  fingerprint where the runtime exposes one (for instance, an Ollama model's
  digest from `GET /api/tags`); its exact form is whatever that runtime
  publishes, so this format does not constrain it to hex.

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
- The encoding must be **canonical**: the four bits the final character carries
  beyond the last byte must be zero, as RFC 4648 section 3.5 requires of a
  canonical encoding. Several spellings decode to the same 64 bytes, and only
  the one a canonical encoder produces is valid. Without this rule one signature
  would have many valid forms, an evidence file would have many valid forms for
  one content, and comparing two exports byte for byte would prove nothing. The
  same rule applies to a checkpoint's `sig` and to a public key in a manifest.
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

### 7.1 Worked example, version 2

A `tool_call` that read a document, with one input artifact attached:

```json
{
  "v": 2,
  "system_id": "acme-support-bot",
  "seq": 20,
  "ts_event": "2026-03-29T14:31:13.000Z",
  "ts_received": "2026-03-29T14:31:13.001Z",
  "actor": { "agent": "selezione-cv" },
  "action": { "kind": "tool_call", "name": "leggi_curriculum" },
  "input_hash": null,
  "output_hash": null,
  "outcome": "ok",
  "source": { "type": "sdk" },
  "prev_hash": "f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543",
  "key_id": "3f2a1c9d8e7b6a5f",
  "sig": "...",
  "artifacts": [
    {
      "role": "input",
      "label": "curriculum",
      "media_type": "text/plain",
      "sha256": "7930b9c8f62bf831bf5d051ffa3e25051329b7148e0b8ee22a13b2d8cd0cfb1e"
    }
  ]
}
```

Its canonical form, 552 bytes on one line — `artifacts` sorts alongside every
other member, and the one artifact's own members are sorted the same way:

```
{"action":{"kind":"tool_call","name":"leggi_curriculum"},"actor":{"agent":"selezione-cv"},"artifacts":[{"label":"curriculum","media_type":"text/plain","role":"input","sha256":"7930b9c8f62bf831bf5d051ffa3e25051329b7148e0b8ee22a13b2d8cd0cfb1e"}],"input_hash":null,"key_id":"3f2a1c9d8e7b6a5f","outcome":"ok","output_hash":null,"prev_hash":"f8d9fb0d22e9e140620df37dd742cfe798417d077aaa6a591eb4680356ec9543","seq":20,"source":{"type":"sdk"},"system_id":"acme-support-bot","ts_event":"2026-03-29T14:31:13.000Z","ts_received":"2026-03-29T14:31:13.001Z","v":2}
```

and its hash, reproducible the same way as the version 1 example above, is

```
b50f22f0f6d1c7332d28f8cece6a5517f04baa85ffcbedb4a62817cb818ecdd6
```

## 8. Checkpoints and the Merkle tree

A chain proves its own order. A checkpoint proves its own size, at a moment
somebody else can vouch for.

### 8.1 What a checkpoint is

```json
{
  "v": 1,
  "system_id": "acme-support-bot",
  "tree_size": 17,
  "root_hash": "84b39fd0350001ad0ef1d6886db35abfa3241db8139941892b8341c5d6c6207a",
  "ts": "2026-03-29T15:00:00.000Z",
  "key_id": "3f2a1c9d8e7b6a5f",
  "sig": "..."
}
```

| member | type | constraint |
|---|---|---|
| `v` | integer | exactly `1` |
| `system_id` | string | the chain this covers |
| `tree_size` | integer | `>= 1`; how many receipts the tree holds, so `seq` 0 to `tree_size - 1` |
| `root_hash` | string | 64 lowercase hex characters; the Merkle root over those receipts |
| `ts` | string | ISO-8601 UTC with milliseconds, as in section 2.1 |
| `key_id` | string | 16 lowercase hex characters |
| `sig` | string | 88 characters of standard base64 |

Its canonical form, its hash and its signature follow exactly the rules of
sections 3, 4 and 5, with `sig` removed before canonicalising. A verifier that
can check a receipt can check a checkpoint with the same code.

### 8.2 The tree

The tree is the one RFC 6962 defines, over the receipt hashes of section 4 in
`seq` order:

```
leaf(i)        = SHA-256(0x00 || receipt_hash(i))
node(l, r)     = SHA-256(0x01 || l || r)
root(n = 0)    = SHA-256("")
root(n = 1)    = leaf(0)
root(n > 1)    = node(root(entries[0:k]), root(entries[k:n]))
                 where k is the largest power of two strictly below n
```

Two things matter here and are worth stating plainly:

- The `0x00` and `0x01` prefixes put leaves and internal nodes in different
  domains. Without them, a leaf whose content happened to be two concatenated
  hashes would hash identically to the node above them, and an internal node
  could be passed off as a record.
- Splitting at the largest power of two below `n`, rather than duplicating the
  last node to make the level even, is what makes the tree append-only: adding
  receipts never rewrites a subtree that already existed, so an old inclusion
  proof stays valid in every later tree that shares its prefix.

Building the tree level by level, pairing nodes and promoting a lone odd node
unchanged, produces the same root. `scripts/gen_merkle_vectors.py` computes both
ways and refuses to write the vectors if they ever disagree.

### 8.3 Inclusion proofs

An inclusion proof is the RFC 6962 audit path: the sibling hashes from a leaf up
to the root, closest sibling first, as a list of 64-character lowercase hex
strings. It carries **no left-or-right markers**. The side of each step follows
from the leaf's index and the tree size, so there is nothing in a proof that can
contradict itself.

To check that receipt `i` of a chain is covered by a checkpoint:

1. Compute `leaf = SHA-256(0x00 || receipt_hash(i))`.
2. Walk the path per RFC 6962 section 2.1.1, with `fn = i` and `sn = tree_size - 1`:
   for each sibling, if `fn == sn` or `fn` is odd, the sibling is on the left
   (`node = node(sibling, node)`) and then `fn` and `sn` are halved while `fn` is
   even and non-zero; otherwise the sibling is on the right. Halve `fn` and `sn`
   at the end of every step.
3. The result must equal `root_hash`, and the checkpoint's own signature must
   verify.

A path must have exactly as many steps as the position requires. A verifier
computes that length from `i` and `tree_size` and rejects any other length:
once the walk reaches the root, extra steps would keep hashing and produce some
other tree's root rather than an error.

`packages/core/test/merkle-vectors.json` carries roots and audit paths for every
tree size from 0 to 17 and every position in each, derived from the RFC by the
Python script above rather than by sigillo's code.

## 9. Timestamp anchoring

Every checkpoint is anchored with an RFC 3161 timestamp token over its
`root_hash`. That is what turns "these receipts are in this order" into "these
receipts existed no later than this time", attested by someone who is not the
operator of the log.

The request is the one this command produces:

```sh
openssl ts -query -sha256 -digest <root_hash> -cert -no_nonce
```

sent by HTTP POST with `Content-Type: application/timestamp-query`. `-cert` asks
the authority to include its certificate, which is what lets the token be
verified later without fetching anything. `-no_nonce` keeps the request
reproducible: anyone holding the checkpoint can rebuild the exact request bytes.

The response is stored as it arrives, in DER, base64-encoded in the database and
written out as a `.tsr` file in an export. sigillo neither re-encodes it nor
re-signs it.

To verify a token:

```sh
openssl ts -verify -digest <root_hash> -in <token>.tsr -CAfile <authority ca>.pem
```

What it proves: the 32 bytes of `root_hash` were shown to that authority at that
time. What it does not prove: anything about what the tree contained. That comes
from the checkpoint's signature and the chain.

If the authority is unreachable, the checkpoint is still written and signed, and
the token is fetched later. A checkpoint with no token yet is a checkpoint
waiting for an anchor, not a gap.

sigillo uses `https://freetsa.org/tsr` in development and in its tests.
FreeTSA is **not** a qualified trust service provider under eIDAS: a deployment
that needs qualified timestamps points `TSA_URL` at a qualified provider and
supplies its credentials.

## 10. The export

An export is what an auditor is handed: a `.zip` archive, or the same files in a
directory. Both are accepted by a verifier; the directory is simply what you get
after unzipping.

```
receipts.jsonl      one receipt per line, in canonical form, ordered by seq
checkpoints.jsonl   one checkpoint per line, with its proofs and its tokens
timestamps/         the RFC 3161 tokens, in DER, exactly as the authority sent
manifest.json       the public keys, the range, the counts
report.pdf          the same facts for a reader
VERIFY.md           how to check all of it without this software
```

The archive uses only stored and deflated entries, no ZIP64 and no encryption,
so any unzip program opens it. Entries are written in a fixed order with no
timestamps, so exporting the same chain twice produces the same bytes.

### 10.1 `receipts.jsonl`

One receipt per line, as a JSON object, in ascending `seq` order, each line
terminated by a line feed. sigillo writes each line in canonical form so the
file is reproducible byte for byte, but a verifier must not require that: it
re-derives the canonical form itself, so an export that reorders members or adds
whitespace still verifies.

### 10.2 `checkpoints.jsonl`

One line per checkpoint:

```json
{
  "checkpoint": { "v": 1, "system_id": "acme-support-bot", "tree_size": 12, "root_hash": "...", "ts": "...", "key_id": "...", "sig": "..." },
  "proofs": [
    { "seq": 0, "receipt_hash": "...", "path": ["...", "..."] },
    { "seq": 11, "receipt_hash": "...", "path": ["..."] }
  ],
  "timestamps": [
    { "tsa_url": "https://freetsa.org/tsr", "obtained_at": "2026-03-29T15:00:05.000Z", "file": "timestamps/checkpoint-12-1.tsr" }
  ]
}
```

- `proofs` carries the audit path (section 8.3) for the first and the last
  receipt the export holds. Those two anchor the whole range to the checkpoint's
  root; the receipts between them are tied to each other by the chain.
- An export that does not start at `seq` 0 cannot build proofs against a tree it
  does not hold in full. It carries the checkpoint with an empty `proofs` rather
  than a proof it cannot support.
- `file` names the token inside the archive. The token is not inlined: it is
  binary, and an auditor needs it as a file to hand to `openssl`.

### 10.3 `manifest.json`

```json
{
  "sigillo_version": "0.1.0",
  "receipt_version": 1,
  "system_id": "acme-support-bot",
  "exported_at": "2026-03-29T16:00:00.000Z",
  "range": { "from_seq": 0, "to_seq": 11, "from_ts": "...", "to_ts": "..." },
  "counts": { "receipts": 12, "checkpoints": 1, "timestamps": 1 },
  "keys": [{ "key_id": "3f2a1c9d8e7b6a5f", "public_key_base64": "HKjeiu4CwSUn2i6yK8lul5MBgAiclTh8XoiSDJo759g=" }]
}
```

`range.from_ts` and `range.to_ts` are the `ts_received` of the first and last
receipt. `keys` carries the raw 32-byte public keys in standard base64.

`receipt_version` is **not** "the version of this export": a chain may upgrade
from `v: 1` to `v: 2` partway through, and one export can hold both. It is the
**highest** version among the receipts the export actually contains — `1` for
an export that is entirely version 1, `2` as soon as any version 2 receipt is
present. Like `counts`, it is a claim a verifier checks against the receipts
themselves, not a value it trusts.

The manifest is not trusted. It is a claim about what the export contains, and
every part of that claim is checked against the files themselves. A key
published under an identifier that is not its own `key_id` is rejected, because
`key_id` is derived from the key (section 5) and cannot be chosen.

### 10.4 What a verifier checks, in order

1. The manifest is well formed, and every published key matches its own `key_id`.
2. Every line of `receipts.jsonl` is a receipt of a schema version it implements.
3. Every receipt carries the `system_id` the manifest declares.
4. Sequence numbers start at `range.from_seq` and rise by one, with no gap, no
   repeat and no reordering.
5. If the export starts at `seq` 0, that receipt is a genesis receipt.
6. Every `prev_hash` equals the recomputed hash of the preceding receipt.
7. Every receipt names a key the manifest publishes, and its signature verifies.
8. Every checkpoint names a published key, and its signature verifies.
9. Every checkpoint's Merkle root is rebuilt from the receipts present, where
   the export holds them all, and must match.
10. Every inclusion proof rebuilds its checkpoint's root, and the
    `receipt_hash` it names is the hash of the receipt actually at that `seq`.
11. `range`, `counts.receipts`, `counts.checkpoints`, `counts.timestamps` and
    `receipt_version` describe what the archive actually holds — the last of
    these is the highest version actually present, per 10.3.
12. Every RFC 3161 token is checked with `openssl` (section 9). With the
    authority's certificate, its signature is verified; without it, only the
    digest it carries is compared with the checkpoint root, and the verifier
    says which of the two it did.

A verifier stops at the first failure and names the file, the line and the
check. Any failure means the export is not evidence of anything.

Three of these deserve a note, because they catch what the others miss:

- Step 4 and step 11 together catch a deleted *last* receipt. Removing it
  leaves a chain that is internally consistent; only the manifest's declared
  range shows that the export was supposed to run further.
- Step 9 catches a receipt altered at the end of the range, where no later
  `prev_hash` covers it, because the Merkle root over the whole tree does.
- Step 12 failing is a verification failure, not a warning. A sound chain with
  a token that is not a token is an archive whose anchor does not hold.

## 11. Test vectors

`packages/core/test/vectors.json` carries a set of receipts with their canonical
form and digest recorded alongside. Its `receipt_versions` member lists every
schema version the file covers — `[1, 2]` — derived from the vectors
themselves rather than asserted separately. They cover the genesis receipt,
every action kind and outcome, present and absent optional members, JSON
escaping, non-ASCII and astral-plane text, control characters, calendar edge
cases, the field length caps, the largest exactly representable integer as a
`seq`, and, for version 2, a receipt with neither new member, one artifact,
two artifacts in a fixed order, a model with a provider and digest, a model
with both null, and an artifact and a model together.

The `sig` values in that file are a fixed placeholder, chosen so it decodes to
readable text: the vectors pin the wire format, not signatures.

`scripts/crosscheck_vectors.py` re-derives every canonical form and digest in
the file using only the Python standard library, with no sigillo code involved.
It runs in CI. If it ever disagrees with the Node implementation, this document
is what decides which one is wrong.

## 12. Relationship to draft-sharif-agent-audit-trail

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
