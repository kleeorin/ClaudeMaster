// node-pty ships a small `spawn-helper` binary that it exec()s at runtime. During
// `npm install` the executable bit can be dropped on extraction/copy, and node-pty
// then fails the moment it launches a shell/ssh/claude with:
//     Error: posix_spawnp failed
// (seen on macOS). Restore +x after install so a fresh clone "just works" without a
// manual chmod. Best-effort and cross-platform: a no-op on Windows or when the file
// isn't present (e.g. node-pty not built yet).
const { chmodSync, existsSync } = require('fs')

const candidates = [
  'node_modules/node-pty/build/Release/spawn-helper',
  'node_modules/node-pty/build/Debug/spawn-helper',
]

for (const path of candidates) {
  try {
    if (existsSync(path)) chmodSync(path, 0o755)
  } catch {
    /* best-effort: perms not critical to fix here beyond the exec bit */
  }
}
