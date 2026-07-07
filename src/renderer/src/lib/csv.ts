// Minimal RFC 4180-ish CSV/TSV parsing + serialising for the table editor.
// Handles quoted fields (delimiter, quote and newline inside quotes; "" escapes a
// literal quote). Kept dependency-free — CSV previews are size-capped upstream, so
// we don't need a streaming parser.

// Pick a delimiter from the filename (.tsv → tab, everything else → comma).
export function delimiterFor(filename: string): ',' | '\t' {
  return /\.tsv$/i.test(filename) ? '\t' : ','
}

// Parse into a grid of rows × cells. A trailing newline is ignored so we don't
// emit a spurious empty final row (but a blank line in the middle is preserved).
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length

  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue } // escaped quote
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === delimiter) { endField(); i++; continue }
    if (c === '\r') { i++; continue } // fold CRLF → LF
    if (c === '\n') { endRow(); i++; continue }
    field += c; i++
  }
  // Flush the last field/row unless the text ended exactly on a row break.
  if (field !== '' || row.length > 0) endRow()
  return rows
}

// Serialise a grid back to a CSV/TSV string. Quote a field only when it contains
// the delimiter, a quote, or a newline; escape embedded quotes by doubling.
export function serializeCsv(rows: string[][], delimiter = ','): string {
  const needsQuote = (s: string) =>
    s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')
  const cell = (s: string) => (needsQuote(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return rows.map((r) => r.map(cell).join(delimiter)).join('\n')
}
