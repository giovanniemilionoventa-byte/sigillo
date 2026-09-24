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
- `keygen` refuses to overwrite an existing key: a key replaced by accident
  would change, from one receipt to the next, the key_id everyone was told to
  expect.
- Every public key the server has signed with is kept in an append-only table
  and published in every export. If the key does change (its volume lost and a
  new one generated), the receipts signed with the old key stay verifiable, and
  the web view keeps checking each receipt under its own key. A signer that
  comes back with a different key while the server runs is refused until the
  server is restarted on purpose. What cannot be recovered is the ability to
  sign with the old key: hence the encrypted, off-host copy in the checklist
  below.
- The server never receives the key's path. It is given a socket, and nothing
  else. That the server contains no code capable of loading a private key is
  checked by `pnpm lint` and asserted by a test that reads every file under
  `apps/server/src`.
- In Docker the key volume is mounted on the signer only. The server and the
  signer share one volume, and it contains one socket.

The signer is not a general signing oracle. `sign` takes a 64-character
lowercase hex digest and nothing else: not a document, not a digest of the wrong
length, not a digest in a different encoding. Every other input is refused. A
request may also carry an `id`, which the signer echoes on its reply and which
is the only thing the server matches replies by: a reply that arrives after its
request has timed out is ignored, and can never complete a later request.

What the signer returns is checked, not trusted. Before a receipt or a
checkpoint is written, the server verifies its signature over exactly the bytes
it is about to store, under the public key the signer announced (whose
identifier must be the `key_id` the record carries). A signature that does not
verify is refused and the transaction is rolled back: nothing is written, and
the position in the chain stays free for the next record.

## If the server is compromised

Assume an attacker has full control of the server process and its database file.

**What they can do.** Write new receipts, because the server's job is to write
receipts and the signer will sign any digest it is given. A sigillo log does not
prevent an attacker with the server from adding false entries going forward.
They can also delete the database file, or replace it with another one.

And, while they hold the server, **rewrite what is not yet anchored, and have
it signed with the real key.** The signer's isolation stops the key from being
*taken*: once the attacker is out, they cannot sign any more. It does not stop
the key from being *used* through the socket while they are in, and the signer
cannot tell a legitimate digest from a forged one. The key alone is therefore
no protection for the past; what protects it is below.

**What they cannot do.** Change or remove a receipt that is already covered by a
checkpoint that has been timestamped, without that being visible to someone who
checks:

- Altering any receipt changes its hash, so the next receipt's `prev_hash` no
  longer matches and the chain breaks at a named position.
- Altering the last receipt of a tree changes the Merkle root, which the
  checkpoint signed and the timestamp authority attested at a known time.
  Re-signing a rewritten chain yields new roots, and the authority's tokens
  over the old roots, with their attested times, no longer match them: a
  rewritten history carries only timestamps from after the rewrite.
- Removing receipts from the middle leaves a gap in the sequence.
- Removing the *last* receipts, together with the checkpoints over them and
  with the manifest adjusted, leaves a shorter chain that verifies on its own.
  It is caught by comparison with an export received earlier
  (`sigillo-verify --previous`), and bounded by the attested time of the last
  checkpoint. See "What sigillo cannot detect" below.

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

Names are metadata, but a name can be abused to carry content. Every
free-text field is capped: 128 characters for a system, 256 for an agent, an
operator or an action name. A cap limits how much fits; it does not stop a
caller from putting a person's name, an email address or a short sentence into
one of those fields. sigillo stores whatever the instrumentation sends there
in clear, signs it, and because of the chain cannot remove it later. What is
recorded in clear, where it comes from, and how to keep personal data out of
it is set out field by field in [DATA-INVENTORY.md](DATA-INVENTORY.md).

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

Checking a token runs scrypt off the event loop, and whether the key is still
live is read from the database on every request: a key revoked with
`sigillo-server key revoke`, from another process, stops working on the next
request of the server that is already running. An address that sends too many
wrong tokens is locked out for a while, during which no scrypt is run for it,
while tokens the server has already accepted keep working.

The web view is guarded by a single administrator password, from
`SIGILLO_ADMIN_PASSWORD_FILE` (a file, as the supplied Compose file provides
it) or `SIGILLO_ADMIN_PASSWORD`. Without either the view is not served at all.

- **Attempts are limited per address.** After 5 wrong passwords in 15 minutes
  (both configurable), the address is locked out for 5 minutes, doubling on
  each further lockout up to an hour. While it is locked out its attempts are
  not evaluated, the right password included, and they get the very page and
  status a wrong password gets: from outside, a lockout cannot be told apart
  from a wrong guess, and no guess made during one can be learned to be right.
  The limits are in memory: a restart forgets them.
- **The address is the real client's**, not the proxy's, only where
  `SIGILLO_TRUST_PROXY` names the proxy. The supplied Compose file names the
  private network Caddy reaches the server on; Caddy replaces any
  `X-Forwarded-For` a client sends. Without that setting the server believes no
  forwarding header at all, so a client cannot pick a new address per guess.
- **The session** is an HMAC cookie, `HttpOnly; SameSite=Strict`, and `Secure`
  whenever the browser came over HTTPS (always, in the supplied Compose file).
  Its secret is per process, so a restart signs everyone out and nothing about
  the session is stored. Signing out, which is a POST, ends every session
  issued until then, a copied cookie included: there is one password, so every
  session is the same person's.
- **Every page behind the password is `Cache-Control: no-store`**, including
  the one that shows a new API key the only time it exists.
- **A form posted from another site is refused** (`403`) when the browser says
  where it comes from, on top of what `SameSite=Strict` already does.

The view is server-rendered with one deliberate exception: "verifica un
documento" carries a small inline script that computes a file's SHA-256 in the
browser, so the document itself is never sent to the server. `deploy/Caddyfile`
allows exactly that script and no other, by its SHA-256 (`script-src
'sha256-...'`), rather than relaxing the content security policy in general. A
test recomputes the hash from the actual script and fails if the two ever
disagree.

## Secrets and logs

**Secrets never appear in `docker compose config`.** The administrator
password is a file (`deploy/secrets/admin_password`), which Compose mounts in
the server as `/run/secrets/admin_password`; the server is told only the
file's path. The timestamp authority's password, when there is one, works the
same way (`TSA_PASSWORD_FILE`). Neither is an environment variable of any
container, so neither shows in `docker compose config` or `docker inspect`.
The signing key never leaves the signer's volume.

Proof, run on 2026-09-24 in the development environment (Docker Compose
v5.1.1; no Docker daemon was needed, `config` only resolves the file), with the
password `Segreto-Di-Prova-1234` in `secrets/admin_password` and, for good
measure, also left behind in `.env` as `SIGILLO_ADMIN_PASSWORD` and
`TSA_PASSWORD`:

```sh
$ cd deploy && docker compose config | grep -c 'Segreto-Di-Prova-1234'
0
```

Before this change the same command printed it twice:

```text
48:      SIGILLO_ADMIN_PASSWORD: Segreto-Di-Prova-1234
54:      TSA_PASSWORD: Tsa-Segreto-5678
```

`apps/server/test/deploy-config.test.ts` repeats the check in CI, on every
push. `deploy/docker-compose.local.yml`, the trial on one's own computer, still
takes the password from `.env` and does print it; it is not a deployment.

**What the server logs.** One JSON line per request, at level `info`: the
method, the path **without its query string**, the client's address, the status
and the time taken. Never a header (so never an API key or a session cookie),
never a body, never a query string (which in the web view holds document
fingerprints and search terms). Errors are logged by type, code and stack
trace, without their message, because a message can quote the input that
caused it (`JSON.parse` does). The password is never printed, and neither is a
token: `sigillo-server key create` prints the new token once, on its own
standard output, for the operator who asked for it.

Proof: `apps/server/test/server-hardening.test.ts` logs in, searches, verifies
a document, sends a receipt whose payload carries a marker, sends a body that
does not parse and makes the server fail, all against a real server with a
real signer, then requires the log to hold none of: the password, the token,
its secret half, the marker, the fingerprint, `sha256=`, the session cookie.
With Fastify's default request serializer the same test fails, on the marker
that reached the log through a query string. `apps/server/test/cli-config.test.ts`
starts the real `sigillo-server serve` with the password in a file and requires
its whole output to be free of it.

**What Caddy logs.** One line per request, with the query string cut off by a
filter in `deploy/Caddyfile`. Caddy itself writes `REDACTED` in place of the
`Authorization` and `Cookie` headers. Checked by running Caddy v2.11.4, the
version the Compose file pins, with the production Caddyfile in front of a test
backend, and requesting `/ui/verify-document?sha256=...&name=...` with a bearer
token, a cookie and a forged `X-Forwarded-For`. The log line:

```text
"uri": "/ui/verify-document", "headers": {..., "Authorization": ["REDACTED"], "Cookie": ["REDACTED"], ...}
```

and the backend received `X-Forwarded-For: 127.0.0.1`, the real client, not
the forged address.

**Rotation.** Every container logs through Docker's `json-file` driver with
`max-size: 10m` and `max-file: 5`: at most 50 MB per service, the oldest file
dropped first. A server run without Docker writes to standard output and leaves
rotation to whatever runs it (systemd's journal rotates on its own).

## What sigillo cannot detect

This list matters as much as the tamper tests that pass
(`apps/server/test/tamper.test.ts`, 17 scenarios run through the real
verifier). A verifier that says OK has checked what is below it on this page,
and nothing else.

**What was never sent.**
- **A source that falls silent.** An agent that stops sending events, or whose
  instrumentation breaks, produces no error anywhere in sigillo. The web view
  turns the system's light yellow after `SIGILLO_STALE_AFTER_MINUTES` without
  activity (a day by default), and that is all: silence is reported as
  inactivity, never as tampering, and an export of the period is simply
  shorter.
- **A source that leaves things out.** An agent that records some actions and
  not others, a span the instrumentation never emits, a span the ingest
  adapter does not recognise as an AI action (it is counted and dropped):
  sigillo attests the integrity of what it received, not the completeness of
  what happened.

**What was sent, and was false.**
- **Well-formed lies with a valid key.** A client that sends made-up actions,
  outcomes, times or digests, authenticated with its own legitimate API key,
  gets them recorded, signed and anchored exactly like true ones. sigillo proves
  *what it was told and when*, not that it was true.
- **A stolen API key.** Whoever holds a system's key writes to that system's
  chain, indistinguishably from the agent. Revoking the key stops it from the
  next request on; what was written before stays.
- **`ts_event`** is the source's claim and is never checked against anything.
- **Duplicates.** An OTLP batch retried after a partial failure can record the
  same span twice (review point 6); the two receipts are both genuine records
  of what arrived.

**What a compromised server can do before anyone checks.**
- **Rewrite what is not yet timestamped.** Receipts since the last anchored
  checkpoint (up to `SIGILLO_CHECKPOINT_MINUTES`, plus however long the
  authority is unreachable) can be rewritten and re-signed with the real key
  through the signer's socket. Nothing in the chain shows it.
- **Replace everything, if nothing was ever handed out.** A database replaced
  wholesale with a consistent forged history, signed through the same signer and
  anchored afresh, verifies. What gives it away is outside it: an export given
  to someone earlier (`--previous`), or the authority's attested times, which
  would all be later than the period they claim to cover.
- **Move the clock.** `ts_received` is the server's own clock. Between two
  timestamps, only that clock vouches for when something happened.

**What a single archive cannot show about itself.**
- **That the key is the operator's.** A wholly fabricated archive, signed with
  a new key published in its own manifest, verifies. Caught only with the
  operator's `key_id` from another channel (`sigillo-verify --key-id`).
- **That nothing was cut from its end.** Removing the last receipts and the
  checkpoints over them, and adjusting the manifest, leaves a valid shorter
  chain. Caught only against an earlier export (`--previous`).
- **That the timestamp authority is who it claims.** Without its certificate
  (`--tsa-ca`), a token is only checked for the digest it carries. FreeTSA, the
  default authority, is not qualified under eIDAS.

**If the signing key is stolen,** everything signed with it from then on is in
doubt, and a forgery is indistinguishable from a real receipt. Timestamped
checkpoints from before the theft still bound what existed then.

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

## Before going to production

*(prima di andare in produzione)* Derived from the hardening of phase 5. The
exact commands, for a server that has never run sigillo, are in
[DEPLOY-PRODUZIONE.md](DEPLOY-PRODUZIONE.md).

**The host**
- [ ] A domain whose DNS record points at this machine, and a firewall that
      lets in only SSH, 80 and 443.
- [ ] The clock synchronised (NTP): `ts_received`, the checkpoints and the
      timestamp requests all come from it.
- [ ] Docker with Compose v2, updated.

**Secrets**
- [ ] `deploy/secrets/admin_password` written once, 12 characters at least
      (better: `openssl rand -base64 24`), the folder `0700`.
- [ ] `deploy/.env` holds no password: `docker compose config | grep -i password`
      shows only `SIGILLO_ADMIN_PASSWORD_FILE: /run/secrets/admin_password`.
- [ ] The signer's key generated **once**, then copied off the host, encrypted,
      to a place whose access is decided and written down. Without it, the
      receipts signed so far can still be verified, but nothing new can be
      signed with the same key.
- [ ] The key's `key_id` written down and published through a channel that does
      not depend on this server (a contract annex, a signed email): it is what
      an auditor compares with the one in an export.

**The containers** (all already set in `deploy/docker-compose.yml`; check
they are still there if the file has been edited)
- [ ] Only Caddy publishes ports; the server `expose`s 8080 to the compose
      network only; the signer has no network at all.
- [ ] `read_only`, `no-new-privileges`, `cap_drop: ALL`, resource limits and
      log rotation on every service.
- [ ] `SIGILLO_TRUST_PROXY` set only because Caddy is in front. Never publish
      8080 with it set: a client could then choose its own address, and the
      attempt limits would not hold.
- [ ] `SIGILLO_COOKIE_SECURE=true`.

**Data**
- [ ] `backup.sh` in the host's cron, **and** the backups copied off the host:
      the `backups` volume is on the same disk as the database.
- [ ] A restore tried once, from a backup to a scratch directory, with an
      export and a verification of the restored copy.

**Evidence**
- [ ] `TSA_URL`: FreeTSA is not qualified under eIDAS. Either accept that for
      the pilot, in writing, or configure a qualified provider.
- [ ] One full round done by hand: a system, an agent sending to it, a
      checkpoint, an export, and `sigillo-verify` run on another machine.
- [ ] The web view reached over HTTPS, and 6 wrong passwords in a row checked
      to lock the address out.

**Running it**
- [ ] `docker compose ps` watched (or its health checks fed to monitoring):
      the server turns unhealthy when it cannot reach the signer.
- [ ] Images rebuilt from time to time for security updates (the base image is
      pinned by digest: moving it is a deliberate edit of `deploy/Dockerfile`),
      and the dependency audit workflow kept green.

## Reporting a problem

Security issues in sigillo itself should go to the maintainers of this
repository before being published.
