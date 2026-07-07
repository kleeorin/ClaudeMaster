// node-pty ships a small `spawn-helper` binary that it exec()s at runtime. Its
// executable bit can be dropped on extraction/copy during `npm install`, and on
// macOS a copied/downloaded node_modules can also carry a `com.apple.quarantine`
// xattr that Gatekeeper blocks. Either way node-pty then fails the moment it
// launches a shell/ssh/claude with:
//     Error: posix_spawnp failed.
// (the macOS spawn path exec()s spawn-helper as argv[0], so a missing/blocked
// helper — not the target command — is what fails). Restore +x (and clear the
// quarantine attr) so a fresh clone "just works" without a manual chmod.
//
// Runs from BOTH `postinstall` AND the `rebuild` script: `electron-rebuild`
// regenerates spawn-helper for the Electron ABI *after* postinstall has already
// run, so fixing perms only at install time would leave the rebuilt binary broken.
//
// Best-effort and cross-platform: a no-op on Windows, when node-pty isn't present,
// or before it's been built. Resolves paths from the project root (not cwd) so it
// works no matter where npm invokes it from.
const { chmodSync, existsSync, readdirSync, statSync } = require('fs')
const { execFileSync } = require('child_process')
const { join, resolve } = require('path')

const nodePtyDir = resolve(__dirname, '..', 'node_modules', 'node-pty')
if (!existsSync(nodePtyDir)) process.exit(0)

// Walk node-pty for every `spawn-helper` (build/Release, build/Debug, and any
// arch-nested output dir electron-rebuild may produce). Guard against symlink
// loops with a visited set and a shallow depth cap — the tree is small.
function findHelpers(dir, depth, seen, out) {
  if (depth > 6) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      let real
      try { real = statSync(p).ino } catch { continue }
      if (seen.has(real)) continue
      seen.add(real)
      findHelpers(p, depth + 1, seen, out)
    } else if (e.name === 'spawn-helper') {
      out.push(p)
    }
  }
}

const helpers = []
findHelpers(nodePtyDir, 0, new Set(), helpers)

for (const path of helpers) {
  try { chmodSync(path, 0o755) } catch { /* best-effort */ }
  if (process.platform === 'darwin') {
    // Clear all xattrs (incl. com.apple.quarantine) — `-c` succeeds whether or not
    // any are present, and a build artifact has none worth keeping. Never throw:
    // quarantine removal is a nice-to-have, the exec bit is the load-bearing fix.
    try { execFileSync('xattr', ['-c', path]) } catch { /* best-effort */ }
  }
}
