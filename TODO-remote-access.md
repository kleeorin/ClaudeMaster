# TODO: Remote / headless access for ClaudeMaster

Goal: run the Electron app on a remote (headless) machine — so Claude sessions,
Jupyter kernels, and files all live on the remote — and stream the GUI to a
laptop. ClaudeMaster's main process spawns local ptys (`sessionManager.ts`,
`jupyterManager.ts`, `paneManager.ts`), so the app must run where you want the
work to happen.

## Done

- **`launch-remote` script** (project root, executable). Run it ON the remote:
  - Checks deps (`Xvfb`, `x11vnc`, `npm`).
  - Starts a virtual display (`Xvfb`), runs `npm run dev` on it, exposes it via
    `x11vnc` bound to **localhost only**.
  - Clean teardown on Ctrl-C (no orphaned Xvfb/x11vnc).
  - Env knobs: `VNC_PASSWORD` (recommended), `DISPLAY_NUM` (default 99),
    `RESOLUTION` (default 1920x1080x24), `VNC_PORT` (default 5900).
  - Connect: `ssh -L 5900:localhost:5900 you@remote`, then a native VNC viewer
    at `localhost:5900`.
- Confirmed expected behavior: full interactivity over VNC — mouse clicks,
  drag, scroll, keyboard input, right-click menus, and copy/paste *within* the
  remote desktop all work.

## To do (later)

1. **Cross-machine copy/paste fix** — laptop↔remote clipboard sync needs a
   clipboard manager on the virtual display; bare Xvfb has none, so it can
   silently fail. Add `autocutsel` (`sudo apt install autocutsel`) started on
   the virtual display inside `launch-remote`.
2. **Browser access (`WEB=1` mode)** — optional noVNC + websockify front end so
   the GUI opens in a browser instead of a native VNC client:
   - `sudo apt install novnc websockify`
   - serve on e.g. port 8080; connect via `ssh -L 8080:localhost:8080` →
     `http://localhost:8080/vnc.html`.
   - Note: still a streamed desktop, not a real web app.
3. **GPU crash fallback** — if a bare headless box crashes on GPU init, add
   `--disable-gpu` to the `dev` script in `package.json` (already `--no-sandbox`).
4. **Docs** — add a "Remote access" section to `README.md` and optionally a
   `dev:remote` npm script that calls `./launch-remote`.

## Local GUI → remote session over SSH (DONE)

The "alternative" below — run Electron locally, each session ssh's into the
remote — is now implemented (VS Code Remote-SSH model). See README "Local GUI →
remote session (SSH)". Summary of the design:

- **Remote-path scheme** (`shared/remotePath.ts`): remote dirs are encoded as
  `remote://<remoteId>/abs/path`, so the whole fs/git IPC surface stays
  path-only; a single `parseTarget` at each main-process boundary routes
  local vs remote.
- **SSH transport** (`main/ssh.ts`): shell-quoting + `ControlMaster` connection
  multiplexing (fs/git polling would be unusable otherwise). Batch mode for
  fs/git/test; interactive (`-tt`) for session/pane ptys.
- **Saved remotes** (`main/remotes.ts`, `remotes.json`): CRUD + `test`,
  managed via the RemotesModal; picked from the New Session menu.
- **Sessions/panes**: `ssh -tt host 'exec $SHELL -lc "cd <dir> && exec claude"'`
  — pty stays local, so the terminal state detection is unchanged.
- **Filesystem** (`main/remoteFs.ts`): each fs:* handler mirrored over ssh
  (find/stat/cat/base64/cp/mv/mkdir/…).
- **Git** (`main/gitManager.ts`): the `git()` runner routes through ssh; output
  parsing untouched.
- **Jupyter** (`main/jupyterManager.ts`): per-remote server, started over ssh
  with an `-L` tunnel; renderer still talks to a localhost port.

### Still to do / limitations

- macOS remotes (BSD `find`/`stat` differ from the assumed GNU coreutils).
- Remote delete uses `gio trash` → `rm -rf` fallback (may be permanent).
- `shell.openPath` ("open externally") doesn't work for remote files.
- No in-app password/2FA auth — relies on keys/agent/ssh-config.

## Alternative (not pursued — superseded by the above)

Run Electron locally and have each session `ssh` into the remote + tunnel
Jupyter ports. (Now pursued and implemented — see above.)
