# WebUI Guide

AutoAgents includes a browser-based IDE-style dashboard for monitoring and controlling chains, files, and REPL activity.

## Accessing the WebUI
- Start the container: `./agent start`
- Or start the UI directly: `./agent ui`
- Open the UI: `http://localhost:5177`
- Finder picker: `./agent ui --finder` (choose a folder, then the UI points at `./container` inside it)
- The top bar includes a **switch workspace** button that opens the same Finder picker.
- The header shows `container` and `session` status. If these are stale, refresh the page or restart the container.

## Layout Overview
- **Left pane (Folders):** Workspace tree with file and folder actions.
- **Center pane (Editor / Chains / Statistics):** File preview/editor by default, with toggles for chain detail view and stats.
- **Right pane (Agents):** Chain creation, chain list, and chain controls.
- **Bottom pane (REPL):** Streaming conversation history with multi-tab chain views.

## Working with Files
- Click a file to preview it in the center pane.
- Click `Edit` to enable editing and `Save` to write changes.
- Use the tree controls to `New file`, `New folder`, `Rename`, `Delete`, or `Refresh`.
- When editing, large files are truncated; save is disabled for truncated previews.

## Chains and Agents
- **Create chain:** Use the “Create chain” box in the Agents pane.
- Choose `manual` or `auto`, then click `Create chain`.
- **Follow chain:** Select a chain and click `follow` to open its detail view.
- **Add note:** Click `note` to append context (same as `/note+`).
- **Stop current:** Stops the most recently active chain; when no chain is active the button is disabled.

## REPL Tabs
- The REPL includes a **main** tab plus per-chain tabs.
- Click `+manual` or `+auto` to create a new chain and open its tab.
- **Rename a tab:** double-click the tab label. Names are saved locally.
- **Close a tab:** click the `x` on the tab (this only hides the tab, it does not stop the chain).

### REPL Input Behavior
- **Main tab:** sends commands/prompts to the shared REPL.
- **Chain tab:** input applies to that chain:
  - Plain text appends context to the chain.
  - Commands: `/note`, `/note+`, `/note-clear`, `/stop`, `/resume`.

## Chains Detail View
- In the center pane, switch to **Chains** to view a list of chains.
- Click a chain to see its runs, prompts, outputs, and status lines.

## Statistics View
- Switch the center pane to **Statistics** to view totals and per-chain metrics:
  - tokens, duration, active runs, failures, and averages.

## Night Mode
- Use the `night mode` button in the top bar to toggle themes.
- The preference is saved in your browser.

## Tips
- If the UI seems empty, verify the container is running and refresh.
- Chain tabs are purely a UI feature; closing a tab does not stop or delete a chain.
