#!/bin/sh
# A consistent copy of the sigillo database, safe to take while the server runs.
#
# It uses SQLite's own backup API rather than cp: a file copy taken while a
# write is in flight is a corrupt database that looks fine until someone reads
# it. Old copies are pruned by count, not by age, so a backup that stops running
# does not silently delete the last good one.
#
# Run it from cron on the host:
#   0 3 * * *  docker compose -f /srv/sigillo/deploy/docker-compose.yml \
#                exec -T server /app/backup.sh
#
# Environment:
#   SIGILLO_DB             the database (default: /var/lib/sigillo/sigillo.db)
#   SIGILLO_BACKUP_DIR     where copies go (default: /var/lib/sigillo-backups)
#   SIGILLO_BACKUP_KEEP    how many to keep (default: 14)

set -eu

DB="${SIGILLO_DB:-/var/lib/sigillo/sigillo.db}"
DIR="${SIGILLO_BACKUP_DIR:-/var/lib/sigillo-backups}"
KEEP="${SIGILLO_BACKUP_KEEP:-14}"

mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$DIR/sigillo-$STAMP.db"

node /app/dist/cli.js backup --db "$DB" --out "$TARGET"

# Keep the newest $KEEP copies and no more.
ls -1t "$DIR"/sigillo-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
	echo "removing $old"
	rm -f "$old"
done

echo "backups in $DIR: $(ls -1 "$DIR"/sigillo-*.db 2>/dev/null | wc -l)"
