# Handover: Live pane editing via MCP (Option A)

**Status:** designed, not started. Decision made — build **Option A**.
**Full option analysis & rationale:** see `PLAN-live-pane-editing.md`. This file is
the action-oriented entry point; read it first, then the PLAN for the "why".

---

## What we're building (one paragraph)

ClaudeMaster hosts a local, token-guarded **MCP server**. Each session's `claude`
is launched pointed at it. The server exposes **path-less, cell-level notebook
tools** (`add_cell`, `edit_cell`, …) that target **the calling session's active
pane** — resolved server-side — then apply the change to the in-memory store
(pane updates live) **and** write through to disk (git/tools stay consistent).
This gives *enforced* active-pane targeting: Claude can't name a wrong file
because it never names a file at all.

## Why A (short version)

- The decisive requirement is **"the active pane is always the subject"** (R3). Only
  a design where the *app supplies the target* can *enforce* that; read-only /
  convention approaches (Option C) only *encourage* it.
- Cell-level tools are **"edit, never write anew" by construction** — no wholesale
  file rewrite, so no clobbering; incremental + notebook-aware (no fragile raw-JSON
  diffing).

## Requirements this must satisfy

| # | Requirement |
|---|-------------|
| R1 | Edits appear in the pane live, no manual reload |
| R2 | Update the in-memory pane (write-through to disk behind it) |
| R3 | **Active pane is the implicit subject** — "add a cell" hits the active notebook, not another open one |
| R4 | Active pane is **per session** — resolved against the *calling* session, even while viewing a different one |
| R5 | Split mode: the file beside Claude is the active pane (already == `activeTab`) |
| R6 | **Fail loud** when the calling session's active tab is the Claude tab (no notebook visible) |
| R7 | Works for **remote** sessions (claude runs over SSH on the remote) |
| R8 | No external dependencies / nothing to install |
| R9 | Reasonable token cost |
| R-consistency | git panel / Claude's file reads / other tools agree with the pane |

---

## Architecture

### Components
1. **MCP server (main process)** — new module, e.g. `src/main/mcpServer.ts`.
   HTTP transport (streamable), token auth, per-session routing. Model it on the
   existing token-guarded **Jupyter server** pattern (`{url, token}` in
   `store/notebooks.tsx` / `jupyterManager.ts`).
2. **Active-pane registry (main)** — `Map<sessionId, { activePath, isNotebook }>`,
   updated by the renderer over IPC on tab switch / open / close. The MCP tools
   resolve their target from this map.
3. **Per-session attribution** — each session's `claude` gets an MCP config whose
   endpoint/token encodes its session id (per-session token, or `…/mcp?session=<id>`),
   so every tool call is attributable to its origin session (satisfies R4).
4. **Store-mutation IPC bridge (main ↔ renderer)** — the MCP handler sends an IPC
   message to the renderer to dispatch the store action + trigger write-through save.
5. **Watcher backstop** — `fs.watch` (local) + mtime-poll (remote). A's robust form
   still needs this: it catches any *bypass* write (Bash) so the pane never silently
   desyncs. (See PLAN: "A converges on A+watcher".)

### The tool set (all path-less; target = calling session's active pane)
`read_notebook`, `add_cell`, `insert_cell`, `edit_cell`, `move_cell`,
`delete_cell`, `set_cell_type`. Map onto existing reducer actions in
`store/notebooks.tsx` (`ADD_CELL`, `INSERT_CELL`, `UPDATE_CODE`, `MOVE_CELL`,
`REMOVE_CELL`, `SET_CELL_TYPE`). Each: **fail loud** if active tab is Claude
tab / not a notebook (R6); else dispatch (live) + write-through; return a result
naming the file ("added cell 3 to n2.ipynb").

### Enforcement (funnel Claude to the tools)
- **Deny native `Write`/`Edit` on `*.ipynb`** via permission rules so Claude must
  use the MCP tools for notebook edits.
- **Known leak: Bash.** Claude can still rewrite via shell (`python -c > nb.ipynb`).
  We accept this; the **watcher backstop** still catches it for *live update* — only
  *targeting enforcement* is lost on that path. Closing Bash fully is
  disproportionate (breaks running notebooks, pip, etc.).
- **New-notebook creation** needs `Write` (Edit can't create files). Since we deny
  Write on `*.ipynb`, give creation a separate path (app-side create, or a
  `create_notebook` MCP tool). **Decide this.**

### Conflict / overwrite handling (still needed in A)
Two writers exist: you (editing the pane) and Claude (via tools → write-through;
or via a Bash bypass). Guard with optimistic concurrency:
- **Baseline** hash/mtime recorded on load + after each save.
- **Echo-suppress** the app's own writes (don't let write-through/save trigger a
  self-reload).
- **Watcher event:** pane clean → adopt disk; pane dirty + real external change →
  **banner** (Reload / Keep mine), never silent.
- **On save:** compare-and-swap against baseline; if disk changed since load, warn
  instead of clobbering.
- **Autosave (debounced)** to shrink the dirty window so conflicts are rare.
- **Notebook subtlety:** running a cell marks the notebook dirty (`ADD_OUTPUT`,
  `SET_EXEC_COUNT`, `CLEAR_OUTPUTS` → `dirtyPatch`). Distinguish *source*-dirty
  from *outputs-only*-dirty; only source divergence should block an auto-reload.

### Remote (R7)
claude runs on the remote; MCP server + panes are local. Add a **reverse SSH
tunnel** (`ssh -R`) in the ssh invocation so remote `localhost:PORT` → local
server; point the per-session config at the tunneled port. Remote fs untouched;
remote needs only the `claude` binary it already has. Handle **tunnel drop**
(reconnect / surface failure). The watcher's remote arm needs mtime polling.

---

## Codebase touchpoints (verified during design)

- `src/main/sessionManager.ts` — spawns claude: local `pty.spawn('claude', …)`,
  remote `ssh <remote> … exec claude`. **Add** per-session MCP config; for remote
  add `-R` to the ssh args.
- `src/main/ssh.ts` — `interactiveArgs`; add reverse-tunnel flag here.
- `src/main/index.ts` — `ipcMain` handlers; wire up MCP server lifecycle,
  active-pane registry, and the store-mutation IPC.
- `src/preload/index.ts` — expose new IPC channels (active-pane publish; apply-edit).
- `src/renderer/src/store/notebooks.tsx` — reducer actions the tools map to; add an
  "apply from MCP" dispatch path + write-through + autosave. `getServerInfo` here is
  the token-guarded-server precedent.
- `src/renderer/src/store/fileBrowser.tsx` — `activeTab` per session; publish
  active-pane changes to main.
- `src/renderer/src/components/NotebookView.tsx` — save/dirty logic; add autosave +
  conflict banner.
- `src/renderer/src/App.tsx` — layout already done: strip (file tab, no split) puts
  Claude below the active pane; split puts it beside; `activeTab` per session is the
  active-pane source of truth. No layout work needed for this feature.

---

## Open items (resolve before/early in build)

1. **Verify the installed `claude` CLI's config surface** (use the
   `claude-code-guide` agent): MCP config mechanism (`--mcp-config` / generated
   `.mcp.json` / `--strict-mcp-config`) **and** the permission-deny mechanism
   (settings.json `permissions` / `--disallowedTools`) for `*.ipynb`.
2. **MCP server lib / SDK** for the Node HTTP server (transport choice).
3. **New-notebook creation path** (since Write on `*.ipynb` is denied).
4. **Write-through timing** (immediate vs debounced) + **autosave cadence** — affects
   git-panel churn and the size of the conflict window.
5. **Non-notebook text files** — same pattern later (own tools), out of scope for v1.

## Suggested build order

1. Confirm CLI flags (item 1) — gates everything.
2. MCP server skeleton (main) + token auth + a trivial `read_notebook` returning the
   active pane's cells. Prove the round-trip end-to-end **local** first.
3. Active-pane registry + renderer publish IPC.
4. Store-mutation IPC + one write tool (`add_cell`) with fail-loud + write-through.
   This is the vertical slice that demonstrates R1+R3+R6.
5. Remaining tools.
6. Deny-rules for native `.ipynb` writes; creation path.
7. Watcher backstop + conflict handling + autosave.
8. Remote: reverse tunnel + per-session config + remote mtime polling.
