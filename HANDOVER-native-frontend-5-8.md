# Handover: native-frontend pivot — Steps 5–8

Resume point for the ClaudeMaster native-frontend rebuild. Steps **0, 1, A, 2, 3,
4 are DONE**; this covers the remaining **5, 6, 7, 8**. Read alongside:
- `PLAN` (approved): `~/.claude/plans/purrfect-rolling-gosling.md`
- `PROTOCOL-stream-json.md` (pinned wire contract, CLI 2.1.198) — **the load-bearing reference**
- memory `project_native_frontend.md` (running status)

## What the pivot is (one line)
Replaced the embedded Claude TUI-in-a-pty with a native chat frontend driven by
`claude` headless over bidirectional **stream-json**, plus an **app-control MCP
server** so Claude can drive ClaudeMaster (open files/panes, spawn subsessions…),
and **same-folder subsessions** (several Claude backends in one dir).

---

## Established infrastructure to REUSE (do not rebuild)

**Backend engine** — `src/main/claudeEngine.ts`
- `ClaudeEngine` = one `claude` process over stream-json. Events: `event` (raw
  ClaudeEvent), `permission` (PermissionRequest), `state` (idle/running/waiting),
  `ready` (claude session id), `exit`. Methods: `sendUserTurn`, `interrupt`,
  `respondPermission`, `kill`.
- `claudeArgs({sessionId, resume?, mcpConfig?, model?, extra?})` builds the argv
  (`-p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --permission-prompt-tool stdio` +
  session-id/resume + `--mcp-config <json-string>` **no --strict** so user MCP
  servers coexist).

**Session lifecycle** — `src/main/sessionManager.ts`
- `SessionManager(opts)` where `opts.mcpConfig(sessionId, remote?) => string|undefined`.
- Public: `create(name,cwd,rootDir,parentId,resume,remote,claudeSessionId?)`,
  `destroy`, `relaunch`, `list`, `claudeSessionId(id)`, `sendUserTurn`,
  `interrupt`, `respondPermission`, `resumeInto(id, claudeSessionId)` (relaunch
  with --resume), `restartFresh(id)` (new session-id, no resume = /clear).
  Events: `event/permission/ready/stateChange/exit` (id-tagged).
- The `replacing` flag + engine-exit-relaunch pattern is how resume/clear swap the
  process without a crash — mirror it for any "relaunch this session" need.

**App-control MCP server** — `src/main/mcpServer.ts` (transport only)
- `AppControlMcpServer`: hand-rolled HTTP JSON-RPC (initialize / tools/list /
  tools/call). `register(tool)`, `start()→port`, `configFor(sessionId)→json`
  (per-session URL token), `release(sessionId)`.
- **Tools are defined in `index.ts`** (they need managers/renderer), registered on
  `appMcp`. Handler signature: `(sessionId, args) => Promise<{text}|{error}>`.
  Existing tools: `list_sessions`, `read_active_pane`, `open_file`, `open_pane`.

**Main↔renderer app-control bridge** — `src/main/index.ts` + `AppControlBridge.tsx`
- `activePane: Map<sessionId, {path,isNotebook}|null>` fed by renderer IPC
  `session:activePane` (published by `AppControlBridge` on tab change). This is the
  active-pane registry — **Step 5's tools resolve their target from it.**
- `askRenderer(op, sessionId, args) => Promise<{text?|error?}>` — request/response
  with reqId correlation + 5s timeout over `appcontrol:request`/`appcontrol:response`.
  Renderer side handled in `src/renderer/src/components/AppControlBridge.tsx`
  (switch on `op`; add new ops there). This is how a tool mutates renderer state.

**Renderer chat** — `store/chat.tsx` + `components/ChatView.tsx`
- Transcript from `on.event`; token streaming via `stream_event`; permission card
  (Allow once / suggestion-labeled always / Deny); MetaBar (model, context meter,
  cost, rate-limit chip); result error banner; `/resume` picker + `/clear`; slash
  menu from init `slash_commands`.
- `useChat()`: transcriptFor, pendingFor, slashCommandsFor, metaFor, sendTurn,
  interrupt, respond, loadTranscript, clearTranscript.

**Resume/history** — `src/main/conversations.ts`: `listConversations(cwd)`,
`readConversation(cwd,id)` reading `~/.claude/projects/<enc>/*.jsonl`
(enc = `cwd.replace(/[^a-zA-Z0-9]/g,'-')`). `ResumePicker.tsx` drives it.

## Verified contracts (don't re-derive)
- Permissions: `--permission-prompt-tool stdio` routes `can_use_tool`; allow resp
  may carry `updatedPermissions` (echo the request's `permission_suggestions`) →
  "allow always", CLI persists per suggestion `destination`. **MCP tool calls that
  aren't allowlisted trigger this same prompt** — that's the gate for Steps 5/6.
- MCP: CLI accepts plain JSON-RPC-over-POST (no SSE); tools appear to Claude as
  `mcp__app__<name>`; per-session URL token = attribution.
- Transcript jsonl lines: `user`/`assistant` (message.content blocks),
  `ai-title`, `last-prompt`; skip `isMeta`/`isSidechain`.

## Build / verify loop
- Typecheck: `npx tsc -p tsconfig.node.json --noEmit` (main/preload) and
  `npx tsc -p tsconfig.web.json --noEmit` (renderer). Then `npm run build`.
- **No display in the dev env** → GUI can't be launched here; user runs `npm run dev`.
- **Headless harness pattern** (proven for engine/MCP): write a `.ts` importing from
  absolute `/home/.../src/main/...`, `npx esbuild <f>.ts --bundle --platform=node
  --format=esm --external:electron --outfile=<f>.mjs`, `node <f>.mjs`. Use
  `--model claude-haiku-4-5-20251001` to keep cost down. This is how to verify
  main-side tools end-to-end without the GUI.

---

## Step 5 — Pane-edit tools + write-through + conflict banner
Goal: Claude edits the file/notebook in the calling session's **active pane**,
live. Subsumes the old `PLAN-live-pane-editing.md` (now superseded).

- **Target = `activePane.get(sessionId)`** (already built). `read_active_pane`
  already fails loud when the Claude tab is active — reuse that guard.
- **New MCP tools** (register in `index.ts`), path-less, notebook-aware:
  `edit_cell`, `add_cell`, `insert_cell`, `delete_cell`, `move_cell`,
  `set_cell_type` (notebooks) + a text `edit_active_file(old,new)` for non-ipynb.
  Each: resolve active pane → `askRenderer('editCell'|…, sessionId, args)`.
- **Renderer op handlers** in `AppControlBridge.tsx`: dispatch the existing
  `store/notebooks.tsx` reducer actions (`ADD_CELL, INSERT_CELL, UPDATE_CODE,
  MOVE_CELL, REMOVE_CELL, SET_CELL_TYPE`) so the pane updates live, then
  **write-through to disk** (`fs:writeFile` / notebook serialize via
  `lib/ipynb.ts`). For text files, dispatch into the CodeEditor/FileView state +
  write-through.
- **Conflict handling** (`NotebookView.tsx`/`FileView.tsx`): baseline hash on
  load + after save; on external change while pane dirty → banner (Reload / Keep
  mine); echo-suppress the app's own writes; debounced autosave to shrink the
  window. Notebook subtlety: running a cell marks it dirty (outputs) — distinguish
  source-dirty from outputs-only-dirty.
- Gotcha: notebook store is keyed by path; make sure write-through uses the active
  pane's path, not a guessed one. Fail loud if pane path ≠ a loaded notebook.

## Step 6 — Session-control tools + same-folder subsessions (the multi-agent headline)
- **Relax `addSubsession`** in `store/sessions.tsx`: today it forces a subdir
  (`openDir(parent.cwd)`, returns early for remotes). Allow `dir === parent.cwd`
  (or omit dir → same folder). `SessionInfo`/`parentId` already support N sessions
  sharing a `cwd`.
- **New MCP tools** (register in `index.ts`):
  - `spawn_subsession({dir?, prompt?})` → `askRenderer('spawnSubsession', sessionId,
    {dir,prompt})`; renderer calls `addSubsession(sessionId, dir)` then, if prompt,
    `sendTurn(newId, prompt)`. Default dir = the caller's cwd (same folder).
  - `create_session({dir})` → `askRenderer('createSession', …)` (renderer
    `createSession`-like; needs a dir, not the native dialog — pass dir through).
  - `close_session({id})` → main-side `sessions.destroy(id)` + `appMcp.release(id)`;
    but the **renderer store must drop it too** → `askRenderer('closeSession',…)`
    calling `closeSession(id)` (which also handles panes/kernels). Prefer routing
    through the renderer store so its bookkeeping stays consistent.
  - `run_in_session({id, prompt})` → main-side `sessions.sendUserTurn(id, prompt)`
    directly (no renderer needed) — enables orchestration.
- **Gating**: these are new/destructive; they're MCP tools so the `can_use_tool`
  prompt already gates them (wide + permission-gated per the plan). No extra work,
  but consider default-denying `close_session` unless explicitly allowed.
- **Concurrency note** (document, don't lock): multiple agents in one dir share the
  fs; rely on Step 5's write-through + baseline compare-and-swap + banner.

## Step 7 — Remote parity (reverse tunnel for the MCP channel)
- Conversation already works remote (engine spawns `ssh … exec claude` stream-json).
  Missing: remote claude can't reach the **local** MCP server.
- **`src/main/ssh.ts` `interactiveArgs(remote, remoteCmd)` (line ~106)**: add a
  reverse tunnel `-R <port>:127.0.0.1:<port>` so remote `localhost:<port>` → local
  server. Thread the MCP port in (interactiveArgs needs to know it, or add a param).
- **`SessionManager` mcpConfig provider** (`index.ts`): currently returns
  `undefined` for remote. Change to return `appMcp.configFor(id)` for remote too
  (the URL is already `127.0.0.1:<port>` = the tunneled port on the remote side).
- **GOTCHA — ControlMaster**: `ssh.ts` uses `ControlMaster=auto` (one shared
  connection per host). A `-R` on a *secondary* multiplexed session may be ignored
  because it reuses the master. Options: put the forward on the master, or use
  `-O forward -R …` against the control socket, or disable multiplexing for the
  claude connection. **Verify the tunnel actually establishes** before wiring tools.
- **Tunnel-failure UX** (per plan §5): Case A (whole ssh drops) = existing session
  loss + Retry. Case B (only `-R` fails, ssh up) = tools error/absent → show a
  per-session "app control disconnected" badge + reconnect; conversation unaffected.
- Resume works remote (jsonl lives on remote). `conversations.ts` is local-only —
  remote /resume would need `remoteFs` listing (defer or note).

## Step 8 — Persistence/restore + retire dead TUI code
- **Persist claude session id**: `SavedSession.claudeSessionId` field already exists
  (`shared/types.ts`). `store/sessions.tsx` `serialize()` must include it — fetch
  via `window.api.session.claudeId(id)` (already exposed) when serializing. Restore
  currently forces `resume=false` (see the comment there) — switch to
  `create(..., resume=true, claudeSessionId)` so sessions **resume their
  conversation** on relaunch. Also replay the transcript on restore via
  `loadTranscript` + `readConversation` for a populated pane (optional polish).
- **Retire dead code**: `components/TerminalView.tsx` is now unused (App uses
  `ChatView`; shell panes use `useTerminal` directly in `PaneView`) → delete it.
  Keep `hooks/useTerminal.ts` + `lib/terminalRegistry.ts` (shell panes need them).
  Remove legacy shims: preload `session.sendInput/resize` + `on.output`, and the
  matching main handlers are already gone. Drop the "legacy" comments.
- Remove any remaining `SavedSession.hasPane` legacy handling once confident.

## Open deferrals (track these)
- Interactive TUI slash commands `/config`, `/login`, model picker, plan-mode
  approval — currently pass through as text = not functional. Need native UI.
- Remote `/resume` (conversations.ts is local-only).
- GUI never run in the dev env — every renderer-facing change needs a `npm run dev`
  pass by the user.
