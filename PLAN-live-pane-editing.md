# Plan: Live pane editing + active-pane-as-subject

Goal: when I ask Claude (running in a session) to edit the notebook/file I'm
looking at, the change shows up **in the pane, live**, and Claude always acts on
**the pane that's active in that session** — never a different open file, and
never the wrong session's file.

## Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | Edits appear in the pane live, no manual reload | The original ask. |
| R2 | Prefer updating the in-memory pane, not a stale disk file | Concluded: write-through to disk is acceptable and better (see R-consistency). |
| R3 | The **active pane** is the implicit subject: "add a cell" → the notebook in the active pane (n2), not another open notebook (n1) | The core new requirement. |
| R4 | Active pane is **per session**, resolved against the *calling* session's active tab — correct even while I'm viewing a different session | App already stores `activeTab` per session. |
| R5 | In split (side-by-side) mode, the file pane shown beside Claude is the active pane | Naturally equals `activeTab` — no special case. |
| R6 | **Fail loud** when the calling session's active tab is the Claude tab (no file visible) — refuse, don't guess | Keeps invariant: Claude only edits a pane I can see. |
| R7 | Must work for **remote** sessions (claude runs over SSH on the remote) | |
| R8 | No external dependencies — nothing to install or run | |
| R9 | Reasonable token cost | |
| R-consistency | Git panel, Claude's own file reads, and other tools should agree with the pane | Argues for disk staying the source of truth. |

Key existing facts (verified in the codebase):
- Sessions are spawned as `pty.spawn('claude', …)` locally, or `ssh <remote> … exec claude` for remotes (`sessionManager.ts`). Remote claude runs **on the remote box**.
- Active tab is per-session state: `browsers[sessionId].activeTab` (store/fileBrowser). `activeId` is only *which session I'm viewing* — a separate thing.
- Split mode only exists when a file tab is active (`splitActive = splitView && !claudeActive && openFiles.length > 0`), so in split, `activeTab` **is** the file beside Claude.
- Notebook state lives in the renderer store (`store/notebooks.tsx`), keyed by path, mutated via reducer actions (ADD_CELL, INSERT_CELL, UPDATE_CODE, MOVE_CELL, REMOVE_CELL, SET_CELL_TYPE). Loaded from disk once on open; nothing watches disk.
- Jupyter already runs as a local, token-guarded server (`{url, token}`) — a proven pattern to mirror.
- No file-watch infra today; no chokidar. `fs.watch` (Node built-in) is available.

---

## Option A — Full MCP

ClaudeMaster hosts a local, token-guarded **HTTP MCP server** (mirrors the
Jupyter server pattern). It exposes notebook tools with **no path argument** —
they target the calling session's active pane:

`read_notebook`, `add_cell`, `insert_cell`, `edit_cell`, `move_cell`,
`delete_cell`, `set_cell_type`.

### Flow of one edit
1. Session B's claude calls `add_cell(code=…)`.
2. MCP server (main process) identifies the **origin session** from a
   session-tagged endpoint/token → session B.
3. Server looks up session B's active pane from a main-side registry
   (`sessionId → { activePath, isNotebook }`) that the renderer keeps updated.
4. If the active tab is the Claude tab or not a notebook → **return an error**
   ("no notebook open in this pane; open one first"). (R6)
5. Otherwise → IPC to renderer → dispatch the store mutation → **pane updates
   live** → **write-through save to disk** (keeps git/reads consistent).
6. Return a result naming the file ("added cell 3 to n2.ipynb").

### How each requirement is met
- **R1/R2** – dispatch into the store re-renders the pane instantly; write-through keeps disk in sync.
- **R3** – tools carry no path; the server resolves to the active tab. Deterministic, enforced server-side.
- **R4** – per-session endpoints (token or `…/mcp?session=<id>`) attribute each call to its origin session, independent of the viewed session.
- **R5** – in split, `activeTab` is the file beside Claude → resolves correctly, no special case.
- **R6** – enforced: the tool itself refuses when there's no visible notebook.
- **R7** – HTTP server is local; the app adds a **reverse SSH tunnel** (`ssh -R`) so remote-claude reaches `localhost:PORT` → local server. Remote fs untouched, nothing installed on the remote.
- **R8** – server is built-in (Node); claude supports MCP natively; the app generates the per-session config. Remote reuses the existing SSH connection.
- **R9** – small, cached tool schemas; a notebook-aware `read_notebook` returns just cell sources (far slimmer than the raw, output-bloated `.ipynb`), so often net-neutral or positive.

### Work items
1. Main: MCP HTTP server (streamable HTTP transport), token auth + per-session routing.
2. Main: active-pane registry, fed by renderer over IPC.
3. Renderer: publish `activeTab` changes (path + isNotebook) to main.
4. Renderer: IPC handler to apply store mutations from MCP + trigger write-through save.
5. Preload: expose the new IPC channels.
6. Session spawn: generate per-session MCP config; pass to claude (`--mcp-config` / generated `.mcp.json`, likely with `--strict-mcp-config`). Remote: add `-R` to ssh args and point config at the tunneled port.
7. Implement the tool set over existing reducer actions + read.
8. Fail-loud errors; result messages naming the file.
9. **Open item:** confirm the exact MCP-config flag for the installed claude CLI version.

### MCP-specific downsides
- **"Will Claude use it?"** Claude may still edit the `.ipynb` with native file tools, bypassing the targeting. (Live update would still work *if* we also run the watcher — see Option C.)
- **Complexity/maintenance:** new server, IPC bridge, config generation, CLI version drift.
- **Remote tunnel** is an added failure mode (drop → tool calls fail until reconnect).
- Source-of-truth split — **mitigated here by write-through**, so disk stays authoritative.

---

## Option B — Full Native (no MCP)

Claude edits files on disk with its native tools; the app watches disk and
reloads the pane. Active-pane targeting is conveyed via a side-channel.

### Mechanisms
- **Live update (R1):** file watcher — `fs.watch` for local, **mtime polling
  over SSH** for remote. On external change: if the pane is clean, reload into
  the store; if dirty, show a "changed on disk" banner. Echo-suppress the app's
  own saves.
- **Active-pane targeting (R3/R4):** a per-session **pointer file** (e.g.
  `.claudemaster/active-<sessionId>`) containing the active notebook's path,
  rewritten on every tab switch. A `CLAUDE.md` convention instructs Claude:
  *"when I say 'the notebook' / 'add a cell', read the pointer to get the target
  path, then edit that file."*

### How each requirement fares
- **R1** – ✔ works, regardless of how Claude edits. Slight delay on remote (poll interval).
- **R2** – ✖ not possible natively; edits inherently go through disk (moot, since MCP write-through also touches disk).
- **R3** – ⚠ **convention-based, best-effort.** Depends on Claude reading the pointer and obeying every turn. Not enforceable; can misfire on unusual phrasing or if Claude forgets.
- **R4** – ⚠ per-session pointer files. Feasible, but the pointer must be discoverable by *that session's* claude — and for remotes it must live on the **remote fs** (written by the app over SSH). More moving parts.
- **R5** – ✔ pointer = `activeTab`, same as MCP.
- **R6** – ⚠ can't be enforced. The convention can say "refuse if no notebook," but Claude might still guess.
- **R7** – ⚠ watcher needs remote mtime polling; pointer files span the SSH boundary. More surface area on the remote.
- **R8** – ✔ no external deps.
- **R9** – watcher adds 0 tokens, but per-turn pointer reads + Claude re-reading the bloated raw `.ipynb` are an **ongoing** cost, potentially higher than MCP.
- **R-consistency** – ✔ disk is inherently the source of truth.

### The crux
R3/R4/R6 — the "active pane is the subject" requirements — are exactly what
native can't do cleanly. They need app **UI state** to drive Claude's decision,
and the only native channel is "write a file and hope Claude reads it and
complies." That's fragile and unenforceable.

---

## Option C — Hybrid (recommended to consider): MCP resolver + watch

Split the problem by which tool is good at what:
- **MCP, but a single read-only tool:** `active_notebook()` → returns the calling
  session's active notebook path (or an error, per R6). Claude then edits that
  path with its **native** file tools.
- **Watcher** picks up the disk change and refreshes the pane (R1).

### Why this is attractive
- **R3/R4/R6** — the resolver gives a *deterministic, per-session* answer (and reports "no notebook" for R6). But note the limit: the tool is **read-only**, so it *encourages* correct targeting, it does not *enforce* it. Claude still writes with native tools and picks the path itself — it could ignore the resolver or edit a different notebook. What makes this workable is that for deictic refs ("this notebook") the resolver is the *only* source of the path (strong incentive), and the watcher can *detect* an edit to a non-active notebook after the fact. So: **resolve + incentive + detect, not enforce.** Enforced targeting requires the write itself to be app-bound to the active pane (Option A) or a per-pane capability-scoped agent (Option D).
- **R1** solved by the watcher — robust regardless of how Claude edits.
- **No source-of-truth split** and **no "will Claude use my edit tool" risk** — Claude keeps using native edit (which it's reliable at); the MCP tool only *tells it what to target*.
- **Minimal MCP surface** → least token overhead, least complexity of any MCP variant.
- Cost: on remote you run **both** mechanisms (reverse tunnel for the resolver call + remote polling for the watch).

---

## Comparison

| Dimension | A: Full MCP | B: Full Native | C: Hybrid |
|---|---|---|---|
| Live pane update (R1) | store dispatch + write-through, instant | watcher reload (poll delay on remote) | watcher reload |
| Active-pane targeting (R3) | **enforced** (app supplies the path) | convention, best-effort, can misfire | **encouraged + detectable** (read-only resolver + watcher), not enforced |
| Per-session correctness (R4) | endpoint-tagged, deterministic | per-session pointer files; remote-side files | resolver answer is per-session/deterministic; compliance still up to Claude |
| Fail-loud (R6) | **enforced by tool** (write refuses) | relies on Claude obeying | resolver returns error; relies on Claude honoring it |
| Git/tools consistency | write-through keeps disk authoritative | disk inherently authoritative | disk inherently authoritative |
| "Will Claude cooperate?" | may bypass edit tools | N/A (always disk) | **low risk** (native edit + read-only resolver) |
| Token cost (R9) | small cached schemas; slim reads | 0 watcher, but per-turn pointer + bloated `.ipynb` reads | smallest MCP footprint |
| Complexity / maint | highest (server, IPC bridge, edit tools, config, tunnel) | moderate (watcher, pointer files, convention) | medium (server + 1 tool, watcher, tunnel) |
| External deps (R8) | none | none | none |
| Robustness of core req (R3) | **strong** (enforced) | **weak/fragile** | **medium** (incentive + detection, not enforced) |

### Remote deep-dive (R7)

**A / C (MCP):** claude runs on the remote; the MCP server + panes are local. Add
`ssh -R` (the app already owns the ssh invocation) so remote `localhost:PORT`
forwards to the local server; point the per-session config there. Remote fs is
untouched, and the remote needs only the `claude` binary it already requires.
Failure mode: tunnel drop → tool calls fail until reconnect (needs handling).

**B (Native):** the watcher must **poll the remote over SSH** for mtime changes
(latency + ongoing cost), and per-session pointer files must be written to and
read from the **remote fs** (via `remoteFs`), so the targeting coordination
crosses the SSH boundary — the most fragile place for the already-fragile R3/R4.
No write-through needed (claude writes remote disk directly), but more moving
parts live on the remote.

**Net for remote:** MCP centralizes the smarts locally and keeps the remote a
thin `claude` + a tunnel. Native pushes coordination onto the remote fs and a
polling loop, which is exactly where R3/R4 are weakest.

---

## Recommendation

- If the decisive requirement is **R3 (active pane is always the subject)** — and
  it is — then a pure-native solution is the wrong tool: it can only *suggest*
  the target to Claude, never *enforce* it.
- **Option C (Hybrid)** is the best *low-complexity* trade: it *resolves* R3/R4/R6
  deterministically (per-session) and makes wrong targeting *detectable* via the
  watcher, gets R1 from the watcher, keeps disk as the single source of truth, and
  avoids the "will Claude use my edit tool" risk. But be clear-eyed: its targeting
  is **encouraged, not enforced** — Claude does the write with native tools and can
  ignore the resolved target. Choose C if "strongly incentivized + detectable" is
  good enough; choose A/D if targeting must be *guaranteed*.
- **Option A (Full MCP)** is worth it only if you specifically want edits routed
  entirely through the app (e.g. to avoid Claude touching disk at all, or to add
  richer pane operations later). It buys enforced targeting *and* in-memory
  editing, at the cost of the largest surface area.

### Open items before build
- Confirm the installed claude CLI's MCP-config mechanism/flags.
- Decide A vs C.
- Decide the write-through save policy (immediate vs debounced) — affects git-panel churn.
