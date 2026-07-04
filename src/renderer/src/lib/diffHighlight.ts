import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'

// Per-line decorations for a unified diff, mirroring the git panel's DiffView
// palette (Catppuccin): added lines green, removed red, hunk headers blue, and
// file/index headers muted. Line-based (not token-based) so it stays correct
// while the buffer is edited, and independent of the syntax highlight theme.
const deco = {
  add: Decoration.line({ class: 'cm-diff-add' }),
  del: Decoration.line({ class: 'cm-diff-del' }),
  hunk: Decoration.line({ class: 'cm-diff-hunk' }),
  meta: Decoration.line({ class: 'cm-diff-meta' }),
}

function classify(text: string): Decoration | null {
  if (text.startsWith('+') && !text.startsWith('+++')) return deco.add
  if (text.startsWith('-') && !text.startsWith('---')) return deco.del
  if (text.startsWith('@@')) return deco.hunk
  if (text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('+++') || text.startsWith('---')) return deco.meta
  return null
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      const d = classify(line.text)
      if (d) builder.add(line.from, line.from, d)
      pos = line.to + 1
    }
  }
  return builder.finish()
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = build(view) }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view) }
  },
  { decorations: (v) => v.decorations },
)

const theme = EditorView.baseTheme({
  '.cm-diff-add': { backgroundColor: '#a6e3a114', color: '#a6e3a1' },
  '.cm-diff-del': { backgroundColor: '#f38ba814', color: '#f38ba8' },
  '.cm-diff-hunk': { color: '#89b4fa' },
  '.cm-diff-meta': { color: '#6c7086' },
})

// Extension that colours the buffer as a unified diff. Add it to a CodeEditor
// whose content is a patch.
export const diffHighlighting: Extension = [plugin, theme]
