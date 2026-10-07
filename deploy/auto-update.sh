#!/bin/sh
# Keeps a running deployment up to date on its own: every three hours, if the
# repository's main branch has a commit the server does not have yet, it runs
# update.sh. Nothing else changes: with nothing new, it does nothing (no
# restart, no downtime).
#
# Set it up once, on the server, after the first manual update.sh:
#
#   $ /root/sigillo/deploy/auto-update.sh install
#
# That adds one line to the host's crontab (and replaces it if it is already
# there, so it can be run again). To stop the automatic updates:
#
#   $ /root/sigillo/deploy/auto-update.sh uninstall
#
# What it runs is whatever is on main: a change merged there reaches this
# server within three hours. The output of each run that did something is
# appended to auto-update.log, beside this script's folder, with the date.
#
# A run that fails (update.sh exits non-zero) is logged and not retried until
# the next time: a half-updated server is for a person to look at, and
# update.sh already says what to do.
set -eu

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
LOG="${SIGILLO_AUTO_UPDATE_LOG:-$DEPLOY/../auto-update.log}"
MARK="# sigillo-auto-update"
SCHEDULE="${SIGILLO_AUTO_UPDATE_SCHEDULE:-0 */3 * * *}"

install_cron() {
  line="$SCHEDULE $DEPLOY/auto-update.sh run $MARK"
  { crontab -l 2>/dev/null | grep -v -F "$MARK" || true; echo "$line"; } | crontab -
  echo "auto-update.sh: installed in crontab: $line"
}

uninstall_cron() {
  { crontab -l 2>/dev/null | grep -v -F "$MARK" || true; } | crontab -
  echo "auto-update.sh: removed from crontab"
}

run() {
  # One at a time: a slow update must not meet the next one.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$DEPLOY/.auto-update.lock"
    flock -n 9 || exit 0
  fi
  cd "$DEPLOY"
  branch=$(git -C .. rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "main" ]; then
    echo "$(date -u +%FT%TZ) skipped: the clone is on '$branch', not main" >> "$LOG"
    exit 0
  fi
  git -C .. fetch --quiet origin main
  if [ "$(git -C .. rev-parse HEAD)" = "$(git -C .. rev-parse FETCH_HEAD)" ]; then
    exit 0
  fi
  {
    echo "=== $(date -u +%FT%TZ) updating to $(git -C .. rev-parse --short FETCH_HEAD)"
    if ./update.sh; then
      echo "=== done"
    else
      echo "=== update.sh FAILED (exit $?): look at it by hand"
    fi
  } >> "$LOG" 2>&1
}

# Everything above is read before anything runs: update.sh's `git pull` may
# replace this very file while it is executing.
case "${1:-}" in
  install) install_cron ;;
  uninstall) uninstall_cron ;;
  run) run ;;
  *) echo "usage: auto-update.sh install | uninstall | run" >&2; exit 2 ;;
esac
exit 0
