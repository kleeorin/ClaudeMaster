// The models a session can be launched with (the UI picker's list). Model is an
// axis orthogonal to the agent role: role sets charter + tool scope + a DEFAULT
// model, but a per-session pick overrides it (effective = pick → role.model →
// account default). Passed to claude as `--model` (see claudeEngine.claudeArgs).
//
// This is the curated picker list; the MCP `model` arg accepts any string the CLI
// understands, so an orchestrator isn't limited to these.

export interface ModelChoice {
  id: string    // the --model value
  name: string  // display name in the picker
}

export const MODELS: ModelChoice[] = [
  { id: 'claude-opus-4-8', name: 'Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
  { id: 'claude-fable-5', name: 'Fable 5' },
]

export function listModels(): ModelChoice[] {
  return MODELS
}
