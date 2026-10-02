# What sigillo protects, and what it does not

This page is short on purpose. Everything below is what an operator, an auditor
or an attacker would want to know before relying on a sigillo log.

## Where the key is

One Ed25519 private key signs every receipt and every checkpoint.

It lives in a file owned by the **signer**, a separate process that does one
thing: over a local Unix socket, it signs the next receipt of each chain, and
checkpoints over the chains it has signed. It has no network access at all, and
in the supplied `docker-compose.yml` it runs with `network_mode: none`.

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

The signer is not a signing oracle. Until protocol version 2 it signed any
32-byte digest it was handed; it no longer signs a digest at all. It speaks
four requests (`PUBKEY`, `SIGN_RECEIPT`, `CHECKPOINT`, `GET_HEAD`; see "The
signer's own record of every chain" below), each one line of at most 256 KiB,
each checked against a strict schema in which an unknown field is a refusal,
and handles them one at a time. Every request carries an `id`, which the
signer echoes on its reply and which is the only thing the server matches
replies by: a reply that arrives after its request has timed out is ignored,
and can never complete a later request.

What the signer returns is checked, not trusted. Before a receipt or a
checkpoint is written, the server verifies its signature over exactly the bytes
it is about to store, under the public key the signer announced (whose
identifier must be the `key_id` the record carries). A signature that does not
verify is refused and the transaction is rolled back: nothing is written. If
the signer did sign that position, its own record says so, and the next write
takes that receipt, with its real signature, from `GET_HEAD` (below) before
going on.

## If the server is compromised

Assume an attacker has full control of the server process and its database file.

**What they can do.** Write new receipts at the end of each chain, because the
server's job is to write receipts and the signer signs the next one of every
chain it is given, with a `ts_received` within the signer's clock tolerance
(five minutes by default). Open new chains under identifiers the signer has
never seen. A sigillo log does not prevent an attacker with the server from
adding false entries going forward. They can also delete the database file, or
replace it with another one.

**What the signer stops them doing, even before anything is anchored.** Since
protocol version 2 the signer keeps its own record of every chain (below), and
signs a receipt only if it is the next one: the position after the last it
signed, hanging off that receipt's hash. Through the socket, an attacker cannot
get a second signature at a position already signed (a rewrite), a receipt
that hangs off anything but the last one signed (a fork), a second genesis for
a chain that exists, or a checkpoint over any tree but the one the signer
built itself. Rewriting the past now takes the key itself, not just the
socket. A database rewritten or cut short underneath the server no longer
agrees with the signer's record: the server finds it at its next start, at the
next refused position or at the next checkpoint, turns the system red, writes
it to the administrative log, and signs no checkpoint over it.

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
`UPDATE` and `DELETE` from any connection that speaks SQL to the database,
with one narrow exception for a chain that never recorded an action (see
"Renaming, archiving and deleting a system" below). They
do **not** stop `DROP TABLE`, and they do not stop someone replacing the file.
Against that, what holds is the signatures, the chain and the timestamps — which
is why anchoring matters: an unanchored log can be rewritten wholesale and
backdated by whoever holds the key.

**If the key itself is taken**, everything signed with it is in doubt from the
moment of the theft. Timestamped checkpoints still bound what existed before
that moment: an auditor holding an old export can show that the receipts in it
are the ones that existed then.

## The signer's own record of every chain

Protocol version 2 of the signer socket (`apps/signer/src/daemon.ts`) replaces
"sign these 32 bytes" with requests the signer can judge for itself:

| request | what the signer does |
|---|---|
| `SIGN_RECEIPT` (an unsigned receipt) | recomputes its hash with `packages/core`, and signs it only if `seq` is its last `seq` + 1 and `prev_hash` is its last receipt's hash (for a system it has never seen: only `seq` 0, a genesis); `key_id` must be its own; `ts_received` must be within the clock tolerance of its own clock and not earlier than the receipt before |
| `CHECKPOINT` (a `system_id`) | signs a checkpoint whose size, root and time it computes itself, from its record and its clock; the request cannot carry any of them |
| `GET_HEAD` (a `system_id`) | returns the last receipt it signed for that system, signature included, or nothing |
| `GET_RECEIPTS` (a `system_id`, a `from_seq`, a `limit` of 1 to 50) | returns the receipts it signed for that system from `from_seq` on, from its journal, signatures included; nothing past its last receipt, and nothing past a position its journal does not hold |
| `PUBKEY` | returns the key identifier and the raw public key |

The signature is unchanged: Ed25519 over the 32 bytes of the receipt hash (or
checkpoint hash). Every receipt, checkpoint and export made before stays valid,
and the verifier did not change.

**The record.** For each system, in the signer's own volume next to the key
(`/var/lib/sigillo-key/state`, one file per system, readable by the signer's
user only): the last `seq`, its hash, the last signed receipt, and the Merkle
frontier of the chain (the roots of the perfect subtrees of RFC 6962,
`packages/core/src/merkle-frontier.ts`), from which a checkpoint's root is
computed without keeping the chain. A file is replaced atomically and durably
— written aside, `fsync`, renamed, the directory `fsync`ed — **before** the
signer answers: a signature the server has received is one the signer will
remember after a crash. If a new state cannot be made durable, the signer
returns no signature and stops serving altogether (the command exits, and
Docker restarts it from what is on disk): what it holds in memory might no
longer be what is on disk, and it must never sign the same position twice.
The record is never in the server's database; the server cannot read or
change it. A state file that does not hold together stops the signer from
starting.

**The journal.** Beside each state file, the signer appends every receipt it
signs for that system to a journal (`<hash>.receipts.jsonl`, readable by the
signer's user only), durably, before the state moves on. It is what lets a
database restored from a backup older than the signer take back every receipt
signed since (below). It is a record to recover from, not evidence: the server
checks each receipt's signature and link before writing it, so a journal
altered on the signer's disk yields a divergence, never a wrong chain. It
holds what the receipts hold: since version 4, pseudonym tokens and digests,
no identifier and no nonce. `init-from-db` writes no journal for the chain
before it, because receipts of versions 1 to 3 can name people in clear; the
journal begins with the next receipt signed.

**When the database and the record disagree.** The server compares every
chain's tip with `GET_HEAD` when it starts, and again whenever the signer
refuses a receipt's position. One case has a safe answer and is repaired by
itself: the signer **ahead**, its receipts continuing the database's tip — the
server died between the signature and the insert (one receipt), or the
database was restored from a backup older than the signer (any number). The
receipts are fetched with `GET_RECEIPTS` and written, once, each checked under
a known key and linked to the one before, ending exactly at the signer's head;
a span already on the chain under the same `trace_id`/`span_id`, or a position
the journal does not hold, makes it a divergence instead. Each one goes to the
administrative log as `signer.recovered`. Receipts taken back this way have no
nonces and no `subjects` rows (those lived only in the database), so their
digests can never be opened and their tokens lead to nobody. **Every other
disagreement** — the signer behind, on another branch, ahead with a gap in its
journal, with no record of a chain the
database has, or a checkpoint whose root is not the database's — turns the
system red, goes to the administrative log as `signer.divergence`, and is not
corrected: which side is right is for a person to establish. Until then the
signer refuses that chain's next receipt.

An OTLP batch is written receipt by receipt for the same reason: a receipt the
signer has signed is never rolled back by the server, so a crash part-way
leaves the signer at most one receipt ahead. The exporter's resend of the
batch finds the receipts already written by `trace_id`/`span_id`.

**Upgrading an installation from before the record existed.** Run
`sigillo-signer init-from-db` once, with the server and the signer stopped
(`docs/DEPLOY-PRODUZIONE.md`). It reads every chain from the database, checks
its positions, links, hashes and signatures, writes the signer's record, marks
every system deleted earlier as retired (its identifier is never given a chain
again, by the signer as well as by the server), and writes one `signer.init`
entry per system to the administrative log. Run a second time, it writes
nothing: it says whether the signer still agrees with the database, and points
at the rollback procedure when the signer is ahead. It never overwrites a
system the signer already knows. Until it has run, the
server shows every existing system red, and the signer refuses to extend them.

**What the record does not protect.** Whoever can read the signer's volume has
the key as well, and can sign anything. A server that holds the socket can
still add false receipts and open new chains. And `init-from-db` takes the
database's word once: what was rewritten through the old socket before the
upgrade stays as it was signed.

## Renaming, archiving and deleting a system

**The principle, which is not negotiable: a system whose chain holds at least
one receipt beyond its genesis (`seq 0`) can never be deleted** — not from the
web view, not with the command line, not with any number of confirmations.
sigillo exists so that nothing disappears in silence. Allowing real evidence
to be deleted, however rare the occasion, would contradict the reason the
product exists. Such a system can only be archived.

- **The `system_id` never changes.** It is written into every receipt,
  checkpoint, API key and export. A trigger refuses any `UPDATE` of it. What
  can change at any time is the `display_name`, a label the web view shows in
  place of the `system_id` (which stays visible beside it). The label is not
  evidence: it is in no receipt, no checkpoint and no `manifest.json`. An
  export carries the name the system had *when it was exported*, in
  `report.pdf` and `VERIFY.md`, marked as an unsigned label, and keeps it
  whatever the system is called later, like any other document.
- **Archiving hides the system, it removes nothing already written.** An
  archived system leaves the main page and the default list of systems. Its
  chain stays exactly as it was: still check pointed, monitored, exportable
  and verifiable. What does stop is new receipts: every API key of an
  archived system is refused at authentication (`ApiKeyStore.verify`), the
  same way a revoked one is, so an agent still sending gets turned away
  rather than silently recorded into a chain nobody is watching. Reactivating
  the system reactivates its keys, unchanged — nothing is reissued. A key
  revoked before the archiving stays revoked after it is reactivated.
  Archiving never hides a problem, though: an archived system whose chain
  fails verification, or that somehow still gained a receipt (only possible
  by writing to the chain directly, bypassing API key authentication
  entirely — no supported path does that), is shown on the main page anyway.
  Archiving can be undone at any time.
- **Deleting is for an empty system only**: one whose chain holds its genesis
  and nothing else, typically created by mistake or for a test. Then the
  genesis, its checkpoint, the timestamp tokens over it and the system's API
  keys are removed for good, so its keys stop working at once. Three things
  guard this:
  1. whether the chain is empty is decided by the server, inside the same
     SQLite `IMMEDIATE` transaction that deletes, from what the database holds
     at that moment. What a page showed earlier does not count: an action that
     arrived since makes the deletion fail;
  2. the web view asks for the exact `system_id` to be typed out, not an
     "are you sure?". The command line asks for it again with `--confirm`;
  3. before anything is deleted, the deletion is written to the
     **administrative log**: who (`web <address>` from the web view, `cli
     <user>@<host>` from the command line), when, and what (the genesis's
     hash, the checkpoints, tokens and keys removed). That log is a table
     outside every chain, since the chain being deleted will no longer exist to
     record its own deletion. It is append-only, and it is in every backup.
     Renames, archivals and reactivations are logged there too. It is shown
     on the systems page and printed by `sigillo-server admin-log`.
- **The database enforces the rule itself**, not only the code. The delete
  triggers on `receipts`, `checkpoints` and `timestamps` let a row go only
  when its chain holds its genesis alone **and** the administrative log
  already names that very genesis, by its hash, as deleted. A receipt of a
  chain with a real action cannot be deleted through any SQL connection, even
  with a forged log entry. The row in `systems` can go only once the chain is
  gone. Databases written before this change are migrated when the server
  opens them. The new guards are created before the old unconditional
  triggers are dropped, so there is no moment with neither.
- **A deleted `system_id` is never given out again.** An export of the empty
  chain, or a timestamp over its root, may exist somewhere. A second genesis
  under the same name would contradict it, and anyone holding the first one
  would see a rewritten history.

What this does not change: someone who can replace the database file, or drop
the triggers, can still do anything to it (see "If the server is compromised"
above). The guards stop the ordinary case: an operator, a script or a support
query deleting evidence by mistake or on request.

## What the operator of the service can and cannot see

sigillo stores **no content**. Not a prompt, not a tool argument, not a model
output, not a document. Where content existed, the receipt carries its SHA-256
digest and nothing else. This is enforced in three places: the ingest adapter
hands `input.value` and `output.value` only to the store, which reduces them to
salted digests before anything is written; the
receipt schema has no field that could hold a payload; and a test greps a
finished export for the strings an example agent actually handled and requires
them to be absent.

A document a receipt names (`sigillo.artifact()` in the Python SDK, or a file
checked on the "verifica un documento" page) is hashed **before it reaches
sigillo**: the SDK hashes it in the caller's own process, and the page hashes
it in the visitor's browser with Web Crypto. Neither ever transmits the
document itself, only its digest.

Since fase 9 of the pilot plan, `input_hash` and `output_hash` have that same
property by default too: the Python SDK hashes a span's input and output in
the caller's own process (`sigillo.init(..., redact_content=True)`, the
default) and sends only the digest, never the value — an operator running the
server never receives the content at all, not even transiently. Before fase
9, and still with `redact_content=False` or from any other OTLP source, the
raw value **does** reach the server: it is reduced to a digest as the request
is read and never written anywhere, but it exists in the server's memory for
the length of that one request. `POST /v1/traces`' response counts how often
this happened (`rawContentHashed`; `docs/API.md`), so an operator can tell
whether their agents are actually sending only digests.

What an operator **can** see:

- which system acted, and when the server received the event;
- the name of the agent, and the pseudonym token of the person or system it
  acted for, where the instrumentation supplied one — and, through the
  `subjects` table, who that token stands for, until that person is erased;
- the kind and the name of each action — `tool_call payments.charge` — and
  whether it succeeded, failed, was blocked, or reported nothing;
- the trace and span identifiers, which link a receipt back to whatever
  observability system produced it;
- digests of inputs and outputs, which are useful only to someone who already
  has the original values and wants to prove they match. A salted digest
  (receipt version 4) also needs its nonce, which the server keeps until it is
  erased (the Python SDK salts its own digests the same way, and sends the
  nonce beside them); a plain one, computed by a client without a nonce, can
  be checked by anyone who can guess the value.

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

## Erasing a person

Receipts cannot be changed, so a person cannot be erased from them. Since
receipt version 4 they do not need to be: nothing in a receipt names anyone or
holds anything that can be guessed back into content. What links a receipt to
a person lives outside the chain, in two tables that are not evidence and can
be deleted from:

- `subjects`: identifier ↔ `psn_` token. **Erasing a person** deletes their
  row (web view: "persone"; command line: `sigillo-server subject erase`). The
  administrative log records the erasure by the token alone. Their receipts
  stay valid, verifiable and in every export; nothing links the token to them
  any more, and if they come back they get a new, unrelated token.
- `openings`: the nonce of each salted digest. **Cutting receipts off from
  their content** deletes their nonces (`sigillo-server openings erase`, by
  position, or with `--document <file>`: every receipt naming that document by
  its fingerprint, and every receipt sharing a trace with one of those). The
  log records the positions and the count, never a nonce. Afterwards nobody can
  show what those digests were computed over, and an export can no longer
  disclose their nonces.

For a candidate who asks to be forgotten, the order is: find their receipts
from their CV's fingerprint and its trace, erase those nonces, then delete the
CV itself where the operator keeps it (sigillo never had it). What remains is
the CV's exact digest in an artifact, which nobody can reverse without the CV.

What the erasure reaches, and what it does not:

- the database file and its write-ahead log: the server deletes with SQLite's
  `secure_delete` on, which overwrites the deleted bytes, and then empties the
  write-ahead log. The test `privacy-store.test.ts` searches the file's bytes
  for the identifier and the nonce after an erasure and finds neither;
- **backups and copies made before**, `deploy/backup.sh`'s included: they keep
  the row until they are rotated away (on the host, two hourly copies by
  default; the off-host copies for as long as the operator keeps them). Any
  other copy of the database file is the operator's to account for;
- **exports made before**: one that disclosed the identifier (`subjects.jsonl`)
  or the nonces (`openings.jsonl`) still holds them. By default an export holds
  neither;
- **a plain digest** (computed by the client): it was never salted, so there is
  no nonce to erase, and a short value stays guessable from it;
- **receipts written before version 4**: they carry `on_behalf_of` as the
  client sent it, a person's identifier in clear included, and plain digests.
  They are signed and chained, so nothing can change them, and erasing a
  person does not reach them. `sigillo-server subject erase` and the web
  view's "persone" page count them for the identifier being erased
  (`legacyReceiptsNaming`) and say so, rather than claiming the person can no
  longer be found. How many a database holds is counted by the query at step 0
  of `DEPLOY.md`; the operator's privacy notice should say they are kept, and
  on what basis. Redacting them in an export (replacing each receipt with its
  position, hash and signature) was considered and not built: it changes the
  export format and grows the verifier, and it serves only a database that
  holds real people's names from before version 4. The one production database
  counted (2026-10-02: 160 receipts, version 1 and 2) holds test names, so the
  work waits for a case that needs it;
- **the content itself**, wherever the operator's own systems keep it.

One case runs the other way, and is safe: a receipt the server recovers from
the signer's head after a crash between the signature and the write (protocol
2, `signer.recovered` in the administrative log) is written without the nonces
of its salted digests, and, if it named a person seen for the first time,
without that person's `subjects` row. Both lived only in the transaction that
was lost. The receipt is valid and verifiable; its digests can never be opened,
and its token leads to nobody (`privacy-crossings.test.ts`).

## What a document match means

Since receipt version 3, a text document can be found by two fingerprints, and
the two claim different things. An auditor should know which one a result
rests on; the web page and `sigillo-verify doc` always say it.

- **Exact** (`sha256`, every receipt version). SHA-256 of the document's raw
  bytes. A match means the bytes are identical, one by one. This is the only
  fingerprint a PDF, an image, a CSV or any document that is not `text/plain`
  ever has, and its meaning has not changed.
- **Same text** (`text.sha256` under `sigillo-text/1`, version 3 only; rule in
  `docs/FORMAT.md`, 2.5.1). SHA-256 of the document's text after removing four
  invisible characters, Unicode NFC, collapsing every run of whitespace into
  one space and trimming. A match means the same characters in the same order,
  words separated the same way; it does **not** mean the same layout. Line
  breaks, blank lines, tabs, indentation and column alignment are all gone:
  `A 1⏎B 2` and `A⏎1 B⏎2` match. That is why only `text/plain` gets this
  fingerprint: in a CSV, Markdown, HTML or source file, spacing and line
  breaks are content.

What the text rule deliberately does **not** fold, so that a match never hides
a difference a reader would see as content: letter case, digits, punctuation,
typographic against straight quotes, dashes, ligatures and superscripts (NFC,
not NFKC: `m²` is not `m2`), the presence of a space (`1 000` is not `1000`),
a word hyphenated across a line break. It also keeps zero-width joiners and
non-joiners (they change meaning in some scripts and in emoji) and every
bidirectional control character: removing those would make a text match one
that **displays differently** (the "Trojan Source" technique), the one case
where an invisible character is not harmless to an auditor.

Two further kinds of match exist, both narrower:

- **Line endings only**, for records made before version 3, which have no
  text fingerprint. The page and `sigillo-verify doc` also hash the document
  with LF and with CRLF line endings, with and without one final newline, with
  and without a leading byte order mark (at most 8 variants), and look for
  those among exact fingerprints. A match says exactly that: the same bytes
  except for those. Other spacing differences cannot be recovered for an old
  record: from a digest there is no way back to the text.
- **Whole input or output.** The document's text as a JSON string, the way
  `input_hash` and `output_hash` are computed (RFC 8785), exactly or give or
  take the same line-ending variants. A match means the entire recorded input
  or output of that action was this text — a tool that returned a file's
  content, for instance. There is no spacing tolerance here: those fields are
  version 1 members, final by decision of 2026-09-21.

Every match is a lookup of a digest the browser or the verifier computed from
the document in hand; the server never sees the document, and it never
computes a text fingerprint itself. Like `sha256`, `text.sha256` is what the
SDK computed in the agent's process and is taken as given: a receipt proves
that the agent's side declared it, signed into the chain from then on, not
that the server checked it against the document.

A known limit of the text rule: NFC depends on the Unicode version of the
implementation. Python 3.11 ships Unicode 14.0, Node 22 ships 17.0, and each
browser its own. For every character assigned in both versions NFC is stable
(a guarantee of Unicode itself), so European text is unaffected; a text using
characters assigned after the older version and carrying a canonical
decomposition (a few recently encoded scripts) may normalise differently. The
result is a document **not found**, never one found wrongly: its exact
fingerprint still matches as before.

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
  where it comes from, on top of what `SameSite=Strict` already does. Three
  headers are read, and each can only refuse:
  `Sec-Fetch-Site` when present must be `same-origin` (or `none`, a request
  the user started, not a page); `Origin` when it names a host must name this
  one; and when `Origin` is `null` and `Sec-Fetch-Site` is missing, the
  `Referer` must name this host. A request with neither `Origin` nor
  `Sec-Fetch-Site` is not a browser's and is let through, as before.

  `Sec-Fetch-Site` is the primary signal because `Origin` is not reliable
  behind the supplied Caddy. Caddy sends `Referrer-Policy: no-referrer`, and
  for a non-CORS POST under that policy the Fetch standard ("append a request
  `Origin` header") sets `Origin` to `null` and sends no `Referer`: every
  login from every browser arrived that way, and was refused, until
  2026-09-25. That cause is established, not guessed: it is what the standard
  says, and a local page served with `no-referrer` reproduces it in Chromium
  (`Origin: null`, no `Referer`, `Sec-Fetch-Site: same-origin`), with no
  redirect anywhere. The first suspicion, an HTTP→HTTPS redirect, turned out
  not to be the cause. A browser too old to send `Sec-Fetch-Site` (before
  Chrome 76, Firefox 90, Safari 16.4) therefore cannot log in through the
  supplied Caddy; changing its policy to `same-origin` would let `Origin`
  through again, at the cost of a `Referer` on same-site navigation.

The view is server-rendered with one deliberate exception: "verifica un
documento" carries a small inline script that computes a document's
fingerprints in the browser, so the document itself is never sent to the
server. The rule it applies is not a copy: the script embeds
`DOCUMENT_TEXT_SOURCE` from `packages/core`, the same source Node runs for the
tests and for `sigillo-verify doc`. `deploy/Caddyfile` allows exactly that
script and no other, by its SHA-256 (`script-src 'sha256-...'`), rather than
relaxing the content security policy in general. A test recomputes the hash
from the script, and `scripts/smoke-dist.mjs` from the script the built server
actually serves, and either fails if it and the Caddyfile disagree. A running
Caddy keeps the policy it started with, so `deploy/update.sh` restarts Caddy on
every update and then checks, through Caddy's admin endpoint inside its
container, that the policy it loaded carries the Caddyfile's hash
(`docs/DEPLOY-PRODUZIONE.md`, 6.3); a Caddy still on an old policy leaves the
page saying the fingerprint cannot be computed, its button disabled. Besides
the fingerprints (at most 1 + 1 + 8 + 1 + 8 digests, section "What a document
match means"), the script tells the server only whether they were computed on
a chosen file or on pasted text (`from=file|text`), never the file's name or
anything else about the document.

### Customers' accounts

Where `SIGILLO_FIREBASE_API_KEY` and `SIGILLO_FIREBASE_PROJECT_ID` are set,
customers sign in with Google or with an email and a password, through
Firebase Authentication (`apps/server/src/auth/firebase.ts`,
`apps/server/src/http/accounts.ts`). The operator's password is unchanged
beside it and remains the only way to the operator's pages.

- **No Firebase code runs in the browser.** The forms post to this server,
  which calls Firebase's REST API itself; Google is reached by an ordinary
  redirect, in the authorization-code flow, so its answer comes back in the
  query string to `/ui/login/google/back`. The content security policy is the
  one above, unchanged.
- **An identity is believed only from an ID token this server has checked**:
  RS256 under one of Google's published `securetoken` certificates (cached as
  long as their `Cache-Control` says, at most a day), `aud` this project, `iss`
  `https://securetoken.google.com/<project>`, `exp`, `iat` and `auth_time`
  within five minutes of this server's clock, a subject and an email. The
  tests sign tokens with a real RSA key and a certificate made by openssl.
- **Passwords are Firebase's.** This server passes them through once and keeps
  nothing but the account's uid and email (`users`). It requires at least ten
  characters on sign-up; wrong passwords count toward the same per-address
  lockout as the operator's. Sign-ups and reset requests, each of which sends
  an email, are limited to 5 per address in 15 minutes. The reset page gives
  the same answer whether or not the address has an account.
- **An unverified email is not let in**: the link is sent again instead.
- **Between steps**, two short-lived values are HMAC-sealed with the session
  secret, each under its own purpose so neither can stand in for the other or
  for a session: the Google flow's session id (10 minutes, `Path=/ui/login/google`,
  `SameSite=Lax` because Google's redirect back is a cross-site navigation, and
  checked by Firebase against the code), and who signed in until they name
  their company (30 minutes, `Path=/ui/registrazione`).
- **Back from Google, the browser is not redirected but shown a page that
  moves on by itself** (`<meta http-equiv="refresh">`, no script). A browser
  sends no `SameSite=Strict` cookie on a navigation that started on another
  site, nor on the redirects that follow it, so the session or the sign-up
  ticket set on that response would not arrive with a redirect. The refresh
  is a new navigation, started from this site. The cookies stay `Strict`.
- **A newcomer cannot see anything until the operator approves them.** The
  first sign-in creates an organization waiting for approval, with that person
  as its member, in one transaction; approval is on the operator's "Clienti"
  page or `sigillo-server org approve`, and both are in the administrative log.
  A member's session names their uid and is checked against `users` on every
  request, so one moved or removed is out at once.
- **Monthly quota.** Each organization may write `SIGILLO_ORG_MONTHLY_RECEIPTS`
  receipts per calendar month (UTC, genesis receipts not counted); past it, its
  systems get `429` with `Retry-After` until the month ends. A batch that starts
  below the limit is written whole. The operator's systems have no limit.

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
(`apps/server/test/tamper.test.ts`, 18 scenarios run through the real
verifier). A verifier that says OK has checked what is below it on this page,
and nothing else.

**What was never sent.**
- **A source that falls silent.** An agent that stops sending events, or whose
  instrumentation breaks, produces no error anywhere in sigillo. The web view
  turns the system's light yellow after `SIGILLO_STALE_AFTER_MINUTES` without
  activity (a day by default), and that is all: silence is reported as
  inactivity, never as tampering, and an export of the period is simply
  shorter.
- **sigillo itself being unreachable, from the agent's side.** Measured for
  real (fase 9), against the Python SDK's default settings
  (`opentelemetry-sdk` 1.44.0): a batch of spans that fails to export is not
  retried later, only replaced by the next batch's own attempt. One export
  attempt keeps trying for about 10 seconds (up to 6 tries with backoff); once
  that window passes, the up to 512 spans in that attempt are gone for good,
  and the cycle repeats roughly every 12–17 seconds while the outage lasts.
  Over a real 60-second outage at 20 actions/second, **none** of the 1192
  spans emitted were ever recorded — not a fraction, all of them — because no
  export attempt fell inside a working window. `Tracing.flush()` returning
  success at the end says only that it finished, not that anything was
  delivered: it does not distinguish "sent" from "given up". An outage shorter
  than about 10 seconds is usually absorbed for free, inside one attempt's own
  retries; anything longer costs everything sent during it. There is no
  local, persistent queue: what is in memory when the process exits, or when
  an attempt gives up, does not come back.
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
- **Duplicates.** A span resent by an OTLP exporter is recognised by its
  `trace_id`/`span_id` and written once. A native API request retried after a
  failure carries no such name, and can be recorded twice; the two receipts
  are both genuine records of what arrived.

**What a compromised server can do before anyone checks.**
- **Add false receipts, and open false chains.** At the end of every chain,
  and under any identifier the signer has never signed for. The signer cannot
  tell a true action from a made-up one.
- **Hide the chain from an export.** An export cut short, built from a
  database the attacker controls, is not checked against the signer by
  `sigillo-verify`: as before, it is caught against an earlier export
  (`--previous`). The operator's own server shows the system red as soon as it
  compares the database with the signer again.
- **Use what was signed before protocol version 2.** Until an installation is
  upgraded and `sigillo-signer init-from-db` has run, the signer signed any
  digest, so a history rewritten before that moment can carry genuine
  signatures. `init-from-db` takes the database's word once, at the upgrade:
  it checks every chain's links, hashes and signatures, but it cannot tell a
  chain rewritten earlier through the old socket from a true one.
- **Replace everything, with the key itself or with signatures from before
  protocol version 2.** A consistent forged history, signed with the real key
  and anchored afresh, has every hash, signature, root and token valid. What
  gives it away is the time the authority attests (`genTime`), which
  `sigillo-verify` takes as the proven time of each checkpoint: the fresh
  tokens lie long after the checkpoints' own times, and that is an
  `anchor-delay` warning (verdict `OK, with a warning`; an error, exit 1, with
  `--strict`). Tamper scenario 18. A forger who also moves the checkpoints'
  own times forward avoids the warning, but then every receipt is proven to
  exist only from the day of the forgery, which the report prints for each
  range of receipts ("existed no later than …"); an auditor who expects the
  records to be older sees it there. An export given to someone earlier
  (`--previous`) catches either.
- **Move the clock, within the tolerance.** `ts_received` is the server's own
  clock; the signer refuses one further than `SIGILLO_SIGNER_CLOCK_TOLERANCE_SECONDS`
  (300) from its own, or earlier than the receipt before it. `sigillo-verify`
  also refuses one later than a timestamp that already includes the receipt
  (`anchor-time`, beyond `--clock-tolerance`, 5 minutes by default), and
  timestamps that go backwards as the tree grows (`anchor-order`). Within
  those windows, and between two timestamps, only those clocks vouch for when
  something happened.

**What a single archive cannot show about itself.**
- **That the key is the operator's.** A wholly fabricated archive, signed with
  a new key published in its own manifest, verifies. Caught only with the
  operator's `key_id` from another channel (`sigillo-verify --key-id`).
- **That nothing was cut from its end.** Removing the last receipts and the
  checkpoints over them, and adjusting the manifest, leaves a valid shorter
  chain. Caught only against an earlier export (`--previous`), which also
  catches a newest checkpoint or timestamp token taken out. On its own, the
  verifier reports the receipts left after the newest checkpoint as "not yet
  anchored" and does not print a plain `OK`.
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

**Organizations separate what the web view shows, not the evidence.** A
hosted installation can hold several customers (`sigillo-server org create`),
each system belonging to one of them or to the operator alone. Signed in as an
organization, the web view shows that organization's systems and nothing else:
another's system answers exactly as one that does not exist, a document is
found only in its own systems, an export names only people its own chain acted
for, and a system it creates is named `<organization_id>.<name>`, so no refusal
can tell it about anyone else's. This is enforced in one place,
`apps/server/src/auth/tenancy.ts`, by a stand-in for the store that is closed
by default: a store method it does not list throws instead of answering, so a
method added later fails a page rather than leaking across organizations
(`apps/server/test/tenancy.test.ts`). What it does not change: one signing key
signs every organization's chains; the operator sees everything; whoever
administers the database administers every organization in it; and the people
pages stay the operator's alone, because one person has one pseudonym token
across every system, whichever organization's agent acted for them. Until
pseudonyms are kept per organization, opening those pages to an organization
would let it look up, and erase, another's people.

**Retention and erasure are not implemented.** Nothing here deletes a
recorded action, and the append-only triggers actively prevent it. The one
deletion there is removes a system that never recorded one (see "Renaming,
archiving and deleting a system"). A deployment with an erasure
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
