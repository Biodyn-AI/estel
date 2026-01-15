# Using AutoAgents With Another Repo

AutoAgents is the controller repo. The target repo is mounted into the container and Codex is pointed at it via `-C`. This keeps queue/logs in AutoAgents and all edits in the target.

## Recommended (persistent) setup

Create a `docker-compose.override.yml` (local-only) that mounts your target repo and sets Codex working dir:

```yaml
services:
  agent:
    volumes:
      - /path/to/target-repo:/workspace/target
    environment:
      CODEX_FLAGS: "--dangerously-bypass-approvals-and-sandbox -C /workspace/target"
      # Optional: drop skip-git-repo-check for repo awareness
      # CODEX_EXEC_FLAGS: ""
```

Then:

```bash
./agent start
./agent
```

All work happens inside `/workspace/target`.

## One-off (no file changes)

You can override `CODEX_FLAGS` for a single run, but the repo still must be mounted:

```bash
CODEX_FLAGS="--dangerously-bypass-approvals-and-sandbox -C /workspace/target" ./agent
```

## Multiple target repos

Mount multiple repos and switch between them:

- Mount under `/workspace/targets/<name>`
- Start sessions with different `CODEX_FLAGS` values

Or run separate containers with different `COMPOSE_PROJECT_NAME` values so each has isolated queues/logs.

## Notes

- AutoAgents queue/logs stay in `/workspace` (this repo).
- Target repo changes are isolated to `/workspace/target`.
- If you tighten sandboxing, add `--add-dir /workspace/target` to `CODEX_FLAGS` so the agent can write there.
