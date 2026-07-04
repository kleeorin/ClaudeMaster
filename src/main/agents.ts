// Agents (roles) — the persistent identity a session runs as. Orthogonal to the
// session/subsession axis: a session is the runtime instance + tree position; an
// AGENT is what that instance is configured to BE (charter + tool scope + model).
// Every session runs as an agent; the default `general` is today's behavior (no
// system prompt, full tools, the user's default model), so nothing changes unless
// a non-default agent is chosen. See HANDOVER-roles.md.
//
// These are ClaudeMaster-native roles (NOT Claude Code `.claude/agents`): each runs
// as a full, separate top-level `claude` process with its own context window and
// cost — that isolation is the point. The fields map onto launch flags in
// claudeEngine.claudeArgs (systemPrompt → --append-system-prompt, tool scope →
// --allowed/--disallowedTools merged with NOTEBOOK_DENY, model → --model).

export interface Agent {
  id: string
  name: string                 // display name / sidebar badge
  description: string          // shown to an orchestrating agent via list_agents
  systemPrompt?: string        // persistent charter → --append-system-prompt
  model?: string               // pin a model (e.g. haiku for cheap roles); undefined = user default
  allowedTools?: string[]      // whitelist → --allowedTools
  disallowedTools?: string[]   // blacklist → --disallowedTools (MERGED with NOTEBOOK_DENY)
}

// Pinned so the cheap exploration role stays cheap. Others inherit the user's
// configured default model (already an Opus-class model), so we don't hardcode a
// choice that can drift.
const HAIKU = 'claude-haiku-4-5-20251001'

export const AGENTS: Record<string, Agent> = {
  general: {
    id: 'general',
    name: 'General',
    description: 'Default agent — no special charter, full tools, the user\'s default model. Same as an ordinary session.',
  },
  explorer: {
    id: 'explorer',
    name: 'Explorer',
    description: 'Cheap read-only searcher. Sweeps the codebase and reports file:line conclusions; never edits. Good for fan-out research you want distilled back.',
    model: HAIKU,
    disallowedTools: ['Write', 'Edit'],
    systemPrompt:
      'You are an Explorer subagent. Your job is to search broadly and report '
      + 'conclusions, not to change anything. Read files, grep, and trace code, then '
      + 'answer with concrete file:line references and a tight summary. You must NOT '
      + 'edit files. When you are done, state your findings concisely so the parent '
      + 'session can act on them.',
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Read-only code reviewer. Finds correctness bugs and reports them as a numbered list; never fixes them itself.',
    disallowedTools: ['Write', 'Edit'],
    systemPrompt:
      'You are a Reviewer subagent. Review the code for correctness bugs, unsafe '
      + 'assumptions, and missed edge cases. Report findings as a numbered list, each '
      + 'with a file:line and a one-line explanation. You must NOT edit files or apply '
      + 'fixes — reviewing and fixing are separate roles. Be specific and avoid '
      + 'speculative nitpicks.',
  },
  implementer: {
    id: 'implementer',
    name: 'Implementer',
    description: 'Focused builder. Makes a scoped change (ideally in its own subdirectory via the spawn `dir` arg) and reports what it did.',
    systemPrompt:
      'You are an Implementer subagent. Make the requested change within your scope '
      + '(prefer the directory you were started in). Keep edits minimal and matching '
      + 'the surrounding style. When you finish, summarize exactly what you changed so '
      + 'the parent session can integrate it.',
  },
}

// Appended to EVERY subsession's system prompt (any role, keyed on having a
// parentId — see sessionManager.launch). Reporting is otherwise opt-in, and a
// subsession that just writes its answer into its own transcript never reaches the
// parent: the parent can't see the child's session and is only ever woken by a
// report landing in its inbox. So we make report_to_parent the required final step.
export const SUBSESSION_REPORT_INSTRUCTION =
  'You are running as a SUBSESSION spawned by a parent Claude session. IMPORTANT: '
  + 'your work does NOT reach the parent automatically — the parent cannot see this '
  + "session's transcript. The ONLY way your result reaches it is the `report_to_parent` "
  + 'tool. So when you finish the task you were given, you MUST call `report_to_parent` '
  + 'with a concise summary of your findings/result (and a status like "done" or '
  + '"blocked"). Treat that call as the required final step of the task — you are not '
  + 'done until you have reported. Writing your answer only in this chat does nothing.'

// Resolve an agent id to its definition, defaulting to `general` for an unknown or
// missing id (so a stale saved id or a typo can never fail a launch).
export function getAgent(id?: string): Agent {
  return (id && AGENTS[id]) || AGENTS.general
}

// Is `id` a real agent? Used to reject bad ids at the MCP tool boundary (with a
// helpful list) rather than silently falling back to general.
export function isAgent(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENTS, id)
}

// Compact catalog for the list_agents MCP tool and any UI.
export function listAgents(): Array<Pick<Agent, 'id' | 'name' | 'description'>> {
  return Object.values(AGENTS).map(({ id, name, description }) => ({ id, name, description }))
}
