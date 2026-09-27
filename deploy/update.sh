#!/bin/sh
# Brings a running deployment up to the latest commit, in one step, from the
# deploy/ directory of the clone on the server (docs/DEPLOY-PRODUZIONE.md, 6.3):
#
#   $ /srv/sigillo/deploy/update.sh
#
# It restarts Caddy every time, whether or not the Caddyfile changed. Caddy
# reads its Caddyfile only when it starts, and the file is bind-mounted on its
# own: after `git pull` replaces it, a running Caddy keeps serving the old one.
# That matters because the Caddyfile carries the SHA-256 of the "verifica un
# documento" page's script in its Content-Security-Policy: a Caddy left
# running after an update that changed the script blocks it, and the page
# stays disabled. A restart costs a second or two of downtime and is harmless
# otherwise.
#
# It then checks the policy Caddy actually loaded, through Caddy's own admin
# endpoint inside the container, against the Caddyfile, and fails loudly if
# they differ. Nothing is deleted: volumes, key and database are untouched.
set -eu
cd "$(dirname "$0")"

git -C .. pull --ff-only
docker compose build
docker compose up -d
docker compose restart caddy

expected=$(grep -o "'sha256-[A-Za-z0-9+/]*=*'" Caddyfile)
loaded=""
tries=0
while [ -z "$loaded" ] && [ "$tries" -lt 30 ]; do
  loaded=$(docker compose exec -T caddy wget -qO- http://localhost:2019/config/ 2>/dev/null |
    grep -o "'sha256-[A-Za-z0-9+/]*=*'" | head -n 1 || true)
  if [ -z "$loaded" ]; then
    tries=$((tries + 1))
    sleep 1
  fi
done

if [ "$loaded" != "$expected" ]; then
  echo "update.sh: Caddy serves script-src ${loaded:-(nothing)}, but deploy/Caddyfile says $expected" >&2
  echo "update.sh: run 'docker compose logs caddy' to see why; the page \"verifica un documento\" will stay disabled until they agree" >&2
  exit 1
fi

echo "update.sh: done; Caddy restarted and serves the Caddyfile's script hash $expected"
docker compose ps
