# stream-json protocol contract (pinned against claude CLI 2.1.198)

The native-frontend backend drives `claude` headless over a bidirectional
stream-json pipe. This file is the **pinned wire contract** the engine
(`sessionManager.ts` rewrite) codes against. Re-verify on CLI upgrades; guard on
`claude --version` / the init event's `claude_code_version`.

## Spawn

```
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \      # token-level deltas (optional but wanted)
  --verbose \                       # required for full event stream
  --permission-prompt-tool stdio \  # HIDDEN sentinel: route permissions over the control channel
  --session-id <uuid> \             # our id → resume with --resume <uuid>
  --mcp-config <app-control.json> --strict-mcp-config
  [--resume <uuid>] [--fork-session] [--model <id>] [--settings <f>] [--add-dir <d>]
```

`--permission-prompt-tool stdio` is **not shown in `--help`** but exists; the SDK
sets exactly this when a `canUseTool` callback is provided. Without it, headless
mode **auto-decides**: "safe" tools (e.g. `echo`) run, unsafe/non-allowlisted
tools (e.g. `Write`) are **silently auto-denied** (appear in
`result.permission_denials`, no prompt). With it, non-auto-allowed tools emit a
`can_use_tool` control request we answer. `bypassPermissions` mode skips
`canUseTool` entirely.

Remote: same argv after `ssh … exec`, plus `-R PORT:localhost:PORT` for the MCP
channel (see plan §5).

## Sending input (stdin, one JSON object per line)

User turn:
```json
{"type":"user","message":{"role":"user","content":"..."}}
```
`content` may also be a blocks array (text + image blocks). Slash commands are
sent as plain text (`/compact`, `/model …`).

## Output events (stdout, line-delimited JSON)

| `type` (+`subtype`) | Key fields | Use |
|---|---|---|
| `system`/`init` | `session_id`, `cwd`, `model`, `permissionMode`, `tools[]`, `mcp_servers[]`, `slash_commands[]`, `skills[]`, `agents[]`, `claude_code_version`, `memory_paths` | Session header; capture `session_id`. |
| `system`/`thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta` | Live "thinking…" indicator. |
| `rate_limit_event` | `rate_limit_info{status, resetsAt, rateLimitType:"five_hour", overageStatus, isUsingOverage}` | **Proactive limit meter** (parity item — this is the source; it's Free). |
| `stream_event` | wraps standard Anthropic streaming events (`message_start`, `content_block_start`, `content_block_delta` with `text_delta`/`thinking_delta`/`input_json_delta`, `content_block_stop`, `message_delta`, `message_stop`) | Token-level streaming into the active block. |
| `assistant` | `message.content[]` blocks (`thinking`{thinking,signature}, `text`, `tool_use`{id,name,input}); `message.usage`; `parent_tool_use_id` | One event **per content block**. `parent_tool_use_id` ≠ null ⇒ from a subagent. |
| `user` | `message.content[]` `tool_result`{tool_use_id, is_error, content} | Tool result echo (content is the tool output, e.g. `cat -n` text). |
| `result`/`success`\|`error` | `result` (final text), `is_error`, `duration_ms`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage[model]{contextWindow, maxOutputTokens, inputTokens,…, costUSD}`, `permission_denials[]`, `terminal_reason` | Turn end. **Context meter** = cumulative input (input+cache_read+cache_creation) ÷ `modelUsage[model].contextWindow`. |

## Permission control protocol (`--permission-prompt-tool stdio`)

**CLI → client** (a tool needs approval):
```json
{"type":"control_request","request_id":"<uuid>","request":{
  "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
  "input":{...},"tool_use_id":"toolu_…","description":"…",
  "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}
```
`permission_suggestions` powers native **allow-always** options (mode changes /
`addRules`). Optional extras seen: `blocked_path`, `decision_reason(_type)`,
`classifier_approvable`.

**Client → CLI** (answer, echo the same `request_id`):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>",
  "response":{"behavior":"allow","updatedInput":{...}}}}
```
or `{"behavior":"deny","message":"…"}`. **Verified:** allow → tool runs (file
written); deny → tool blocked + listed in `result.permission_denials`.

## Other control requests (client → CLI)

- **Interrupt** (Esc): `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`.
- **initialize** (optional handshake, SDK-style): `{subtype:"initialize", hooks, sdkMcpServers, systemPrompt, appendSystemPrompt, agents, skills, toolAliases, …}` → CLI replies with a `control_response` carrying the slash-command catalog. Needed only for hooks / in-process SDK MCP; **not required** for basic conversation + `stdio` permissions.

## Parity items resolved by step 0

- Proactive limit meter → **Free** (`rate_limit_event`).
- Context-window size → **Free** (`modelUsage[model].contextWindow`); meter is a derive.
- Interrupt, tools, results, cost, thinking, slash-command catalog → confirmed available.
- Interactive-only flows (`/config`, `/login`, model picker) still need native/shell equivalents.
