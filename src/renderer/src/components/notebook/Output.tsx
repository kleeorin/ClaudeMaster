import type { CellOutput } from '../../lib/kernelClient'

function AnsiText({ text }: { text: string }) {
  // Strip ANSI escape codes for display
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
  return <>{clean}</>
}

function MimeContent({ data }: { data: Record<string, string> }) {
  if (data['text/html']) {
    return <div className="text-sm" dangerouslySetInnerHTML={{ __html: data['text/html'] }} />
  }
  if (data['image/png']) {
    return <img src={`data:image/png;base64,${data['image/png']}`} className="max-w-full" />
  }
  if (data['image/svg+xml']) {
    return <div dangerouslySetInnerHTML={{ __html: data['image/svg+xml'] }} />
  }
  if (data['text/plain']) {
    return <pre className="text-xs text-ctp-text whitespace-pre-wrap font-mono">{data['text/plain']}</pre>
  }
  return null
}

export function Output({ output }: { output: CellOutput }) {
  switch (output.type) {
    case 'stream':
      return (
        <pre className={`text-xs font-mono whitespace-pre-wrap ${output.name === 'stderr' ? 'text-ctp-red' : 'text-ctp-text'}`}>
          <AnsiText text={output.text} />
        </pre>
      )
    case 'result':
    case 'display':
      return <MimeContent data={output.data} />
    case 'error':
      return (
        <div className="text-xs font-mono text-ctp-red space-y-0.5">
          <div className="font-semibold">{output.ename}: {output.evalue}</div>
          <pre className="whitespace-pre-wrap opacity-80">
            {output.traceback.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')}
          </pre>
        </div>
      )
  }
}
