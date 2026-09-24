# sigillo

sigillo turns what an AI agent does into **evidence**: a chain of signed
receipts that nobody can change, delete or reorder without an independent
verifier saying exactly where.

It exists for the recording obligations of Regulation (EU) 2024/1689 — the AI
Act — in particular Articles 12, 14 and 26.

```
agent ──OpenTelemetry──▶ sigillo server ──▶ signed receipt, chained to the last
                              │
                              ├─ every hour: a Merkle checkpoint over the chain,
                              │              anchored by an RFC 3161 timestamp
                              │
                              └─ on request: an evidence file (.zip) an auditor
                                             can verify without trusting you
```

sigillo does **not** capture events itself. It receives them from the
instrumentation you already have — OpenTelemetry or OpenInference — or from its
SDK. What it adds is the signature, the chain, the anchor and the export.

A receipt carries **no content**: no prompt, no tool argument, no model output.
Only digests of them. See [docs/SECURITY.md](docs/SECURITY.md).

> **Non usi il terminale?** [`PROVA-LOCALE.md`](PROVA-LOCALE.md) è una guida
> passo per passo, in italiano, per provare sigillo sul tuo computer con Docker
> Desktop: installazione, avvio, agente di esempio, fascicolo e verifica.

## Five minutes

Node 22 and pnpm 10. `openssl` on the path.

```sh
pnpm install
pnpm build
```

Start the signer, which is the only process that ever sees the key:

```sh
node apps/signer/dist/cli.js keygen --key /tmp/sigillo/signer.key
node apps/signer/dist/cli.js serve --key /tmp/sigillo/signer.key \
     --socket /tmp/sigillo/signer.sock &
```

Register a system, issue a key for it, and start the server:

```sh
export SIGILLO_DB=/tmp/sigillo/sigillo.db
export SIGILLO_SIGNER_SOCKET=/tmp/sigillo/signer.sock

node apps/server/dist/cli.js system create acme-support-bot
node apps/server/dist/cli.js key create acme-support-bot     # prints the token once

export SIGILLO_ADMIN_PASSWORD='a password of at least 12 characters'
node apps/server/dist/cli.js serve --port 8080 &
```

Record something:

```sh
curl -X POST http://127.0.0.1:8080/api/v1/receipts \
  -H "Authorization: Bearer sigillo_..." -H "Content-Type: application/json" \
  -d '{"actor":{"agent":"planner"},
       "action":{"kind":"decision","name":"refund.approve"},
       "outcome":"blocked","input":{"amount":120}}'
```

Checkpoint it, anchor it, and hand someone the evidence:

```sh
node apps/server/dist/cli.js checkpoint --tsa-url https://freetsa.org/tsr
node apps/server/dist/cli.js export acme-support-bot --out ./fascicolo.zip

node packages/verifier/dist/cli.js ./fascicolo.zip
# OK  acme-support-bot: 2 receipts, seq 0..1, signed by 886b980555e75c28
#     1 checkpoint(s), 1 root(s) rebuilt, 2 inclusion proof(s) verified
```

The web view is at `http://127.0.0.1:8080/ui`.

## From an agent, without touching your code

```sh
pip install -e sdk-python -r sdk-python/examples/requirements.txt
```

```python
import sigillo

sigillo.init(
    endpoint="http://127.0.0.1:8080",
    api_key="sigillo_...",
    system_id="acme-support-bot",
    instrument=["langchain"],
)
```

That is the whole integration. Every span your framework already emits becomes a
receipt. There is a working LangGraph agent in
[`sdk-python/examples/`](sdk-python/examples/langgraph_agent.py); it uses a fake
model, so running it costs nothing.

## The pieces

| where | what |
|---|---|
| `packages/core` | the format: schema, canonicalisation, hashing, signatures, Merkle. No I/O, no clock, no environment |
| `packages/verifier` | `sigillo-verify`, open source, depends only on core and `openssl` |
| `apps/signer` | the separate process that holds the key |
| `apps/server` | ingest, storage, checkpoints, anchoring, export, the web view |
| `sdk-python/` | `sigillo.init()`, `sigillo.artifact()` |
| `deploy/` | Dockerfile, docker-compose, Caddy, backup |

All the cryptography lives in `core`, and the server and the verifier use the
same code. An auditor who wants to check what matters reads `core` and
`verifier` and nothing else.

## In production

```sh
cd deploy
cp .env.example .env     # set the domain and the certificate contact address
install -d -m 700 secrets && openssl rand -base64 24 | tr -d '\n' > secrets/admin_password
chmod 444 secrets/admin_password   # the web view's password, kept out of .env
docker compose run --rm signer keygen --key /var/lib/sigillo-key/signer.key
docker compose up -d
docker compose exec server node dist/cli.js system create acme-support-bot
docker compose exec server node dist/cli.js key create acme-support-bot
```

Three containers: the signer with the key and no network, the server with the
database, Caddy with TLS. See [`deploy/`](deploy/). The complete procedure for a
real server, from `git clone` to a verified evidence file, with a checklist, is
[`docs/DEPLOY-PRODUZIONE.md`](docs/DEPLOY-PRODUZIONE.md) (in Italian).

For qualified timestamps under eIDAS, point `TSA_URL` at a qualified provider.
The default, FreeTSA, is fine for a trial and is **not** qualified.

## Documentation

- [docs/FORMAT.md](docs/FORMAT.md) — the format, in enough detail to write a
  second verifier without reading this code. That is not a figure of speech: a
  Python script in `scripts/` re-derives the test vectors from that document
  alone, and it runs in CI.
- [docs/API.md](docs/API.md) — the endpoints and the commands.
- [docs/SECURITY.md](docs/SECURITY.md) — where the key is, what an attacker can
  and cannot do, and what sigillo does not prove.
- [docs/DATA-INVENTORY.md](docs/DATA-INVENTORY.md) — every member a receipt
  records in clear, where its value comes from, and how to keep personal data
  out of it before it is signed for good.

## What it does not do

sigillo makes the records it is given tamper-evident. It cannot tell you that
everything the system did was recorded — that depends on your instrumentation,
and no log format can attest it. It says so in the report it produces, too.

Also out of scope in this version: cross-checking multiple sources, automatic
deletion for retention, HSM or KMS key storage, multi-tenancy, analytics.

## Development

```sh
pnpm check                                   # lint, typecheck, build, test
python3 -m unittest discover -s sdk-python/tests -t sdk-python
```

`pnpm lint` is not a style checker. It enforces the things that would otherwise
rot: that `core` stays pure, that no dependency creeps in outside the approved
list, that the server contains no code able to load a private key, and that no
key material is committed.
