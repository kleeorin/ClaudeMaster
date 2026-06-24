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

## Linux: sandbox note

On some Linux systems (e.g. without user namespaces enabled) Electron's sandbox will fail to launch. The dev script already passes `--no-sandbox` to work around this. If you hit a sandbox error in a production build, run the output binary with `--no-sandbox`:

```bash
./out/ClaudeMaster-linux-x64/claudemaster --no-sandbox
```

## Troubleshooting

**`node-pty` build fails** — make sure `build-essential` / Xcode CLT are installed, then re-run `npm run rebuild`.

**`claude: command not found`** — ensure `@anthropic-ai/claude-code` is installed globally and that your `PATH` is set correctly in your shell profile (`.bashrc`, `.zshrc`, etc.).

**Blank window on Linux** — try running with `--no-sandbox` (see above).
