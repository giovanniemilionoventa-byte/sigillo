#!/bin/sh
# Sends the newest database backup to a place that is not this server,
# encrypted so that this server can write the copy but never read it back.
#
# Run it on the HOST (not in the container), once a day, from cron
# (docs/DEPLOY-PRODUZIONE.md, 6.1):
#
#   30 3 * * * /srv/sigillo/deploy/offsite-backup.sh >> /srv/sigillo-offsite.log 2>&1
#
# How it is kept safe:
#   - The copy is encrypted with `age` to a PUBLIC key. The matching private
#     key lives only with the owner (password manager); a person who breaks
#     into this server, or into the storage, finds files they cannot open.
#   - Nothing secret is stored here. The storage login lives in rclone's own
#     config on the host, outside the repository.
#   - It uploads the newest copy that backup.sh made; it does not make one
#     itself, so the hourly cron stays the only thing that touches the live
#     database.
#   - Old copies are pruned by count, never by age, so a job that stops
#     running does not slowly delete the last good copy.
#   - It fails loudly (non-zero exit, message on stderr) if the newest
#     copy is older than SIGILLO_OFFSITE_MAX_AGE_HOURS: that is the symptom
#     of the hourly backup having stopped.
#   - The signer's key is NOT part of this copy, by design: the key and the
#     database never travel together (DEPLOY.md, 1.2 for its own encrypted copy).
#
# Settings are read from /etc/sigillo-offsite.env (a shell file), or from the
# file named by SIGILLO_OFFSITE_ENV:
#   SIGILLO_OFFSITE_RECIPIENT   the age public key, "age1..." (required)
#   SIGILLO_OFFSITE_REMOTE      an rclone destination, "name:bucket/folder" (required)
#   SIGILLO_OFFSITE_KEEP        copies to keep there (default: 30)
#   SIGILLO_OFFSITE_MAX_AGE_HOURS  newest local copy may be this old (default: 6)
#   SIGILLO_OFFSITE_SOURCE      a backup file to send instead of fetching the
#                               newest from the server container (used by the tests)

set -eu

ENV_FILE="${SIGILLO_OFFSITE_ENV:-/etc/sigillo-offsite.env}"
if [ -f "$ENV_FILE" ]; then
	# shellcheck disable=SC1090
	. "$ENV_FILE"
fi

RECIPIENT="${SIGILLO_OFFSITE_RECIPIENT:-}"
REMOTE="${SIGILLO_OFFSITE_REMOTE:-}"
KEEP="${SIGILLO_OFFSITE_KEEP:-30}"
MAX_AGE_HOURS="${SIGILLO_OFFSITE_MAX_AGE_HOURS:-6}"

fail() { echo "offsite-backup: $*" >&2; exit 1; }

[ -n "$RECIPIENT" ] || fail "SIGILLO_OFFSITE_RECIPIENT is not set (the age public key, age1...) in $ENV_FILE"
[ -n "$REMOTE" ] || fail "SIGILLO_OFFSITE_REMOTE is not set (rclone destination, name:bucket/folder) in $ENV_FILE"
case "$RECIPIENT" in age1*) ;; *) fail "SIGILLO_OFFSITE_RECIPIENT must be a PUBLIC key starting with age1 (never the private AGE-SECRET-KEY)" ;; esac
case "$KEEP" in ''|*[!0-9]*|0) fail "SIGILLO_OFFSITE_KEEP must be a positive number" ;; esac
command -v age >/dev/null 2>&1 || fail "age is not installed (apt install age)"
command -v rclone >/dev/null 2>&1 || fail "rclone is not installed (apt install rclone)"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
chmod 700 "$WORK"

if [ -n "${SIGILLO_OFFSITE_SOURCE:-}" ]; then
	SRC="$SIGILLO_OFFSITE_SOURCE"
	[ -f "$SRC" ] || fail "no such file: $SRC"
else
	cd "$(dirname "$0")"
	NEWEST=$(docker compose exec -T server sh -c 'ls -1t /var/lib/sigillo-backups/sigillo-*.db 2>/dev/null | head -n 1' | tr -d '\r')
	[ -n "$NEWEST" ] || fail "no backup found on the server; is backup.sh running?"
	# docker cp writes a tar stream; unpack it into the private work folder.
	docker cp "$(docker compose ps -q server):$NEWEST" - | tar -x -C "$WORK"
	SRC="$WORK/$(basename "$NEWEST")"
fi

# The stamp is in the name (sigillo-YYYYMMDDThhmmssZ.db); the age of the file
# is what tells us the hourly backup is still alive.
if [ -n "$(find "$SRC" -mmin +$((MAX_AGE_HOURS * 60)) 2>/dev/null)" ]; then
	fail "the newest backup ($(basename "$SRC")) is older than ${MAX_AGE_HOURS} hours: the hourly backup.sh has stopped"
fi

NAME="$(basename "$SRC").age"
age -r "$RECIPIENT" -o "$WORK/$NAME" "$SRC"

# copyto checks size and hash after uploading and fails if they differ.
rclone copyto "$WORK/$NAME" "$REMOTE/$NAME"
echo "uploaded $NAME ($(wc -c < "$WORK/$NAME") bytes) to $REMOTE"

# Keep the newest $KEEP, by name (the stamp sorts oldest to newest).
rclone lsf "$REMOTE" --files-only 2>/dev/null | grep '^sigillo-.*\.db\.age$' | sort -r | tail -n +$((KEEP + 1)) |
while read -r old; do
	echo "removing $old"
	rclone deletefile "$REMOTE/$old"
done
echo "copies at $REMOTE: $(rclone lsf "$REMOTE" --files-only | grep -c '^sigillo-.*\.db\.age$')"
