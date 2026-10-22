# Checking for yourself that sigillo does not keep your content

This page is for a partner, a customer, or an assessor they hire, who wants
to check what a sigillo installation stores instead of taking anyone's word
for it. It takes about fifteen minutes and needs shell access to the machine
the server runs on (on your own installation, or on ours with us beside you).

The claim being checked: **prompts, model answers, tool arguments, tool
results and documents never reach sigillo's storage.** They reach it only as
SHA-256 digests (salted, for input and output). What sigillo does store is
listed column by column in `docs/STORAGE-INVENTORY.md`, and the text members
of a receipt are described in `docs/DATA-INVENTORY.md`.

## The canary test

1. **Get a marker.** A random string nobody could produce by accident:

   ```
   sigillo-server privacy canary
   sigillo-canary-3f9c0b7e1d2a4c5b8e6f7a9d0c1b2e3f
   ```

2. **Send it through your real agent**, connected to sigillo as you would in
   production (the SDK, OpenTelemetry, or the model gateway). Put the marker
   everywhere your agent puts content: in the user's prompt, in a document it
   reads, in a tool's arguments, in what a tool returns, so that the model
   repeats it in its answer. Run the agent once and check in the console that
   the actions were recorded.

3. **Scan for it**, on the server:

   ```
   sigillo-server privacy scan <marker> --db /var/lib/sigillo/sigillo.db \
     --also /var/lib/sigillo-backups --also <a folder of server logs> --also <an export zip>
   ```

   The scan looks in every column of every table of the database, then in the
   raw bytes of the database file and of its write-ahead log, which also covers
   pages that were freed but not yet overwritten. Every file under each
   `--also` path is searched as well, and each zip (an export, a daily export)
   is opened and searched entry by entry. The marker is searched for as UTF-8
   and as UTF-16.

   The expected result, and exit code 0:

   ```
   not found: every column of the database, and 14 file(s)
   ```

   If the marker is found, the scan says where, and exits with code 2:

   ```
   FOUND in receipts.action_name: 1 row(s)
   FOUND in receipts.canonical: 1 row(s)
   FOUND in file /var/lib/sigillo/sigillo.db: 2 time(s)
   ```

## When the marker is found

It is found only where your agent put it in a field that sigillo records as
sent, by design:

| where it was found | what put it there | what to do |
|---|---|---|
| `subjects.identifier` | the marker was the user id (`user.id` / `enduser.id`) | expected: the identifier is kept, outside the evidence, so that a person can be found and erased. `sigillo-server subject erase --identifier <marker>` removes it, and the scan then finds nothing |
| `receipts.action_name`, `receipts.canonical` | the marker was in a span's *name* (`"reply to <marker>"`), a tool name, an agent name or a model name | name spans and tools with code identifiers, never with data (`docs/DATA-INVENTORY.md`, "Recommendations") |
| `artifacts.label` | the marker was an artifact label (a file name, for example) | label documents with a category such as `curriculum` |
| `systems.display_name`, `admin_log.detail` | the marker was typed as a system's name | name systems neutrally |

Anywhere else is a defect. Please report it to us: we treat it as a security
incident (the incident plan in the partner pack).

## What the test does and does not show

- It shows what **this installation** stores, at the moment you run it, for
  the paths you gave. It does not look at other machines: a reverse proxy's
  logs (Caddy writes no request bodies, see `deploy/Caddyfile`), an off-site
  backup copy (encrypted, see `docs/SECURITY.md`), or the model provider your
  gateway calls go to (that provider receives the prompt, as it would without
  sigillo).
- It shows storage, not memory. While a request is being handled, its content
  is in the server's memory: the model gateway must hold the prompt to forward
  it. Nothing writes it out.
- It does not replace an independent assessment. It makes one quick and
  repeatable: an assessor can run it, read the code it runs
  (`apps/server/src/assurance/privacy-check.ts`), and read the test that runs
  the same check on every change (`apps/server/test/privacy-check.test.ts`).

## The same check, on every change

`apps/server/test/privacy-check.test.ts` runs this procedure in the test suite,
which CI runs on every change. It sends the marker through an agent's spans in
every content attribute the server knows (OpenInference, OpenTelemetry GenAI,
tool parameters, an exception message) and through a real call to the model
gateway, prompt and answer, then scans: nothing may be found. It also checks
that the scan *does* find the marker when it is put in a field recorded as
sent, so a scan that cannot fail would itself fail the test. A third test fails
whenever the database gains a column that `docs/STORAGE-INVENTORY.md` does not
classify.
