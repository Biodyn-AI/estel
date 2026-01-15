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
LOG_DIR="${WORKSPACE}/logs"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/agentd.log}"

AGENT_WORKERS="${AGENT_WORKERS:-1}"
POLL_SECONDS="${POLL_SECONDS:-2}"

CODEX_BIN="${CODEX_BIN:-codex}"
CODEX_FLAGS="${CODEX_FLAGS:---dangerously-bypass-approvals-and-sandbox -C /workspace}"
CODEX_EXEC_FLAGS="${CODEX_EXEC_FLAGS:---skip-git-repo-check}"
AGENT_VERBOSE="${AGENT_VERBOSE:-0}"
CODEX_EXEC_MODE="${CODEX_EXEC_MODE:-stdin}"
AGENT_WORKDIR="${AGENT_WORKDIR:-}"
AUTONOMOUS_CONTEXT_LIMIT="${AUTONOMOUS_CONTEXT_LIMIT:-4000}"
CHAIN_SUMMARY_LIMIT="${CHAIN_SUMMARY_LIMIT:-1200}"
SESSION_CONTEXT_LIMIT="${SESSION_CONTEXT_LIMIT:-8000}"
SHUTDOWN=0

if [ -z "${HOME:-}" ] || [ "$HOME" = "/root" ]; then
  HOME_DIR="$(getent passwd "$(id -u)" | cut -d: -f6)"
  if [ -z "$HOME_DIR" ]; then
    HOME_DIR="/home/agent"
  fi
  export HOME="$HOME_DIR"
fi

if [ -z "${USER:-}" ] || [ "$USER" = "root" ]; then
  export USER="$(id -un)"
fi

status_from_line() {
  local line="$1"
  line="${line//$'\r'/}"
  line="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$line" ]; then
    return 1
  fi
  case "$line" in
    thinking*|Thinking*)
      echo "thinking..."
      return 0
      ;;
    "**"*"**")
      echo "${line//\*\*/}"
      return 0
      ;;
    exec)
      echo "running command..."
      return 0
      ;;
    mcp\ startup:*)
      echo "$line"
      return 0
      ;;
    ERROR*|error:*)
      echo "$line"
      return 0
      ;;
  esac
  return 1
}

update_status_file() {
  local file="$1"
  local line="$2"
  if [ -z "$file" ] || [ -z "$line" ]; then
    return 0
  fi
  printf '%s\n' "$line" > "$file"
}

normalize_codex_flags() {
  if [ -z "$AGENT_WORKDIR" ]; then
    return 0
  fi
  local -a filtered=()
  local skip_next=0
  local token
  for token in $CODEX_FLAGS; do
    if [ "$skip_next" -eq 1 ]; then
      skip_next=0
      continue
    fi
    case "$token" in
      -C|--cd)
        skip_next=1
        continue
        ;;
      -C*|--cd=*)
        continue
        ;;
    esac
    filtered+=("$token")
  done
  CODEX_FLAGS="-C $AGENT_WORKDIR"
  if [ "${#filtered[@]}" -gt 0 ]; then
    CODEX_FLAGS+=" ${filtered[*]}"
  fi
}

resolve_workdir_hint() {
  if [ -n "$AGENT_WORKDIR" ]; then
    printf '%s' "$AGENT_WORKDIR"
    return 0
  fi
  local prev=""
  local token
  for token in $CODEX_FLAGS; do
    case "$token" in
      -C)
        prev="-C"
        continue
        ;;
      --cd)
        prev="--cd"
        continue
        ;;
      -C*)
        printf '%s' "${token#-C}"
        return 0
        ;;
      --cd=*)
        printf '%s' "${token#--cd=}"
        return 0
        ;;
    esac
    if [ "$prev" = "-C" ] || [ "$prev" = "--cd" ]; then
      printf '%s' "$token"
      return 0
    fi
    prev=""
  done
  if [ -n "$WORKSPACE" ]; then
    printf '%s' "$WORKSPACE"
  fi
  return 0
}

normalize_codex_flags
WORKDIR_HINT="$(resolve_workdir_hint)"

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

ensure_dirs() {
  mkdir -p "$INBOX_DIR" "$WORKING_DIR" "$OUTBOX_DIR" "$FAILED_DIR" "$RUNS_DIR" "$SESSIONS_DIR" "$CHAINS_DIR" "$LOG_DIR"
  touch "$LOG_FILE"
}

requeue_working() {
  shopt -s nullglob
  local f
  for f in "$WORKING_DIR"/*.json; do
    mv "$f" "$INBOX_DIR"/
  done
}

new_id() {
  printf '%s-%s-%s\n' "$(date +%Y%m%d-%H%M%S)" "$$" "$RANDOM"
}

trim_context() {
  local text="$1"
  local limit="$2"
  if [ -z "$text" ]; then
    return 0
  fi
  printf '%s' "$text" | tail -c "$limit"
}

trim_summary() {
  local text="$1"
  local limit="$2"
  if [ -z "$text" ]; then
    return 0
  fi
  printf '%s' "$text" | head -c "$limit"
}

session_file() {
  local session_id="$1"
  echo "${SESSIONS_DIR}/${session_id}.md"
}

repl_session_file() {
  local session_id="$1"
  echo "${SESSIONS_DIR}/${session_id}.repl.md"
}

sanitize_chain_id() {
  local chain_id="$1"
  if [ -z "$chain_id" ]; then
    return 0
  fi
  printf '%s' "$chain_id" | tr -c 'A-Za-z0-9._-' '_'
}

chain_repl_file() {
  local session_id="$1"
  local chain_id="$2"
  local safe
  safe="$(sanitize_chain_id "$chain_id")"
  echo "${SESSIONS_DIR}/${session_id}.chain.${safe}.repl.md"
}

chain_note_file() {
  local chain_id="$1"
  echo "${CHAINS_DIR}/${chain_id}.note"
}

chain_stop_file() {
  local chain_id="$1"
  echo "${CHAINS_DIR}/${chain_id}.stop"
}

last_output_chain_file() {
  echo "${CHAINS_DIR}/last_output"
}

chain_stop_requested() {
  local chain_id="$1"
  [ -n "$chain_id" ] && [ -f "$(chain_stop_file "$chain_id")" ]
}

record_last_output_chain() {
  local chain_id="$1"
  if [ -n "$chain_id" ]; then
    echo "$chain_id" > "$(last_output_chain_file)"
  fi
}

load_chain_note() {
  local chain_id="$1"
  local file
  file="$(chain_note_file "$chain_id")"
  if [ -f "$file" ]; then
    cat "$file"
  fi
}

load_session_history() {
  local session_id="$1"
  local file
  file="$(session_file "$session_id")"
  if [ -f "$file" ]; then
    trim_context "$(cat "$file")" "$SESSION_CONTEXT_LIMIT"
  fi
}

build_session_prompt() {
  local history="$1"
  local user_prompt="$2"

  cat <<EOF
You are continuing a multi-turn conversation. Reply as the assistant.

CONVERSATION_HISTORY:
${history:-<none>}

WORKSPACE_ROOT:
${WORKDIR_HINT:-$WORKSPACE}

Use the workspace root for file operations unless instructed otherwise. If you run commands, `cd` into WORKSPACE_ROOT first.

USER:
$user_prompt

ASSISTANT:
EOF
}

append_session_history() {
  local session_id="$1"
  local user_prompt="$2"
  local assistant_output="$3"
  local file
  file="$(session_file "$session_id")"
  {
    printf 'User:\n%s\n\nAssistant:\n%s\n\n' "$user_prompt" "$assistant_output"
  } >> "$file"
}

append_repl_history() {
  local session_id="$1"
  local user_prompt="$2"
  local assistant_output="$3"
  if [ -z "$session_id" ]; then
    return 0
  fi
  local file
  file="$(repl_session_file "$session_id")"
  {
    printf 'User:\n%s\n\nAssistant:\n%s\n\n' "$user_prompt" "$assistant_output"
  } >> "$file"
}

append_chain_repl_history() {
  local session_id="$1"
  local chain_id="$2"
  local user_prompt="$3"
  local assistant_output="$4"
  if [ -z "$session_id" ] || [ -z "$chain_id" ]; then
    return 0
  fi
  local file
  file="$(chain_repl_file "$session_id" "$chain_id")"
  {
    printf 'User:\n%s\n\nAssistant:\n%s\n\n' "$user_prompt" "$assistant_output"
  } >> "$file"
}

build_autonomous_prompt() {
  local goal="$1"
  local task="$2"
  local context="$3"
  local note="$4"
  local repl_history="$5"

  cat <<EOF
You are running in an autonomous loop using the Codex CLI.

WORKSPACE_ROOT:
${WORKDIR_HINT:-$WORKSPACE}

Use the workspace root for file operations unless instructed otherwise. If you run commands, `cd` into WORKSPACE_ROOT first.

GOAL:
$goal

CURRENT_TASK:
$task

CONTEXT_FROM_LAST_STEP:
${context:-<none>}

REPL_HISTORY:
${repl_history:-<none>}

CHAIN_NOTES:
${note:-<none>}

If possible, include a next task. If no reasonable follow-up exists, output DONE.

Return output in this exact format (tokens must be on their own lines):

BEGIN_RESULT
<your result>
END_RESULT
BEGIN_NEXT_TASK
<the next concrete task to run>
END_NEXT_TASK

Do not include the BEGIN_/END_ tokens inside the content.

If the goal is fully complete, output exactly:
DONE
EOF
}

build_next_task_prompt() {
  local goal="$1"
  local last_task="$2"
  local context="$3"
  local note="$4"
  local repl_history="$5"

  cat <<EOF
You are continuing an autonomous chain. The previous step did not provide a next task.

WORKSPACE_ROOT:
${WORKDIR_HINT:-$WORKSPACE}

Use the workspace root for file operations unless instructed otherwise. If you run commands, `cd` into WORKSPACE_ROOT first.

GOAL:
$goal

LAST_TASK:
$last_task

CONTEXT_FROM_LAST_STEP:
${context:-<none>}

REPL_HISTORY:
${repl_history:-<none>}

CHAIN_NOTES:
${note:-<none>}

Return output in this exact format (tokens must be on their own lines):

BEGIN_NEXT_TASK
<the next concrete task to run>
END_NEXT_TASK

If no reasonable follow-up exists, output exactly:
DONE

Do not include the BEGIN_/END_ tokens inside the content.
EOF
}

extract_result() {
  local output_file="$1"
  if grep -q '^[[:space:]]*BEGIN_RESULT[[:space:]]*$' "$output_file"; then
    awk 'BEGIN{f=0} /^[[:space:]]*BEGIN_RESULT[[:space:]]*$/{f=1; next} /^[[:space:]]*END_RESULT[[:space:]]*$/{exit} f{print}' "$output_file"
    return 0
  fi
  awk 'BEGIN{f=0} /^RESULT:/{f=1; next} /^NEXT_TASK:/{exit} /^DONE[[:space:]]*$/{exit} f{print}' "$output_file"
}

extract_next_task() {
  local output_file="$1"
  if grep -q '^[[:space:]]*DONE[[:space:]]*$' "$output_file"; then
    echo "__DONE__"
    return 0
  fi
  if grep -q '^[[:space:]]*BEGIN_NEXT_TASK[[:space:]]*$' "$output_file"; then
    awk 'BEGIN{f=0} /^[[:space:]]*BEGIN_NEXT_TASK[[:space:]]*$/{f=1; next} /^[[:space:]]*END_NEXT_TASK[[:space:]]*$/{exit} f{print}' "$output_file" \
      | sed '/^[[:space:]]*$/d'
    return 0
  fi
  awk 'BEGIN{f=0} /^NEXT_TASK:/{f=1; next} f{print}' "$output_file" \
    | sed '/^[[:space:]]*$/d'
}

summary_from_output() {
  local output_file="$1"
  if [ ! -f "$output_file" ]; then
    return 0
  fi
  local result
  result="$(extract_result "$output_file")"
  if [ -z "$result" ]; then
    result="$(cat "$output_file")"
  fi
  trim_summary "$result" "$CHAIN_SUMMARY_LIMIT"
}

latest_chain_run_id() {
  local chain_id="$1"
  local skip_id="${2:-}"
  local latest=""
  shopt -s nullglob
  local f
  for f in "$RUNS_DIR"/*/task.json; do
    local task_chain
    task_chain="$(jq -r '.chain // empty' "$f" 2>/dev/null || true)"
    if [ "$task_chain" = "$chain_id" ]; then
      local run_id
      run_id="$(basename "$(dirname "$f")")"
      if [ -n "$skip_id" ] && [ "$run_id" = "$skip_id" ]; then
        continue
      fi
      if [ -z "$latest" ] || [ "$run_id" \> "$latest" ]; then
        latest="$run_id"
      fi
    fi
  done
  echo "$latest"
}

summary_from_chain() {
  local chain_id="$1"
  local skip_id="${2:-}"
  if [ -z "$chain_id" ]; then
    return 0
  fi
  local run_id
  run_id="$(latest_chain_run_id "$chain_id" "$skip_id")"
  if [ -z "$run_id" ]; then
    return 0
  fi
  local output_file=""
  if [ -f "$RUNS_DIR/$run_id/output.txt" ]; then
    output_file="$RUNS_DIR/$run_id/output.txt"
  elif [ -f "$OUTBOX_DIR/$run_id.md" ]; then
    output_file="$OUTBOX_DIR/$run_id.md"
  fi
  if [ -z "$output_file" ]; then
    return 0
  fi
  summary_from_output "$output_file"
}

append_chain_summary() {
  local chain_id="$1"
  local output_file="$2"
  local reason="${3:-}"
  local prefer_chain="${4:-0}"
  local skip_id="${5:-}"
  if [ -z "$output_file" ] || [ ! -f "$output_file" ]; then
    return 0
  fi
  if grep -q '^[[:space:]]*SUMMARY:' "$output_file"; then
    return 0
  fi
  local summary=""
  if [ "$prefer_chain" != "1" ]; then
    summary="$(summary_from_output "$output_file")"
  fi
  if [ -z "$summary" ]; then
    summary="$(summary_from_chain "$chain_id" "$skip_id")"
  fi
  if [ -z "$summary" ] && [ -n "$reason" ]; then
    summary="$reason"
  fi
  if [ -n "$summary" ]; then
    printf '\nSUMMARY:\n%s\n' "$summary" >> "$output_file"
  fi
}

run_codex() {
  local prompt_file="$1"
  local output_file="$2"
  local raw_file="$3"
  local verbose="$4"
  local status_file="${5:-}"
  local -a flags_arr=()
  local -a exec_flags_arr=()
  if [ -n "$CODEX_FLAGS" ]; then
    read -r -a flags_arr <<< "$CODEX_FLAGS"
  fi
  if [ -n "$CODEX_EXEC_FLAGS" ]; then
    read -r -a exec_flags_arr <<< "$CODEX_EXEC_FLAGS"
  fi

  if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
    log "codex binary not found: $CODEX_BIN"
    {
      echo "ERROR: codex CLI not found in the container."
      echo "Install it inside the container and run: codex login"
    } > "$output_file"
    return 127
  fi

  local -a cmd=("$CODEX_BIN" "${flags_arr[@]}" exec "${exec_flags_arr[@]}")
  local output_target="$raw_file"
  if [ "$verbose" -eq 1 ]; then
    output_target="$output_file"
  else
    cmd+=("--output-last-message" "$output_file")
  fi

  set +e
  if [ "$CODEX_EXEC_MODE" = "arg" ]; then
    local prompt
    prompt="$(cat "$prompt_file")"
    "${cmd[@]}" "$prompt" 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line" >> "$output_target"
      if [ "$output_target" != "$raw_file" ]; then
        printf '%s\n' "$line" >> "$raw_file"
      fi
      echo "$line" >> "$LOG_FILE"
      local status_line
      status_line="$(status_from_line "$line" || true)"
      if [ -n "$status_line" ]; then
        update_status_file "$status_file" "$status_line"
      fi
    done
    local status=${PIPESTATUS[0]}
  else
    "${cmd[@]}" < "$prompt_file" 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line" >> "$output_target"
      if [ "$output_target" != "$raw_file" ]; then
        printf '%s\n' "$line" >> "$raw_file"
      fi
      echo "$line" >> "$LOG_FILE"
      local status_line
      status_line="$(status_from_line "$line" || true)"
      if [ -n "$status_line" ]; then
        update_status_file "$status_file" "$status_line"
      fi
    done
    local status=${PIPESTATUS[0]}
  fi
  set -e

  if [ ! -s "$output_file" ] && [ -f "$raw_file" ]; then
    cp "$raw_file" "$output_file"
  fi
  return "$status"
}

suggest_next_task() {
  local goal="$1"
  local last_task="$2"
  local context="$3"
  local note="$4"
  local repl_history="$5"
  local run_dir="$6"

  local prompt_file="${run_dir}/fallback_prompt.txt"
  local output_file="${run_dir}/fallback_output.txt"
  local raw_file="${run_dir}/fallback_raw.txt"

  build_next_task_prompt "$goal" "$last_task" "$context" "$note" "$repl_history" > "$prompt_file"
  : > "$output_file"
  : > "$raw_file"

  if run_codex "$prompt_file" "$output_file" "$raw_file" 0 ""; then
    extract_next_task "$output_file"
  else
    log "fallback next-task generation failed"
    echo ""
  fi
}

process_task() {
  local task_file="$1"
  local worker_id="$2"
  local id mode prompt raw_prompt goal task chain context session task_verbose verbose note manual_chain chain_log_id

  id="$(jq -r '.id // empty' "$task_file")"
  mode="$(jq -r '.mode // empty' "$task_file")"
  chain="$(jq -r '.chain // empty' "$task_file")"
  manual_chain="$(jq -r '.manual_chain // .manualChain // empty' "$task_file")"
  goal="$(jq -r '.goal // empty' "$task_file")"
  task="$(jq -r '.task // empty' "$task_file")"
  context="$(jq -r '.context // empty' "$task_file")"
  session="$(jq -r '.session // empty' "$task_file")"
  task_verbose="$(jq -r '.verbose // empty' "$task_file")"
  verbose="${AGENT_VERBOSE}"
  if [ -n "$task_verbose" ] && [ "$task_verbose" != "null" ]; then
    verbose="$task_verbose"
  fi
  case "${verbose,,}" in
    1|true|yes|on)
      verbose=1
      ;;
    *)
      verbose=0
      ;;
  esac

  if [ -z "$id" ] || [ -z "$mode" ]; then
    log "invalid task file: $task_file"
    rm -f "$task_file"
    return 1
  fi

  if [ "$mode" = "autonomous" ]; then
    chain_log_id="${chain:-$id}"
  else
    chain_log_id="${manual_chain:-$id}"
  fi

  local run_dir="${RUNS_DIR}/${id}"
  mkdir -p "$run_dir"
  cp "$task_file" "$run_dir/task.json"

  if [ "$mode" = "autonomous" ]; then
    if [ -z "$goal" ] || [ -z "$task" ]; then
      log "task $id missing goal or task"
      rm -f "$task_file"
      return 1
    fi
    note="$(load_chain_note "$chain")"
    local repl_history
    repl_history="$(load_session_history "$session")"
    prompt="$(build_autonomous_prompt "$goal" "$task" "$context" "$note" "$repl_history")"
  elif [ "$mode" = "manual" ]; then
    raw_prompt="$(jq -r '.prompt // empty' "$task_file")"
    if [ -z "$raw_prompt" ]; then
      log "task $id missing prompt"
      rm -f "$task_file"
      return 1
    fi
    if [ -n "$session" ]; then
      local history
      history="$(load_session_history "$session")"
      prompt="$(build_session_prompt "$history" "$raw_prompt")"
    else
      prompt="$raw_prompt"
    fi
  else
    log "task $id has unknown mode: $mode"
    rm -f "$task_file"
    return 1
  fi

  printf '%s\n' "$prompt" > "$run_dir/prompt.txt"

  local output_file="${run_dir}/output.txt"
  local raw_file="${run_dir}/raw.txt"
  local status_file="${run_dir}/status.txt"
  : > "$output_file"
  : > "$raw_file"
  : > "$status_file"
  update_status_file "$status_file" "starting codex..."

  if [ "$mode" = "autonomous" ] && chain_stop_requested "$chain"; then
    log "chain $chain stop requested; skipping task $id"
    printf 'DONE\nChain stopped by user.\n' > "$output_file"
    append_chain_summary "$chain" "$output_file" "Chain stopped by user." 1 "$id"
    append_repl_history "$session" "AUTO TASK (chain ${chain:-$id}): $task" "$(cat "$output_file")"
    append_chain_repl_history "$session" "$chain_log_id" "AUTO TASK (chain ${chain:-$id}): $task" "$(cat "$output_file")"
    record_last_output_chain "${chain:-$id}"
    cp "$output_file" "$OUTBOX_DIR/$id.md"
    rm -f "$task_file"
    return 0
  fi

  log "worker $worker_id running task $id (mode: $mode)"
  if run_codex "$run_dir/prompt.txt" "$output_file" "$raw_file" "$verbose" "$status_file"; then
    log "task $id completed"

    if [ "$mode" = "manual" ] && [ -n "$session" ]; then
      append_session_history "$session" "$raw_prompt" "$(cat "$output_file")"
      append_repl_history "$session" "$raw_prompt" "$(cat "$output_file")"
      append_chain_repl_history "$session" "$chain_log_id" "$raw_prompt" "$(cat "$output_file")"
    fi

    if [ "$mode" = "autonomous" ]; then
      record_last_output_chain "${chain:-$id}"
      append_repl_history "$session" "AUTO TASK (chain ${chain:-$id}): $task" "$(cat "$output_file")"
      append_chain_repl_history "$session" "$chain_log_id" "AUTO TASK (chain ${chain:-$id}): $task" "$(cat "$output_file")"
      local next_task result next_id
      local chain_done=0
      local chain_reason=""
      next_task="$(extract_next_task "$output_file")"
      if [ "$next_task" = "__DONE__" ]; then
        log "chain ${chain:-$id} completed"
        chain_done=1
        chain_reason="Chain completed."
      else
        result="$(extract_result "$output_file")"
        if [ -z "$result" ]; then
          result="$(cat "$output_file")"
        fi
        result="$(trim_context "$result" "$AUTONOMOUS_CONTEXT_LIMIT")"

        if [ -z "$next_task" ]; then
          log "task $id missing next task; generating a follow-up"
          next_task="$(suggest_next_task "$goal" "$task" "$result" "$note" "$repl_history" "$run_dir")"
        fi

        if [ -z "$next_task" ] || [ "$next_task" = "__DONE__" ]; then
          log "chain ${chain:-$id} completed"
          chain_done=1
          chain_reason="Chain completed."
        elif chain_stop_requested "$chain"; then
          log "chain $chain stop requested; not queueing next task"
          chain_done=1
          chain_reason="Chain stopped by user."
        else
          next_id="$(new_id)"
          jq -n \
            --arg id "$next_id" \
            --arg mode "autonomous" \
            --arg chain "${chain:-$id}" \
            --arg parent "$id" \
            --arg goal "$goal" \
            --arg task "$next_task" \
            --arg context "$result" \
            --arg session "$session" \
            --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{id:$id,mode:$mode,chain:$chain,parent:$parent,goal:$goal,task:$task,context:$context,session:$session,created:$created}' \
            > "$INBOX_DIR/$next_id.json"
          log "queued next task $next_id (chain ${chain:-$id})"
        fi
      fi
      if [ "$chain_done" -eq 1 ]; then
        append_chain_summary "$chain" "$output_file" "$chain_reason" 0 "$id"
      fi
    fi

    cp "$output_file" "$OUTBOX_DIR/$id.md"
  else
    cp "$output_file" "$FAILED_DIR/$id.md" 2>/dev/null || true
    log "task $id failed"
    if [ "$mode" = "autonomous" ]; then
      record_last_output_chain "${chain:-$id}"
      append_repl_history "$session" "AUTO TASK (chain ${chain:-$id}): $task" "$(cat "$output_file")"
      append_chain_repl_history "$session" "$chain_log_id" "AUTO TASK (chain ${chain:-$id}): $task" "$(cat "$output_file")"
    fi
  fi

  update_status_file "$status_file" "idle"

  rm -f "$task_file"
}

worker_loop() {
  local worker_id="$1"
  while :; do
    if [ "$SHUTDOWN" -eq 1 ]; then
      log "shutdown requested; worker $worker_id exiting"
      break
    fi
    if [ -f "$STOP_FILE" ]; then
      sleep "$POLL_SECONDS"
      continue
    fi

    local task_file
    task_file="$(find "$INBOX_DIR" -maxdepth 1 -type f -name '*.json' -print -quit)"
    if [ -z "$task_file" ]; then
      sleep "$POLL_SECONDS"
      continue
    fi

    local base
    base="$(basename "$task_file")"
    if mv "$task_file" "$WORKING_DIR/$base" 2>/dev/null; then
      process_task "$WORKING_DIR/$base" "$worker_id"
    fi
  done
}

shutdown() {
  log "shutdown requested"
  SHUTDOWN=1
}

main() {
  ensure_dirs
  requeue_working
  trap shutdown INT TERM

  local i
  for i in $(seq 1 "$AGENT_WORKERS"); do
    worker_loop "$i" &
  done
  wait
}

main "$@"
