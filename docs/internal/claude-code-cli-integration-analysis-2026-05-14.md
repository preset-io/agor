# Claude Code CLI Integration Analysis — 2026-05-14

**Author:** scoping pass (analyze-claude-code-cli-integration worktree)
**Status:** Draft for Max review. No code yet. Implementation worktrees spawn after signoff.
**Companion PRs (already merged):** #1136 (Codex subscription auth UX) — the analogous pattern.

---

## TL;DR

1. **Integration tightness is much better than feared.** The `claude` shell binary exposes `--print --verbose --input-format=stream-json --output-format=stream-json`, which keeps a single long-lived process alive across many turns and streams the same structured events the SDK does: `system/init`, `assistant`, `result`, `rate_limit_event`, `stream_event` (with `--include-partial-messages`), plus optional `hook` events. Cost (`total_cost_usd`), token usage with cache breakdown, `modelUsage`, `contextWindow`, `maxOutputTokens`, `permission_denials`, `terminal_reason` are all first-class fields. **We do not need a JSONL file watcher as the primary data source.** The disk JSONL stays as a useful fallback / backfill mechanism.

2. **Recommended spawn shape is *not* "wrap inside the web terminal."** The web terminal is a passthrough PTY — we never see structured events through it. The right shape is a daemon-spawned `claude` child with stdio piped to the executor, semantically equivalent to how the SDK is wired today. The xterm.js modal stays a manual shell. We can optionally add a "raw terminal view" of the running agent as a secondary UI mode, but it should not be the primary bridge.

3. **The unavoidable regression is permission prompts.** The CLI takes a single static `--permission-mode` at spawn (`default | acceptEdits | bypassPermissions | plan | dontAsk | auto`). There is no programmatic prompt-and-await-user API like the SDK's `canUseTool` callback. For subscriber UX we recommend defaulting to `acceptEdits` (the closest equivalent to "do work, only stop on dangerous things") and surfacing the mode as a session setting. The Agor permission-modal UX simply will not fire for CLI-mode sessions. Document loudly.

4. **Most other gaps either don't exist or have first-class CLI flags:** model picker (`--model`), effort (`--effort low/medium/high/xhigh/max`), MCP injection (`--mcp-config`, `--strict-mcp-config`), session id (`--session-id <uuid>`), fork (`--fork-session`), resume (`--resume <id>`), budget cap (`--max-budget-usd`), additional dirs (`--add-dir`), system prompt (`--append-system-prompt`), context-1M beta (`--betas`).

5. **Effort estimate: ~1-2 PRs for v1**, ~70-80% of code is parallel to the existing Codex adapter. Most novel work is the `apiKeySource` / `claude auth login` UX panel and the rename of the existing `claude-code` agentic tool to `claude-agent-sdk`.

---

## Context

Anthropic is restricting Claude **Agent SDK** access for Claude 20×/Max subscription users: only API-key billing accounts work through the SDK going forward. The shell binary `claude` (which authenticates against the subscription via `claude auth login`) remains usable. (Cite: Max's report — Anthropic announcement URL TBD, please paste if you have it.)

Agor currently dispatches `agentic_tool: 'claude-code'` through the Agent SDK (`packages/executor/src/sdk-handlers/claude/`). Subscribers cannot use that path anymore. We need an additive integration — call it `claude-code-cli` — that wraps the shell binary, while the existing SDK adapter is renamed to `claude-agent-sdk` and stays available for API-key users.

Analog precedent: Codex's auth lives entirely in the CLI binary's `~/.codex/auth.json` and Agor doesn't try to manage credentials directly (see `packages/executor/src/sdk-handlers/codex/prompt-service.ts:205-217`, `apps/agor-ui/src/components/CodexSettingsForm/`). PR #1136 (merged) improved this UX. We mirror the same idea for the CLI's `~/.claude/.credentials.json`.

---

## Why the integration is more tractable than the brief feared

The original framing assumed "the CLI gives us a terminal, and bridging to `Task`/`Messages` requires hacks on top of the JSONL persistence file." That framing is correct for an *interactive* terminal session, but the CLI also exposes a fully programmatic mode:

```
claude --print --verbose \
       --input-format=stream-json \
       --output-format=stream-json \
       --session-id <uuid> \
       --model <alias-or-id> \
       --effort <level> \
       --permission-mode <mode> \
       --mcp-config <file>
```

In this mode, `claude` reads JSONL user messages on stdin and writes structured events to stdout, *with no TTY required*. The process stays alive across multiple turns until stdin closes. Verified by spawning a real session and piping two `{"type":"user","message":{...}}` messages with a sleep between them — both produced complete `result` events on stdout (replies `"1"` and `"2"`, two `result` lines, two `system/init` lines, one `rate_limit_event`).

This is essentially the same shape as the SDK. The CLI integration can be ~90% structurally identical to the SDK adapter — different process, same plumbing.

---

## Verified facts from a live `claude` v2.1.132 session

All gathered in this worktree on 2026-05-14:

- **Binary:** `/usr/bin/claude`, version `2.1.132 (Claude Code)`.
- **Disk persistence:** `~/.claude/projects/<slugged-cwd>/<session-id>.jsonl` — one JSONL per session, plus `<session-id>/subagents/agent-<id>.jsonl` for `Task()`-tool sub-agents (with `isSidechain: true`).
- **Slug rule:** `/` and `.` both → `-` in the cwd path. So `/var/lib/agor/home/agorpg/.agor/worktrees/foo` becomes `-var-lib-agor-home-agorpg--agor-worktrees-foo` (the `--` represents the `.agor` dotfile boundary). Confirmed on multiple paths.
- **`--session-id <uuid>` works** — we can pre-generate UUIDv4 and pin it (different convention from Agor's UUIDv7 short-ids, but a `(agorSessionId ↔ claudeSessionId)` mapping is trivial).
- **`--print` with stream-json IS multi-turn**, despite the help text saying "print response and exit" — when stdin stays open and `--input-format=stream-json` is set, the process keeps consuming user messages and emitting `result` events until stdin closes. Verified empirically.
- **`--resume <id>` appends to the same JSONL.** Verified.
- **`--fork-session` (with `--resume` or `--continue`)** creates a new session ID instead of reusing the original — true fork at the CLI level, no wrapper needed.
- **File is fully line-buffered.** Every line in the JSONL is a complete JSON object — no partial-line buffering concerns. (Verified by `awk '$0!~/^\{.*\}$/'` returning empty.)
- **JSONL `entrypoint` is `"sdk-ts"` regardless of whether spawn came from SDK or CLI** — confirmed by running `claude --print` directly and reading the resulting file. So we cannot distinguish SDK vs CLI invocations from the JSONL itself. (Not a real problem — we know which we spawned.)

### Event types observed on disk JSONL (real session, this worktree)

```
ai-title            — autogenerated session title (e.g. "Analyze Claude Code CLI agentic-tool integration")
last-prompt         — preview of the most recent user prompt, truncated ~120 chars
queue-operation     — enqueue/dequeue lifecycle markers around each turn
user                — user message (top-level prompt OR tool_result via toolUseResult)
assistant           — assistant turn with message.{content, usage, model, stop_reason, stop_details, requestId}
attachment          — system attachments: skill_listing, budget_usd, deferred_tools_delta, pendingMcpServers
```

### Event types observed on stdout in stream-json mode

```
system        — subtype:init  — cwd, session_id, tools[], mcp_servers[], model, permissionMode,
                                apiKeySource, claude_code_version, output_style, agents[], skills[],
                                plugins[], analytics_disabled, memory_paths, fast_mode_state
rate_limit_event — rate_limit_info {status, resetsAt, rateLimitType (e.g. "five_hour"), overageStatus, isUsingOverage}
assistant     — incremental assistant chunks. message.content[] blocks: text | thinking | tool_use
stream_event  — appears when --include-partial-messages. Fine-grained streaming (token-level / block-level).
result        — terminal event per turn. duration_ms, duration_api_ms, num_turns, result, stop_reason,
                total_cost_usd, usage, modelUsage{<model>:{costUSD, contextWindow, maxOutputTokens, ...}},
                permission_denials[], terminal_reason
```

`assistant.message.usage` includes:
```
input_tokens, output_tokens,
cache_creation_input_tokens, cache_read_input_tokens,
cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens},
service_tier, inference_geo, iterations[]
```

### Cost is first-class

`result.total_cost_usd` is computed by the CLI for every turn. `result.modelUsage[<model>]` includes `costUSD`, `contextWindow`, and `maxOutputTokens` per model used in the turn. **Crucial:** for subscription users this number is "list price" (what an API-key user would have paid) — the subscription is flat-rate, so we must label it accordingly in the UI ("approximate, covered by subscription"). The `system/init` event includes `apiKeySource: "none" | "user" | …` — we use that to distinguish billing modes per session.

### Rate limit signals are first-class

`rate_limit_event` fires whenever the CLI hits a rate-limit boundary. Fields include `status`, `resetsAt` (epoch), `rateLimitType` (`"five_hour"` etc.), `overageStatus`, `overageDisabledReason`, `isUsingOverage`. **The SDK probably emits the same, but Agor doesn't currently surface it.** We should surface it for both adapters as a side-benefit.

---

## Existing "Claude Code" (SDK) integration — what we keep

Map of the current SDK adapter (becomes the `claude-agent-sdk` tool after the rename):

| Capability | Where it lives today |
|---|---|
| Adapter entry | `packages/executor/src/handlers/sdk/tool-registry.ts` (registers `claude-code`); `packages/executor/src/handlers/sdk/claude.ts` (`executeClaudeCodeTask`) |
| Event handling | `packages/executor/src/sdk-handlers/claude/message-processor.ts` (SDK events → `ProcessedEvent`); `packages/executor/src/handlers/sdk/base-executor.ts:109-196` (`createStreamingCallbacks`); persisted via `messagesService.create()/patch()` |
| Cost/tokens | `packages/executor/src/sdk-handlers/claude/normalizer.ts`; `packages/executor/src/handlers/sdk/base-executor.ts:428-507` patches the task row. SDK returns `total_cost_usd` already, no Agor-side price map. |
| MCP injection | `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:69-207` (`getMcpServersForSession`); `packages/executor/src/sdk-handlers/claude/query-builder.ts:289+` |
| Permission flow | `packages/executor/src/sdk-handlers/claude/permissions/permission-hooks.ts` (`canUseTool` → WebSocket `permission:requested` → modal → `waitForResponse`) |
| Model + betas + effort | `packages/executor/src/sdk-handlers/claude/model-utils.ts` (`parseModelWithBetas`); `query-builder.ts:184-188` (strip `[1m]` → `context-1m-2025-08-07` beta) |
| External prompt | `packages/executor/src/sdk-handlers/claude/prompt-service.ts:112-175` (`promptSessionStreaming`); resumes via `sdk_session_id` |
| Spawn/fork | `packages/core/src/sessions/resolve-child-session-config.ts`; cross-tool gate at L66-73 |
| Compaction | Delegated to SDK (`/compact` slash command). No server-side compaction. |
| CLAUDE.md | `packages/executor/src/sdk-handlers/claude/session-context.ts` (appends "## Agor Session Context" block) |
| Auth/API key | `packages/executor/src/handlers/sdk/base-executor.ts:274-296` (`resolveApiKeyForTask`); precedence: user-encrypted → config → env → SDK native |
| Tool enum | `packages/core/src/types/agentic-tool.ts:18` (`AgenticToolName` union, currently 5 entries) |
| UI picker | `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx`, `AgentSelectionGrid/availableAgents.ts` |

Everything in this table stays for API-key users.

---

## Capability mapping

For each Agor capability: SDK source, CLI source, gap/mitigation.

| Agor capability | SDK source | `claude` CLI source | Gap / mitigation |
|---|---|---|---|
| Persist user message | SDK callback | `{"type":"user"}` line on JSONL **and** echoed on stdout when `--replay-user-messages` set; we push them so we know what we sent | Trivial; we write them ourselves before sending to stdin |
| Persist assistant turn | SDK message | `{"type":"assistant"}` on stdout | Direct equivalence |
| Streaming text/thinking blocks | SDK chunk callbacks | `assistant.message.content[]` blocks (`text`, `thinking`, `tool_use`); `--include-partial-messages` emits `stream_event` for token-level | Reuse existing `SDKMessageProcessor` shape after small adapter |
| Tool call & tool_result | SDK events | `tool_use` block in assistant message; subsequent `user` event has `toolUseResult` and `sourceToolAssistantUUID` | Direct equivalence; identical field semantics |
| Token in/out + cache | SDK event field | `result.usage` + per-iteration `usage`; `assistant.message.usage` per chunk | Direct; richer breakdown than SDK in some places |
| Dollar cost | SDK `total_cost_usd` | `result.total_cost_usd` + `result.modelUsage[<model>].costUSD` | Direct equivalence. Subscription: list price, label as estimated |
| Rate-limit signal | (SDK probably emits; Agor doesn't surface) | `rate_limit_event` | **New capability** — surface in UI for both adapters |
| External prompt injection | `promptSessionStreaming` | Write `{"type":"user","message":{...}}` to long-running stdin | Direct equivalence; single daemon-managed process |
| Spawn subsession | New SDK session | New `claude` child with new `--session-id` | Trivial |
| Fork session | SDK fork | `claude --resume <id> --fork-session` | First-class CLI flag |
| MCP server attachment | SDK option | `--mcp-config <file>` (`--strict-mcp-config` to ignore user MCPs) | Direct equivalence; write JSON config to a per-session tmpfile |
| Model selection | SDK option | `--model <alias\|id>` | Direct equivalence |
| `[1m]` extended context | SDK option with `context-1m-2025-08-07` beta | `--betas context-1m-2025-08-07` (alongside `--model claude-…`) | Direct equivalence |
| Effort level | SDK option | `--effort low\|medium\|high\|xhigh\|max` | Direct; Agor's `max` maps to CLI `max` (CLI also has `xhigh`, can expose) |
| Budget cap | (Agor-side computed) | `--max-budget-usd <amount>` | First-class CLI flag — could even **delegate** budget enforcement to the CLI |
| CLAUDE.md / context dirs | SDK auto-loads | CLI auto-loads from `cwd`; `--add-dir <dirs...>` adds more | Direct equivalence |
| Permission mode | SDK option | `--permission-mode` (static at spawn) | **Mode is set; prompts are NOT programmatically interceptable** — see Blind Spots |
| Real-time permission prompt | `canUseTool` callback → UI modal | None | **Hard gap. Mitigation: default `acceptEdits`; expose mode setting; document loudly.** |
| Compaction events | SDK emits | CLI emits to JSONL when `/compact` runs | Direct equivalence (verify by triggering `/compact` once) |
| Cost reconciliation across subscription vs API-key | `apiKeySource` in `system/init` | Same | Tag session-level: `billingMode: subscription \| api-key` from init event |
| Auth (subscription) | N/A (SDK is API-key only post-restriction) | `~/.claude/.credentials.json` managed by `claude auth login` | New UI panel mirroring Codex pattern |
| Auth (API key) | `ANTHROPIC_API_KEY` env / `apiKeyHelper` | Same; pass via spawn env | Direct equivalence — both adapters can share the existing User Settings → Claude Code Auth panel |
| Mid-session model switch | Not actually supported by SDK either | Not supported (need re-spawn) | **Non-regression** — flag both as "set at session start" |
| `Task()` subagent tool | SDK internal | `<session>/subagents/agent-<id>.jsonl` written by CLI | We don't persist sub-agent threads today; consider as a bonus capability |

---

## Blind spots

For each, an explicit "accept" or "mitigate":

### 1. Programmatic permission prompts (HARD GAP — UX regression)

**Problem.** The SDK's `canUseTool` callback lets Agor block the agent mid-tool-call and ask the user via WebSocket modal. The CLI has no equivalent. `--permission-mode` chooses a static policy at spawn:

- `default` — CLI internally prompts on its own TTY. Useless for us (no TTY in stream-json mode → the CLI will hang or auto-deny, TBD).
- `acceptEdits` — auto-approve edits, prompt for shell commands. (Behavior in stream-json mode needs verification.)
- `bypassPermissions` — approve everything. (What our internal SDK sessions use today.)
- `plan` — research-only, no edits.
- `dontAsk` / `auto` — auto-deny on uncertainty.

**Mitigations.**
- v1 default: `acceptEdits`. Most aligned with subscriber expectation ("the CLI usually does the right thing"). Verify what happens in `--print --output-format=stream-json` mode for prompts that would normally fire — likely they get serialized into a `permission_denials` entry on the next `result` (verify before commit).
- Expose `permission-mode` as a per-session setting in the UI (analogous to Codex's `sandboxMode` / `approvalPolicy`). Codex precedent: `apps/agor-ui/src/components/CodexSettingsForm/CodexSettingsForm.tsx`.
- The Permission Mode picker in NewSessionModal needs adapter-conditional rendering: SDK shows the rich mode picker; CLI shows the CLI's permission-mode choices with a banner "prompts will not be intercepted by Agor."
- Document loudly in the agent card description and in the User Settings → Claude Code CLI page.

### 2. Mid-session model / effort switching (NON-REGRESSION)

**Problem.** Static at spawn. **Same is true for the SDK.** Re-flag as "set at session start; new session to switch."

### 3. Watching stdout *and* the JSONL is redundant (ARCHITECTURAL CHOICE)

**Problem.** Same events appear in both places. Which is the source of truth?

**Mitigation.** Use stdout as primary (low latency, structured per turn, includes `result.total_cost_usd` not present in the JSONL). Use JSONL as a fallback/audit log (for crash recovery: if the daemon dies mid-turn, on restart we can read the JSONL to backfill missing messages). The JSONL also makes `--resume` possible cleanly.

### 4. Multi-turn `--print` behavior is undocumented in `--help` (RISK)

**Problem.** `--help` says `--print` exits after one response, but empirically with `--input-format=stream-json` it stays alive across many turns. Anthropic could change this any release.

**Mitigation.** Pin a tested `claude` version range in our binary check (`packages/executor/src/sdk-handlers/codex/codex-tool.ts:124-132` already does `which codex` — mirror for `claude`, parse `--version`, warn on untested versions). Add an integration test that asserts multi-turn behavior at startup or in CI (would have to be opt-in since it costs subscription quota).

### 5. Subagent threads (`<session-id>/subagents/agent-<id>.jsonl`) (DEFERRED FEATURE)

**Problem.** When the `Task()` tool runs an internal sub-agent, it writes a separate JSONL with `isSidechain: true`. We don't ingest these today (the SDK doesn't surface them either).

**Mitigation.** v1: ignore. v2: optional watcher that ingests sidechain JSONL as collapsible "internal subagent" rows in the UI (parallel improvement that also benefits the SDK adapter).

### 6. Slugging the cwd to find the JSONL (FRAGILE)

**Problem.** We derive the disk path by slugging `/` and `.` → `-`. Anthropic could change this.

**Mitigation.** Don't depend on slugging for the primary path. The `system/init` event includes the actual `cwd` and `session_id`, and `--session-id` is set by us. The on-disk file is `~/.claude/projects/<slug>/<session_id>.jsonl` — we can compute the slug at runtime by reading `~/.claude/projects/` and matching by `session_id` rather than guessing the slug. Make the slug rule a single utility with unit tests, and document the assumption.

### 7. Cost is "list price" for subscribers (LABELING)

**Problem.** `total_cost_usd` reflects what an API-key user would have paid. For subscription users, the cost is flat-rate; per-session $ figures mislead.

**Mitigation.** Read `system/init.apiKeySource`. Persist `billingMode: 'subscription' | 'api-key' | 'unknown'` on the session. In the cost UI for subscription sessions: show the number with an explicit "estimated; covered by your Claude subscription" caption, or hide the running-total and show only token usage. Engineering call: probably keep showing but caption.

### 8. Permission-mode + missing TTY (UNKNOWN)

**Problem.** When `permission-mode: default` and a tool would normally prompt, what does `--print --output-format=stream-json` (no TTY) do? Hang? Auto-deny? Emit a structured `permission_request` event?

**Mitigation.** **MUST verify before settling on default mode.** v1 spike before implementation: run a session in stream-json mode with `permission-mode: default` and trigger a Bash command. Document the answer. If it auto-denies → `acceptEdits` is the right default. If it emits a structured event → maybe we *can* bridge prompts to the UI after all (best case). If it hangs → we must default to `bypassPermissions` / `acceptEdits` and document.

### 9. Rate-limit visibility (BONUS)

**Problem (inverse).** `rate_limit_event` is emitted by the CLI but not by Agor today. Subscribers hit `five_hour` limits frequently.

**Bonus.** Add a `RateLimitsBanner` to the session panel for CLI sessions (and retrofit the SDK adapter to emit the equivalent, if the SDK surfaces it).

### 10. "Wrap inside the existing web terminal" is the wrong primitive (ARCHITECTURAL CALLOUT)

**Problem.** The existing web terminal (`apps/agor-daemon/src/services/terminals.ts`, `packages/executor/src/commands/zellij.ts`) is a strict passthrough PTY — `pty.onData()` writes raw bytes to a socket channel. No TEE, no structured capture. Running `claude` in there gives us a terminal view but **zero events for `Task`/`Messages`**.

**Mitigation.** Don't do that for the structured integration. The `claude-code-cli` adapter spawns `claude` as a daemon child with stdio pipes, just like the SDK is spawned. Optionally, we add a *separate* feature: a "live terminal view" mode for any agent (SDK or CLI) that surfaces the rendered TTY output of the agent process. That's an independent UX improvement, not the structured bridge.

---

## Proposed architecture

### Spawn shape

A new executor adapter at `packages/executor/src/sdk-handlers/claude-cli/`:

```
claude --print --verbose \
       --input-format=stream-json \
       --output-format=stream-json \
       --include-partial-messages \           # optional, for token-level streaming
       --session-id <agorSessionId-or-mapped-uuid> \
       --model <resolved model alias> \
       --betas context-1m-2025-08-07 \        # if model has [1m] suffix
       --effort <resolved effort> \
       --permission-mode <user-setting, default acceptEdits> \
       --mcp-config <tmp json file with agor MCP + user MCPs> \
       --strict-mcp-config \                  # ignore the user's global ~/.claude.json
       --add-dir <repo root>,<each shared dir> \
       --append-system-prompt-file <file with Agor session context> \
       --max-budget-usd <optional cap>
```

The process runs under the daemon (in `simple`/`insulated` modes) or under the session creator's Unix user (in `strict` mode), reusing the existing `unix_user_mode` plumbing.

Env vars:
- `ANTHROPIC_API_KEY` set IFF user has configured a key in User Settings; **unset** if user is on subscription auth (then the CLI reads `~/.claude/.credentials.json`).
- `CLAUDE_CODE_SIMPLE=0` (default; don't pass `--bare`).
- `HOME` honored; the CLI's auth and cache live under `$HOME/.claude/`. In `strict` unix mode, each Unix user has their own `~/.claude/` and runs their own `claude auth login`. In `insulated` mode, there's one executor user with one `~/.claude/` — collaborators share one subscription (intentional / matches today's Codex behavior, document).

### Event ingestion

- A line-buffered stdout reader feeds each event into a CLI-side `MessageProcessor` parallel to the SDK's `SDKMessageProcessor`. The output `ProcessedEvent` shape is identical.
- Mapping rules:
  - `system/init` → write `(claudeSessionId, billingMode, mcpServers[], permissionMode, model)` to a new `session.cli_runtime` JSONB column. Surface `billingMode` + `model` in the UI.
  - `assistant` → upsert assistant message rows by `assistant.uuid`. Content blocks (`text` / `thinking` / `tool_use`) populate `message.content` and child `tool_calls`.
  - `stream_event` (when `--include-partial-messages`) → optional token-level streaming, behind a setting (off by default to keep DB write rate manageable).
  - `tool_use` → create empty tool-call row (UI shows "running"), patched when the next `user` event arrives with `toolUseResult` for the matching `tool_use.id`.
  - `result` → patch the current task row: status `completed`, `cost_usd`, `tokens_*`, `num_turns`, `terminal_reason`, `permission_denials`.
  - `rate_limit_event` → emit a WebSocket event for the UI banner; persist last-known state on the user record so the banner appears even after page reload.

### External prompt injection

- The CLI child stays alive. New prompts are written as `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}` to the child's stdin.
- `agor_sessions_prompt(sessionId, prompt)` with `mode: "continue"` → write to stdin of the existing process.
- With `mode: "fork"` → spawn a NEW `claude --resume <originalId> --fork-session` child to get a fresh session id, then continue with it.
- With `mode: "subsession"` → spawn a NEW `claude --session-id <new uuid>` child with the parent's CLAUDE.md context.
- All of these match the SDK adapter's mode semantics exactly.

### Permission flow

- v1: default `--permission-mode acceptEdits` (subject to verification per Blind Spot #8).
- Expose `permission-mode` as a per-session setting on the agent card and in NewSessionModal under the CLI tab.
- For CLI sessions, the Permission Modal subsystem is INERT. Add a small "Permissions: handled by CLI binary, mode: `<mode>`" badge on the session panel where the existing Permission Modal would otherwise appear, with a tooltip linking to the docs.
- `result.permission_denials[]` IS visible after each turn — surface as a "Denied: tool X" row in the session feed, with a "switch to acceptEdits to allow this" CTA if the current mode is `default` / `dontAsk`.

### Cost & rate limits

- Persist `cost_usd` from `result.total_cost_usd` exactly like the SDK adapter does today.
- Add a `billing_mode` column to `tasks` (or compute it from the session): `subscription` | `api-key`. UI captions cost for subscription sessions.
- New `RateLimitsBanner` component listens for `rate_limit_event` (CLI) / equivalent (SDK if available) and shows resetsAt countdown. Lives on the session panel header.

### Spawn / fork / subsession

- `AGENTIC_TOOL_CAPABILITIES['claude-code-cli']`:
  ```
  supportsSessionFork: true,   // --fork-session
  supportsChildSpawn: true,    // spawn new claude --session-id
  supportsSessionImport: true, // can adopt an existing on-disk JSONL
  stateless: false             // process is long-lived
  ```
- Genealogy bookkeeping: same as today (`packages/core/src/sessions/resolve-child-session-config.ts`).
- Bonus capability unique to CLI: **session import.** Because the CLI persists every session to disk, we can offer "Adopt existing Claude session" — read a JSONL from `~/.claude/projects/`, ingest its messages, and let the user resume in Agor with `--resume <id>`. Useful for power users who run `claude` outside Agor first.

### Auth & credentials

Mirror Codex (PR #1136):
- New UI panel: User Settings → "Claude Code CLI Auth" (next to "Claude Code Auth" which we rename to "Claude Agent SDK Auth").
- Status indicator: read `~/.claude/.credentials.json` (or run `claude auth status` if it exists in this version — verify with `claude auth --help`) and show "Logged in as `<email>`" or "Not logged in. Run `claude auth login` on this host."
- For multi-user environments (`insulated` / `strict` modes): show the daemon's / executor's / session-user's `~/.claude/` status separately.
- API key option still works — falls back to setting `ANTHROPIC_API_KEY` env var on spawn for users who prefer to use their key.

### MCP injection

- Write a per-session tmp file: `/tmp/agor-mcp-<sessionId>.json` containing Agor's MCP server config + any user-level MCPs scoped to this session.
- Pass `--mcp-config <file> --strict-mcp-config` (the strict flag prevents the user's global `~/.claude.json` from leaking other MCPs in).
- File is cleaned up on session end.
- Reuse `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:getMcpServersForSession` to build the list.

---

## Migration / coexistence

### Rename

- `'claude-code'` → `'claude-agent-sdk'` (the existing SDK adapter).
- New `'claude-code-cli'` is introduced.
- DB migration: rewrite existing `sessions.agentic_tool = 'claude-code'` to `'claude-agent-sdk'`. Backfill `worktrees.agentic_tool` too. (Both columns: see `packages/core/src/types/worktree.ts:457`.)
- Update `AgenticToolName` union (`packages/core/src/types/agentic-tool.ts:18`) and `Tool` (`packages/executor/src/handlers/sdk/tool-registry.ts:14`).
- UI labels: "Claude Agent SDK" (formerly "Claude Code") + "Claude Code CLI" (new). Sublabels: "API-key billing, full structured features" vs "Claude subscription, CLI binary wrapper."

### Settings & picker surfaces

- `apps/agor-ui/src/components/AgentSelectionGrid/availableAgents.ts` — add new entry with install check (`which claude`), version probe, and onboarding link.
- `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx` — both tools appear in the grid; selection swaps the form to the right tool-specific config component (mirrors Codex / Claude split today).
- `apps/agor-ui/src/components/AgenticToolConfigForm/` — new `ClaudeCliConfigForm` mirroring `CodexSettingsForm` structure: model picker (claude models), effort picker, permission-mode picker (with disclaimer), MCP toggle.
- User Settings → Default Agentic Config — already keyed by tool name (`currentUser.default_agentic_config[tool]`); no special handling needed beyond adding the new key.
- Permission Mode picker on the Claude tab: replace the SDK's modes with the CLI's `acceptEdits | bypassPermissions | plan | default | dontAsk` choices and a banner: "These map to the `claude` CLI's `--permission-mode` flag. Prompts will not be intercepted by Agor."

### Default model picker

- Today: User Settings → Default Agentic Config keys the default model per tool. The CLI accepts the same model aliases the SDK does (`opus`, `sonnet`, `haiku`, `claude-opus-4-7`, etc.). Reuse `packages/core/src/models/claude.ts` for the dropdown options.
- `[1m]` suffix → CLI: split into `--model <base>` + `--betas context-1m-2025-08-07`.

### Onboarding affordance

- First-time User Settings panel detects:
  - `claude` binary present? → version match? → `~/.claude/.credentials.json` present?
  - If yes: "Looks like you're set up with Claude Code CLI. Default new Claude sessions to CLI mode?" with `[yes]` / `[no, use API key with the SDK]`.
  - If no: "Are you a Claude 20× or Max subscriber? Install Claude Code from anthropic.com/install and run `claude auth login` to use Claude Code CLI."

---

## Phased delivery plan

### v1 — Spawn + structured ingest (1-2 PRs, ~3-5 days)

- Add `'claude-code-cli'` to type unions and tool registry.
- New executor adapter `packages/executor/src/sdk-handlers/claude-cli/` (mostly forked from `claude/` adapter; ~70-80% identical scaffolding).
- Stdout stream-json reader → `ProcessedEvent` → `MessagesService` + `TasksService`.
- Spawn flags: `--print --input-format=stream-json --output-format=stream-json --session-id --model --effort --permission-mode --mcp-config --strict-mcp-config --add-dir --append-system-prompt-file`.
- `--permission-mode acceptEdits` default (after verifying Blind Spot #8).
- Cost + tokens + cache breakdown from `result` event.
- Rename `claude-code` → `claude-agent-sdk` (DB migration, UI labels).
- New `claude-code-cli` entry in `AgentSelectionGrid` and the agent picker.
- `RateLimitsBanner` consuming `rate_limit_event`.
- Disk-based crash recovery: on daemon restart, read the JSONL files for in-flight sessions and backfill missing messages by `uuid`.

**Out of scope for v1:** custom UI for permission prompts (there is none), subagent thread ingestion, session import from existing on-disk JSONL.

### v1.5 — Auth UX & external prompting polish (1 PR, ~2 days)

- "Claude Code CLI Auth" User Settings panel.
- Onboarding affordance in the user dropdown / first-run wizard.
- External prompts via `agor_sessions_prompt` (stdin write to long-lived child).
- `permission_denials` row in the session feed.

### v2 — Session import, sub-agent ingestion (1 PR, ~3 days)

- "Adopt existing Claude session" picker: list `~/.claude/projects/*/`*.jsonl`, parse, ingest into Agor as a new session.
- Sub-agent JSONL ingestion (`<session>/subagents/agent-<id>.jsonl`) as collapsible "internal subagent" rows. Also benefits SDK adapter retroactively.
- Mid-session model switch (re-spawn with `--resume --model <new>` after the current turn completes).

---

## Risks

1. **Anthropic changes the CLI's stream-json shape or removes flags.** Pin tested version range; emit a warning if `claude --version` is outside it. Watch the CLI's `--bare` flag — it implies an "explicit subset" mode that Anthropic supports as stable. Consider running v1 with `--bare` + explicit flags as the safest cross-version contract.
2. **Anthropic further restricts subscription auth (e.g., disables stream-json for subscribers).** Out of our control. The migration path back to SDK + API key would be: flip the session's `agentic_tool` to `claude-agent-sdk` and re-spawn. Build the rename as bi-directional from the start so this is a UI button, not a migration.
3. **`--print --input-format=stream-json` multi-turn behavior changes between versions.** Add a startup smoke test in CI (gated, costs a few cents) that asserts two-turn stream behavior. Fail-fast if it regresses.
4. **Subscriber rate limits get hit during ordinary Agor usage** (we're running many parallel agents). The `rate_limit_event` banner mitigates surprise. Consider per-user concurrent-session caps for CLI-mode sessions.
5. **Permission flow user confusion** — first-time CLI users will expect the Agor permission modal and won't see it. Mitigation: explicit empty-state on the agent card.

---

## Effort estimate

- v1: ~3-5 days for one engineer familiar with the executor architecture. Most code is mirroring `packages/executor/src/sdk-handlers/claude/` with the SDK call replaced by a child-process spawn + stdout reader. Existing normalizer, message processor, MCP scoping, cost calculator, all reusable.
- v1.5: ~2 days. UI work only.
- v2: ~3 days. Pure new functionality, opt-in.
- Tests: integration suite needs a "fake claude binary" stub that emits scripted stream-json (so we don't burn subscription quota in CI). Worth building right.

---

## Open questions (for Max)

1. **Default permission mode.** `acceptEdits` is my recommendation. `bypassPermissions` is what our internal SDK sessions use today. Which?
2. **Cost UI for subscription sessions.** Show the list-price number with a caption, or hide it?
3. **Multi-user `~/.claude/` sharing in `insulated` mode** — one collaborator runs `claude auth login`, all collaborators use that subscription. Intentional or a footgun? (Today's Codex has the same behavior.)
4. **Should `claude-code-cli` be the default for new Claude sessions** once it ships, with `claude-agent-sdk` reserved for users who configure an API key? Or vice versa?
5. **Permission-mode unknown** (Blind Spot #8): can we get an authoritative answer from Anthropic on what `--permission-mode default` does in `--print --output-format=stream-json` mode before we ship? Otherwise the v1 implementation has to spike this.
6. **Session import (v2)** — desirable, or scope creep? Power-user appeal.

---

## Appendix A: Live session reference

This very analysis ran inside a Claude Code session whose JSONL is at:
`~/.claude/projects/-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration/d72a04ab-2f8b-4917-a2ed-fd3d797dab9b.jsonl`

Subagent JSONL (from the Explore agent invocation):
`~/.claude/projects/-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration/d72a04ab-2f8b-4917-a2ed-fd3d797dab9b/subagents/agent-a9d54b3c4cb327318.jsonl`

Smoke-test session (CLI `--print` invocation):
`~/.claude/projects/-tmp-tmp-U1DCWo1tcw/b9649f1c-0087-424b-a8f6-10a068ebcadc.jsonl` (line-buffered, 25 lines across two `--resume` invocations).

Field shape for `result.usage` (CLI stream-json), captured live:

```json
{
  "input_tokens": 10,
  "cache_creation_input_tokens": 84,
  "cache_read_input_tokens": 29859,
  "output_tokens": 36,
  "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 84,
    "ephemeral_5m_input_tokens": 0
  },
  "iterations": [{ "input_tokens": 10, "output_tokens": 36, ... }],
  "speed": "standard"
}
```

`modelUsage` per turn, captured live:

```json
{
  "claude-haiku-4-5-20251001": {
    "inputTokens": 10,
    "outputTokens": 36,
    "cacheReadInputTokens": 29859,
    "cacheCreationInputTokens": 84,
    "webSearchRequests": 0,
    "costUSD": 0.0032809,
    "contextWindow": 200000,
    "maxOutputTokens": 32000
  }
}
```

## Appendix B: CLI flag reference (relevant subset, v2.1.132)

```
--print, -p                              Non-interactive mode (still long-lived with stream-json stdin)
--verbose                                Required for --output-format=stream-json
--input-format <text|stream-json>        stream-json enables multi-turn stdin
--output-format <text|json|stream-json>  stream-json enables structured stdout
--include-partial-messages               Adds token-level stream_event
--include-hook-events                    Adds hook lifecycle events
--session-id <uuid>                      Deterministic session id
--resume <id>                            Resume by id (appends to same JSONL)
--continue, -c                           Resume the most recent in cwd
--fork-session                           With --resume, create a new id (true fork)
--model <alias|id>                       Same aliases as SDK
--betas <flag...>                        e.g. context-1m-2025-08-07
--effort <low|medium|high|xhigh|max>     Mirrors Agor's effort
--permission-mode <mode>                 default|acceptEdits|bypassPermissions|plan|dontAsk|auto
--dangerously-skip-permissions           Equivalent to bypassPermissions
--mcp-config <files...>                  Load MCP from JSON files/strings
--strict-mcp-config                      Ignore other MCP config sources
--add-dir <dirs...>                      Extra context/work dirs
--append-system-prompt <text>            (--append-system-prompt-file: TBD verify)
--max-budget-usd <amount>                Built-in budget cap (--print only)
--bare                                   Stable, explicit-context mode (consider for v1 robustness)
--no-session-persistence                 Don't write JSONL (we want persistence, do NOT pass)
--replay-user-messages                   Echo user input on stdout (useful for confirming what we sent)
auth                                     Subcommand: manage subscription auth
```
