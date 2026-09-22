#!/usr/bin/env bash
# Runs the CV-screening demo end to end: a throwaway signer and server, the
# 20 CVs through the agent, a checkpoint, and a summary. Leaves the server
# running afterwards so you can follow ISPEZIONE.md against it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO="$ROOT/demo/selezione-cv"
WORK="$DEMO/.run"
SIGNER="$ROOT/apps/signer/dist/cli.js"
SERVER="$ROOT/apps/server/dist/cli.js"
SYSTEM_ID="selezione-cv"
PORT="${SIGILLO_DEMO_PORT:-8099}"
ADMIN_PASSWORD="${SIGILLO_ADMIN_PASSWORD:-demo-locale-non-usare-in-produzione}"

if [ ! -f "$SIGNER" ] || [ ! -f "$SERVER" ]; then
  echo "Build sigillo first: pnpm install && pnpm build (dalla radice del repository)." >&2
  exit 1
fi
if ! command -v python3 > /dev/null; then
  echo "python3 non trovato nel PATH." >&2
  exit 1
fi
if ! python3 -c "import langgraph, langchain_core, sigillo" > /dev/null 2>&1; then
  echo "Dipendenze mancanti. Installale con:" >&2
  echo "  pip install -e \"$ROOT/sdk-python\" -r \"$DEMO/requirements.txt\"" >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"
KEY="$WORK/signer.key"
SOCK="$WORK/signer.sock"
DB="$WORK/sigillo.db"

node "$SIGNER" keygen --key "$KEY"
( node "$SIGNER" serve --key "$KEY" --socket "$SOCK" > "$WORK/signer.log" 2>&1 & echo $! > "$WORK/signer.pid" )
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
if [ ! -S "$SOCK" ]; then
  echo "il firmatario non si è avviato entro 5 secondi; log:" >&2
  cat "$WORK/signer.log" >&2
  exit 1
fi

node "$SERVER" system create "$SYSTEM_ID" --db "$DB" --signer-socket "$SOCK"
TOKEN=$(node "$SERVER" key create "$SYSTEM_ID" --db "$DB" | tail -1)

export SIGILLO_ADMIN_PASSWORD="$ADMIN_PASSWORD"
( node "$SERVER" serve --db "$DB" --signer-socket "$SOCK" --port "$PORT" --checkpoint-minutes 1000 \
    > "$WORK/server.log" 2>&1 & echo $! > "$WORK/server.pid" )
READY=""
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null; then READY=1; break; fi
  sleep 0.2
done
if [ -z "$READY" ]; then
  echo "il server non ha risposto su http://127.0.0.1:$PORT entro 10 secondi; log:" >&2
  cat "$WORK/server.log" >&2
  echo "un'altra istanza è forse già in ascolto sulla porta $PORT: prova SIGILLO_DEMO_PORT=8100 $0" >&2
  exit 1
fi

export SIGILLO_ENDPOINT="http://127.0.0.1:$PORT"
export SIGILLO_API_KEY="$TOKEN"
export SIGILLO_SYSTEM_ID="$SYSTEM_ID"

python3 "$DEMO/agent.py"

node "$SERVER" checkpoint --db "$DB" --signer-socket "$SOCK" --tsa-url https://freetsa.org/tsr || \
  echo "avviso: non sono riuscito a raggiungere la marca temporale (freetsa.org); il checkpoint resta senza marca, riprovalo più tardi con: node \"$SERVER\" checkpoint --db \"$DB\" --signer-socket \"$SOCK\" --tsa-url https://freetsa.org/tsr"

cat <<SUMMARY

Fatto: 20 candidature registrate nel sistema "$SYSTEM_ID".

  Interfaccia:             http://127.0.0.1:$PORT/ui
  Password amministratore: $ADMIN_PASSWORD
  Verificatore offline:    node "$ROOT/packages/verifier/dist/cli.js" --help

Per fermare il server e il firmatario quando hai finito:
  kill \$(cat "$WORK/server.pid") \$(cat "$WORK/signer.pid")

Ora puoi seguire demo/selezione-cv/ISPEZIONE.md.
SUMMARY
