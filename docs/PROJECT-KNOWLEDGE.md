# Project knowledge: decisions that live outside the code

State as of 2026-11-05 (main after PR #138). This file keeps what the owner (Giovanni)
decided in conversations and that the code, `SPEC.md`, `PROGRESS.md` and `CLAUDE.md` do not
say. It holds no passwords, tokens or keys. Where the code already answers, it is not repeated.

## Business and legal

- **No company, for now.** Sigillo is software **licensed to a partner** who resells it by
  subscription. Contracts and privacy follow the chain licensor → partner → customers, not a
  direct SaaS supplier. A partner with a company is still wanted; a revenue share of about 50%
  was floated, numbers to be decided after the pilots.
- **Partner contact: Polina** (sales, non-technical, English). She does market research and
  finds customers. The partner becomes liable to its clients, so it needs hard proof that
  Sigillo stores no client data.
- **Language and law:** every text for customers and partners is in English; reference law is
  European (GDPR, AI Act).
- **Privacy and contracts are simple and provisional** until the first 3-4 customers. Say how
  data is handled (including the encrypted off-site copy); no long compliance lists. The Terms
  and DPA pages on the site are provisional; the DPA needs a lawyer.
- **Framing of "we store nothing":** hosted = "we never store content" (true by design);
  "we store nothing at all" only for a partner/customer-run install, where the licensor is not
  a processor.
- **Proof is the documentation and the design** (`docs/DATA-PROTECTION.md`). Giovanni
  rejected any in-console "test" or canary shown to customers ("looks rigged"). Do not propose
  customer-facing self-tests again.
- **Price (provisional):** pilot free (10,000 receipts/month; paid with a case study,
  feedback and a contact); Standard 190 EUR/month (100,000 receipts); custom from about
  490 EUR/month.
- **Market:** software houses and consultants building Python agents for finance, insurance
  and HR; Italy and Spain first. Competitors (Elydora, Agnys, Sigill.ai) also sell signed
  receipts. Sigillo's edge: it records the agent as-is, the agent cannot hold the key or
  silence the recorder, local + cloud model guard, one-step setup, EU/AI Act focus.
- **Fines context:** AI Act logging duties up to 15 M EUR / 3%; the Digital Omnibus may delay
  high-risk duties to Dec 2027 / Aug 2028; the nearer risk is GDPR.
- **Wording:** say "tamper-evident" / "independently verifiable". Never "tamper-proof",
  "compliant" or "AI Act ready": it gives evidence, not compliance.

## How to work with Giovanni

- Non-technical. No long plans in `.md` files unless he asks. Explain in simple, short chat
  messages, and implement after his OK (if he already said implement, proceed). Give small
  copy-paste steps, per operating system. Status updates in Italian.
- **Until the first customers exist, changes and features go live directly for every account**
  (rule 11 of `CLAUDE.md` is suspended since 2026-10-20), switches default to `all`.
- Nothing goes outside without his explicit OK: mail, publishing on PyPI or crates.io, new
  dependencies outside the approved list.
- He restarts the production stack himself after a change.

## Product decisions and limits

- **Key vault (passphrase-sealed keys): suspended** on 2026-10-23 (`SIGILLO_KEY_VAULT`,
  default off, `on` restores it; code and tables kept). Do not propose re-enabling unless he
  asks. Why: without a passphrase the server could open it, with one he found it inconvenient.
- **API keys customers hand over:** stored AES-256-GCM, key file apart from the database, only
  the last 4 digits shown. The server must be able to open them to call the model, so
  "invisible even to the server" is **not** achieved. Privacy texts promise only that.
- **Upload your agent:** Python only in the console. TypeScript upload and Java/.NET
  OpenTelemetry settings are built but switched off (`data-other-languages`), because only what
  gives the same control as Python is kept. The Rust SDK (PR #117, branch
  `claude/project-thread-6olagu`) was **closed unmerged**; its dependencies (ureq, ring,
  unicode-normalization) were never approved. Resume only if he asks.
- **Not eIDAS-qualified:** FreeTSA stamps are not qualified; a qualified stamp or company seal
  needs a company. Decision: wait.
- **Known gaps:** no key-code field on the public `/verify` page (proposal pending); no
  automatic retention/deletion (proposal of 6 or 12 months pending, see
  `docs/PROPOSTA-CONSERVAZIONE.md`); admin password has no second factor; no GitHub login; SDK
  not on PyPI (installed from the repository zip); no self-hosted product yet; no local queue
  (capture lost if the server is unreachable for more than about 10 s); Ctrl-C is recorded as
  `lost`.
- **Needs outside parties:** independent data-handling assessment, penetration test (briefs in
  the partner pack), a lawyer for the DPA.
- **Home live demo** (PR #135/#141): three sample agents, steps 1-4 above the window, no box
  around it, starts when in view. Giovanni preferred the first layout (PR #139 was reverted).

## Server and deploy (production)

- Aruba Cloud VPS in the EU (40 GB disk, 4 GB RAM), public IP 5.249.150.200, domain
  `get-sigillo.eu`. SSH user is `root` (the `ARU-...` login is the Aruba panel, not SSH); the
  Aruba web console works if SSH fails. The repository and compose live in
  `/root/sigillo/deploy`, not `/srv/sigillo` as some docs assume. Update with `./update.sh`;
  never `docker compose down -v`.
- **Off-site backup active since 2026-10-18:** daily 03:30 `offsite-backup.sh`, age-encrypted
  copy (last 30 kept) to a Google Drive of a dedicated account through rclone remote `box`,
  folder `sigillo-backup`; hourly local `backup.sh`. Settings in `/etc/sigillo-offsite.env`
  (public key only). The age **private key is only with Giovanni** (password manager) and is
  needed only to restore. An rclone token was once pasted in a chat (low risk, backup-only
  account); revoking it breaks the backup until `rclone config reconnect`. Not yet done:
  confirm the cron ran on a later day, practise a real restore on a spare machine. Steps:
  `docs/DEPLOY-PRODUZIONE.md`, 6.1.
- Auto-update from `main` was flagged as high risk.

## Open items

- PR #129 (zod 4) fixes `pnpm audit`, red on main because of a zod advisory; awaiting a
  decision.
- Caddyfile `img-src 'self'` blocks the `data:` SVG grain of the backdrop.
- Partner call kit and a 50-minute Italian training course were built on request (2026-10-27,
  2026-11-02); facts in them may be out of date after later decisions. Answers on price and
  downtime behaviour in the call kit await Giovanni's confirmation.
- Outreach videos for HiLabs, Anomity, Aibound, Murmu (in that order) were produced with
  `SIGILLO_HILABS_CUT=<cut> pnpm tsx video/hilabs.ts` (cuts `hilabs`, `second`, `third`,
  `fourth`); a new narration needs a new cut. The cloud session cannot upload large files to
  Drive; they go through Giovanni's PC.
