# Checking for yourself that sigillo does not keep your content

The claim being checked: **prompts, model answers, tool arguments, tool
results and documents never reach sigillo's storage.** They reach it only as
SHA-256 digests (salted, for input and output). What sigillo does store is
listed column by column in `docs/STORAGE-INVENTORY.md`, and the text members
of a receipt are described in `docs/DATA-INVENTORY.md`.

## For a customer: the Privacy page

In the console, **Privacy** (`/ui/privacy`), for every account:

1. The page offers a random phrase (`sigillo-check-...`). Put it into
   something your agent handles: a prompt, a document it reads, a tool
   argument. Or type a phrase of your own, taken from your real data (at
   least 8 characters).
2. Press **Check now**. Sigillo searches everything it stores for your account:
   your recorded actions, the documents they name, your systems' names, the
   administrative log, keys, account details, the people your agents acted
   for.
3. The answer is one of two:
   - **Not found**: the phrase is in nothing Sigillo stores for your account.
   - **Found**, with where, in words, and what it means. The only expected
     places are labels your agent itself sent (a span, tool or system *name*
     that contains the phrase: use neutral names) and personal identifiers you
     gave Sigillo (a user id, an email), which can be erased on request.
     Anywhere else is a defect: please tell us.

What the search cannot do, and the page says so: it shows what is *stored*,
not what passes through the server's memory (with the optional model gateway
the prompt travels through the server during a call and is not saved), and it
cannot see what your model provider keeps.

Safety of the page itself: it is behind the sign-in; the search is cut down to
the signed-in account's own systems and account details (`auth/tenancy.ts`), so
one customer's answer never reveals anything of another's, and the operator's
search covers the operator's own systems only; the phrase travels in a POST
body (not in an address, not in the log), is escaped when shown back and is
never written anywhere; one check per account every 3 seconds.
`apps/server/test/privacy-page.test.ts` covers each of these, and fails if a
table is added to the schema without a decision on whether the search covers
it.

## For whoever runs the server, or an assessor: the command line

`sigillo-server privacy scan <phrase> --db <file> [--also <folder or file>]...`
does the same search more widely: every column of every table, the raw bytes
of the database file and its write-ahead log (which also covers pages that were
freed but not yet overwritten), and every file under each `--also` path (logs,
backups, exports; zips are opened and searched entry by entry), as UTF-8 and
UTF-16. It exits 0 and prints `not found: ...` if nothing holds the phrase, and
exits 2 and says where if something does. The phrase must be at least 16
characters. `sigillo-server privacy inventory --db <file>` prints every table
and column with its row count and its kind, and exits 1 if this release has a
column it does not describe.

## The same check, on every change

`apps/server/test/privacy-check.test.ts` puts a phrase through an agent's
spans in every content attribute the server knows (OpenInference, GenAI, tool
parameters, an exception message) and through a real model-gateway call, then
scans: nothing may be found. It also checks that the scan *does* find the
phrase when it is put in a field recorded as sent, so a scan that cannot fail
would itself fail the test. Another test fails whenever the database gains a
column that `docs/STORAGE-INVENTORY.md` does not classify.
