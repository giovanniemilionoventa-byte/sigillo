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
# Whether the copy is made, and how often (every 1, 6, 12 or 24 hours), is
# chosen in the web view's Impostazioni, which writes offsite-settings.json in
# the backups volume. The script reads it on every run, and writes back
# offsite-status.json, which Impostazioni shows: when it last ran, whether
# Drive is connected, and when the last copy succeeded or failed.
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

DIR=/var/lib/sigillo-backups
in_server() {
	docker compose exec -T server "$@"
}

in_server /app/backup.sh

# What Impostazioni chose (backup/offsite.ts writes it), and what the last run
# reported. Missing, they read as the defaults: on, every hour, never copied.
field() {
	printf '%s' "$1" | sed -n "s/.*\"$2\":\([a-z0-9]*\).*/\1/p"
}
settings=$(in_server cat "$DIR/offsite-settings.json" 2>/dev/null || true)
status=$(in_server cat "$DIR/offsite-status.json" 2>/dev/null || true)
enabled=$(field "$settings" enabled)
every=$(field "$settings" every_hours)
case "$every" in
1 | 6 | 12 | 24) ;;
*) every=1 ;;
esac
last_success=$(field "$status" last_success)
last_failure=$(field "$status" last_failure)
case "$last_success" in *[!0-9]*) last_success= ;; esac
case "$last_failure" in *[!0-9]*) last_failure= ;; esac
now=$(date +%s)
drive=false
if configured; then drive=true; fi

# Every run says so, copy or not: Impostazioni turns red when the runs stop.
report() {
	printf '{"checked":%s,"drive":%s,"last_success":%s,"last_failure":%s}\n' \
		"$now" "$drive" "${last_success:-null}" "${last_failure:-null}" |
		in_server sh -c "cat > $DIR/offsite-status.json.tmp && mv $DIR/offsite-status.json.tmp $DIR/offsite-status.json" ||
		echo "off-site copy: could not write the status for Impostazioni" >&2
}

if [ "$enabled" = "false" ]; then
	echo "off-site copy: turned off in Impostazioni, the backup stays on this host only"
	report
	exit 0
fi
if [ "$drive" = false ]; then
	echo "off-site copy: not configured, the backup stays on this host only (docs/DEPLOY-PRODUZIONE.md, 6.1)"
	report
	exit 0
fi
# Ten minutes early counts as on time: cron's hour is not to the second.
if [ -n "$last_success" ] && [ $((now - last_success)) -lt $((every * 3600 - 600)) ]; then
	echo "off-site copy: the last one is less than $every h old"
	report
	exit 0
fi

latest=$(in_server sh -c "ls -1t $DIR/sigillo-*.db | head -n 1")
if [ -z "$latest" ]; then
	echo "off-site copy: no backup found in the server container" >&2
	last_failure=$now
	report
	exit 1
fi
name="$(basename "$latest").gz"

# Streamed, so the copy never needs a second time its size on this disk. A
# stream cut short still leaves a file behind: remove it, so the newest copy
# on the remote is always a whole one.
if ! in_server cat "$latest" | gzip -c | rclone rcat "$REMOTE$name"; then
	rclone deletefile "$REMOTE$name" 2>/dev/null || true
	echo "off-site copy: upload of $name to $REMOTE failed" >&2
	last_failure=$now
	report
	exit 1
fi
echo "off-site copy: uploaded $name to $REMOTE"
last_success=$now
report

# Newest first: the first copy of each day is kept, for the newest $KEEP_DAYS
# days that have one; every other copy goes.
rclone lsf --files-only --include 'sigillo-*.db.gz' "$REMOTE" | sort -r |
	awk -v keep="$KEEP_DAYS" '{ day = substr($0, 9, 8); if (day != last) { last = day; days++; if (days <= keep) next } print }' |
	while read -r old; do
		echo "off-site copy: removing $old"
		rclone deletefile "$REMOTE$old"
	done

echo "off-site copies in $REMOTE: $(rclone lsf --files-only --include 'sigillo-*.db.gz' "$REMOTE" | wc -l)"
