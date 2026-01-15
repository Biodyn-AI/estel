# Repository Guidelines

## Project Structure & Module Organization
- `agent`: host-side wrapper CLI for starting the container and REPL.
- `scripts/`: container entrypoints and daemon logic:
  - `agentd.sh` (queue worker), `agentctl.sh` (control CLI), `entrypoint.sh` (UID/GID + HOME setup).
- `webui/`: static IDE-style dashboard (`index.html`, `styles.css`, `app.js`) and `server.js`.
- `tests/`: lightweight bash tests with a stub Codex binary in `tests/bin/codex`.
- Docs: `README.md`, `REPL_CONTROLS.MLD`, `TARGET_REPO.md`.
- Runtime state: `logs/`, `queue/`, `tasks/` (git‑ignored).

## Build, Test, and Development Commands
- `./agent start`: build/rebuild container and start daemon.
- `./agent`: start REPL (auto‑follow chains by default).
- `./agent stop`: stop the container.
- `./agent logs`: tail daemon logs.
- `./agent shell` or `./agent shell --root`: debug inside container.
- `docker compose run --rm agent bash tests/run.sh`: run tests in an isolated workspace.

If you change anything under `scripts/`, rebuild with `./agent start` so the container picks up updates.

## Coding Style & Naming Conventions
- Shell scripts are Bash with `set -euo pipefail`.
- Keep changes ASCII unless the file already uses Unicode.
- Prefer descriptive, short variable names; add comments only for non‑obvious logic.
- Keep new docs concise and task‑oriented.

## Testing Guidelines
- Tests are bash‑based (`tests/run.sh`) and use a stub Codex binary.
- Name new tests by adding steps to `tests/run.sh`.
- Run tests in Docker: `docker compose run --rm agent bash tests/run.sh`.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative summaries (e.g., “Fix Codex HOME/USER env for daemon”).
- Keep commits focused on a single change.
- PRs should include a brief description, test results, and any user‑visible behavior changes.

## Agent‑Specific Notes
- REPL controls are documented in `REPL_CONTROLS.MLD`.
- Codex runs inside the container; it expects `HOME=/home/agent` and `USER=agent` (set in compose and daemon).
