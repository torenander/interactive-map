#!/usr/bin/env bash
# Mutual exclusion for anything that contends for this machine: Playwright runs,
# `vite preview`, `npm run build`, or any script that drives a browser. One holder
# at a time.
#
# Usage:
#   scripts/e2e-lock.sh acquire [owner] [timeout-seconds]   # exits non-zero if not acquired
#   scripts/e2e-lock.sh release [owner]                     # only releases a lock you own
#   scripts/e2e-lock.sh status
#
# In a script:
#   scripts/e2e-lock.sh acquire "$OWNER" || exit 1
#   trap 'scripts/e2e-lock.sh release "$OWNER"' EXIT
#
# Why this file exists rather than three lines inlined per script. The inlined
# version used across this project was:
#
#   for i in $(seq 1 360); do mkdir "$LOCK" 2>/dev/null && break; sleep 5; done
#   [ -d "$LOCK" ] || exit 1
#   trap 'rmdir "$LOCK"' EXIT
#
# and it was wrong in two ways that cancel each other out just often enough to
# look like it worked. `[ -d "$LOCK" ]` is TRUE exactly when somebody ELSE holds
# the lock, so an exhausted acquisition loop fell straight through the guard and
# ran unlocked; and the EXIT trap then released a lock it never owned, letting a
# third run start. Two agents could each believe they held it. `mkdir` is atomic
# and was never the problem — discarding its result was.
#
# So: acquisition is whether OUR mkdir returned 0, never whether the directory
# exists, and release is refused unless the owner file says it is ours.

set -uo pipefail

# The process that HOLDS the lock is the caller — the script that invoked this
# helper — not this helper invocation, which exits immediately. Recording $$ here
# made every lock look stale the moment it was taken: the first self-test had a
# live lock reported dead by the very next command. Default to the parent, and
# let a caller name a PID explicitly when it forks.
HOLDER_PID="${E2E_LOCK_PID:-$PPID}"

LOCK_DIR="${E2E_LOCK_DIR:-/private/tmp/claude-501/-Users-tor-interactive-map/7c0e50f5-ee63-4693-9af7-48f940a0ba68/scratchpad/e2e-lock}"
OWNER_FILE="$LOCK_DIR/owner"
POLL_SECONDS=5

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

read_owner() { [ -f "$OWNER_FILE" ] && cat "$OWNER_FILE" 2>/dev/null; }
owner_pid()  { read_owner | sed -n 's/^pid=\([0-9]*\).*/\1/p'; }
owner_name() { read_owner | sed -n 's/.*owner=\(.*\)$/\1/p'; }

# A holder that died without running its EXIT trap — killed, crashed, machine
# rebooted — leaves the lock held forever, and every waiter then burns its full
# timeout and gives up. That is indistinguishable from "somebody is legitimately
# busy", which makes a correct lock more brittle than the broken one it replaces:
# the broken one at least always cleared. The owner file carries the PID so a
# waiter can tell the difference and say so out loud.
holder_is_alive() {
  local pid; pid=$(owner_pid)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

cmd_acquire() {
  local owner="${1:-$$}" timeout="${2:-1800}" waited=0
  while :; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf 'pid=%s\nstarted=%s\nowner=%s\n' "$HOLDER_PID" "$(now)" "$owner" > "$OWNER_FILE"
      echo "lock acquired by $owner (pid $HOLDER_PID) at $(now)"
      return 0
    fi
    # Held by someone. Report whether that someone still exists — a stale lock is
    # a human decision, not something to clear automatically: "the PID is gone"
    # and "the process forked and the PID moved" look identical from here.
    if [ -d "$LOCK_DIR" ] && ! holder_is_alive; then
      echo "STALE LOCK: held by $(owner_name) (pid $(owner_pid)), which is not running." >&2
      echo "  Verify nothing is mid-run, then: rm -rf '$LOCK_DIR'" >&2
      return 2
    fi
    if [ "$waited" -ge "$timeout" ]; then
      echo "COULD NOT ACQUIRE after ${timeout}s; held by $(owner_name) (pid $(owner_pid))." >&2
      return 1
    fi
    sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
  done
}

cmd_release() {
  local owner="${1:-$$}"
  [ -d "$LOCK_DIR" ] || { echo "no lock to release"; return 0; }
  local held_pid held_name; held_pid=$(owner_pid); held_name=$(owner_name)
  # Release only what we own, and judge ownership by NAME first. An earlier
  # version required both the PID and the name to mismatch before refusing, so
  # two scripts sharing a parent shell could release each other's lock — the
  # PIDs matched, and the name check never got a say. Names are the identity
  # that actually distinguishes two agents on one machine; the PID is the
  # fallback for callers that pass no name.
  if [ -n "$held_name" ]; then
    if [ "$held_name" != "$owner" ]; then
      echo "REFUSING to release: lock belongs to $held_name (pid $held_pid), not $owner." >&2
      return 1
    fi
  elif [ -n "$held_pid" ] && [ "$held_pid" != "$HOLDER_PID" ]; then
    echo "REFUSING to release: lock belongs to pid $held_pid, not $HOLDER_PID." >&2
    return 1
  fi
  rm -rf "$LOCK_DIR"
  echo "lock released by $owner"
}

cmd_status() {
  if [ -d "$LOCK_DIR" ]; then
    echo "HELD"; read_owner
    holder_is_alive && echo "holder alive" || echo "holder NOT running — stale"
  else
    echo "FREE"
  fi
}

case "${1:-}" in
  acquire) shift; cmd_acquire "$@" ;;
  release) shift; cmd_release "$@" ;;
  status)  cmd_status ;;
  *) echo "usage: $0 {acquire [owner] [timeout] | release [owner] | status}" >&2; exit 64 ;;
esac
