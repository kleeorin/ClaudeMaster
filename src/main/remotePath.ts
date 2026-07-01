// Main-process entry point for the remote-path helpers. The implementation lives
// in shared/ so the renderer uses the identical encoding — see there for docs.
export { isRemote, parseTarget, makeRemotePath } from '../shared/remotePath'
