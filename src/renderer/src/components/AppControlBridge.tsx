import { useEffect, useRef } from 'react'
import { useFileBrowser, CLAUDE_TAB } from '../store/fileBrowser'
import { useSessions } from '../store/sessions'
import { useNotebooks } from '../store/notebooks'
import { useChat } from '../store/chat'
import { emitFileTouched } from '../lib/fileEvents'

// Bridges app-control MCP tools (main process) to renderer state/actions:
//  - publishes each session's active pane so path-less tools can target it,
//  - performs renderer-side tool ops (open a file / pane) main forwards.
// Renders nothing; mount once inside the store providers.
export function AppControlBridge() {
  const { browsers, openFile } = useFileBrowser()
  const { sessions, addPane, spawnSubsession, createSessionAt, closeSession } = useSessions()
  const { applyAppEdit, createNotebook } = useNotebooks()
  const { sendTurn } = useChat()

  // Publish the active pane per session whenever tabs change.
  useEffect(() => {
    for (const s of sessions) {
      const b = browsers[s.id]
      const tab = b?.activeTab ?? CLAUDE_TAB
      if (tab === CLAUDE_TAB) {
        window.api.session.publishActivePane(s.id, null)
      } else {
        const f = b?.openFiles.find((of) => of.path === tab)
        window.api.session.publishActivePane(s.id, { path: tab, isNotebook: f ? f.isNotebook : tab.endsWith('.ipynb') })
      }
    }
  }, [browsers, sessions])

  // Keep action refs fresh so the once-subscribed handler never goes stale.
  const openFileRef = useRef(openFile); openFileRef.current = openFile
  const addPaneRef = useRef(addPane); addPaneRef.current = addPane
  const applyAppEditRef = useRef(applyAppEdit); applyAppEditRef.current = applyAppEdit
  // Fresh view of open tabs so the once-subscribed handler reads current state.
  const browsersRef = useRef(browsers); browsersRef.current = browsers
  const createNotebookRef = useRef(createNotebook); createNotebookRef.current = createNotebook
  const spawnSubsessionRef = useRef(spawnSubsession); spawnSubsessionRef.current = spawnSubsession
  const createSessionAtRef = useRef(createSessionAt); createSessionAtRef.current = createSessionAt
  const closeSessionRef = useRef(closeSession); closeSessionRef.current = closeSession
  const sendTurnRef = useRef(sendTurn); sendTurnRef.current = sendTurn
  useEffect(() => {
    return window.api.on.appControlRequest(async ({ reqId, op, sessionId, args }) => {
      const respond = (r: { text?: string; error?: string }) => window.api.session.appControlRespond(reqId, r)
      try {
        if (op === 'openFile') {
          const path = String(args.path)
          openFileRef.current(sessionId, path, Boolean(args.isNotebook))
          respond({ text: `Opened ${path}` })
        } else if (op === 'openPane') {
          await addPaneRef.current(sessionId)
          respond({ text: 'Opened a terminal pane' })
        } else if (op === 'notebookEdit') {
          // "Open" = the path is a live tab in some session's pane (NOT merely
          // cached in the notebooks store, which lingers after a tab closes — that
          // false-positive made closed notebooks take the live path). Open → mutate
          // the store live; not open → quiet disk write. See applyAppEdit.
          const path = String(args.path)
          const isOpen = Object.values(browsersRef.current).some((b) => b.openFiles.some((f) => f.path === path))
          const r = await applyAppEditRef.current(path, String(args.op), args, isOpen)
          respond(r.startsWith('error') ? { error: r } : { text: r })
        } else if (op === 'createNotebook') {
          const r = await createNotebookRef.current(String(args.path))
          respond(r.startsWith('error') ? { error: r } : { text: r })
        } else if (op === 'editActiveFile') {
          // Read → unique-replace → write on disk, then signal the open FileView to
          // reload live (or raise a conflict banner if it has unsaved edits).
          const path = String(args.path)
          const oldStr = String(args.old_string ?? '')
          const newStr = String(args.new_string ?? '')
          const res = await window.api.fs.readText(path)
          if (!res.ok) { respond({ error: `could not read ${path}: ${res.error}` }); return }
          const count = oldStr ? res.text.split(oldStr).length - 1 : 0
          if (count === 0) { respond({ error: 'old_string not found in the file' }); return }
          if (count > 1) { respond({ error: `old_string is not unique (${count} matches) — include more surrounding context` }); return }
          const wr = await window.api.fs.writeFile(path, res.text.replace(oldStr, newStr))
          if (!wr.ok) { respond({ error: `write failed: ${wr.error}` }); return }
          emitFileTouched(path)
          respond({ text: `Edited ${path}` })
        } else if (op === 'spawnSubsession') {
          const id = await spawnSubsessionRef.current(sessionId, args.dir as string | undefined)
          if (id && args.prompt) sendTurnRef.current(id, String(args.prompt))
          respond(id ? { text: `Spawned subsession ${id}${args.prompt ? ' and seeded its first turn' : ''}.` } : { error: 'could not spawn subsession' })
        } else if (op === 'createSession') {
          const id = await createSessionAtRef.current(String(args.dir))
          if (id && args.prompt) sendTurnRef.current(id, String(args.prompt))
          respond(id ? { text: `Opened session ${id} in ${args.dir}.` } : { error: 'could not open session' })
        } else if (op === 'runInSession') {
          sendTurnRef.current(String(args.id), String(args.prompt))
          respond({ text: `Sent a turn to session ${args.id}.` })
        } else if (op === 'closeSession') {
          await closeSessionRef.current(String(args.id))
          respond({ text: `Closed session ${args.id}.` })
        } else {
          respond({ error: `unknown op: ${op}` })
        }
      } catch (e) {
        respond({ error: e instanceof Error ? e.message : String(e) })
      }
    })
  }, [])

  return null
}
