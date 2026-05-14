# Claude Code CLI Integration Analysis — 2026-05-14

**Author:** scoping pass (`analyze-claude-code-cli-integration` worktree)
**Status:** Draft for Max review. No code yet.
**Companion PRs (already merged):** #1136 (Codex subscription auth UX) — the analogous pattern.

> **Revision note (same day, after Max review of v1).**
> An earlier version of this doc proposed a daemon-spawned `claude --print --output-format=stream-json` child as the primary architecture for subscribers. That was wrong: Anthropic's own headless docs explicitly classify `claude -p` as **"Agent SDK usage"** that draws from a separate monthly credit pool starting **June 15, 2026** ([source](https://code.claude.com/docs/en/headless)), and pre-June-15 it's a ToS-grey path that GitHub issue [#36324](https://github.com/anthropics/claude-code/issues/36324) was opened (and closed "not planned") to warn about. **The subscriber-safe path is interactive `claude` in a TTY**, which is exactly what the original brief specified. This rewrite commits to that architecture.

---

## TL;DR

1. **Two adapters. `claude-agent-sdk` (today's `claude-code`, just renamed) stays as-is for API-key users. New `claude-code-cli` is added for subscribers.** The two are deliberately separate agentic tools in `AgenticToolName` rather than a runtime mode on a single adapter — different auth, different billing, different UX shape, different ToS exposure.

2. **`claude-code-cli` runs the `claude` binary interactively inside the existing web terminal (Zellij pane in the xterm.js modal).** The conversation surface IS the terminal — the user types prompts, sees ANSI-rendered output, answers permission prompts there. Agor does *not* try to recreate the SDK's structured UX over a PTY.

3. **Structured integration is best-effort via the on-disk JSONL.** The daemon runs a watcher per active session that tails `~/.claude/projects/<slug>/<session-id>.jsonl` (line-buffered, verified). Each line maps to a `messages` row; assistant `usage` blocks roll up into `tasks.cost_usd` / `tokens_*`. We get the same structured data shape we already get from the SDK — just observed from disk instead of pushed by callbacks.

4. **External prompt injection = simple PTY stdin write.** `agor_sessions_prompt(continue)` writes the prompt text plus a newline to the running `claude` process's PTY, exactly as if the user typed it. The JSONL watcher then records the resulting turn like any other.

5. **What we lose vs the SDK adapter, and how to live with it:**
   - **No structured permission prompts.** User answers inline in the terminal. Mitigate by exposing `--permission-mode` as a per-session setting; `acceptEdits` is a reasonable default for subscriber UX. Agor's permission-modal subsystem is inert for this tool.
   - **No `total_cost_usd` aggregation event** — JSONL has per-turn `usage` but no rolled-up cost. Mitigate with a price table × token counts, **dedup'd by `message.id`** (the cumulative-snapshot footgun: assistant lines repeat the same cumulative `usage` once per content block — naive sum over-counts ~6×; verified in the live session). For subscribers cost is informational anyway (flat-rate). See Appendix C for prior-art (ccusage / claude-code-parser) and build-vs-adopt analysis.
   - **5-hour billing-window tracking** — ccusage's `loadSessionBlockData` already computes this from the JSONL across sessions, which is the rate-limit signal subscribers care about most. The `rate_limit_event` (only in `-p` stream-json mode) we still don't get, but the practical metric is largely covered.
   - **No fine-grained streaming of token-level deltas** (the `stream_event` type is print-only). Acceptable — interactive UI renders directly in xterm; the message-row update on `assistant` turn completion is fast enough for the conversation pane.

6. **Effort estimate: ~3-5 days for v1** (revised down from 5-7 after the ccusage adoption decision). Remaining novel work is the watcher, the ccusage→Agor translator, the PTY-injection prompt path, the `claude auth` status UI panel, and the rename of `claude-code` → `claude-agent-sdk`. Zellij + xterm.js plumbing already mostly exists for the user-shell terminal.

---

## Policy & ToS landscape

Three things changed Anthropic's stance toward third-party programmatic use of Claude on subscription auth:

1. **April 4, 2026 — initial subscription block.** Anthropic blocked all third-party agentic tools from authenticating with Claude subscriptions. Pure-OAuth-token harnesses (OpenClaw etc.) stopped working. Source: VentureBeat, dataworldbank, multiple secondary sources cited below.

2. **(Reversal) "Agent SDK credits" — announced for June 15, 2026.** Anthropic reinstated third-party access *but* moved programmatic usage onto a separate monthly credit pool. Sources: official [headless docs](https://code.claude.com/docs/en/headless), [support article 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

   What's moving to the new credit pool on June 15:
   - Claude Agent SDK usage in user-built projects (Python or TypeScript)
   - **`claude -p` (the CLI's non-interactive print mode)** — explicitly named
   - Claude Code GitHub Actions integration
   - **Third-party apps authenticating via Agent SDK with subscription credentials** — explicitly named

   What stays on subscription limits (NOT in the credit pool):
   - **Interactive Claude Code in terminal/IDE**
   - Web / desktop / mobile chat
   - Claude Cowork

   Credit amounts (monthly, non-rollover): Pro $20, Max 5x $100, Max 20x $200, Team Standard $20, Team Premium $100. Exhaustion → "extra usage" at API rates if enabled, otherwise stop until refresh.

3. **Consumer ToS.** Quoted in [issue #36324](https://github.com/anthropics/claude-code/issues/36324):
   > "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."

   Anthropic's *explicit permission* for the Claude Code CLI itself is implicit (it's their product, designed for that). Wrapping the CLI by *calling `claude -p` from a script* is the questionable shape — pre-June-15 a ban risk, post-June-15 simply billed against the Agent SDK credit pool.

### What this means for Agor

| Path | Pre-June-15-2026 | Post-June-15-2026 | Cost model |
|---|---|---|---|
| `claude-agent-sdk` adapter, API key | Allowed (always) | Allowed | Per-token API rates |
| `claude-agent-sdk` adapter, subscription OAuth | ToS-grey, ban risk | Allowed but draws Agent SDK credits | Credits then API rates |
| `claude-code-cli` adapter — **interactive `claude` in a TTY where a human types** | Allowed (interactive carve-out) | Allowed (interactive carve-out) | **Subscription limits — no credit pool** |
| `claude-code-cli` adapter — `claude -p` spawned programmatically | ToS-grey, ban risk | Allowed but draws Agent SDK credits | Credits then API rates |

The middle row of the second group is **the only path that delivers the project's goal: "subscribers keep working without separate billing."** That's the interactive PTY shape this doc commits to.

### "But the user is typing in our web app, not in their local iTerm — is that interactive?"

The carve-out is for `claude` running in a TTY where a human is driving. A `claude` process running in a Zellij pane attached to a real PTY, where the user types from xterm.js in the browser, is functionally indistinguishable from typing in iTerm — the same `claude` binary, the same PTY, the same human-keystroke cadence. We are not extracting tokens, not forging requests, not bypassing the CLI's own request loop. We are just *displaying* the TTY in a browser instead of a native terminal emulator.

The PTY-injection path for `agor_sessions_prompt` is the one to be careful about — see Blind Spots #2 and #3 below — but a default-off / opt-in / per-session-toggle posture there is defensible.

---

## Verified facts from a live `claude` v2.1.132 session

Gathered in this worktree on 2026-05-14:

- **Binary:** `/usr/bin/claude`, version `2.1.132 (Claude Code)`.
- **Disk persistence (works for interactive AND print mode):** `~/.claude/projects/<slugged-cwd>/<session-id>.jsonl`, one JSONL per session. Sub-agents (`Task()` tool internals) get `<session-id>/subagents/agent-<id>.jsonl` with `isSidechain: true`.
- **Slug rule:** `/` and `.` both → `-` in the cwd path. Verified across multiple paths.
- **Line-buffered.** Every line is a complete JSON object. No partial-line buffering concerns for a tail-style watcher.
- **`--session-id <uuid>` accepts a pre-generated UUID.** Trivial `(agorSessionId ↔ claudeSessionId)` mapping.
- **`--resume <id>` appends to the same JSONL.**
- **`--fork-session` (with `--resume`)** creates a new session ID — true fork at the CLI level.
- **JSONL `entrypoint` is `"sdk-ts"` regardless of whether the session was launched via SDK or shell.** Can't distinguish SDK vs CLI invocations from the file alone. (Not a problem — we know which we spawned.)
- **The current Agor session's JSONL** at `~/.claude/projects/-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration/d72a04ab-2f8b-4917-a2ed-fd3d797dab9b.jsonl` is the canonical sample. It contains the same shape we'd see from an interactive `claude` REPL — same event types, same fields, same buffering.

### JSONL event types observed (all written during normal use; survive the interactive vs print distinction)

```
ai-title          autogenerated session title (e.g. "Analyze Claude Code CLI agentic-tool integration")
last-prompt       preview of the most recent user prompt, truncated ~120 chars
queue-operation   enqueue/dequeue lifecycle around each turn
user              user message — top-level prompt OR tool_result via toolUseResult
assistant         assistant turn: message.{content, usage, model, stop_reason, stop_details, requestId}
attachment        system attachments: skill_listing, budget_usd, deferred_tools_delta, pendingMcpServers, etc.
```

### What's in `--print --output-format=stream-json` stdout but NOT in the on-disk JSONL

```
system/init       per-session metadata (cwd, tools[], mcp_servers[], permissionMode, apiKeySource, ...)
result            per-turn aggregate: total_cost_usd, modelUsage{<model>:{costUSD, contextWindow, maxOutputTokens}},
                  permission_denials[], terminal_reason, duration_ms, num_turns
rate_limit_event  rate_limit_info: status, resetsAt, rateLimitType ("five_hour"), overageStatus, isUsingOverage
stream_event      token-level partial-message deltas (requires --include-partial-messages)
```

**We do not get these for free in interactive mode.** Mitigations in the Capability Mapping section. (Aside: `--debug-file <path>` may log some of this in interactive mode — worth a v1.5 spike but not load-bearing for v1.)

### Cost extraction: yes, but dedup-by-`message.id` is mandatory

**Footgun verified live in this session.** The same `message.id` (e.g. `msg_01ULxJHPur6nS1o2wuLaG4ri`) appears across **five sequential `assistant` JSONL lines**, each carrying identical `usage`. This happens because the CLI writes one JSONL line per content block emitted during a turn (one per `text`, `thinking`, `tool_use` block), and each line snapshots the cumulative turn usage. Naively summing `.message.usage` across all lines in this session: 27M tokens. Dedup'd by `message.id`: 4M tokens. **6× over-count without dedup.**

Confirmed by `requestId` correlation too — events sharing a `message.id` always share a `requestId`. Either field works as the dedup key; `message.id` is more semantically anchored to the Anthropic API surface.

The dedup rule, plus the cache-tier price math (`cache_creation` priced at base input × 1.25 for 5m and × 2 for 1h; `cache_read` at base input × 0.1), is precisely what existing community tools (notably **ccusage**) have already reverse-engineered. See Appendix D for the prior-art survey and our build-vs-adopt decision.

### `assistant.message.usage` shape (interactive, captured live)

```json
{
  "input_tokens": 6,
  "output_tokens": 2252,
  "cache_creation_input_tokens": 22902,
  "cache_read_input_tokens": 17762,
  "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 22902},
  "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
  "service_tier": "standard",
  "iterations": [{ "input_tokens": 6, "output_tokens": 2252, ... }]
}
```

Per-turn cost is a deterministic function of these fields × the published price table for `message.model`. Agor already does this kind of normalization for Codex (`packages/executor/src/sdk-handlers/codex/codex-tool.ts`), so a `claude-code-cli` cost calculator is reuse, not net-new code.

### Session state tracking: all the signals we need are in the JSONL

Confirmed live: every `user` / `assistant` / `attachment` event carries `cwd`, `gitBranch`, `sessionId`, `version`. User events additionally carry `permissionMode`. Assistant events carry `message.model`, `message.stop_reason`, `requestId`.

| Session attribute | JSONL source |
|---|---|
| Active model | latest `assistant.message.model` (could change mid-session via `/model`) |
| Permission mode | latest `user.permissionMode` |
| Working dir / git branch | latest `cwd` / `gitBranch` on any event |
| Total tokens & cost | sum of `assistant.message.usage` × prices, **dedup'd by `message.id`** |
| Turn lifecycle | `queue-operation` enqueue → dequeue → `assistant` line(s) → end-of-turn (`stop_reason: "end_turn"`) |
| Mid-turn waiting on permission | latest `assistant.stop_reason: "tool_use"` with no matching `toolUseResult` in subsequent `user` events for > N seconds (heuristic) |
| Session is alive | the watcher sees new lines OR the spawned `claude` PTY is still attached |
| Compaction occurred | (TBD) `/compact` triggers an event in the JSONL — verify by running once during implementation |
| Auto-title | `ai-title.aiTitle` (CLI auto-generates) — opt-in surface as Agor session title |

This is enough to drive the existing `tasks` / `messages` / `session` UI surfaces without re-implementing what the SDK callback path gives us.

### Content blocks observed

`assistant.message.content[]` has three block types in this session: `text`, `thinking`, `tool_use`. `tool_use` carries `{type, name, id, input}`. The matching `tool_result` arrives as a subsequent `user` event with `toolUseResult` and `sourceToolAssistantUUID` pointing back to the assistant turn. Identical to SDK semantics.

---

## Existing "Claude Code" (SDK) integration — what we keep verbatim

The current SDK adapter becomes the `claude-agent-sdk` tool after rename. No functional changes. Map for reference:

| Capability | Where it lives today |
|---|---|
| Adapter entry | `packages/executor/src/handlers/sdk/tool-registry.ts`; `packages/executor/src/handlers/sdk/claude.ts` |
| Event handling | `packages/executor/src/sdk-handlers/claude/message-processor.ts`; `packages/executor/src/handlers/sdk/base-executor.ts:109-196` |
| Cost/tokens | `packages/executor/src/sdk-handlers/claude/normalizer.ts`; `base-executor.ts:428-507` |
| MCP injection | `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:69-207`; `query-builder.ts:289+` |
| Permission flow | `packages/executor/src/sdk-handlers/claude/permissions/permission-hooks.ts` |
| Model + betas + effort | `packages/executor/src/sdk-handlers/claude/model-utils.ts`; `query-builder.ts:184-188` |
| External prompt | `packages/executor/src/sdk-handlers/claude/prompt-service.ts:112-175` |
| Spawn/fork | `packages/core/src/sessions/resolve-child-session-config.ts` |
| CLAUDE.md | `packages/executor/src/sdk-handlers/claude/session-context.ts` |
| Auth/API key | `packages/executor/src/handlers/sdk/base-executor.ts:274-296` |
| Tool enum | `packages/core/src/types/agentic-tool.ts:18` |

Everything here stays for API-key users. The only changes affecting it are: rename `'claude-code'` → `'claude-agent-sdk'` (DB migration + UI labels) and a new entry in the agentic-tool union for `'claude-code-cli'`.

---

## Capability mapping (SDK vs interactive-CLI-in-PTY + JSONL watcher)

| Agor capability | `claude-agent-sdk` (today, kept) | `claude-code-cli` (new, interactive+watcher) | Gap / mitigation |
|---|---|---|---|
| Spawn shape | SDK `query()` in executor process | `claude` binary inside Zellij pane attached to user's xterm.js PTY; no `-p` | Reuse existing terminal infrastructure (`apps/agor-daemon/src/services/terminals.ts`, `packages/executor/src/commands/zellij.ts`) |
| Conversation surface | Agor message panel rendered from SDK events | **The terminal itself** is the conversation; Agor message panel is a *parallel* read-only view rebuilt from JSONL | Two-pane UX: TTY in xterm modal (read-write), structured feed in conversation pane (read-only mirror) |
| Persist user message | SDK callback | JSONL `user` event (or PTY-injection path writes a marker first) | Watcher reads line |
| Persist assistant turn | SDK callback | JSONL `assistant` event | Watcher reads line |
| Tool call / result | SDK events | JSONL `tool_use` block + subsequent `user` with `toolUseResult` | Direct equivalence |
| Streaming text mid-turn | SDK chunk callbacks | Rendered by `claude` directly in the terminal; Agor sees the final `assistant` line in JSONL after the turn | Acceptable — user already sees streaming in xterm; Agor's structured view updates at end-of-turn |
| Token in/out + cache | SDK event field | `assistant.message.usage` per turn (full breakdown, including cache 5m/1h) | Direct equivalence |
| Dollar cost | SDK `total_cost_usd` field | **Computed: token counts × model price table** | New per-CLI cost-calculator utility. Subscribers: caption as "estimated; covered by your subscription" |
| Rate-limit signal | (SDK probably emits; Agor doesn't surface today) | **Not in JSONL.** TBD: `--debug-file` | v1.5 investigation; otherwise document as missing |
| External prompt injection (`agor_sessions_prompt continue`) | `promptSessionStreaming` | **Write prompt + `\n` to the PTY stdin** | Simple PTY write via Zellij `action write-chars` or direct pty.write. Document race-y when user is also typing |
| Spawn subsession | New SDK session | New Zellij pane / new `claude --session-id <new uuid>` child | Reuses Zellij tab/pane plumbing |
| Fork session | SDK fork | `claude --resume <id> --fork-session` (first-class CLI flag) | Direct equivalence |
| MCP server attachment | SDK option | `--mcp-config <file>` + `--strict-mcp-config` | Direct equivalence; write per-session tmp file with agor MCP config |
| Model selection | SDK option | `--model <alias>` (with `--betas context-1m-2025-08-07` for `[1m]`) | Direct equivalence |
| Effort level | SDK option | `--effort low\|medium\|high\|xhigh\|max` | Direct equivalence |
| CLAUDE.md / context dirs | SDK auto-loads | CLI auto-loads from `cwd`; `--add-dir <dirs...>` adds more | Direct equivalence |
| Permission mode | SDK option | `--permission-mode <mode>` at spawn (default / acceptEdits / bypassPermissions / plan / dontAsk / auto) | Set at spawn; **user answers in-terminal**; Agor's permission modal is inert for this tool |
| Real-time permission UI | `canUseTool` callback → WebSocket modal | **User reads + answers in xterm.js terminal** | This is the user-visible regression. Mitigation: settle on a default mode (likely `acceptEdits`) and surface as a session setting |
| Cost reconciliation across subscription / API-key | `apiKeySource` in env / config | Read `~/.claude/.credentials.json` presence + spawn env (`ANTHROPIC_API_KEY` set or not) | Session-level `billing_mode: 'subscription' \| 'api-key' \| 'unknown'` |
| Auth | API key (env) / SDK native | `~/.claude/.credentials.json` managed by `claude auth login` | New UI panel mirroring Codex (#1136) |
| `Task()` subagent threads | (Not persisted today) | `<session-id>/subagents/agent-<id>.jsonl` written automatically | Bonus capability for v2 (also retrofits SDK adapter) |
| Mid-session model switch | Not supported by SDK either | Not supported; new session required | Non-regression |
| Compaction events | SDK emits | `/compact` triggers JSONL emit (verify by triggering once) | Direct equivalence expected |

---

## Blind spots

For each: explicit "accept" or concrete mitigation.

### 1. No structured permission prompts (USER-VISIBLE REGRESSION)

The user answers tool-use prompts in the xterm.js terminal, not via an Agor modal. This is the project's primary UX cost.

**Mitigations:**
- Default to `--permission-mode acceptEdits` (auto-approve edits and common filesystem commands; ask only for arbitrary shell + network). Most ergonomic for subscribers.
- Expose `permission-mode` as a per-session setting (CLI-adapter UI parallels Codex's `sandboxMode`/`approvalPolicy` form: `apps/agor-ui/src/components/CodexSettingsForm/`).
- Show a "Permissions: handled in terminal — mode `<mode>`" badge where the Agor permission modal would normally fire, with a tooltip linking to the CLI mode docs.
- If `--permission-mode default` and the user is *not* watching the terminal, the prompt will sit unanswered → session stalls. Mitigation: when `permission-mode default` is chosen, surface an inline banner in the conversation pane: "Agent is waiting on a permission prompt in the terminal — open the terminal modal to respond." (Detected by JSONL going silent + last assistant turn ending with `stop_reason: "tool_use"` whose tool has no result yet.)

### 2. PTY injection for external prompts is best-effort and racy (ACCEPT WITH GUARDRAILS)

`agor_sessions_prompt(sessionId, prompt, mode: "continue")` will write `<prompt>\r\n` to the running `claude` process's PTY stdin. If the user is mid-typing, this will interleave with their input. If `claude` is mid-turn, the bytes queue.

**Mitigations:**
- v1: support only `mode: "continue"` via PTY injection.
- Inject only when JSONL shows the most recent event is a `result`-equivalent (end-of-turn assistant message with `stop_reason: "end_turn"`).
- If a turn is in progress, queue the injection and write it when the turn finishes. Reuse `apps/agor-daemon/src/services/sessions-queue.ts` (or wherever queueing lives — verify in implementation).
- Document the race-condition caveat in the agentic-tool description.

### 3. PTY injection's ToS classification is grey (DOCUMENT, NOT RESOLVED)

Writing bytes to a PTY is not the same as forging API requests, but it *is* a form of automated input. Anthropic has not opined on this specifically. The community read (autonomee.ai, alex fazio) is that wrapping the CLI is fine as long as you're not extracting OAuth tokens or impersonating Claude Code. PTY injection where a real user owns the session, in real time, with the user able to see and stop it via the same xterm.js modal, falls inside the "human-in-the-loop" framing.

**Stance:** ship it default-on, behind a per-session opt-out, with clear copy. If Anthropic clarifies later, we can flip the default.

### 4. Cost is computed locally, not aggregated by the CLI — with a dedup footgun (KNOWN GAP, BAKED FIX)

The on-disk JSONL has `assistant.message.usage` per turn but no `total_cost_usd`. Aggregation is on us.

**Non-obvious wrinkle (verified live):** every `assistant` JSONL line for a single turn carries the **cumulative** `usage` for that turn, not a delta. The CLI writes one line per content block (`text` / `thinking` / `tool_use`) and each line repeats the cumulative snapshot. Naive `sum(.message.usage.*)` across all assistant lines in this session overshoots by ~6×. **Mandatory dedup key: `assistant.message.id`** (the API's `msg_…` ID; `requestId` is also 1:1). Both `ccusage` and `claude-code-parser` document and handle this same case.

**Cache-tier pricing:** `cache_creation_input_tokens` splits between `ephemeral_5m_input_tokens` (1.25× base input) and `ephemeral_1h_input_tokens` (2× base input). `cache_read_input_tokens` is 0.1× base input. Without per-tier accounting, cache-heavy sessions misprice substantially.

**Mitigation:** adopt **`ccusage`** as a runtime dep (MIT, well-maintained, ESM-compatible with our daemon). Use `ccusage/data-loader.createUniqueHash` for dedup, `ccusage/data-loader.calculateCostForEntry` for per-entry cost (which already handles the cache-tier ratios above), and `ccusage/data-loader.loadSessionUsageById(sessionId)` for batch loading at session resume / crash recovery. We wrap these with our own `fs.watch` layer for real-time tailing. See **Appendix C** for the full surface, why this beats vendoring, and the small risks (transitive deps, multi-tool coupling, semver).

For subscription users: caption cost "estimated, covered by subscription" in the UI. For API-key users: same numbers, no caption.

### 5. No `rate_limit_event` in the JSONL — but the 5-hour billing window IS computable (MOSTLY MITIGATED)

The CLI emits `rate_limit_event` only in `-p`/stream-json output. Interactive mode does not write that event to the JSONL.

**Mitigations:**
- v1: use `ccusage/data-loader.loadSessionBlockData()`, which computes the 5-hour billing-window aggregate across all sessions on disk. This is the rate-limit metric subscribers actually care about — "how close am I to my 5h cap?" — and ccusage already handles it.
- v1.5: spike `--debug-file <path>` to see if any structured rate-limit info appears there as a secondary signal.
- The fast-path event-driven `rate_limit_event` (with `resetsAt` etc.) remains unavailable in interactive mode. Document as a minor gap; UI can still show "X% of 5h window consumed" without it.

### 6. JSONL is written by `claude`, not by Agor — schema can change between versions (RISK)

Our watcher depends on a schema controlled by Anthropic. They may rename fields, add types, or move things.

**Mitigations:**
- On startup, run `claude --version` and check against a tested range. Warn loudly if outside.
- Defensive parser: known event types translate, unknown ones get logged + ignored (don't crash).
- Add a CI smoke test that runs a scripted real `claude --print` session (against an API key, in a CI-only `ANTHROPIC_API_KEY` env) and asserts the JSONL schema is what we expect. Costs cents per CI run.

### 7. Slug rule for the JSONL path could change (RISK)

We derive the file path by slugging `cwd` (`/` and `.` → `-`). Anthropic could change this.

**Mitigation:** Don't depend on the slug rule for steady-state operation. At spawn time, we know the `session-id` we passed via `--session-id`. The path is `~/.claude/projects/<slug>/<session-id>.jsonl`. Slug computation is local to one utility (`packages/executor/src/sdk-handlers/claude-cli/path-utils.ts`) with unit tests. If the rule changes, we find it by `find ~/.claude/projects -name "<session-id>.jsonl"` fallback once, then cache.

### 8. Terminal lifecycle ≠ session lifecycle (UX FOOTGUN)

In our existing terminal architecture, the Zellij session persists across modal close/reopen (verified — `apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx:331-347`). But if the user *quits* `claude` (Ctrl+C, /exit, or it crashes), the Agor session has lost its agent without Agor knowing immediately.

**Mitigations:**
- Watcher also watches the PTY's process state. On `claude` exit, mark session status `idle` or `error` accordingly.
- When the user reopens the session in Agor, offer "Resume Claude" → spawns `claude --resume <claudeSessionId>` in the same tab.

### 9. Multi-user `~/.claude/` sharing in `insulated` Unix mode (SECURITY/UX TRADEOFF)

`unix_user_mode: insulated` runs all executors as one shared `agor_executor` user. That user has one `~/.claude/.credentials.json`. So all collaborators effectively share one Claude subscription — whichever collaborator's `claude auth login` ran last. This mirrors the existing Codex behavior.

**Mitigations:** Document. In `strict` Unix mode, per-user Unix accounts → per-user `~/.claude/` → per-user subscription auth → clean separation. This is the recommended mode for shared deployments.

### 10. Watcher restart / crash recovery (ENGINEERING)

If the daemon crashes mid-turn, we miss events. On restart, the watcher must read the JSONL from where it left off.

**Mitigation:** Persist `cli_watcher_offset` per session (bytes consumed). On daemon restart, reopen each in-flight session's JSONL from that offset. Trivial bookkeeping.

---

## Proposed architecture

### Spawn shape (interactive `claude` inside an existing-style web terminal pane)

```
claude \
  --session-id <agor-mapped-uuid> \
  --model <resolved alias> \
  --betas context-1m-2025-08-07 \           # only when model has [1m] suffix
  --effort <low|medium|high|xhigh|max> \
  --permission-mode <user setting, default acceptEdits> \
  --mcp-config <tmp file with agor MCP + scoped user MCPs> \
  --strict-mcp-config \
  --add-dir <repo root> \
  --append-system-prompt-file <file with agor session context>
```

No `-p`. No `--output-format`. No `--input-format`. The process runs in a TTY allocated by Zellij. The user sees the rendered REPL in xterm.js.

**Env vars:**
- `ANTHROPIC_API_KEY` set only when the user has explicitly chosen API-key billing for this adapter. Default for `claude-code-cli` sessions is subscription auth → leave unset → CLI reads `~/.claude/.credentials.json`.
- `HOME` honored per the unix-mode boundary (in `strict` mode each user has their own `~/.claude/`; in `insulated` mode the shared executor user's `~/.claude/`).

### Web terminal extension (the smallest set of changes)

Today: `apps/agor-daemon/src/services/terminals.ts` spawns one Zellij session per user, with one tab per worktree. The terminal is a generic shell.

New for `claude-code-cli`:
- A session whose `agentic_tool === 'claude-code-cli'` gets a **dedicated Zellij tab** named after the session (e.g., `cli-<agorSessionShortId>`) inside the user's existing Zellij session, with `--cwd <worktree path>` and the initial command set to the `claude` invocation above.
- The xterm.js modal gets a tab switcher to focus that session's pane. (Reuse existing tab logic in `packages/executor/src/commands/zellij.ts:412-444`.)
- The conversation-pane UI for these sessions shows the standard message feed (read-only from JSONL) PLUS a prominent "Open terminal" CTA that opens the modal focused on this session's tab.

### Watcher

A new daemon-side service `apps/agor-daemon/src/services/claude-cli-watcher.ts` (working name) that:
- On `claude-code-cli` session creation: registers the JSONL path `~/.claude/projects/<slug>/<session-id>.jsonl` plus the subagent subdir.
- Uses `fs.watch` (Linux: inotify) on the JSONL file. On each new chunk, splits by `\n`, parses each complete line as JSON.
- Translates each event into a `ProcessedEvent` (the same shape the SDK adapter produces) and pushes it through the existing `MessagesService.create/patch` and `TasksService.patch` pipeline.
- Maintains a per-session byte offset for crash recovery.
- Polls subagent subdir every N seconds; spawns child watchers for new sidechain JSONLs.

Translation rules summary:
- `user` event with no `toolUseResult` → user message row.
- `user` event with `toolUseResult` → patch the matching pending tool-call row with the result.
- `assistant` event → upsert assistant message row by `assistant.uuid`. Content blocks (`text`, `thinking`, `tool_use`) populate `message.content` and create empty child tool-call rows (later patched when their result arrives).
- End-of-turn detection: `assistant.message.stop_reason in ('end_turn', 'tool_use', 'stop_sequence')` → roll up `message.usage` into `tasks.cost_usd` + `tokens_*` deltas via the cost calculator.
- `attachment` of type `pendingMcpServers` → log; no action.
- `queue-operation` enqueue → mark task `running`. `queue-operation` dequeue or absence of new events for N seconds after end-of-turn → mark task `idle`.
- `ai-title` → optionally use as session title if user hasn't set one.

### External prompt injection (PTY write)

`agor_sessions_prompt(sessionId, prompt, mode)` for `claude-code-cli` sessions:

- `mode: "continue"` → write to the PTY of the running `claude` process. Implementation: have the executor's Zellij command path expose a `writeChars(paneId, text)` action, write `<prompt>\n` to it. (Zellij has `zellij action write-chars` — verify in v1 implementation.)
- `mode: "subsession"` → spawn a new pane with a fresh `--session-id` and the parent's CLAUDE.md context (same plumbing as a top-level session creation).
- `mode: "fork"` → spawn a new pane with `claude --resume <parent-claude-session-id> --fork-session`; the resulting new session-id is captured from the first `system/init`-equivalent JSONL line (or from the JSONL filename appearing in `~/.claude/projects/<slug>/`).
- `mode: "btw"` → if it exists in current sessions API, same as `continue` but with a "by the way" prefix; identical PTY-write path.

**Queueing rule:** if the JSONL watcher shows the session is mid-turn (last event has no closing assistant turn with `stop_reason: "end_turn"` yet), queue the injection. Drain on end-of-turn.

### Permission flow

- v1: default `--permission-mode acceptEdits`. Per-session override in NewSessionModal's CLI tab.
- A new badge component in the conversation-pane header for `claude-code-cli` sessions: "Permissions: handled in terminal — mode `acceptEdits`" with a tooltip + link.
- If the JSONL watcher detects "agent is waiting on a tool_use that hasn't been resolved for > 10s" AND `permission-mode` is `default` / `dontAsk`, render an inline banner: "Open the terminal to respond to a permission prompt."

### Cost & billing-mode UX

- New per-session `billing_mode` column on `sessions` (or computed from `apiKeyEnvVar` presence at spawn): `'subscription' | 'api-key' | 'unknown'`.
- New cost calculator: token counts × price table.
- UI for `billing_mode === 'subscription'`: cost shown with caption "Estimated; covered by your Claude subscription. Counted against your subscription's rate limits, not against Agent SDK credits."
- UI for `billing_mode === 'api-key'`: cost shown plain.

### Auth & credentials (mirror Codex pattern)

- New User Settings panel: **Claude Code CLI Auth**. Sits next to the existing Claude Code Auth panel (which gets renamed to **Claude Agent SDK Auth**).
- Status indicator: read `~/.claude/.credentials.json` (presence + parse minimal fields); also run `claude auth status` if that subcommand exists (verify with `claude auth --help` in v1).
- Multi-user environments: in `insulated` mode, show the executor user's auth status. In `strict` mode, show the session creator's auth status.
- "Run `claude auth login`" CTA opens the terminal modal pre-typed with the command — user runs it once, the credential persists.
- API-key fallback: optional field "Use API key instead of subscription" — sets `ANTHROPIC_API_KEY` env var on spawn. Useful for users who want to avoid the Agent SDK credit pool entirely after June 15.

### Spawn / fork / subsession capabilities

```
AGENTIC_TOOL_CAPABILITIES['claude-code-cli'] = {
  supportsSessionFork: true,    // --fork-session on resume
  supportsChildSpawn: true,     // spawn new claude with new --session-id
  supportsSessionImport: true,  // can adopt an existing on-disk JSONL (v2)
  stateless: false              // process is long-lived in a Zellij pane
}
```

### MCP injection

- Per-session tmp file: `/tmp/agor-mcp-<sessionId>.json` containing Agor's MCP server config + scoped user MCPs.
- Spawn flags: `--mcp-config <file> --strict-mcp-config`.
- Cleaned up on session end.
- Reuse `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:getMcpServersForSession`.

---

## Migration & coexistence

### Rename

- `'claude-code'` → `'claude-agent-sdk'` (the existing adapter, SDK-based, API-key default).
- New `'claude-code-cli'`.
- DB migration: rewrite `sessions.agentic_tool = 'claude-code'` to `'claude-agent-sdk'`. Same for `worktrees.agentic_tool` (`packages/core/src/types/worktree.ts:457`).
- Update `AgenticToolName` union (`packages/core/src/types/agentic-tool.ts:18`) and `Tool` (`packages/executor/src/handlers/sdk/tool-registry.ts:14`).
- UI labels (proposed):
  - **Claude Code CLI** — *"Wraps the `claude` shell binary in your web terminal. Best for Claude Pro/Max subscribers. Uses your subscription's interactive limits."*
  - **Claude Agent SDK** — *"Runs Claude via the Anthropic Agent SDK. Best with an API key (per-token billing). On a subscription, this draws from Agent SDK credits starting June 15, 2026."*

### Settings & picker surfaces

- `apps/agor-ui/src/components/AgentSelectionGrid/availableAgents.ts` — add new entry; install check uses `which claude` + parse `--version`; show "Not installed — see install instructions" when missing.
- `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx` — both tools selectable; selection swaps in the per-tool config form.
- New `ClaudeCliConfigForm` component (parallel to `CodexSettingsForm`): model picker, effort picker, permission-mode picker (with disclaimer banner), MCP toggle, "auth: subscription / API key" radio.
- User Settings → Default Agentic Config: keyed by tool name; just add the new key.

### Default-tool affordance

First-run / User Settings affordance:
- If `claude` binary present AND `~/.claude/.credentials.json` valid: "Looks like you're set up with the Claude CLI on this host. Default new Claude sessions to **Claude Code CLI** (subscription)?" `[yes]` / `[no, use API key with Agent SDK]`.
- If `claude` binary not present: "Install Claude Code from anthropic.com/install and run `claude auth login` to use the CLI adapter on your subscription. Or use the Agent SDK with an API key."

### Onboarding copy (calls out the policy nuance)

In the new agent description and in onboarding modals:
> "**Claude Code CLI** uses the interactive `claude` binary on your machine, authenticated against your Claude Pro/Max subscription. Anthropic explicitly carves interactive use out of the new Agent SDK credit pool that starts June 15, 2026 — so this adapter draws from your subscription's normal rate limits, not from a separate credit budget. If you'd rather use a per-token API key, choose **Claude Agent SDK** instead."

---

## Phased delivery plan

### v1 — Spawn + watcher + structured bridge (~3-5 days)

- Add `'claude-code-cli'` to type unions and tool registry.
- Add `ccusage` runtime dep; thin translator from `ccusage` types → Agor `ProcessedEvent`.
- New executor adapter `packages/executor/src/sdk-handlers/claude-cli/` (mostly translator + spawn config; cost calc delegated to `ccusage/data-loader.calculateCostForEntry`).
- Daemon-side `claude-cli-watcher` service: `fs.watch` per session, calls `ccusage/data-loader.loadSessionUsageById` on each new chunk, dedupes with `createUniqueHash`, translates, pushes through MessagesService/TasksService.
- Zellij tab spawn for CLI sessions (extend `packages/executor/src/commands/zellij.ts`).
- Rename `claude-code` → `claude-agent-sdk` (DB migration + UI labels).
- New `ClaudeCliConfigForm` (model, effort, permission-mode picker).
- `billing_mode` column + UI caption.
- 5-hour billing-window banner powered by `ccusage/data-loader.loadSessionBlockData()`.
- Crash recovery via per-session `cli_watcher_offset`.
- Integration test: feed a fixture JSONL through ccusage, assert dedup + cost totals — regression alarm if ccusage's behavior shifts.

**Out of scope for v1:** PTY-prompt injection (deferred to v1.5 so we ship the watcher first), `claude auth login` Settings panel (deferred), subagent thread ingestion, session import, rate-limit surfacing.

### v1.5 — PTY prompt injection + Auth UX (~2-3 days)

- `agor_sessions_prompt(continue)` writes to the running PTY via Zellij `action write-chars` (verify exact flag).
- Queue injections during in-flight turns; drain on end-of-turn.
- **Claude Code CLI Auth** Settings panel: `~/.claude/.credentials.json` status, "Run `claude auth login`" CTA in pre-typed terminal.
- Onboarding affordance for first-run users.
- Spike: does `--debug-file <path>` log rate-limit info? If yes, add as a secondary watcher source.

### v2 — Polish + power features (~3-4 days)

- Subagent (`<session>/subagents/agent-<id>.jsonl`) ingestion as collapsible internal-subagent rows. Also retrofit `claude-agent-sdk` adapter to surface these.
- Session import: "Adopt existing Claude session" picker that lists `~/.claude/projects/*/`*.jsonl` and ingests one into Agor.
- Spawn/fork via `agor_sessions_prompt(fork)` (spawn new pane with `--fork-session`).
- Rate-limit banner if v1.5 spike found a source.
- Mid-session model switch: respawn `claude --resume --model <new>` after current turn completes.

---

## Risks

1. **Anthropic tightens the interactive carve-out.** Possible but disruptive to their own product. Mitigation: nothing structural — we follow whatever they publish.
2. **Anthropic changes the JSONL schema between versions.** Pin tested range, defensive parser, CI smoke test.
3. **PTY injection gets reclassified as automation.** Unlikely given the human-supervised framing, but if so we'd disable injection and revert to "user must type" UX. Make sure the watcher works without injection — the UX is degraded but not broken.
4. **`~/.claude/` collisions in `insulated` mode.** Document and steer multi-user deployments to `strict` mode.
5. **Subscription rate limits hit hard.** New `RateLimitsBanner` (when we find a source) + per-user concurrency caps for `claude-code-cli` sessions.
6. **The `claude` binary isn't installed** on the host. Detect at session-create time; show install instructions; fall back to SDK adapter if user accepts that path.

---

## Effort estimate

- v1: **~3-5 days** for one engineer familiar with the executor + terminal architecture. Reduced from the earlier 5-7-day estimate by adopting `ccusage` (parser, dedup, price table, 5h window all delegated). Remaining novel work: the watcher (`fs.watch` + offset bookkeeping), the ccusage→`ProcessedEvent` translator, Zellij tab spawn for CLI sessions, and the rename.
- v1.5: ~2-3 days. PTY-injection plumbing + auth panel.
- v2: ~3-4 days. Power features, no core architecture changes.
- Tests: fixture JSONL (this analysis's own session file) replayed through ccusage in unit tests so we catch a ccusage regression early. CI smoke test using `--print` and an API key in CI-only env validates the spawn shape end-to-end.

---

## Open questions for Max

1. **Default permission mode** — `acceptEdits` (recommend) or `bypassPermissions` (matches what our internal SDK sessions use today)?
2. **Cost UI for subscription sessions** — show estimated $ with a caption, or hide and show only token usage?
3. **First-run default** — if both adapters are available, which is the default agentic tool for a new Claude session? My recommendation: detect at run time. If `claude auth status` shows subscription → default `claude-code-cli`. If only `ANTHROPIC_API_KEY` is configured → default `claude-agent-sdk`. If both → ask once and store in user prefs.
4. **PTY injection toggle UX** — per-session opt-out checkbox? User-level setting? Default-on or default-off?
5. **`--debug-file` investigation** — willing to spend v1.5 spike time, or defer to v2?
6. **Session import (v2)** — keep on the roadmap, or drop?

---

## Appendix A: Live session reference

This analysis's host session JSONL:
`~/.claude/projects/-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration/d72a04ab-2f8b-4917-a2ed-fd3d797dab9b.jsonl`

Subagent JSONL (from an Explore agent call earlier in this analysis):
`~/.claude/projects/-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration/d72a04ab-2f8b-4917-a2ed-fd3d797dab9b/subagents/agent-a9d54b3c4cb327318.jsonl`

These two files together demonstrate every event type the watcher needs to handle. Schema is identical between SDK-launched and CLI-launched sessions (the only distinguishing field would have to be added by us — `entrypoint` is always `"sdk-ts"`).

## Appendix B: CLI flag reference (v2.1.132, interactive-mode subset, this is what the spawn command uses)

Only flags safe and useful in the interactive (no-`-p`) path:

```
--session-id <uuid>           Deterministic session id (REQUIRED — we map agor↔claude)
--resume <id>                 Resume by id (appends to existing JSONL)
--continue, -c                Resume most recent in cwd
--fork-session                With --resume, create new session id (true fork)
--model <alias|id>            Same aliases as SDK
--betas <flag...>             e.g. context-1m-2025-08-07 (for [1m] models)
--effort <level>              low|medium|high|xhigh|max
--permission-mode <mode>      default|acceptEdits|bypassPermissions|plan|dontAsk|auto
--mcp-config <files...>       Inject our MCP config
--strict-mcp-config           Ignore user's other MCP sources
--add-dir <dirs...>           Extra context/work dirs
--append-system-prompt <text> (or --append-system-prompt-file)
-n, --name <name>             Display name (shows in /resume picker, terminal title)
--debug                       Verbose debug output (TBD: structured?)
--debug-file <path>           Write debug logs to a path (TBD: structured? rate-limit info?)
```

Print-only flags we deliberately do NOT use for `claude-code-cli`:

```
-p, --print                   POLICY: classified as Agent SDK usage; bills against credit pool June 15+
--output-format <fmt>         Only works with --print
--input-format <fmt>          Only works with --print
--include-partial-messages    Only works with --print
--include-hook-events         Only works with --print
--max-budget-usd <amount>     Only works with --print
--no-session-persistence      Only works with --print (we want persistence)
--replay-user-messages        Only works with --print+stream-json
```

## Appendix C: Prior art — adopt `ccusage` as a runtime dep

**Decision: adopt `ccusage` from npm.** Earlier in this doc's drafting I recommended vendoring our own parser; that was wrong, based on an incomplete read of ccusage's published surface. Spelling out the analysis honestly:

### What ccusage actually publishes

`ccusage` (the npm package, version 18.0.11 as of 2026-05-14, MIT license confirmed in repo `LICENSE`) deliberately exports reusable internals via its `package.json`:

```json
"exports": {
  ".":                  "./dist/index.js",
  "./calculate-cost":   "./dist/calculate-cost.js",
  "./data-loader":      "./dist/data-loader.js",
  "./debug":            "./dist/debug.js",
  "./logger":           "./dist/logger.js"
}
```

This is not a private monorepo dep accidentally leaked — these are intentional public exports. The package serves both the `ccusage` CLI and downstream consumers building on it.

### Exports we'd actually use

From `ccusage/data-loader`:

| Export | Purpose for Agor |
|---|---|
| `transcriptMessageSchema`, `usageDataSchema` | Valibot schemas we validate JSONL lines against — schema-drift detection comes for free; an unrecognized field surfaces as a validation warning |
| `createUniqueHash(data)` | **The dedup helper.** Returns a stable hash from `message.id + requestId` or `null` if neither present. Drop this directly into our watcher's `seen` set |
| `calculateCostForEntry(data, ...)` | Per-entry USD cost calc that already handles `cache_creation.ephemeral_5m_input_tokens` × 1.25, `ephemeral_1h_input_tokens` × 2, `cache_read_input_tokens` × 0.1 |
| `loadSessionUsageById(sessionId, options)` | Per-session batch load — exactly the shape we need for crash recovery and "adopt existing session" import (v2) |
| `loadSessionBlockData(options)` | **Five-hour billing-window tracking.** This fills Blind Spot #5 (rate-limit signal) almost for free: subscribers care most about hitting the 5h window, and ccusage already computes it from the JSONL |
| `calculateContextTokens()` | Context-window utilization tracking |
| `getClaudePaths()`, `extractProjectFromPath()` | Slug rule + multi-path discovery — saves us reimplementing slug logic from scratch (and shields us if Anthropic changes it) |

From `ccusage/calculate-cost`:
- `calculateTotals(...)`, `getTotalTokens(...)` — aggregation helpers (session-level and global totals).

### What we still own

- The **file watcher** (`fs.watch` per active session's JSONL, plus the subagent subdir). ccusage is batch-mode; we wrap its loader functions with line-tail logic.
- The **translation layer**: ccusage emits its own `UsageData` / `SessionUsage` shape; we translate that to our existing `ProcessedEvent` shape so the rest of the executor pipeline (MessagesService, TasksService, cost rollup on `task.cost_usd`) stays unchanged.
- **Per-session offset bookkeeping** for crash recovery (bytes consumed on each JSONL).
- **PTY integration** (Zellij + xterm.js) — entirely outside ccusage's scope.
- **Agor session ↔ Claude session ID mapping**, MCP injection, auth panel, UI — all Agor-side.

### Why this is the right call

1. **Maintenance economics.** ccusage absorbs the schema-drift cost (14k stars + multi-tool coverage means many users discover breakage fast). Vendoring puts that on us.
2. **Bonus capability.** `loadSessionBlockData` gives us a subscriber-relevant rate-limit signal we'd otherwise be doing without (Blind Spot #5).
3. **Multi-tool reuse.** ccusage also exports Codex / OpenCode / Amp / Pi parsers in sibling apps — if we like the pattern for Claude, we can converge our Codex cost normalizer onto the same library later.
4. **Schema source-of-truth.** Valibot schemas are tighter than our internal types; reusing them prunes a class of bugs (silently-tolerated unknown fields).
5. **ESM compat checked.** Agor's `apps/agor-daemon`, `packages/executor`, `packages/core` are all `"type": "module"` — ccusage's ESM-only shape lands cleanly. Engines: ccusage requires Node ≥22.11; Agor's package.json should be checked but no daemon I've seen runs below 20.
6. **License is MIT** — verified in the repo's `LICENSE` file; the GitHub classifier's NOASSERTION readout I cited earlier was a false alarm.

### Concrete risks (small, manageable)

1. **Transitive deps.** ccusage pulls in `valibot`, `consola`, `@praha/byethrow`. Light, no native compilation. Lockfile drift is normal pnpm hygiene.
2. **Multi-tool coupling.** ccusage's `data-loader` also globs Codex/OpenCode files in `~/.claude/projects/` siblings. We restrict our usage to per-session APIs (`loadSessionUsageById`) so the multi-tool surface doesn't leak in unexpectedly.
3. **Breaking changes.** ccusage is at v18 — they've had majors. Pin a major (`"ccusage": "^18.0.0"`); read the release notes before upgrading.
4. **Anthropic ships a CLI version with a new event type.** ccusage's valibot schemas validate against known shapes; new fields are passed through and we keep going. Schema-breaking changes show up as validation errors which we surface to logs (not silent corruption).

### Effort impact

v1 estimate drops by **~1-2 days**. The parser, dedup, price table, and 5-hour-window logic are off our plate. We focus on: spawn-in-Zellij, watcher around ccusage's loader, translation to `ProcessedEvent`, PTY injection, auth UI, and the rename. Revised v1 estimate: **~3-5 days** (was 5-7).

### The dedup + cache-tier intricacies we'd have built ourselves

For posterity (and so the unit tests live in the right place), the two non-obvious things ccusage handles internally:

1. **Cumulative-snapshot dedup.** Every `assistant` JSONL line for a single turn carries the cumulative-to-that-point `usage`. Naive sum across lines inflates ~6× in our live session sample (verified). Dedup by `message.id` + `requestId` is mandatory. ccusage's `createUniqueHash` does this.
2. **Cache-creation tier pricing.** `cache_creation_input_tokens` splits between `ephemeral_5m_input_tokens` (1.25× base input) and `ephemeral_1h_input_tokens` (2× base input). `cache_read_input_tokens` is 0.1× base input. ccusage's `calculateCostForEntry` does this.

We still add an integration test that feeds a known fixture JSONL (e.g., this analysis's own session file) through ccusage and asserts the totals, so a ccusage regression breaks our CI loudly rather than silently mispricing.

### Tools considered and not adopted

| Tool | Why not |
|---|---|
| [**pixelhq-bridge**](https://github.com/waynedev9598/PixelHQ-bridge) | Watcher pattern is right, but it's iOS-app-oriented with a WebSocket broadcast layer + privacy-stripping we don't want. ccusage + our own watcher is cleaner. |
| [**claude-code-parser**](https://github.com/udhaykumarbala/claude-code-parser) | For `--output-format=stream-json` stdout (`-p` path). Not our path. But its [public protocol documentation](https://udhaykumarbala.github.io/claude-code-parser/) is the best-in-class reference for the JSONL/stream-json formats — keep it bookmarked for when ccusage's behavior is unclear. |
| [**@constellos/claude-code-kit**](https://www.npmjs.com/package/@constellos/claude-code-kit) | npm page 403'd at fetch time; not enough signal to recommend, and ccusage covers our needs. |
| token-dashboard, claude-code-usage-tracker, Claude-Code-Usage-Monitor, claude-code-dashboard | Full applications, not libraries. Worth reading for UX ideas (especially Stargx/claude-code-dashboard's real-time multi-session view) but not consumable as dependencies. |

## Appendix D: Sources (Anthropic policy + community references)

- Anthropic official headless docs (notes June 15 change): https://code.claude.com/docs/en/headless
- Anthropic support article on Agent SDK credits: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Anthropic support: Claude Code with Pro/Max plan: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- GitHub issue #36324 (headless docs / ToS warning, closed "not planned"): https://github.com/anthropics/claude-code/issues/36324
- VentureBeat coverage of reinstatement with credit pool: https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch
- DevToolPicks summary of June 15 change: https://devtoolpicks.com/blog/anthropic-splits-claude-subscriptions-agent-sdk-credit-june-2026
- ToS analysis on third-party Claude Code wrappers: https://autonomee.ai/blog/claude-code-terms-of-service-explained/
- Alex Fazio "headless claude maxxing" thread (community framing): https://x.com/alxfazio/status/2027532563544228013
