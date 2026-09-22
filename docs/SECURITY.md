# What sigillo protects, and what it does not

This page is short on purpose. Everything below is what an operator, an auditor
or an attacker would want to know before relying on a sigillo log.

## Where the key is

One Ed25519 private key signs every receipt and every checkpoint.

It lives in a file owned by the **signer**, a separate process that does one
thing: it answers `pubkey`, and it signs 32-byte digests handed to it over a
local Unix socket. It has no network access at all, and in the supplied
`docker-compose.yml` it runs with `network_mode: none`.

- The key file is written with permission `0600`, and the signer **refuses to
  load a key file that anyone else can read**.
- `keygen` refuses to overwrite an existing key: losing a signing key silently
  would orphan every receipt already signed with it.
- The server never receives the key's path. It is given a socket, and nothing
  else. That the server contains no code capable of loading a private key is
  checked by `pnpm lint` and asserted by a test that reads every file under
  `apps/server/src`.
- In Docker the key volume is mounted on the signer only. The server and the
  signer share one volume, and it contains one socket.

The signer is not a general signing oracle. `sign` takes a 64-character
lowercase hex digest and nothing else: not a document, not a digest of the wrong
length, not a digest in a different encoding. Every other input is refused.

## If the server is compromised

Assume an attacker has full control of the server process and its database file.

**What they can do.** Write new receipts, because the server's job is to write
receipts and the signer will sign any digest it is given. A sigillo log does not
prevent an attacker with the server from adding false entries going forward.
They can also delete the database file, or replace it with another one.

**What they cannot do.** Change or remove a receipt that is already covered by a
checkpoint that has been timestamped, without that being visible:

- Altering any receipt changes its hash, so the next receipt's `prev_hash` no
  longer matches and the chain breaks at a named position.
- Altering the last receipt of a tree changes the Merkle root, which the
  checkpoint signed and the timestamp authority attested at a known time.
- Removing receipts leaves a gap in the sequence, and removing the last ones is
  caught because the export manifest declares how far the range was meant to
  run.
- Re-signing a forged chain requires the key, which is not in that process.

The append-only triggers on `receipts`, `checkpoints` and `timestamps` stop
`UPDATE` and `DELETE` from any connection that speaks SQL to the database. They
do **not** stop `DROP TABLE`, and they do not stop someone replacing the file.
Against that, what holds is the signatures, the chain and the timestamps — which
is why anchoring matters: an unanchored log can be rewritten wholesale and
backdated by whoever holds the key.

**If the key itself is taken**, everything signed with it is in doubt from the
moment of the theft. Timestamped checkpoints still bound what existed before
that moment: an auditor holding an old export can show that the receipts in it
are the ones that existed then.

## What the operator of the service can and cannot see

sigillo stores **no content**. Not a prompt, not a tool argument, not a model
output, not a document. Where content existed, the receipt carries its SHA-256
digest and nothing else. This is enforced in three places: the ingest adapter
reduces `input.value` and `output.value` to digests as it reads them; the
receipt schema has no field that could hold a payload; and a test greps a
finished export for the strings an example agent actually handled and requires
them to be absent.

A document a receipt names (`sigillo.artifact()` in the Python SDK, or a file
checked on the "verifica un documento" page) is hashed **before it reaches
sigillo**: the SDK hashes it in the caller's own process, and the page hashes
it in the visitor's browser with Web Crypto. Neither ever transmits the
document itself, only its digest — the same property `input_hash` and
`output_hash` already had, extended to whole files.

What an operator **can** see:

- which system acted, and when the server received the event;
- the name of the agent, and the person or system it acted for, where the
  instrumentation supplied one;
- the kind and the name of each action — `tool_call payments.charge` — and
  whether it succeeded, failed, was blocked, or reported nothing;
- the trace and span identifiers, which link a receipt back to whatever
  observability system produced it;
- digests of inputs and outputs, which are useful only to someone who already
  has the original values and wants to prove they match.

Names are metadata, but a name can be abused to carry content, so every
free-text field is capped: 128 characters for a system, 256 for an agent, an
operator or an action name. A caller cannot smuggle a prompt into a name field.

What an operator **cannot** see: anything the instrumented system did not put in
a span, and anything that was only ever a digest.

## Authentication

Ingest is authenticated by an API key, one per system, sent as a bearer token.
A key belongs to exactly one system and writes to that chain and no other.

Only an scrypt hash of the secret is stored, with a per-key salt, so a copy of
the database does not let anyone speak for a system. A test reads the raw bytes
of the database file and its write-ahead log and requires the secret to appear
in neither. The token is shown once when it is issued and is not recoverable.

The key identifier inside a token is stored in the clear. It is a lookup handle,
not a credential: it tells the server which row to check, so verifying costs one
scrypt rather than one per key in the database.

The web view is guarded by a single administrator password from
`SIGILLO_ADMIN_PASSWORD`. Without that variable the view is not served at all.
Its session is an HMAC cookie with a per-process secret, so a restart signs
everyone out and nothing about the session is stored.

The view is server-rendered with one deliberate exception: "verifica un
documento" carries a small inline script that computes a file's SHA-256 in the
browser, so the document itself is never sent to the server. `deploy/Caddyfile`
allows exactly that script and no other, by its SHA-256 (`script-src
'sha256-...'`), rather than relaxing the content security policy in general. A
test recomputes the hash from the actual script and fails if the two ever
disagree.

## Known limits

**sigillo certifies integrity, not completeness.** It makes the records it is
given tamper-evident. It cannot tell you that everything the AI system did was
recorded: that depends entirely on the instrumentation of the system itself. An
action that never reached sigillo leaves no trace of its absence. Any claim of
completeness has to come from somewhere else — a review of the instrumentation,
a second source, a control on the deployment — and is outside what this or any
log format can attest.

**`ts_event` is not trusted.** It is what the source claimed. `ts_received` is
the server's own observation, and it is bounded from above by the timestamp
token covering the checkpoint that includes the receipt. Between checkpoints,
the server's clock is the only witness.

**One writer.** One process owns the database. Two writing processes on the same
file are out of scope and not supported.

**No multi-tenancy.** Every system in one database is administered by whoever
administers that database. There is no separation between them beyond the API
keys that decide where a request writes.

**Retention and erasure are not implemented.** Nothing here deletes anything,
and the append-only triggers actively prevent it. A deployment with an erasure
obligation needs a design for it that this version does not have.

**The default timestamp authority is not qualified under eIDAS.** `TSA_URL`
points at FreeTSA unless a deployment changes it. A FreeTSA token is a genuine
RFC 3161 token and a verifier checks it as one, but it carries no qualified
status: it shows *when*, attested by an authority that no eIDAS supervisory body
stands behind. A deployment that needs qualified timestamps points `TSA_URL` at
a qualified provider and ships that provider's CA certificate with the evidence
file, so the token can be checked offline. Nothing else changes.

**No HSM or KMS.** The key is a file. Moving it into hardware would change the
signer and nothing else, which is part of why the signer is a separate process.

## Reporting a problem

Security issues in sigillo itself should go to the maintainers of this
repository before being published.
