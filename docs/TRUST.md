# Trust and security overview

The front door for a security review. Each section gives the short answer and
points to the document that holds the detail. Sigillo is early-stage software:
this page says plainly what is live, what is planned and what is not offered.

## What sigillo proves, and what it does not

sigillo produces **tamper-evident records of what an AI system did**. It proves:

- a record existed no later than a given time;
- it was not altered, reordered or removed from the middle of a chain after it
  was signed;
- the chain was signed by a given key.

It does **not** prove that the AI's decision was correct, lawful or fair
(integrity is not correctness), that every action was recorded, or that the
data sent to it was true. See [CAPTURE.md](CAPTURE.md) and the "What sigillo
cannot detect" section of [SECURITY.md](SECURITY.md).

## Architecture in brief

- **Receipts.** One receipt per action: actor, action, outcome, time, and
  SHA-256 fingerprints of input and output. The text of prompts, arguments and
  answers is never stored. Format: [FORMAT.md](FORMAT.md), complete enough to
  write a second verifier from it.
- **Hash chain.** Each receipt carries the hash of the previous one, over its
  canonical form (RFC 8785 JSON). Changing or deleting any receipt breaks every
  link after it.
- **Signing.** Ed25519, from `node:crypto`. The key lives in a separate
  process, the **signer**, with no network access, which signs only the next
  receipt of a chain and keeps its own record of every chain. A compromised
  server cannot rewrite history without that record disagreeing.
- **Checkpoints and timestamps.** Periodic signed Merkle roots over the
  receipts, each anchored with an RFC 3161 timestamp from an external authority.
- **Pseudonyms and erasure.** People appear only as pseudonym tokens. Erasing a
  person removes the means to link a token to them, without breaking the chain.

## Key management

- One Ed25519 key, in a file readable only by the signer (`0600`; the signer
  refuses a key others can read).
- The server never receives the key's path, only a socket.
- Every public key ever used is kept in an append-only table and published in
  every export, so old receipts stay verifiable after a key change.
- Keys are held in a file, not in an HSM or a cloud KMS (planned, see below).
- If the signing key is stolen, receipts signed with it from then on are in
  doubt; checkpoints timestamped earlier still bound what existed before.

## Offline verification

Anyone can verify an export without trusting us or our server:

```sh
sigillo-verify export.zip --key-id <the key id we gave you> --previous <earlier export>
```

The verifier is open source, small, depends only on the core library and
`openssl`, and checks hashes, signatures, Merkle roots and timestamp tokens.
Give the key id through another channel (`--key-id`) and keep earlier exports
(`--previous`): a lone archive cannot prove the key is ours or that its end
was not cut off.

## Operational resilience

- The database is backed up **hourly on the server** and **daily to separate,
  encrypted off-site storage** (age encryption; the private key is held only by
  the operator). The last 30 daily copies are kept. A full restore was tested
  end to end when the backup was activated.
- Recovery from a lost server is a restore of the latest copy; data written
  after the last copy is lost, so the recovery point is up to one day.
- Procedure: [DEPLOY-PRODUZIONE.md](DEPLOY-PRODUZIONE.md) (Italian, internal).

## Data location and deployment

sigillo is offered as a **cloud service only**, hosted in the European Union.
Customer-hosted installation is **not offered**. If a regulated customer
requires dedicated infrastructure, a dedicated instance run by us in the EU is
the route we would study; it is not a product today.

## Timestamps and eIDAS

- Live: RFC 3161 timestamps from a free, public authority (FreeTSA). They show
  *when*, vouched for by that authority. They are **not qualified** under
  eIDAS and carry no legal presumption of accuracy under Article 41.
- Planned, **Custom plan only, not available yet**: timestamps from a qualified
  trust service provider. Do not rely on them in a contract today.

## Live and planned

| Capability | Status |
|---|---|
| Signed hash chains, offline verifier, Merkle checkpoints, RFC 3161 timestamps | Live |
| Signer process separated from the server | Live |
| Capture via OpenTelemetry, Python SDK, model gateway, native API | Live |
| Encrypted off-site backup | Live |
| Pseudonymisation and erasure of personal data | Live |
| Human approvals recorded by convention (`decision` receipts) | Live, documented in [API.md](API.md#human-approvals) |
| SDK helper and console view for approvals | Planned |
| Local queue in the SDK for outages | Planned |
| Second factor for the administrator | Planned |
| Qualified eIDAS timestamps | Planned, Custom plan only, not available |
| HSM or KMS key storage | Planned, no date |
| Customer-hosted (self-hosted) installation | Not offered |

"Planned" is an intention, not a commitment or a date.

## Reporting a problem

See the end of [SECURITY.md](SECURITY.md). Privacy and contractual terms are
covered separately and are provisional until the first customers.
