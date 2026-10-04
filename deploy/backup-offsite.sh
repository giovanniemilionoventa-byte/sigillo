#!/bin/bash
# The hourly backup, and a copy of it off this host (docs/DEPLOY-PRODUZIONE.md,
# 6.1). Run from cron on the host, from the deploy/ directory of the clone:
#
#   0 * * * * /root/sigillo/deploy/backup-offsite.sh >> /root/sigillo-backup.log 2>&1
#
# First it runs backup.sh inside the server container, exactly as before. Then,
# if rclone is installed and has a remote called sigillo-backup, it streams the
# newest copy out of the container, compresses it, and uploads it there. Without
# that remote it stops after the local copy and says so: the off-host copy is
# optional, the local one is not.
#
# sigillo-backup is meant to be an rclone "crypt" remote over a Google Drive
# remote (6.1 shows how to make both). The database holds customers' data, so
# it leaves this host only encrypted, with a password kept in rclone's config
# here and, written down, somewhere else: without it the copies on Drive cannot
# be read, by anyone, the owner included.
#
# On the remote it keeps the newest copy of each day, for the newest
# SIGILLO_OFFSITE_KEEP_DAYS days: the copy of the last hour, and one per day
# before it. Older copies are deleted after each upload, counted by days that
# have a copy, not by the calendar, so an upload that stops running does not
# delete the last good copies.
#
#   ./backup-offsite.sh --check
#
# asks for the password as it was written down, downloads the newest copy using
# only that password, and checks that it decrypts and is a whole SQLite
# database. Run it once after the setup, so the password on paper is known to
# be the right one.
#
# Environment:
#   SIGILLO_OFFSITE_REMOTE     where copies go (default: sigillo-backup:)
#   SIGILLO_OFFSITE_KEEP_DAYS  how many days to keep (default: 30)

set -euo pipefail
cd "$(dirname "$0")"

REMOTE="${SIGILLO_OFFSITE_REMOTE:-sigillo-backup:}"
KEEP_DAYS="${SIGILLO_OFFSITE_KEEP_DAYS:-30}"
case "$REMOTE" in
*: | */) ;;
*) REMOTE="$REMOTE/" ;;
esac
REMOTE_NAME="${REMOTE%%:*}"

configured() {
	command -v rclone >/dev/null 2>&1 && rclone listremotes | grep -qxF "$REMOTE_NAME:"
}

newest_on_remote() {
	rclone lsf --files-only --include 'sigillo-*.db.gz' "$@" | sort -r | head -n 1
}

if [ "${1:-}" = "--check" ]; then
	if ! configured; then
		echo "no rclone remote called $REMOTE_NAME: nothing to check (docs/DEPLOY-PRODUZIONE.md, 6.1)" >&2
		exit 1
	fi
	# The same remote, rebuilt from the Drive connection and the password typed
	# here: the password saved in rclone's config plays no part.
	under=$(rclone config show "$REMOTE_NAME" | sed -n 's/^remote = //p')
	read -r -s -p "password of the off-site backups, as written down: " typed
	echo
	export RCLONE_CRYPT_REMOTE="$under"
	export RCLONE_CRYPT_FILENAME_ENCRYPTION=off
	export RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION=false
	RCLONE_CRYPT_PASSWORD=$(printf '%s' "$typed" | rclone obscure -)
	export RCLONE_CRYPT_PASSWORD
	latest=$(newest_on_remote :crypt:)
	if [ -z "$latest" ]; then
		echo "no copy on $under yet: run ./backup-offsite.sh once first" >&2
		exit 1
	fi
	header=$(rclone cat ":crypt:$latest" 2>/dev/null | gzip -dc 2>/dev/null | head -c 15 || true)
	if [ "$header" != "SQLite format 3" ]; then
		echo "$latest could not be read with that password: it is not the one in rclone's config" >&2
		exit 1
	fi
	rclone cat ":crypt:$latest" | gzip -t
	echo "ok: $latest decrypts with that password and is a whole database"
	exit 0
fi

docker compose exec -T server /app/backup.sh

if ! configured; then
	echo "off-site copy: not configured, the backup stays on this host only (docs/DEPLOY-PRODUZIONE.md, 6.1)"
	exit 0
fi

latest=$(docker compose exec -T server sh -c 'ls -1t /var/lib/sigillo-backups/sigillo-*.db | head -n 1')
if [ -z "$latest" ]; then
	echo "off-site copy: no backup found in the server container" >&2
	exit 1
fi
name="$(basename "$latest").gz"

# Streamed, so the copy never needs a second time its size on this disk. A
# stream cut short still leaves a file behind: remove it, so the newest copy
# on the remote is always a whole one.
if ! docker compose exec -T server cat "$latest" | gzip -c | rclone rcat "$REMOTE$name"; then
	rclone deletefile "$REMOTE$name" 2>/dev/null || true
	echo "off-site copy: upload of $name to $REMOTE failed" >&2
	exit 1
fi
echo "off-site copy: uploaded $name to $REMOTE"

# Newest first: the first copy of each day is kept, for the newest $KEEP_DAYS
# days that have one; every other copy goes.
rclone lsf --files-only --include 'sigillo-*.db.gz' "$REMOTE" | sort -r |
	awk -v keep="$KEEP_DAYS" '{ day = substr($0, 9, 8); if (day != last) { last = day; days++; if (days <= keep) next } print }' |
	while read -r old; do
		echo "off-site copy: removing $old"
		rclone deletefile "$REMOTE$old"
	done

echo "off-site copies in $REMOTE: $(rclone lsf --files-only --include 'sigillo-*.db.gz' "$REMOTE" | wc -l)"
