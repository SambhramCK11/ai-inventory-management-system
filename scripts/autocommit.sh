#!/usr/bin/env bash
# autocommit.sh — commit and push automatically as you edit.
#
# Watches the working tree and, once at least THRESHOLD lines have changed,
# stages everything, commits with a generated message and pushes to the
# current branch. Keeps GitHub in step with your editor without you having to
# remember to commit.
#
#   ./scripts/autocommit.sh                 # 3 changed lines, poll every 15s
#   THRESHOLD=10 INTERVAL=60 ./scripts/autocommit.sh
#   ./scripts/autocommit.sh --once          # single pass, no loop (use in a hook)
#   NO_PUSH=1 ./scripts/autocommit.sh       # commit locally, never push
#
# Stop it with Ctrl-C. Commits are ordinary commits — squash or reword them
# later with `git rebase -i` if you want a tidier history before a PR.

set -euo pipefail

THRESHOLD="${THRESHOLD:-3}"     # changed lines needed to trigger a commit
INTERVAL="${INTERVAL:-15}"      # seconds between checks
NO_PUSH="${NO_PUSH:-}"          # set to any value to skip pushing
ONCE=""
[ "${1:-}" = "--once" ] && ONCE=1

cd "$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$BRANCH" = "HEAD" ]; then
  echo "autocommit: detached HEAD — checkout a branch first." >&2
  exit 1
fi

changed_lines() {
  # Tracked edits plus every line of each untracked file.
  local tracked untracked=0
  tracked="$(git diff HEAD --numstat -- . \
    | awk '{ a += ($1 == "-" ? 0 : $1); d += ($2 == "-" ? 0 : $2) } END { print a + d + 0 }')"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    untracked=$(( untracked + $(wc -l < "$f" 2>/dev/null || echo 1) ))
  done < <(git ls-files --others --exclude-standard)
  echo $(( tracked + untracked ))
}

commit_message() {
  local files count summary
  count="$(git diff --cached --name-only | wc -l | tr -d ' ')"
  summary="$(git diff --cached --name-only | head -3 | xargs -r -n1 basename | paste -sd ', ' -)"
  if [ "$count" -gt 3 ]; then
    echo "Update $summary and $(( count - 3 )) more"
  else
    echo "Update ${summary:-working tree}"
  fi
}

push_with_retry() {
  local i
  for i in 1 2 3 4; do
    if git push -u origin "$BRANCH"; then
      return 0
    fi
    echo "autocommit: push failed, retrying in $(( 2 ** i ))s..." >&2
    sleep $(( 2 ** i ))
  done
  echo "autocommit: push failed after 4 attempts — commits are safe locally." >&2
  return 1
}

sync_once() {
  local n
  n="$(changed_lines)"
  if [ "$n" -lt "$THRESHOLD" ]; then
    return 1
  fi
  git add -A
  # Nothing actually staged (e.g. only ignored files moved) — bail out quietly.
  if git diff --cached --quiet; then
    return 1
  fi
  git commit -q -m "$(commit_message)"
  echo "autocommit: committed ${n} changed line(s) — $(git log --oneline -1)"
  [ -n "$NO_PUSH" ] || push_with_retry
  return 0
}

if [ -n "$ONCE" ]; then
  sync_once || echo "autocommit: fewer than ${THRESHOLD} changed lines, nothing to do."
  exit 0
fi

echo "autocommit: watching $(pwd) on '$BRANCH' — commit every ${THRESHOLD}+ changed lines, checking every ${INTERVAL}s. Ctrl-C to stop."
while true; do
  sync_once || true
  sleep "$INTERVAL"
done
