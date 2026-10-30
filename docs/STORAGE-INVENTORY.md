# What the sigillo database stores, column by column

Generated from `apps/server/src/assurance/privacy-check.ts` (`sigillo-server privacy inventory --markdown`).
A test fails if the database schema gains a column this page does not classify, so the page cannot
silently fall behind the code. To see the same thing for a running installation, with row counts:
`sigillo-server privacy inventory --db <file>`. Why content never reaches it, and the customer's
own key, are in `docs/DATA-PROTECTION.md`. What the text members of a receipt contain is
described in `docs/DATA-INVENTORY.md`.

Nothing in the database holds a prompt, a model answer, a tool argument, a tool result or a
document: those reach the database only as digests.

## Classes

| class | meaning |
|---|---|
| `content-digest` | a SHA-256 digest or a hash tree root: no content, and salted where it digests an input or output |
| `recorded-as-sent` | text recorded exactly as the agent, operator or console sent it, and kept as a record (signed evidence, an append-only log or the export register): no command erases it |
| `personal-erasable` | personal data in clear, outside the evidence: it can be changed or deleted (the note says how) |
| `identifier` | a random or operator-chosen identifier |
| `credential-hash` | a one-way hash of a secret: the secret itself is not stored |
| `sealed` | encrypted (AES-256-GCM); the key is not in the database |
| `public-key` | a public key, meant to be published |
| `time` | a timestamp |
| `operational` | a state, a count, a flag or a size |

## `systems`

one row per AI system (chain). Kept: while the system exists; removable only once its chain is gone.

| column | class | note |
|---|---|---|
| `system_id` | identifier | chosen by the operator or customer; written into every receipt |
| `created_at` | time |  |
| `display_name` | personal-erasable | label shown in the console; can be changed or cleared |
| `archived_at` | time |  |
| `organization_id` | identifier | the customer account the system belongs to |

## `organizations`

customer accounts. Kept: while the account exists; an account with no recorded action can be deleted.

| column | class | note |
|---|---|---|
| `organization_id` | identifier | random |
| `name` | personal-erasable | company name given at sign-up; also written in the administrative log at sign-up |
| `created_at` | time |  |
| `approved_at` | time |  |

## `users`

people who sign in for a customer account. Kept: while the account exists.

| column | class | note |
|---|---|---|
| `uid` | identifier | Firebase's id for the login |
| `email` | personal-erasable | the login email, removed with the account; also written in the administrative log at sign-up. No password is ever stored |
| `organization_id` | identifier |  |
| `created_at` | time |  |

## `api_keys`

the keys agents use to send records. Kept: until revoked; revoked keys stay as a record.

| column | class | note |
|---|---|---|
| `key_id` | identifier | random |
| `system_id` | identifier |  |
| `salt` | operational | random salt for the hash below |
| `secret_hash` | credential-hash | scrypt |
| `created_at` | time |  |
| `revoked_at` | time |  |

## `transfer_links`

links that hand a system to another account. Kept: as a record of who received what.

| column | class | note |
|---|---|---|
| `token_hash` | credential-hash | SHA-256 of the secret in the link |
| `system_id` | identifier |  |
| `created_at` | time |  |
| `expires_at` | time |  |
| `used_at` | time |  |
| `used_by` | identifier | the receiving account |
| `revoked_at` | time |  |

## `receipts`

the signed, chained record of each agent action (the evidence). Kept: for the life of the chain: append-only, enforced by database triggers.

| column | class | note |
|---|---|---|
| `id` | operational |  |
| `system_id` | identifier |  |
| `seq` | operational | position in the chain |
| `hash` | content-digest | the receipt's own hash |
| `prev_hash` | content-digest | the previous receipt's hash |
| `canonical` | recorded-as-sent | the whole receipt: input/output only as digests; agent name, action name, model name, artifact labels and the pseudonym token in clear (docs/DATA-INVENTORY.md) |
| `sig` | operational | Ed25519 signature |
| `key_id` | identifier | which signing key |
| `ts_event` | time |  |
| `ts_received` | time |  |
| `action_kind` | recorded-as-sent | a fixed kind such as tool_call or llm_call |
| `action_name` | recorded-as-sent | tool, model or step name, copied from the receipt |
| `outcome` | operational | ok, error or unknown |
| `source_trace_id` | identifier | OpenTelemetry trace id, random |
| `source_span_id` | identifier | OpenTelemetry span id, random |

## `checkpoints`

signed hash-tree roots over each chain. Kept: for the life of the chain: append-only, enforced by database triggers.

| column | class | note |
|---|---|---|
| `id` | operational |  |
| `system_id` | identifier |  |
| `tree_size` | operational |  |
| `root_hash` | content-digest |  |
| `ts` | time |  |
| `key_id` | identifier |  |
| `sig` | operational | Ed25519 signature |

## `timestamps`

RFC 3161 timestamp tokens over checkpoints. Kept: for the life of the chain: append-only, enforced by database triggers.

| column | class | note |
|---|---|---|
| `id` | operational |  |
| `checkpoint_id` | operational |  |
| `tsa_url` | identifier | the timestamp authority's address |
| `token_base64` | content-digest | the authority's signed token over a checkpoint root |
| `obtained_at` | time |  |

## `artifacts`

index of documents named in receipts, by fingerprint. Kept: for the life of the chain: append-only, enforced by database triggers.

| column | class | note |
|---|---|---|
| `id` | operational |  |
| `system_id` | identifier |  |
| `seq` | operational |  |
| `role` | operational | input or output |
| `label` | recorded-as-sent | a category the agent's code gives, such as 'curriculum' |
| `media_type` | recorded-as-sent | such as application/pdf |
| `sha256` | content-digest | the document's fingerprint; the document itself is never sent |
| `text_canon` | operational | name of the text normalisation used for text_sha256 |
| `text_sha256` | content-digest | fingerprint of the document's normalised text |

## `signing_keys`

every public key receipts were signed with. Kept: forever, so old receipts stay verifiable.

| column | class | note |
|---|---|---|
| `key_id` | identifier |  |
| `public_key_base64` | public-key |  |
| `first_seen` | time |  |

## `export_register`

which evidence packs were handed out. Kept: as a record.

| column | class | note |
|---|---|---|
| `id` | operational |  |
| `ts` | time |  |
| `system_id` | identifier |  |
| `actor` | recorded-as-sent | who exported: 'web <address>' or 'web <email> (<account>)' |
| `period_from` | time |  |
| `period_to` | time |  |
| `run_trace` | identifier |  |
| `disclosure` | operational | which nonces were disclosed, if any |
| `zip_sha256` | content-digest | the pack's fingerprint; the pack itself is not kept |
| `bytes` | operational |  |

## `connections`

heartbeat state of running agents. Kept: current state only, overwritten.

| column | class | note |
|---|---|---|
| `system_id` | identifier |  |
| `session_id` | identifier | random, chosen by the SDK |
| `state` | operational |  |
| `started_at` | time |  |
| `last_beat_at` | time |  |
| `script_hash` | content-digest | SHA-256 of the agent's script; the script is never sent |
| `script_changed` | operational |  |
| `boot_at` | time | when the agent's computer was switched on |

## `provider_keys`

the customer's own model-provider keys, for the model gateway. Kept: until the customer replaces or removes them.

| column | class | note |
|---|---|---|
| `system_id` | identifier |  |
| `provider` | operational | openai, anthropic, ... |
| `sealed` | sealed | the key, encrypted |
| `last4` | operational | last four characters, shown in the console |
| `created_at` | time |  |
| `vault_owner` | identifier | the account whose vault seals it (schema 8, the key vault) |

## `vaults`

each account's key vault (schema 8, the key vault). Kept: while the account exists.

| column | class | note |
|---|---|---|
| `owner` | identifier | the account |
| `salt` | operational | scrypt salt |
| `wrapped_by_pass` | sealed | the vault's data key, sealed under the passphrase |
| `wrapped_by_recov` | sealed | the vault's data key, sealed under the recovery key |
| `created_at` | time |  |

## `vault_schedule`

the hours in which an account's key vault is kept sealed (schema 9). Kept: while the account exists.

| column | class | note |
|---|---|---|
| `owner` | identifier | the account |
| `timezone` | operational | for example Europe/Rome |
| `windows` | operational | weekly windows: days and times, nothing of the customer's content |
| `updated_at` | time |  |

## `admin_log`

administrative actions outside the chains (renames, deletions, erasures, sign-ups). Kept: append-only, enforced by database triggers.

| column | class | note |
|---|---|---|
| `id` | operational |  |
| `ts` | time |  |
| `action` | operational |  |
| `system_id` | identifier |  |
| `actor` | recorded-as-sent | 'web <address>', 'web <email> (<account>)' or 'cli <user>@<host>' |
| `detail` | recorded-as-sent | names before and after a rename; sign-up email and company name |
| `genesis_hash` | content-digest |  |

## `subjects`

which person a pseudonym token in the receipts stands for. Kept: until the person is erased (sigillo-server subject erase); the row is overwritten on delete.

| column | class | note |
|---|---|---|
| `token` | identifier | psn_ + 128 random bits, the only thing a receipt holds |
| `identifier` | personal-erasable | the user id the agent sent; deleted by `sigillo-server subject erase` |
| `created_at` | time |  |

## `openings`

the nonces that salted input/output digests were computed under. Kept: until erased (sigillo-server openings erase); without it the digest can never be matched to content.

| column | class | note |
|---|---|---|
| `system_id` | identifier |  |
| `seq` | operational |  |
| `role` | operational | input or output |
| `nonce` | operational | 32 random bytes |
