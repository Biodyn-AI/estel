#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
QUEUE_DIR="${QUEUE_DIR:-$WORKSPACE/queue}"
INBOX_DIR="${QUEUE_DIR}/inbox"
WORKING_DIR="${QUEUE_DIR}/working"
OUTBOX_DIR="${QUEUE_DIR}/outbox"
FAILED_DIR="${QUEUE_DIR}/failed"
RUNS_DIR="${QUEUE_DIR}/runs"
SESSIONS_DIR="${QUEUE_DIR}/sessions"
CHAINS_DIR="${QUEUE_DIR}/chains"
STOP_FILE="${QUEUE_DIR}/STOP"
AUTONOMOUS_CONTEXT_LIMIT="${AUTONOMOUS_CONTEXT_LIMIT:-4000}"

ensure_dirs() {
  mkdir -p "$INBOX_DIR" "$WORKING_DIR" "$OUTBOX_DIR" "$FAILED_DIR" "$RUNS_DIR" "$SESSIONS_DIR" "$CHAINS_DIR"
}

new_id() {
  printf '%s-%s-%s\n' "$(date +%Y%m%d-%H%M%S)" "$$" "$RANDOM"
}

now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

trim_context() {
  local text="$1"
  local limit="$2"
  if [ -z "$text" ]; then
    return 0
  fi
  printf '%s' "$text" | tail -c "$limit"
}

usage() {
  cat <<'EOF'
Usage:
  agentctl submit "prompt"
  agentctl submit --file prompt.txt
  agentctl submit --session <id> "prompt"
  agentctl submit --verbose "prompt"
  agentctl start-autonomous "goal"
  agentctl start-autonomous --file goal.txt [--task "first task"] [--session <id>] [--verbose]
  agentctl follow <chain-id>
  agentctl follow-all
  agentctl chain-note <chain-id> "note"
  agentctl chain-append <chain-id> "note"
  agentctl chain-clear <chain-id>
  agentctl chain-stop <chain-id>
  agentctl chain-stop-all
  agentctl chain-stop-current
  agentctl chain-resume <chain-id>
  agentctl chain-resume-all
  agentctl list
  agentctl stats [--json] [--session <id>] [--active-only]
  agentctl status <id>
  agentctl wait [--no-stream] <id>
  agentctl output <id>
  agentctl reset-session <id>
  agentctl stop
  agentctl start
EOF
}

chain_note_file() {
  local chain_id="$1"
  echo "${CHAINS_DIR}/${chain_id}.note"
}

chain_stop_file() {
  local chain_id="$1"
  echo "${CHAINS_DIR}/${chain_id}.stop"
}

note_requests_stop() {
  local note="$1"
  if [ -z "$note" ]; then
    return 1
  fi
  printf '%s' "$note" | tr '[:upper:]' '[:lower:]' \
    | grep -Eq '(^|[^[:alnum:]_])stop([^[:alnum:]_]|$)'
}

status_file_for_task() {
  local id="$1"
  echo "${RUNS_DIR}/${id}/status.txt"
}

status_line_for_task() {
  local id="$1"
  local file
  file="$(status_file_for_task "$id")"
  if [ -f "$file" ]; then
    tail -n 1 "$file" 2>/dev/null | tr -d '\r'
  fi
}

last_output_chain_file() {
  echo "${CHAINS_DIR}/last_output"
}

session_key() {
  local session="$1"
  if [ -z "$session" ]; then
    echo "default"
    return 0
  fi
  printf '%s' "$session" | tr -c 'A-Za-z0-9._-' '_'
}

aliases_file() {
  local key
  key="$(session_key "${1:-}")"
  echo "${CHAINS_DIR}/aliases.${key}.tsv"
}

aliases_next_file() {
  local key
  key="$(session_key "${1:-}")"
  echo "${CHAINS_DIR}/aliases.${key}.next"
}

alias_lock_dir() {
  local key
  key="$(session_key "${1:-}")"
  echo "${CHAINS_DIR}/.alias.${key}.lock"
}

acquire_alias_lock() {
  local lock
  lock="$(alias_lock_dir "${1:-}")"
  local tries=0
  while ! mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 50 ]; then
      echo "unable to acquire alias lock" >&2
      return 1
    fi
    sleep 0.1
  done
}

release_alias_lock() {
  local lock
  lock="$(alias_lock_dir "${1:-}")"
  rmdir "$lock" 2>/dev/null || true
}

alias_for_chain() {
  local session="$1"
  local chain_id="$2"
  if [ -z "$chain_id" ]; then
    return 0
  fi
  awk -v id="$chain_id" '$2==id {print $1; exit}' "$(aliases_file "$session")" 2>/dev/null
}

chain_for_alias() {
  local session="$1"
  local alias="$2"
  awk -v a="$alias" '$1==a {print $2; exit}' "$(aliases_file "$session")" 2>/dev/null
}

ensure_alias() {
  local session="$1"
  local chain_id="$2"
  local alias
  alias="$(alias_for_chain "$session" "$chain_id")"
  if [ -n "$alias" ]; then
    echo "$alias"
    return 0
  fi

  if ! acquire_alias_lock "$session"; then
    return 1
  fi

  alias="$(alias_for_chain "$session" "$chain_id")"
  if [ -n "$alias" ]; then
    release_alias_lock "$session"
    echo "$alias"
    return 0
  fi

  local next=1
  local next_file
  next_file="$(aliases_next_file "$session")"
  if [ -f "$next_file" ]; then
    next="$(cat "$next_file" 2>/dev/null || echo 1)"
  fi
  if ! [[ "$next" =~ ^[0-9]+$ ]]; then
    next=1
  fi

  local max=0
  local file
  file="$(aliases_file "$session")"
  if [ -f "$file" ]; then
    max="$(awk '($1+0)>m {m=$1} END{print m+0}' "$file")"
  fi
  if [ "$max" -ge "$next" ]; then
    next=$((max + 1))
  fi

  printf '%s\t%s\n' "$next" "$chain_id" >> "$file"
  echo $((next + 1)) > "$next_file"
  release_alias_lock "$session"
  echo "$next"
}

resolve_chain_id() {
  local session="$1"
  local input="$2"
  if [ -z "$input" ]; then
    echo ""
    return 0
  fi
  if printf '%s' "$input" | grep -q '^manual:'; then
    input="${input#manual:}"
  fi
  if printf '%s' "$input" | grep -Eq '^[0-9]+$'; then
    local chain
    chain="$(chain_for_alias "$session" "$input")"
    if [ -z "$chain" ]; then
      echo "unknown chain alias: $input" >&2
      exit 1
    fi
    echo "$chain"
    return 0
  fi
  local task_json
  task_json="${RUNS_DIR}/${input}/task.json"
  if [ -f "$task_json" ]; then
    local chain
    chain="$(jq -r '.chain // empty' "$task_json" 2>/dev/null || true)"
    if [ -n "$chain" ]; then
      echo "$chain"
      return 0
    fi
  fi
  echo "$input"
}

label_for_chain() {
  local session="$1"
  local chain_id="$2"
  if [ -z "$chain_id" ] || [ "$chain_id" = "null" ]; then
    echo "manual"
    return 0
  fi
  local alias
  alias="$(alias_for_chain "$session" "$chain_id")"
  if [ -z "$alias" ]; then
    alias="$(ensure_alias "$session" "$chain_id" 2>/dev/null || true)"
  fi
  if [ -n "$alias" ]; then
    echo "$alias"
  else
    echo "$chain_id"
  fi
}

active_chains() {
  shopt -s nullglob
  local f
  for f in "$INBOX_DIR"/*.json "$WORKING_DIR"/*.json; do
    jq -r '.chain // empty' "$f" 2>/dev/null || true
  done | awk 'NF' | sort -u
}

session_for_chain() {
  local chain_id="$1"
  if [ -z "$chain_id" ]; then
    echo ""
    return 0
  fi
  local direct="${RUNS_DIR}/${chain_id}/task.json"
  if [ -f "$direct" ]; then
    jq -r '.session // empty' "$direct" 2>/dev/null || true
    return 0
  fi
  shopt -s nullglob
  local f
  for f in "$INBOX_DIR"/*.json "$WORKING_DIR"/*.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      jq -r '.session // empty' "$f" 2>/dev/null || true
      return 0
    fi
  done
  for f in "$RUNS_DIR"/*/task.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      jq -r '.session // empty' "$f" 2>/dev/null || true
      return 0
    fi
  done
  echo ""
}

purge_inbox_for_chain() {
  local chain_id="$1"
  local removed=0
  if [ -z "$chain_id" ]; then
    echo 0
    return 0
  fi
  shopt -s nullglob
  local f
  for f in "$INBOX_DIR"/*.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      rm -f "$f"
      removed=$((removed + 1))
    fi
  done
  echo "$removed"
}

chain_is_active() {
  local chain_id="$1"
  if [ -z "$chain_id" ]; then
    return 1
  fi
  shopt -s nullglob
  local f
  for f in "$INBOX_DIR"/*.json "$WORKING_DIR"/*.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      return 0
    fi
  done
  return 1
}

run_id_active() {
  local run_id="$1"
  if [ -z "$run_id" ]; then
    return 1
  fi
  if [ -f "$INBOX_DIR/$run_id.json" ] || [ -f "$WORKING_DIR/$run_id.json" ]; then
    return 0
  fi
  return 1
}

manual_chain_active() {
  local session="$1"
  shopt -s nullglob
  local f
  for f in "$INBOX_DIR"/*.json "$WORKING_DIR"/*.json; do
    local task_session task_mode
    task_session="$(jq -r '.session // empty' "$f" 2>/dev/null || true)"
    task_mode="$(jq -r '.mode // empty' "$f" 2>/dev/null || true)"
    if [ "$task_session" = "$session" ] && [ "$task_mode" = "manual" ]; then
      return 0
    fi
  done
  return 1
}

chain_is_autonomous() {
  local chain_id="$1"
  if [ -z "$chain_id" ]; then
    return 1
  fi
  shopt -s nullglob
  local f
  for f in "$RUNS_DIR"/*/task.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      return 0
    fi
  done
  return 1
}

latest_chain_run_id() {
  local chain_id="$1"
  local latest=""
  if [ -z "$chain_id" ]; then
    echo ""
    return 0
  fi
  shopt -s nullglob
  local f
  for f in "$RUNS_DIR"/*/task.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      local run_id
      run_id="$(basename "$(dirname "$f")")"
      if [ -z "$latest" ] || [ "$run_id" \> "$latest" ]; then
        latest="$run_id"
      fi
    fi
  done
  echo "$latest"
}

extract_result_from_output() {
  local output_file="$1"
  if [ ! -f "$output_file" ]; then
    return 0
  fi
  if grep -q '^[[:space:]]*BEGIN_RESULT[[:space:]]*$' "$output_file"; then
    awk 'BEGIN{f=0} /^[[:space:]]*BEGIN_RESULT[[:space:]]*$/{f=1; next} /^[[:space:]]*END_RESULT[[:space:]]*$/{exit} f{print}' "$output_file"
    return 0
  fi
  awk 'BEGIN{f=0} /^RESULT:/{f=1; next} /^NEXT_TASK:/{exit} /^DONE[[:space:]]*$/{exit} f{print}' "$output_file"
}

chain_last_context() {
  local run_id="$1"
  if [ -z "$run_id" ]; then
    echo ""
    return 0
  fi
  local output_file=""
  if [ -f "$RUNS_DIR/$run_id/output.txt" ]; then
    output_file="$RUNS_DIR/$run_id/output.txt"
  elif [ -f "$OUTBOX_DIR/$run_id.md" ]; then
    output_file="$OUTBOX_DIR/$run_id.md"
  fi
  if [ -z "$output_file" ]; then
    echo ""
    return 0
  fi
  local result
  result="$(extract_result_from_output "$output_file")"
  if [ -z "$result" ]; then
    result="$(cat "$output_file")"
  fi
  trim_context "$result" "$AUTONOMOUS_CONTEXT_LIMIT"
}

queue_manual_task() {
  local prompt="$1"
  local session="$2"
  local verbose="${3:-0}"
  local id
  id="$(new_id)"
  jq -n \
    --arg id "$id" \
    --arg mode "manual" \
    --arg prompt "$prompt" \
    --arg session "$session" \
    --arg created "$(now_utc)" \
    --argjson verbose "$verbose" \
    '{id:$id,mode:$mode,prompt:$prompt,session:$session,verbose:$verbose,created:$created}' \
    > "$INBOX_DIR/$id.json"
  echo "$id"
}

reactivate_chain_if_needed() {
  local chain_id="$1"
  local note="$2"
  if [ -z "$chain_id" ] || [ -z "$note" ]; then
    return 0
  fi

  if chain_is_autonomous "$chain_id"; then
    if chain_is_active "$chain_id"; then
      return 0
    fi
    local last_id
    last_id="$(latest_chain_run_id "$chain_id")"
    if [ -z "$last_id" ]; then
      return 0
    fi
    local task_file="$RUNS_DIR/$last_id/task.json"
    local goal session context
    goal="$(jq -r '.goal // empty' "$task_file" 2>/dev/null || true)"
    session="$(jq -r '.session // empty' "$task_file" 2>/dev/null || true)"
    context="$(chain_last_context "$last_id")"
    if [ -z "$goal" ]; then
      goal="$note"
    fi
    rm -f "$(chain_stop_file "$chain_id")"
    local new_id
    new_id="$(new_id)"
    jq -n \
      --arg id "$new_id" \
      --arg mode "autonomous" \
      --arg chain "$chain_id" \
      --arg parent "$last_id" \
      --arg goal "$goal" \
      --arg task "$note" \
      --arg context "$context" \
      --arg session "$session" \
      --arg created "$(now_utc)" \
      '{id:$id,mode:$mode,chain:$chain,parent:$parent,goal:$goal,task:$task,context:$context,session:$session,created:$created}' \
      > "$INBOX_DIR/$new_id.json"
    echo "chain reactivated"
    return 0
  fi

  local session
  session="$(session_for_chain "$chain_id")"
  if [ -z "$session" ] && [ -n "${AGENT_SESSION:-}" ]; then
    session="$AGENT_SESSION"
  fi
  if run_id_active "$chain_id"; then
    return 0
  fi
  rm -f "$(chain_stop_file "$chain_id")"
  local new_id
  new_id="$(queue_manual_task "$note" "$session" 0)"
  echo "manual chain reactivated ($new_id)"
}

submit_cmd() {
  local prompt=""
  local session=""
  local prompt_from_file=0
  local verbose=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --file|-f)
        if [ -z "${2:-}" ]; then
          echo "missing file path" >&2
          exit 1
        fi
        prompt="$(cat "$2")"
        prompt_from_file=1
        shift 2
        ;;
      --session|-s)
        if [ -z "${2:-}" ]; then
          echo "missing session id" >&2
          exit 1
        fi
        session="$2"
        shift 2
        ;;
      --verbose|-v)
        verbose=1
        shift
        ;;
      *)
        if [ "$prompt_from_file" -eq 1 ]; then
          echo "cannot combine --file with inline prompt" >&2
          exit 1
        fi
        prompt="${prompt:+$prompt }$1"
        shift
        ;;
    esac
  done

  if [ -z "$prompt" ]; then
    echo "prompt is empty" >&2
    exit 1
  fi

  local id
  id="$(new_id)"
  jq -n \
    --arg id "$id" \
    --arg mode "manual" \
    --arg prompt "$prompt" \
    --arg session "$session" \
    --argjson verbose "$verbose" \
    --arg created "$(now_utc)" \
    '{id:$id,mode:$mode,prompt:$prompt,session:$session,verbose:$verbose,created:$created}' \
    > "$INBOX_DIR/$id.json"
  echo "$id"
}

start_autonomous_cmd() {
  local goal=""
  local task="Decide the next concrete step toward the goal and execute it."
  local session=""
  local verbose=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --file|-f)
        if [ -z "${2:-}" ]; then
          echo "missing goal file path" >&2
          exit 1
        fi
        goal="$(cat "$2")"
        shift 2
        ;;
      --task)
        if [ -z "${2:-}" ]; then
          echo "missing task text" >&2
          exit 1
        fi
        task="$2"
        shift 2
        ;;
      --session|-s)
        if [ -z "${2:-}" ]; then
          echo "missing session id" >&2
          exit 1
        fi
        session="$2"
        shift 2
        ;;
      --verbose|-v)
        verbose=1
        shift
        ;;
      *)
        goal="${goal:+$goal }$1"
        shift
        ;;
    esac
  done

  if [ -z "$goal" ]; then
    echo "goal is empty" >&2
    exit 1
  fi

  local id chain
  id="$(new_id)"
  chain="$id"
  jq -n \
    --arg id "$id" \
    --arg mode "autonomous" \
    --arg chain "$chain" \
    --arg goal "$goal" \
    --arg task "$task" \
    --arg session "$session" \
    --argjson verbose "$verbose" \
    --arg created "$(now_utc)" \
    '{id:$id,mode:$mode,chain:$chain,goal:$goal,task:$task,session:$session,verbose:$verbose,created:$created}' \
    > "$INBOX_DIR/$id.json"
  local alias
  alias="$(ensure_alias "$session" "$chain" 2>/dev/null || true)"
  if [ -n "$alias" ]; then
    echo "$alias"
  else
    echo "$id"
  fi
}

list_cmd() {
  shopt -s nullglob
  local f id

  for f in "$INBOX_DIR"/*.json; do
    id="$(basename "$f" .json)"
    echo "queued $id"
  done
  for f in "$WORKING_DIR"/*.json; do
    id="$(basename "$f" .json)"
    echo "working $id"
  done
  for f in "$OUTBOX_DIR"/*.md; do
    id="$(basename "$f" .md)"
    echo "done $id"
  done
  for f in "$FAILED_DIR"/*.md; do
    id="$(basename "$f" .md)"
    echo "failed $id"
  done
}

stats_cmd() {
  local format="text"
  local session=""
  local active_only=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json)
        format="json"
        shift
        ;;
      --session)
        session="${2:-}"
        shift 2
        ;;
      --active-only)
        active_only=1
        shift
        ;;
      *)
        break
        ;;
    esac
  done

  local script="$WORKSPACE/webui/stats.js"
  if [ ! -f "$script" ]; then
    echo "stats module not found: $script" >&2
    exit 1
  fi

  local args=()
  if [ "$format" = "json" ]; then
    args+=("--json")
  fi
  if [ -n "$session" ]; then
    args+=("--session" "$session")
  fi
  if [ "$active_only" -eq 1 ]; then
    args+=("--active-only")
  fi

  node "$script" "${args[@]}"
}

status_cmd() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "missing id" >&2
    exit 1
  fi

  if [ -f "$OUTBOX_DIR/$id.md" ]; then
    echo "done"
  elif [ -f "$FAILED_DIR/$id.md" ]; then
    echo "failed"
  elif [ -f "$WORKING_DIR/$id.json" ]; then
    echo "working"
  elif [ -f "$INBOX_DIR/$id.json" ]; then
    echo "queued"
  else
    echo "unknown"
  fi
}

wait_cmd() {
  local stream=1
  local id=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --no-stream)
        stream=0
        shift
        ;;
      *)
        id="$1"
        shift
        ;;
    esac
  done

  if [ -z "$id" ]; then
    echo "missing id" >&2
    exit 1
  fi

  if [ "$stream" -eq 0 ]; then
    while :; do
      if [ -f "$OUTBOX_DIR/$id.md" ]; then
        cat "$OUTBOX_DIR/$id.md"
        exit 0
      fi
      if [ -f "$FAILED_DIR/$id.md" ]; then
        cat "$FAILED_DIR/$id.md"
        exit 1
      fi
      sleep 1
    done
  fi

  local output_file="$RUNS_DIR/$id/output.txt"
  local status_file="$RUNS_DIR/$id/status.txt"
  local use_status=0
  local status_active=0
  local last_status=""
  if [ -t 1 ] && [ "${FOLLOW_STATUS_LINE:-1}" != "0" ]; then
    use_status=1
  fi

  status_clear() {
    if [ "$use_status" -eq 1 ] && [ "$status_active" -eq 1 ]; then
      printf '\r\033[K'
      status_active=0
    fi
  }

  status_print() {
    local text="$1"
    if [ "$use_status" -eq 1 ]; then
      printf '\r\033[K%s' "$text"
      status_active=1
    fi
  }

  while :; do
    if [ -f "$OUTBOX_DIR/$id.md" ]; then
      status_clear
      cat "$OUTBOX_DIR/$id.md"
      exit 0
    fi
    if [ -f "$FAILED_DIR/$id.md" ]; then
      status_clear
      cat "$FAILED_DIR/$id.md"
      exit 1
    fi
    if [ -f "$output_file" ]; then
      break
    fi
    if [ "$use_status" -eq 1 ] && [ -f "$status_file" ]; then
      local line
      line="$(tail -n 1 "$status_file" 2>/dev/null | tr -d '\r')"
      if [ -n "$line" ] && [ "$line" != "$last_status" ]; then
        status_print "thinking: $line"
        last_status="$line"
      fi
    fi
    sleep 1
  done

  status_clear
  tail -n +1 -f "$output_file" &
  local tail_pid=$!

  while :; do
    if [ -f "$OUTBOX_DIR/$id.md" ]; then
      kill "$tail_pid" 2>/dev/null || true
      wait "$tail_pid" 2>/dev/null || true
      exit 0
    fi
    if [ -f "$FAILED_DIR/$id.md" ]; then
      kill "$tail_pid" 2>/dev/null || true
      wait "$tail_pid" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
}

follow_cmd() {
  local chain="$1"
  local poll="${FOLLOW_POLL_SECONDS:-2}"
  if [ -z "$chain" ]; then
    echo "missing chain id" >&2
    exit 1
  fi
  local session="${AGENT_SESSION:-}"
  chain="$(resolve_chain_id "$session" "$chain")"
  local label
  local chain_session
  chain_session="$(session_for_chain "$chain")"
  label="$(label_for_chain "${chain_session:-$session}" "$chain")"

  declare -A seen_queued
  declare -A seen_working
  declare -A seen_done
  declare -A seen_failed
  local done_seen=0
  local use_status=0
  local status_active=0
  local last_status=""
  local last_status_id=""
  if [ -t 1 ] && [ "${FOLLOW_STATUS_LINE:-1}" != "0" ]; then
    use_status=1
  fi

  status_clear() {
    if [ "$use_status" -eq 1 ] && [ "$status_active" -eq 1 ]; then
      printf '\r\033[K'
      status_active=0
    fi
  }

  status_print() {
    local text="$1"
    if [ "$use_status" -eq 1 ]; then
      printf '\r\033[K%s' "$text"
      status_active=1
    fi
  }

  shopt -s nullglob
  while :; do
    local activity=0
    local working_ids=()

    local f id chain_id
    for f in "$INBOX_DIR"/*.json; do
      chain_id="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
      if [ "$chain_id" = "$chain" ]; then
        id="$(jq -r '.id // empty' "$f" 2>/dev/null || true)"
        if [ -n "$id" ] && [ -z "${seen_queued[$id]:-}" ]; then
          status_clear
          echo "queued $id"
          seen_queued["$id"]=1
          activity=1
        fi
      fi
    done

    for f in "$WORKING_DIR"/*.json; do
      chain_id="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
      if [ "$chain_id" = "$chain" ]; then
        id="$(jq -r '.id // empty' "$f" 2>/dev/null || true)"
        if [ -n "$id" ]; then
          working_ids+=("$id")
        fi
        if [ -n "$id" ] && [ -z "${seen_working[$id]:-}" ]; then
          status_clear
          echo "working $id"
          seen_working["$id"]=1
          activity=1
        fi
      fi
    done

    for f in "$OUTBOX_DIR"/*.md; do
      id="$(basename "$f" .md)"
      if [ -n "${seen_done[$id]:-}" ]; then
        continue
      fi
      local task_json="$RUNS_DIR/$id/task.json"
      if [ -f "$task_json" ]; then
        chain_id="$(jq -r '.chain // empty' "$task_json" 2>/dev/null || true)"
        if [ "$chain_id" = "$chain" ]; then
          status_clear
          echo "done $id"
          cat "$f"
          echo
          seen_done["$id"]=1
          activity=1
          if grep -q '^[[:space:]]*DONE[[:space:]]*$' "$f"; then
            done_seen=1
          fi
        fi
      fi
    done

    for f in "$FAILED_DIR"/*.md; do
      id="$(basename "$f" .md)"
      if [ -n "${seen_failed[$id]:-}" ]; then
        continue
      fi
      local task_json="$RUNS_DIR/$id/task.json"
      if [ -f "$task_json" ]; then
        chain_id="$(jq -r '.chain // empty' "$task_json" 2>/dev/null || true)"
        if [ "$chain_id" = "$chain" ]; then
          status_clear
          echo "failed $id"
          cat "$f"
          echo
          seen_failed["$id"]=1
          activity=1
        fi
      fi
    done

    if [ "$done_seen" -eq 1 ]; then
      local pending=0
      for f in "$INBOX_DIR"/*.json "$WORKING_DIR"/*.json; do
        chain_id="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
        if [ "$chain_id" = "$chain" ]; then
          pending=1
          break
        fi
      done
        if [ "$pending" -eq 0 ]; then
        status_clear
        echo "chain $label completed"
        exit 0
      fi
    fi

    if [ "$use_status" -eq 1 ] && [ "${#working_ids[@]}" -gt 0 ]; then
      local newest_ts=0
      local newest_line=""
      local newest_id=""
      local wid
      for wid in "${working_ids[@]}"; do
        local file
        file="$(status_file_for_task "$wid")"
        if [ -f "$file" ]; then
          local mtime
          mtime="$(stat -c %Y "$file" 2>/dev/null || echo 0)"
          local line
          line="$(tail -n 1 "$file" 2>/dev/null | tr -d '\r')"
          if [ -n "$line" ] && [ "$mtime" -ge "$newest_ts" ]; then
            newest_ts="$mtime"
            newest_line="$line"
            newest_id="$wid"
          fi
        fi
      done
      if [ -n "$newest_line" ] && { [ "$newest_line" != "$last_status" ] || [ "$newest_id" != "$last_status_id" ]; }; then
        status_print "thinking (chain $label): $newest_line"
        last_status="$newest_line"
        last_status_id="$newest_id"
      fi
    elif [ "$use_status" -eq 1 ] && [ "$status_active" -eq 1 ]; then
      status_clear
      last_status=""
      last_status_id=""
    fi

    if [ "$activity" -eq 0 ]; then
      sleep "$poll"
    fi
  done
}

follow_all_cmd() {
  local poll="${FOLLOW_POLL_SECONDS:-2}"
  local include_done="${FOLLOW_INCLUDE_DONE:-0}"
  local start_ts
  start_ts="$(date +%s)"

  declare -A seen_queued
  declare -A seen_working
  declare -A seen_done
  declare -A seen_failed
  local use_status=0
  local status_active=0
  local last_status=""
  local last_status_id=""
  if [ -t 1 ] && [ "${FOLLOW_STATUS_LINE:-1}" != "0" ]; then
    use_status=1
  fi

  status_clear() {
    if [ "$use_status" -eq 1 ] && [ "$status_active" -eq 1 ]; then
      printf '\r\033[K'
      status_active=0
    fi
  }

  status_print() {
    local text="$1"
    if [ "$use_status" -eq 1 ]; then
      printf '\r\033[K%s' "$text"
      status_active=1
    fi
  }

  shopt -s nullglob
  while :; do
    local activity=0
    local working_ids=()
    declare -A working_labels=()

    local f id chain_id label
    for f in "$INBOX_DIR"/*.json; do
      id="$(jq -r '.id // empty' "$f" 2>/dev/null || true)"
      chain_id="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
      local session
      session="$(jq -r '.session // empty' "$f" 2>/dev/null || true)"
      label="$(label_for_chain "$session" "$chain_id")"
      if [ -n "$id" ] && [ -z "${seen_queued[$id]:-}" ]; then
        status_clear
        echo "queued $id (chain $label)"
        seen_queued["$id"]=1
        activity=1
      fi
    done

    for f in "$WORKING_DIR"/*.json; do
      id="$(jq -r '.id // empty' "$f" 2>/dev/null || true)"
      chain_id="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
      local session
      session="$(jq -r '.session // empty' "$f" 2>/dev/null || true)"
      label="$(label_for_chain "$session" "$chain_id")"
      if [ -n "$id" ]; then
        working_ids+=("$id")
        working_labels["$id"]="$label"
      fi
      if [ -n "$id" ] && [ -z "${seen_working[$id]:-}" ]; then
        status_clear
        echo "working $id (chain $label)"
        seen_working["$id"]=1
        activity=1
      fi
    done

    for f in "$OUTBOX_DIR"/*.md; do
      id="$(basename "$f" .md)"
      if [ -n "${seen_done[$id]:-}" ]; then
        continue
      fi
      if [ "$include_done" -eq 0 ]; then
        local mtime
        mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
        if [ "$mtime" -lt "$start_ts" ]; then
          seen_done["$id"]=1
          continue
        fi
      fi
      local task_json="$RUNS_DIR/$id/task.json"
      chain_id=""
      local session=""
      if [ -f "$task_json" ]; then
        chain_id="$(jq -r '.chain // empty' "$task_json" 2>/dev/null || true)"
        session="$(jq -r '.session // empty' "$task_json" 2>/dev/null || true)"
      fi
      label="$(label_for_chain "$session" "$chain_id")"
      status_clear
      echo "done $id (chain $label)"
      cat "$f"
      echo
      seen_done["$id"]=1
      activity=1
    done

    for f in "$FAILED_DIR"/*.md; do
      id="$(basename "$f" .md)"
      if [ -n "${seen_failed[$id]:-}" ]; then
        continue
      fi
      if [ "$include_done" -eq 0 ]; then
        local mtime
        mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
        if [ "$mtime" -lt "$start_ts" ]; then
          seen_failed["$id"]=1
          continue
        fi
      fi
      local task_json="$RUNS_DIR/$id/task.json"
      chain_id=""
      local session=""
      if [ -f "$task_json" ]; then
        chain_id="$(jq -r '.chain // empty' "$task_json" 2>/dev/null || true)"
        session="$(jq -r '.session // empty' "$task_json" 2>/dev/null || true)"
      fi
      label="$(label_for_chain "$session" "$chain_id")"
      status_clear
      echo "failed $id (chain $label)"
      cat "$f"
      echo
      seen_failed["$id"]=1
      activity=1
    done

    if [ "$use_status" -eq 1 ] && [ "${#working_ids[@]}" -gt 0 ]; then
      local newest_ts=0
      local newest_line=""
      local newest_id=""
      local wid
      for wid in "${working_ids[@]}"; do
        local file
        file="$(status_file_for_task "$wid")"
        if [ -f "$file" ]; then
          local mtime
          mtime="$(stat -c %Y "$file" 2>/dev/null || echo 0)"
          local line
          line="$(tail -n 1 "$file" 2>/dev/null | tr -d '\r')"
          if [ -n "$line" ] && [ "$mtime" -ge "$newest_ts" ]; then
            newest_ts="$mtime"
            newest_line="$line"
            newest_id="$wid"
          fi
        fi
      done
      if [ -n "$newest_line" ] && { [ "$newest_line" != "$last_status" ] || [ "$newest_id" != "$last_status_id" ]; }; then
        local label_text="${working_labels[$newest_id]:-manual}"
        status_print "thinking (chain $label_text): $newest_line"
        last_status="$newest_line"
        last_status_id="$newest_id"
      fi
    elif [ "$use_status" -eq 1 ] && [ "$status_active" -eq 1 ]; then
      status_clear
      last_status=""
      last_status_id=""
    fi

    if [ "$activity" -eq 0 ]; then
      sleep "$poll"
    fi
  done
}

output_cmd() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "missing id" >&2
    exit 1
  fi
  if [ -f "$OUTBOX_DIR/$id.md" ]; then
    cat "$OUTBOX_DIR/$id.md"
    exit 0
  fi
  if [ -f "$FAILED_DIR/$id.md" ]; then
    cat "$FAILED_DIR/$id.md"
    exit 1
  fi
  echo "output not found" >&2
  exit 1
}

chain_note_cmd() {
  local id="$1"
  shift || true
  local note="$*"
  if [ -z "$id" ] || [ -z "$note" ]; then
    echo "usage: chain-note <chain-id> \"note\"" >&2
    exit 1
  fi
  local session="${AGENT_SESSION:-}"
  id="$(resolve_chain_id "$session" "$id")"
  echo "$note" > "$(chain_note_file "$id")"
  echo "note set"
  if note_requests_stop "$note"; then
    chain_stop_cmd "$id"
  fi
}

chain_append_cmd() {
  local id="$1"
  shift || true
  local note="$*"
  if [ -z "$id" ] || [ -z "$note" ]; then
    echo "usage: chain-append <chain-id> \"note\"" >&2
    exit 1
  fi
  local session="${AGENT_SESSION:-}"
  id="$(resolve_chain_id "$session" "$id")"
  echo "$note" >> "$(chain_note_file "$id")"
  echo "note appended"
  if note_requests_stop "$note"; then
    chain_stop_cmd "$id"
    return 0
  fi
  reactivate_chain_if_needed "$id" "$note"
}

chain_clear_cmd() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "usage: chain-clear <chain-id>" >&2
    exit 1
  fi
  local session="${AGENT_SESSION:-}"
  id="$(resolve_chain_id "$session" "$id")"
  rm -f "$(chain_note_file "$id")"
  echo "note cleared"
}

chain_stop_cmd() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "usage: chain-stop <chain-id>" >&2
    exit 1
  fi
  if [ "$id" = "all" ]; then
    chain_stop_all_cmd
    return 0
  fi
  local session="${AGENT_SESSION:-}"
  id="$(resolve_chain_id "$session" "$id")"
  touch "$(chain_stop_file "$id")"
  local removed
  removed="$(purge_inbox_for_chain "$id")"
  if [ "$removed" -gt 0 ]; then
    echo "stop requested; purged ${removed} queued task(s)"
  else
    echo "stop requested"
  fi
}

chain_stop_all_cmd() {
  local chains last chain
  chains="$(active_chains)"
  if [ -f "$(last_output_chain_file)" ]; then
    last="$(head -n 1 "$(last_output_chain_file)" | tr -d '[:space:]')"
    if [ -n "$last" ]; then
      chains="$(printf '%s\n%s\n' "$chains" "$last" | awk 'NF' | sort -u)"
    fi
  fi
  if [ -z "$chains" ]; then
    echo "no active chains"
    return 0
  fi
  local count=0
  local removed=0
  while IFS= read -r chain; do
    [ -z "$chain" ] && continue
    touch "$(chain_stop_file "$chain")"
    count=$((count + 1))
    removed=$((removed + $(purge_inbox_for_chain "$chain")))
  done <<< "$chains"
  if [ "$removed" -gt 0 ]; then
    echo "stop requested for ${count} chain(s); purged ${removed} queued task(s)"
  else
    echo "stop requested for ${count} chain(s)"
  fi
}

chain_stop_current_cmd() {
  local file
  file="$(last_output_chain_file)"
  if [ ! -f "$file" ]; then
    echo "no chain output recorded" >&2
    exit 1
  fi
  local id
  id="$(head -n 1 "$file" | tr -d '[:space:]')"
  if [ -z "$id" ]; then
    echo "no chain output recorded" >&2
    exit 1
  fi
  chain_stop_cmd "$id"
}

chain_resume_cmd() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "usage: chain-resume <chain-id>" >&2
    exit 1
  fi
  if [ "$id" = "all" ]; then
    chain_resume_all_cmd
    return 0
  fi
  local session="${AGENT_SESSION:-}"
  id="$(resolve_chain_id "$session" "$id")"
  rm -f "$(chain_stop_file "$id")"
  echo "resume requested"
}

chain_resume_all_cmd() {
  shopt -s nullglob
  local f count=0
  for f in "$CHAINS_DIR"/*.stop; do
    rm -f "$f"
    count=$((count + 1))
  done
  echo "resume requested for ${count} chain(s)"
}

reset_session_cmd() {
  local id="$1"
  if [ -z "$id" ]; then
    echo "missing session id" >&2
    exit 1
  fi
  rm -f "$SESSIONS_DIR/$id.md"
  echo "session reset"
}

stop_cmd() {
  touch "$STOP_FILE"
  echo "stop requested"
}

start_cmd() {
  rm -f "$STOP_FILE"
  echo "start requested"
}

ensure_dirs

case "${1:-}" in
  submit)
    shift
    submit_cmd "$@"
    ;;
  start-autonomous)
    shift
    start_autonomous_cmd "$@"
    ;;
  list)
    list_cmd
    ;;
  stats)
    shift
    stats_cmd "$@"
    ;;
  status)
    shift
    status_cmd "$@"
    ;;
  wait)
    shift
    wait_cmd "$@"
    ;;
  follow)
    shift
    follow_cmd "$@"
    ;;
  follow-all)
    follow_all_cmd
    ;;
  chain-note)
    shift
    chain_note_cmd "$@"
    ;;
  chain-append)
    shift
    chain_append_cmd "$@"
    ;;
  chain-clear)
    shift
    chain_clear_cmd "$@"
    ;;
  chain-stop)
    shift
    chain_stop_cmd "$@"
    ;;
  chain-stop-all)
    chain_stop_all_cmd
    ;;
  chain-stop-current)
    chain_stop_current_cmd
    ;;
  chain-resume)
    shift
    chain_resume_cmd "$@"
    ;;
  chain-resume-all)
    chain_resume_all_cmd
    ;;
  output)
    shift
    output_cmd "$@"
    ;;
  reset-session)
    shift
    reset_session_cmd "$@"
    ;;
  stop)
    stop_cmd
    ;;
  start)
    start_cmd
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    echo "unknown command: $1" >&2
    usage
    exit 1
    ;;
esac
