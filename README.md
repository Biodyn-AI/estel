# AutoAgents (Dockerized)

Run Codex CLI agents inside a Docker container with a durable queue, REPL, and autonomous chains.
This project is designed to use a Codex subscription via the CLI (no API tokens) while keeping
the host system isolated.

## What this gives you

- A long-running agent daemon (`agentd`) that consumes tasks from a queue.
- A host-side REPL (`./agent`) for natural-language prompts.
- Autonomous chains that keep creating their own next tasks until `DONE`.
- Non-verbose output by default (assistant reply only), with a verbose mode when needed.
- Persistent Codex login stored in a Docker volume (`/home/agent/.codex`).

## Quick start

1) Start the container and open the REPL:

```
./agent
```

2) Log into Codex once (inside the container):

```
./agent shell
codex login
exit
```

3) Use the REPL:

```
> Say hello and list the current directory.
> /auto "Set up a TODO list and then summarize next steps."
```

Notes:
- The REPL starts a background `follow-all` stream by default so you see output from all chains.
- To quiet the stream: `/follow-stop`.

## How it works (architecture)

- `./agent` (host wrapper)
  - Starts the Docker Compose service if needed.
  - Provides the REPL and helper commands.
  - Defaults to non-verbose output.
- `agentd` (inside container)
  - Watches `queue/inbox` for tasks.
  - Runs `codex exec` to answer tasks.
  - Writes results to `queue/outbox` or `queue/failed`.
- `agentctl` (inside container)
  - Creates tasks, follows chains, and inspects status.

The queue is file-based, so tasks and outputs are durable and easy to inspect.

## Manual tasks (one-off prompts)

Manual tasks are single prompts. In the REPL, any line that does not start with `/` becomes a
manual task and is executed synchronously (the REPL waits for completion).

You can also submit a manual task without the REPL:

```
./agent "Summarize README.md"
./agent submit "Explain queue layout"
```

Manual tasks use a session transcript for continuity. The current session id is stored on the
host at `~/.local/state/codex-agent/session` (override with `AGENT_SESSION` or `AGENT_SESSION_DIR`).

Manual tasks can be submitted while autonomous chains are running. The REPL blocks during a
manual task, so for parallel manual work use a second terminal with `./agent submit "..."` or
start a chain with `/auto` and let it run in the background.

To reset the manual conversation history:

```
./agent reset-session
```

## Autonomous chains

Autonomous chains keep running until the model returns `DONE`.

Start a chain:

```
./agent --auto "Set up a roadmap and maintain it."
```

Or from the REPL:

```
> /auto "Prepare release notes and keep refining them"
```

Chains started from the REPL automatically include the current session history, so the chain
can reference prior manual prompts and answers.

Each step of a chain receives:
- the overall `GOAL`
- the current `CURRENT_TASK`
- `CONTEXT_FROM_LAST_STEP` (trimmed to `AUTONOMOUS_CONTEXT_LIMIT`)
- `REPL_HISTORY` (recent manual conversation from the current session, trimmed to `SESSION_CONTEXT_LIMIT`)
- optional `CHAIN_NOTES`

The chain ends when the model returns `DONE` or when you request a stop. If a step returns no
`BEGIN_NEXT_TASK`, the daemon asks Codex to propose a follow-up task based on the goal and
context. The chain id is the id of the first task in the chain.

Expected autonomous response format:

```
BEGIN_RESULT
<your result>
END_RESULT
BEGIN_NEXT_TASK
<the next concrete task>
END_NEXT_TASK
```

If the goal is complete, output exactly:

```
DONE
```

### Chain controls

- Stop a specific chain (after the current task): `/stop <chain-id>`
- Stop all chains: `/stop`
- Stop the last active chain that produced output: `/stop-current`
- Resume a chain: `/resume <chain-id>`
- Add chain notes (influence future steps): `/note <chain-id> <note>`

Stopping a chain lets the in-flight task finish. Any queued tasks for that chain are purged, and
no new tasks are enqueued after the stop is observed.

Chain ids in the UI are short numeric aliases (1, 2, 3, ...). Aliases reset per session, so a
fresh session starts again at 1. Commands accept either the short alias or the full id if you
need to reference older chains.

See `REPL_CONTROLS.MLD` for the full REPL command list.

## Output modes (verbose vs non-verbose)

Default behavior is **non-verbose**: only the assistant's final reply is shown.
This uses `codex exec --output-last-message` internally.

Verbose mode shows the full Codex transcript and tool output.

Ways to enable verbose output:
- One-off: `./agent --verbose "prompt"`
- Autonomous chain: `./agent --verbose --auto "goal"`
- Container-wide default: `AGENT_VERBOSE=1 ./agent`

Raw Codex output is always stored in `queue/runs/<id>/raw.txt`.

## REPL

Start it with `./agent`. It supports natural-language prompts and slash commands.
The REPL is synchronous for manual tasks but **non-blocking** for `/auto`.

To see the full REPL command list:

```
cat REPL_CONTROLS.MLD
```

## Follow output

- `./agent follow <chain-id>`: follow one chain (prints new results as they complete).
- `./agent follow-all`: follow outputs from all chains and manual tasks.

In the REPL, `follow-all` starts automatically. Set `AGENT_FOLLOW_ALL=0` to disable.

## Pausing processing

You can pause the queue without stopping the container:

```
./agent shell
agentctl stop
agentctl start
exit
```

Stopping the container (`./agent stop`) halts all processing entirely.

## File layout

```
queue/
  inbox/            queued task JSON files
  working/          tasks being processed
  outbox/           completed task outputs (.md)
  failed/           failed task outputs (.md)
  runs/<id>/        prompt.txt, raw.txt, output.txt, task.json
  sessions/         manual conversation transcripts
  chains/           chain notes, stop flags, and per-session alias mappings
logs/
  agentd.log        daemon logs
```

## Key commands (host)

- `./agent`             Start REPL (default)
- `./agent "prompt"`    Run one manual task
- `./agent submit "prompt"` Submit a manual task via the queue
- `./agent --auto "goal"` Start autonomous chain
- `./agent start-autonomous "goal"` Same as `--auto`
- `./agent list`        List queued/working/done/failed tasks
- `./agent status <id>` Show status for a task id
- `./agent wait <id>`   Wait for a task to finish and stream output
- `./agent follow <chain-id>` Stream a single chain
- `./agent follow-all`  Stream all outputs
- `./agent reset-session` Clear current manual session
- `./agent shell`       Shell into container as `agent`
- `./agent shell --root` Shell into container as `root`
- `./agent logs`        Tail agent daemon logs
- `./agent start`       Ensure container is running
- `./agent stop`        Stop container

## Key commands (inside container)

```
agentctl submit "prompt"
agentctl start-autonomous "goal"
agentctl start-autonomous --session <id> "goal"
agentctl follow <chain-id>
agentctl follow-all
agentctl list
agentctl status <id>
agentctl wait <id>
agentctl output <id>
agentctl chain-note <chain-id> "note"
agentctl chain-append <chain-id> "note"
agentctl chain-clear <chain-id>
agentctl chain-stop <chain-id>
agentctl chain-stop-all
agentctl chain-stop-current
agentctl chain-resume <chain-id>
agentctl chain-resume-all
agentctl stop
agentctl start
```

Tip: you rarely need these directly; the `./agent` wrapper calls them for you.

## Configuration

Host-side variables:
- `AGENT_SESSION_DIR`   Session dir for manual prompt history on the host.
- `AGENT_SESSION`       Override session id for manual prompts.
- `AGENT_FOLLOW_ALL`    Set to `0` to disable auto follow-all in the REPL.
- `LOCAL_UID`, `LOCAL_GID` Override container UID/GID mapping.

Container variables (set via environment or `docker-compose.yml`):
- `AGENT_WORKERS`            Number of worker loops (default 1).
- `POLL_SECONDS`             Poll interval for the queue (default 2).
- `CODEX_BIN`                Codex CLI binary name (default `codex`).
- `CODEX_FLAGS`              Flags passed to `codex` (default disables sandbox and approvals).
- `CODEX_EXEC_FLAGS`         Extra flags for `codex exec` (default `--skip-git-repo-check`).
- `CODEX_EXEC_MODE`          `stdin` or `arg` (how prompts are passed to `codex exec`).
- `AGENT_VERBOSE`            Default verbosity (0 or 1).
- `AUTONOMOUS_CONTEXT_LIMIT` Max bytes of prior context for chains.
- `SESSION_CONTEXT_LIMIT`    Max bytes stored per manual session.
- `WORKSPACE`                Workspace root inside the container (default `/workspace`).
- `QUEUE_DIR`                Queue root (default `$WORKSPACE/queue`).
- `LOG_FILE`                 Log file path (default `/workspace/logs/agentd.log`).
- `FOLLOW_POLL_SECONDS`      Poll interval for follow commands.
- `FOLLOW_INCLUDE_DONE`      Set to `1` to print prior completed outputs.

## Notes on security and isolation

The container defaults to `CODEX_FLAGS=--dangerously-bypass-approvals-and-sandbox` to avoid
sandbox issues and allow the agent to run commands. This means the agent can execute commands
inside the container without prompting. The workspace is bind-mounted at `/workspace`, so
be mindful of what you allow the agent to modify.

## Troubleshooting

- **Docker daemon not running**: start Docker Desktop and retry `./agent`.
- **Codex not logged in**: run `./agent shell` then `codex login`.
- **Verbose output looks noisy**: use default mode or `--output-last-message` (already default).
- **Need prior outputs in follow-all**: set `FOLLOW_INCLUDE_DONE=1`.
- **AppleDouble files on external drives**: the wrapper removes `._*` automatically, but if you
  keep seeing build errors, delete them manually and rebuild.

## Testing

Tests run inside Docker and use a stub Codex binary to avoid network calls.

```
docker compose run --rm agent bash tests/run.sh
```

The test suite spins up a separate `agentd` with an isolated workspace under `/tmp`.

## Updating Codex CLI

Codex is installed in the container image. To update it:

```
docker compose build --no-cache
```

Then rerun `./agent`.
