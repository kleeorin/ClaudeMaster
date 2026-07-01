# ClaudeMaster

A multi-session GUI for [Claude Code](https://claude.ai/code) built with Electron. Run and manage multiple Claude Code sessions side-by-side in a single window.

## Prerequisites

### 1. Node.js

Install Node.js 20 LTS or later.

**Linux (via nvm — recommended):**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Restart your shell, then:
nvm install 20
nvm use 20
```

**macOS:**
```bash
brew install node@20
```

**Windows:** Download from [nodejs.org](https://nodejs.org).

### 2. Native build tools

`node-pty` is a native module and requires a C++ build toolchain.

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install -y build-essential python3
```

**macOS:** Install Xcode Command Line Tools:
```bash
xcode-select --install
```

**Windows:** Install [windows-build-tools](https://github.com/felixrieseberg/windows-build-tools) or Visual Studio Build Tools with the "Desktop development with C++" workload.

### 3. Claude Code CLI

ClaudeMaster launches `claude` in each session, so the CLI must be on your `PATH`.

```bash
npm install -g @anthropic-ai/claude-code
```

Verify it works:
```bash
claude --version
```

### 4. Jupyter (only for the notebook feature)

Opening or creating a `.ipynb` from the file browser starts a Jupyter kernel.
ClaudeMaster launches the server with the `python3` on your `PATH`
(`python3 -m jupyter server`), so Jupyter must be installed for that `python3`:

```bash
python3 -m pip install jupyter-server notebook ipykernel
```

If it's missing, the notebook panel shows "kernel unavailable" with an
**Install jupyter & retry** button that runs the command above for you.

**Kernels / environments.** The kernel dropdown in a notebook's header lists
whatever kernelspecs are *globally registered* on the machine
(`jupyter kernelspec list`) — ClaudeMaster does **not** install or modify any.
These specs live in a shared directory (`~/.local/share/jupyter/kernels`), so the
same list appears in every Jupyter frontend (JupyterLab, classic Notebook, etc.),
not just this app. Each kernel is started in the notebook's own directory (or a
directory you pick via **Custom directory…**), so per-project virtualenvs resolve
correctly.

If present, ClaudeMaster defaults a notebook to a kernelspec named
`python-autovenv` (a user-provided launcher that picks the nearest venv); install
your own with that name to opt in, otherwise it falls back to the default
`python3` kernel. Register a venv as a selectable kernel with:

```bash
/path/to/venv/bin/python -m ipykernel install --user --name myproj \
  --display-name "Python (myproj)"
```

## Installation

```bash
# Clone the repo
git clone <repo-url>
cd ClaudeMaster

# Install dependencies
npm install

# Rebuild native modules (node-pty) against the bundled Electron version
npm run rebuild
```

## Running

**Development mode** (hot-reload):
```bash
npm run dev
```

**Production build:**
```bash
npm run build
npm run preview
```

## Remote / headless access

You can run ClaudeMaster on a remote (headless) machine and view the GUI from
your laptop. This is the right setup when you want the actual work — Claude
sessions, Jupyter kernels, files — to live on the remote box. The app's main
process spawns local ptys, so it must run *where the work should happen*; the
remote streams only the display.

The included `launch-remote` script handles this by running the app on a virtual
X display (`Xvfb`) and exposing it over VNC, bound to **localhost only**.

### On the remote machine

Install the extra dependencies (one time):
```bash
sudo apt install xvfb x11vnc
# optional but recommended for laptop↔remote copy/paste:
sudo apt install autocutsel
```

Then start the app (after the normal `npm install` / `npm run rebuild`):
```bash
VNC_PASSWORD=somesecret ./launch-remote
```

The script starts `Xvfb`, runs `npm run dev` on it, and serves it with `x11vnc`.
Press **Ctrl-C** to stop everything — it tears down Xvfb/x11vnc cleanly.

Config via environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `VNC_PASSWORD` | _(none)_ | Password required to connect. **Set this.** |
| `DISPLAY_NUM` | `99` | Virtual X display number |
| `RESOLUTION` | `1920x1080x24` | Virtual screen geometry |
| `VNC_PORT` | `5900` | VNC port (bound to localhost) |

### On your laptop

VNC is bound to localhost on the remote, so reach it through an SSH tunnel —
never expose the VNC port directly:

```bash
ssh -L 5900:localhost:5900 you@remote-host
```

Then point any VNC viewer at `localhost:5900` and enter the `VNC_PASSWORD`.

Mouse, keyboard, scroll, drag, right-click menus, and copy/paste *within* the
remote desktop all work over VNC. Cross-machine (laptop↔remote) clipboard sync
requires the `autocutsel` package above.

> **GPU crashes on a bare headless box?** Add `--disable-gpu` to the `dev`
> script in `package.json` (it already passes `--no-sandbox`).

## Local GUI → remote session (SSH)

The reverse of the VNC setup above: run ClaudeMaster **on your laptop** but have a
session's work — the Claude terminal, extra panes, the file browser, the git
panel, and Jupyter — all execute on a **remote host** over SSH. This is the VS
Code Remote-SSH model. The GUI stays local; each remote session's processes and
files live on the remote.

### Prerequisites (on the remote)

- **Key/agent auth.** ClaudeMaster never prompts for a password — it relies on
  your SSH keys / agent / `~/.ssh/config`. Make sure `ssh <host>` works
  non-interactively from a terminal first.
- **First connection.** Connect once from a terminal (`ssh <host>`) so the host
  key is trusted, or add `StrictHostKeyChecking=accept-new` to the remote's SSH
  options (below). Background file/git calls use batch mode and will fail on an
  unknown host key.
- **GNU coreutils** (Linux remote): `find`, `stat`, `base64`, `cp`, `mv`, etc.
  (macOS remotes aren't supported yet — BSD `find` differs.)
- **`claude`** on the remote's login `PATH` — needed for the Claude terminal
  itself. If it's missing, the session still opens and the file browser, git
  panel, and terminals all work; the Claude pane shows "Claude isn't running…"
  with a **Retry** (install `claude` on the remote, then click Retry — no need to
  recreate the session).
- **`python3 -m jupyter`** on the remote, only if you open notebooks there.

### Add a remote

Click **+ New Session → Manage remotes…**, then **Add remote**:

| Field | Example | Notes |
|-------|---------|-------|
| Label | `gpu-box` | Shown on sessions from this host. |
| SSH host | `me@gpu-box` | Anything `ssh` accepts — `user@host` or a `~/.ssh/config` alias. |
| Start folder | _(blank)_ | Optional. Where the folder picker opens; blank = the remote's home directory. |
| SSH options | `-p 2222 -i ~/.ssh/id_ed25519` | Extra `ssh` args (`-p`, `-i`, `-J` jump host, `-o …`). |

Hit **Test connection** to confirm reachability + auth, then **Save**.

### Start a remote session

**+ New Session** now lists **Local…** plus each saved remote. Pick a remote and
the folder picker opens on the remote filesystem (starting at its home directory,
or the optional start folder) — browse to the project folder and confirm. The
session (and everything in it) runs there. Remote sessions carry a small host
badge in the sidebar, and restore on relaunch just like local ones. Subsessions
of a remote session are remote too.

Under the hood, ssh connection multiplexing (`ControlMaster`) keeps one connection
warm per host, so file navigation and git refreshes stay snappy after the first
connect.

> **Remote delete is not always recoverable.** Local deletes go to the OS trash;
> on a remote, ClaudeMaster uses `gio trash` when available and otherwise falls
> back to `rm -rf`. Treat remote deletes as permanent unless `gio` is installed.

## Linux: sandbox note

On some Linux systems (e.g. without user namespaces enabled) Electron's sandbox will fail to launch. The dev script already passes `--no-sandbox` to work around this. If you hit a sandbox error in a production build, run the output binary with `--no-sandbox`:

```bash
./out/ClaudeMaster-linux-x64/claudemaster --no-sandbox
```

## Troubleshooting

**`node-pty` build fails** — make sure `build-essential` / Xcode CLT are installed, then re-run `npm run rebuild`.

**`claude: command not found`** — ensure `@anthropic-ai/claude-code` is installed globally and that your `PATH` is set correctly in your shell profile (`.bashrc`, `.zshrc`, etc.).

**Blank window on Linux** — try running with `--no-sandbox` (see above).

**Notebook says "kernel unavailable"** — Jupyter isn't installed for the `python3`
on your `PATH`. Install it (`python3 -m pip install jupyter-server notebook ipykernel`)
or use the **Install jupyter & retry** button, then reopen the notebook.

**Wrong / missing kernel in the dropdown** — the list comes from
`jupyter kernelspec list` (globally registered specs), not from ClaudeMaster.
Add one with `python -m ipykernel install --user --name … --display-name …`.
