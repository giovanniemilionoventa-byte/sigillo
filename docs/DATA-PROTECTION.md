# How sigillo protects your content: your own key

*For customers, partners and their technical teams. Every statement below
names the code that makes it true, so it can be checked by reading, not by
running a test.*

## In one paragraph

Your agent runs on your computer or your server. Before anything leaves it,
sigillo's SDK turns every prompt, answer, tool argument and tool result into a
**fingerprint** (a SHA-256 digest), locked with **a key that only you have**.
Sigillo receives the fingerprint and nothing that unlocks it: not the content,
not your key, not the per-action value derived from it. So neither sigillo nor
anyone who breaks into sigillo's server can read your content, or even find it
by guessing, because it is not there and the means to test a guess are not
there either. You, with your key, can prove at any time what a fingerprint was
of.

## Each customer has its own key

- **Where it is made.** On the console's "Upload your agent" page, your browser
  makes the key (32 random bytes, `crypto.getRandomValues`) and writes it into
  the agent file it gives back, as `customer_key="…"` in `sigillo.init`. The
  file is read and rewritten in the browser and never sent to the server
  (`apps/server/src/http/agent-setup.ts`). If you paste the code by hand, the
  same page fills in a key made the same way; you can also use any secret of
  your own.
- **Where it stays.** In your agent's file, on your machine. The SDK uses it
  inside your process and never sends it (`nonce_for` and
  `_filtered_attributes` in `sdk-python/src/sigillo/__init__.py`).
- **One per customer, or per agent.** Two customers never share a key: each
  key is made separately, by the customer's own browser. An account with
  several agents may give them the same key or one each.

## What happens to your content, step by step

1. Your agent produces a prompt, an answer, a tool call (OpenTelemetry spans,
   recorded by the SDK in your process).
2. For each input and output, the SDK computes a 32-byte value from your key
   and the action's identifiers:
   `nonce = HMAC-SHA256(your key, "sigillo-nonce-v1" ‖ trace id ‖ span id ‖ input|output)`.
3. It computes the fingerprint `SHA-256(nonce ‖ content)` (the salted digest of
   `docs/FORMAT.md`, section 2.7) and **replaces the content with it**. Every
   other attribute the server does not read is dropped.
4. It sends the fingerprint, with the word `customer` where a nonce would go.
   The nonce and the key are not sent.
5. The server signs a receipt holding the fingerprint, marked `salted`, and
   stores no nonce for it (`digestFor` in `apps/server/src/storage/store.ts`,
   `NONCE_KEPT_BY_CUSTOMER`).

## Why nobody but you can get at the content

- **The content is never sent**, so it cannot be stored, logged, backed up or
  stolen on our side. Step 3 happens in your process, before the network.
- **A fingerprint cannot be reversed.** SHA-256 is one-way.
- **A fingerprint cannot be guessed either.** For short content ("approved",
  "score: 7"), a plain fingerprint could be found by trying candidates. Here
  every fingerprint is mixed with a 32-byte value that depends on your key, and
  that value is never sent. Without your key there is nothing to try guesses
  against: not for us, not for anyone holding a copy of our database.
- **Our own access changes nothing.** Server administrators, backups (the
  off-site copy too) and the database file hold the same fingerprints. There is
  no master key on our side, because the key is not on our side.

## What you can prove with your key

To show that a receipt's fingerprint is of a given content (to an auditor, a
court, a client), rebuild the nonce and give it to the open-source verifier:

```python
import sigillo
nonce = sigillo.nonce_for(customer_key, trace_id, span_id, "input")  # from the receipt's "source"
```

```
sigillo-verify open export.zip <seq> input --text "<the content>" --nonce <nonce>
```

It prints `MATCH`, or `NO MATCH`. The verifier runs offline and needs nothing
from sigillo.

**Keep a copy of your key.** Without it, receipts still verify (nobody can
alter them), but no one, sigillo included, can show what a fingerprint was of.
That is also how you erase: **destroy the key and every fingerprint made with
it is cut off from its content for good.**

## What sigillo does see

Said plainly, so that the claim above is not read as more than it is:

- **Labels your agent sends**: the names of tools, agents and models, the kind
  of action, whether it succeeded, times. Use neutral names: a tool called
  `refund_maria_bianchi` puts a name in a label.
- **Account details**: the email and company name you sign up with.
- **Who an action was for**, only if your agent says so (`user.id`): stored as
  a pseudonym, erasable on request; with `sigillo.pseudonym(...)` the
  identifier is turned into an opaque one in your process first.
- **Document fingerprints** (`sigillo.artifact`): plain SHA-256 of the file, not
  locked with your key, so that a document can be recognised later. A
  fingerprint does not reveal a document; whoever already has the same file
  can tell it is the same.
- **With the model gateway** (sigillo's address in place of the model
  provider's): the prompt passes through sigillo's server memory on its way to
  the provider, and is not saved. For the full guarantee above, let your agent
  call its model directly.
- **What your model provider keeps** is outside sigillo.

All of it, field by field, is in `docs/STORAGE-INVENTORY.md`, generated from the
code; a test fails if the database gains a field that page does not describe.

## For a technical reviewer

| claim | where to read it |
|---|---|
| content is replaced before sending | `sdk-python/src/sigillo/__init__.py`: `_CONTENT_ATTRIBUTES`, `_filtered_attributes`, `_ContentFilteringExporter` |
| the key and nonce are not sent | same file: `nonce_for`; only `"customer"` goes in `sigillo.<role>.nonce` |
| the server keeps nothing that opens it | `apps/server/src/storage/store.ts`: `digestFor`, `NONCE_KEPT_BY_CUSTOMER`; `apps/server/src/ingest/adapter.ts`: `payloadOf` |
| the key is made in the browser | `apps/server/src/http/agent-setup.ts`: `crypto.getRandomValues` |
| the fingerprint format | `docs/FORMAT.md`, section 2.7 |
| what is stored, field by field | `docs/STORAGE-INVENTORY.md` |

The SDK and the verifier are short and readable on purpose; the repository is
available for review on request. The automated tests that keep these
statements true run on every change (`sdk-python/tests/test_end_to_end.py`
runs the real signer, server and verifier and checks that neither the key, the
nonce nor the content is anywhere in the server's files).

For whoever runs a server: `sigillo-server privacy inventory --db <file>` lists
every table and column with its row count, and `sigillo-server privacy scan
<phrase> --db <file> [--also <path>]...` searches the database, its raw bytes
and any logs or backups for a phrase.
