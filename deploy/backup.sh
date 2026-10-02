#!/bin/sh
# A consistent copy of the sigillo database, safe to take while the server runs.
#
# It uses SQLite's own backup API rather than cp: a file copy taken while a
# write is in flight is a corrupt database that looks fine until someone reads
# it. Old copies are pruned by count, not by age, so a backup that stops running
# does not silently delete the last good one.
#
# Run it from cron on the host, every hour (docs/DEPLOY-PRODUZIONE.md, 6.1).
#
# Few copies are kept here, two by default, because here is the same disk as
# the database: every copy is the whole database again, so 48 copies would
# let the database grow to about 1/50 of the disk before the backups filled
# it. The copies that cover days and weeks belong off this host (6.1).
#
# It refuses to write a copy that would leave less free space than the
# database's own size: a full disk stops the database from recording, which
# is worse than a missed backup. The refusal exits non-zero, and cron's log
# shows it.
#
# Environment:
#   SIGILLO_DB             the database (default: /var/lib/sigillo/sigillo.db)
#   SIGILLO_BACKUP_DIR     where copies go (default: /var/lib/sigillo-backups)
#   SIGILLO_BACKUP_KEEP    how many to keep (default: 2)

set -eu

DB="${SIGILLO_DB:-/var/lib/sigillo/sigillo.db}"
DIR="${SIGILLO_BACKUP_DIR:-/var/lib/sigillo-backups}"
KEEP="${SIGILLO_BACKUP_KEEP:-2}"

mkdir -p "$DIR"

# The copy needs about the database's size, and the database needs as much
# again to keep growing: refuse below twice its size.
DB_KB=$(( ($(wc -c < "$DB") + 1023) / 1024 ))
FREE_KB=$(df -Pk "$DIR" | awk 'NR == 2 { print $4 }')
if [ "$FREE_KB" -lt $((DB_KB * 2)) ]; then
	echo "refusing to back up: ${FREE_KB} KiB free in $DIR, and the database is ${DB_KB} KiB" >&2
	echo "free some space, or move the old copies off this host (docs/DEPLOY-PRODUZIONE.md, 6.1)" >&2
	exit 1
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$DIR/sigillo-$STAMP.db"

node /app/dist/cli.js backup --db "$DB" --out "$TARGET"

# Keep the newest $KEEP copies and no more.
ls -1t "$DIR"/sigillo-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
	echo "removing $old"
	rm -f "$old"
done

echo "backups in $DIR: $(ls -1 "$DIR"/sigillo-*.db 2>/dev/null | wc -l)"
