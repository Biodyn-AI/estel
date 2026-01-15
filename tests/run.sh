#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(mktemp -d /tmp/autoagents-test-XXXXXX)"
BIN_DIR="$ROOT/tests/bin"
AGENTD_CMD="$ROOT/scripts/agentd.sh"
AGENTCTL_CMD="$ROOT/scripts/agentctl.sh"

export WORKSPACE
export CODEX_BIN="$BIN_DIR/codex"
export CODEX_FLAGS=""
export CODEX_EXEC_FLAGS=""
export CODEX_EXEC_MODE="stdin"
export AGENT_WORKERS=1
export POLL_SECONDS=1
export LOG_FILE="$WORKSPACE/logs/agentd.log"

mkdir -p "$WORKSPACE/logs"

"$AGENTD_CMD" > "$WORKSPACE/agentd.out" 2>&1 &
AGENTD_PID=$!

cleanup() {
  kill "$AGENTD_PID" 2>/dev/null || true
  wait "$AGENTD_PID" 2>/dev/null || true
  rm -rf "$WORKSPACE"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [ "$expected" != "$actual" ]; then
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -q "$needle" "$file"; then
    echo "---- $file ----" >&2
    cat "$file" >&2 || true
    fail "Expected '$needle' in $file"
  fi
}

wait_for_file() {
  local file="$1"
  local timeout="${2:-10}"
  local start
  start="$(date +%s)"
  while [ ! -f "$file" ]; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      fail "Timed out waiting for $file"
    fi
    sleep 0.2
  done
}

wait_for_grep() {
  local pattern="$1"
  local dir="$2"
  local timeout="${3:-10}"
  local start
  start="$(date +%s)"
  while ! grep -R "$pattern" "$dir" >/dev/null 2>&1; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      fail "Timed out waiting for pattern '$pattern' in $dir"
    fi
    sleep 0.2
  done
}

session_key() {
  local session="$1"
  if [ -z "$session" ]; then
    echo "default"
  else
    printf '%s' "$session" | tr -c 'A-Za-z0-9._-' '_'
  fi
}

chain_id_for_alias() {
  local session="$1"
  local alias="$2"
  local key
  key="$(session_key "$session")"
  local file="$WORKSPACE/queue/chains/aliases.${key}.tsv"
  awk -v a="$alias" '$1==a {print $2; exit}' "$file" 2>/dev/null
}

echo "Running tests in $WORKSPACE"

# Test 1: manual task + session history
session="s-manual"
id="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" submit --session "$session" "hello")"
wait_for_file "$WORKSPACE/queue/outbox/$id.md"
assert_file_contains "$WORKSPACE/queue/outbox/$id.md" "MANUAL_REPLY"
assert_file_contains "$WORKSPACE/queue/sessions/$session.md" "MANUAL_REPLY"

echo "ok: manual task and session history"

# Test 2: REPL history injected into autonomous prompt
session="s-history"
id="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" submit --session "$session" "HISTORY_MARKER")"
wait_for_file "$WORKSPACE/queue/outbox/$id.md"
alias="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" start-autonomous --session "$session" "history test")"
chain_id="$(chain_id_for_alias "$session" "$alias")"
if [ -z "$chain_id" ]; then
  fail "missing chain id for alias $alias"
fi
wait_for_file "$WORKSPACE/queue/runs/$chain_id/prompt.txt"
assert_file_contains "$WORKSPACE/queue/runs/$chain_id/prompt.txt" "HISTORY_MARKER"

echo "ok: history injected into autonomous prompt"

# Test 3: alias resets per session
session_a="s-alias-a"
session_b="s-alias-b"
a1="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" start-autonomous --session "$session_a" "goal a1")"
a2="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" start-autonomous --session "$session_a" "goal a2")"
b1="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" start-autonomous --session "$session_b" "goal b1")"
assert_eq "1" "$a1" "alias a1"
assert_eq "2" "$a2" "alias a2"
assert_eq "1" "$b1" "alias b1"

echo "ok: aliases reset per session"

# Test 4: chain-stop purges queued tasks
session="s-stop"
touch "$WORKSPACE/queue/STOP"
alias="$(WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" start-autonomous --session "$session" "stop test")"
chain_id="$(chain_id_for_alias "$session" "$alias")"
if [ -z "$chain_id" ]; then
  fail "missing chain id for stop test"
fi
jq -n \
  --arg id "dummy-1" \
  --arg mode "autonomous" \
  --arg chain "$chain_id" \
  --arg goal "stop test" \
  --arg task "dummy" \
  --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{id:$id,mode:$mode,chain:$chain,goal:$goal,task:$task,created:$created}' \
  > "$WORKSPACE/queue/inbox/dummy-1.json"
AGENT_SESSION="$session" WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" chain-stop "$alias" >/dev/null
if [ -f "$WORKSPACE/queue/inbox/dummy-1.json" ]; then
  fail "dummy task not purged"
fi
rm -f "$WORKSPACE/queue/STOP"

echo "ok: chain-stop purges queued tasks"

# Test 5: fallback next-task generation
session="s-fallback"
WORKSPACE="$WORKSPACE" "$AGENTCTL_CMD" start-autonomous --session "$session" "MISSING_NEXT" >/dev/null
wait_for_grep "FALLBACK_TASK" "$WORKSPACE/queue/runs"

echo "ok: fallback next-task generation"

echo "All tests passed."
