#!/bin/sh
# Keeps a running deployment up to date on its own: every minute, if the
# repository's main branch has a commit the server does not have yet, it runs
# update.sh. Nothing else changes: with nothing new, the check is one
# `git fetch` and a comparison (no build, no restart, no downtime, no log).
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
# server within a minute or so (plus the time update.sh takes to build). A
# different schedule can be set at install time with
# SIGILLO_AUTO_UPDATE_SCHEDULE (a crontab schedule, e.g. "0 */3 * * *"). The output of each run that did something is
# appended to auto-update.log, beside this script's folder, with the date.
#
# A run that fails (update.sh exits non-zero) is logged once, and that commit
# is not tried again: a half-updated server is for a person to look at, and
# update.sh already says what to do. The next commit on main is tried as
# usual; to retry the same one, delete deploy/.auto-update.failed. A run that
# finds the previous one still going does nothing (a lock), so a slow build
# never meets the next minute's check.
set -eu

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
LOG="${SIGILLO_AUTO_UPDATE_LOG:-$DEPLOY/../auto-update.log}"
MARK="# sigillo-auto-update"
SCHEDULE="${SIGILLO_AUTO_UPDATE_SCHEDULE:-* * * * *}"
FAILED="$DEPLOY/.auto-update.failed"

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
  target=$(git -C .. rev-parse FETCH_HEAD)
  if [ "$(git -C .. rev-parse HEAD)" = "$target" ]; then
    exit 0
  fi
  if [ "$(cat "$FAILED" 2>/dev/null || true)" = "$target" ]; then
    exit 0
  fi
  {
    echo "=== $(date -u +%FT%TZ) updating to $(git -C .. rev-parse --short "$target")"
    if ./update.sh; then
      rm -f "$FAILED"
      echo "=== done"
    else
      status=$?
      echo "$target" > "$FAILED"
      echo "=== update.sh FAILED (exit $status): look at it by hand; not retried until main moves"
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
