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

6. **Effort estimate: ~7-10 days for v1, shipped as a big-bang POC** that pushes the approach as far as we can in one PR (per Max). Bundles spawn + watcher + view toggle + Defaults panel + auth UX + subagent ingestion + backgrounded MCP spawn + co-use sync. v2 is reserved for follow-up niceties (session import, mid-session model switch). No remaining open questions block implementation.

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

**TL;DR — no polling.** Linux's `fs.watch` (inotify) is event-driven: the watcher sleeps with zero CPU until the kernel notifies it that the file changed. The daemon doesn't spin a polling loop; the kernel does the work. A single daemon process can comfortably manage hundreds of concurrent CLI-session watchers without measurable overhead.

#### Where the watcher lives

`apps/agor-daemon/src/services/claude-cli-watcher.ts` (working name) — a daemon-side service, NOT in the executor. Rationale:
- Daemon already has the DB, MessagesService, TasksService, and WebSocket fanout.
- One executor per user (the Zellij wrapper) runs as a long-lived per-user process; session lifecycles are shorter than that. Watcher state belongs with the session row.
- Crash recovery is simpler: on daemon restart, we re-instantiate watchers from the `sessions` table in one place.

Sibling existing pattern: `apps/agor-daemon/src/services/terminals.ts` (per-user PTY orchestration) — we add `claude-cli-watcher.ts` next to it, with a similar lifecycle.

#### `fs.watch` vs chokidar vs polling

| Option | Pick? | Why |
|---|---|---|
| `node:fs.watch` (inotify on Linux) | **Yes** | Event-driven, zero CPU when idle, in the Node stdlib, no transitive dep |
| `chokidar` | No | Solves cross-platform inconsistencies we don't have (Agor deploys on Linux). Adds a non-trivial dep. Rejected. |
| `fs.watchFile` (polling fallback) | No | Polls `stat` every N ms. Wasteful for our scale. |
| Periodic `loadSessionUsageById` re-runs | No | Bypasses the kernel notification; defeats the point. |

Trade-off acknowledged: `fs.watch` on macOS (via `kqueue`) is less reliable than on Linux. Agor's production deployments are Linux; this is acceptable. If we ever support macOS dev workflows that need this, we slot in chokidar behind the same interface.

#### Watcher lifecycle

```
Session created (agentic_tool === 'claude-code-cli')
  ↓
Compute path: ~/.claude/projects/<slug>/<claudeSessionId>.jsonl
  ↓
File doesn't exist yet (claude is still starting):
  retry fs.stat with 100ms backoff up to 5s, then give up and surface an error
  (Empirically claude writes the first `queue-operation` line within <100ms of spawn.)
  ↓
File exists → fs.openSync(path, 'r') and seek to position cli_watcher_offset (0 on first start)
  ↓
fs.watch(path, { persistent: false }) → on every change event:
  1. Stat the file; if size hasn't grown, ignore (mtime touch).
  2. Read from cli_watcher_offset to end into a buffer.
  3. Split on '\n'. Last fragment (if no trailing newline) is held over for next event.
  4. For each complete line: parse JSON, run through ccusage's transcriptMessageSchema
     (defensive: log + skip unknown shapes), translate to ProcessedEvent, push through
     MessagesService.create/patch and TasksService.patch.
  5. Advance cli_watcher_offset.
  6. Persist cli_watcher_offset to the sessions row every M lines OR every T seconds,
     whichever comes first. (Cheap; SQLite handles 100s of writes/sec.)
  ↓
Also fs.watch the parent slug directory for the subagent subdir
(~/.claude/projects/<slug>/<claudeSessionId>/subagents/). When that dir appears or
gets new agent-<id>.jsonl files, spawn a child watcher for each.
  ↓
Session ends OR PTY exits:
  close watchers, flush final offset, mark session.status accordingly.
```

#### Triggers (what makes the watcher do something)

The watcher is **purely reactive**. It doesn't fire on a timer. The triggers are:

1. **Kernel inotify event** → process new bytes (the only steady-state trigger).
2. **Session create with `agentic_tool === 'claude-code-cli'`** → instantiate a new watcher instance.
3. **Daemon startup** → for every `sessions` row where `agentic_tool === 'claude-code-cli'` AND `status IN ('running', 'idle')`, re-instantiate watcher from persisted `cli_watcher_offset`.
4. **Session ends / PTY exit / user runs `/exit`** → tear down watcher.
5. **Mid-turn timeout heuristic** (only for `--permission-mode default`/`dontAsk`) → if no new event arrives for >10s after a `stop_reason: "tool_use"` whose tool_result hasn't appeared, surface "open the terminal to respond" banner. This is the one timer in the system, and it's a one-shot scheduled on the watcher's "last event seen" timestamp, not a poll loop.

#### End-of-turn detection

Three signals, in priority order:
1. **`assistant.message.stop_reason === "end_turn"`** — canonical, fires when Claude is done.
2. **`assistant.message.stop_reason === "tool_use"` + matching `user` event with `toolUseResult` for every `tool_use.id` in the assistant turn** — the turn is "complete" pending follow-up, agent will continue automatically.
3. **`queue-operation: dequeue`** — useful as a coarse signal but lags actual end-of-turn.

For the prompt-injection queue (below), we drain on signal #1 only. Signal #2 means the agent is still working and shouldn't be interrupted.

#### Translation rules (ccusage event → Agor `ProcessedEvent`)

- `user` with no `toolUseResult` → `messages` row, role `user`.
- `user` with `toolUseResult` → patch the pending tool-call row matched by `sourceToolAssistantUUID`.
- `assistant` → upsert `messages` row by `assistant.message.id` (the API msg_… ID, NOT the JSONL line's `uuid` — multiple JSONL lines share one `message.id`). Content blocks (`text`/`thinking`/`tool_use`) hydrate `message.content`.
- On `assistant` event: run `ccusage/data-loader.createUniqueHash` against an in-memory `seen` Set; skip dedup'd duplicates so MessagesService doesn't double-write.
- On end-of-turn: pull aggregated cost from `ccusage/data-loader.calculateCostForEntry` and patch `tasks.cost_usd` + token totals.
- `attachment` types: `pendingMcpServers`, `skill_listing`, `budget_usd`, `deferred_tools_delta` → log only, no DB write in v1.
- `queue-operation` → drive `task.status`: enqueue → `running`, dequeue → `idle` (after end-of-turn).
- `ai-title` → if the session still has a placeholder/empty title, set it.

#### Inotify operational note

Linux `inotify_max_user_watches` defaults to 8192 per user. Each `claude-code-cli` session uses 2 watches (the JSONL file + the parent slug dir for subagent discovery), plus one per active subagent file. A user with 50 concurrent CLI sessions and ~3 subagents-per-session active uses ~250 watches — well under the limit. Document for operators running Agor at scale (>500 concurrent sessions per Unix user): bump `fs.inotify.max_user_watches` via sysctl.

#### Co-use (user runs `claude` outside Agor on the same JSONL)

Worth flagging: if a user runs `claude --resume <agor-session-id>` in their own terminal while Agor's watcher is tailing, both interleave. The user's prompts get appended to the same JSONL → the watcher ingests them as if they came through Agor's session pane → Agor's UI sees turns it didn't initiate. This is technically a feature (cross-environment continuity) but can surprise. Document. The cleanest defense is the `--session-id` namespacing we already use: a normal Agor user won't accidentally guess a UUIDv4 to resume.

### Prompt input surfaces & PTY injection

Two distinct prompt input paths, with different purposes:

**Path 1 (primary, user-driven): the CLI's own REPL prompt inside the xterm.js terminal.** The user opens the terminal view and types directly into `claude`'s built-in input box. This is the same UX as running `claude` in iTerm. Nothing Agor-specific to wire — the PTY already exists.

**Path 2 (programmatic): PTY stdin injection from the daemon.** Used for:
- MCP-driven prompts (`agor_sessions_prompt` from another agent or external trigger)
- Background fork / subsession spawn that then needs a starting prompt
- The Agor conversation-pane textarea (kept wired in v1 / beta — see below)

PTY injection writes `<prompt>\n` to the running `claude` process's pseudo-terminal. Implementation: Zellij exposes `zellij action write-chars` per pane; the executor wraps this in a `writeToPane(paneId, text)` helper that the daemon calls. Each session row carries the `zellij_pane_id` after spawn so we can target it.

**Mode mapping (`agor_sessions_prompt(sessionId, prompt, mode)`):**

| Mode | Implementation |
|---|---|
| `continue` | PTY-inject `<prompt>\n` into the existing pane. Watcher captures the resulting turn. |
| `btw` (if supported) | Same as `continue` with a "by the way" prefix on the text. |
| `subsession` | Spawn a new detached Zellij pane running `claude --session-id <fresh-uuid>` with the parent's CLAUDE.md context; wait for the JSONL to appear; PTY-inject the prompt. See "Backgroundable sessions" below. |
| `fork` | Spawn a new detached Zellij pane running `claude --resume <parent.claudeSessionId> --fork-session`; the CLI mints a fresh session-id which we capture by watching the parent slug directory for a new `<new-uuid>.jsonl` filename; PTY-inject the prompt. |

**Queueing rule.** If the watcher shows the session is mid-turn (last `assistant` event has `stop_reason: "tool_use"` and its `toolUseResult` hasn't arrived, OR the most recent event isn't an `end_turn`), enqueue the injection in an in-memory per-session FIFO. Drain on the next `stop_reason: "end_turn"` event. User-typed input from path 1 is never queued — it goes straight to the PTY and the agent decides how to interleave.

**Wiring the Agor textarea (beta / dev safety net).** In v1 the conversation-pane textarea stays wired up — sending from it triggers a PTY injection just like an MCP call. Rationale: the integration is new, the watcher is new, the round-trip is new; keeping the textarea wired gives us a frictionless way to test the injection path during beta without firing up an MCP harness. Once the integration is solid we can hide the textarea in CLI-mode sessions and steer users to the terminal view (the CLI has its own input area; ours is redundant).

### Backgroundable sessions & MCP-driven spawn

This is the part that makes `agor_sessions_spawn` / `agor_sessions_prompt(mode:"fork")` / `agor_sessions_prompt(mode:"subsession")` and other "an agent over here starts work in a new session over there" workflows survive into the CLI adapter.

**The persistence layer is Zellij itself, not a tmux wrapper.** Zellij sessions persist across xterm.js modal close/reopen — already verified (`apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx:331-347`). A `claude` process running in a Zellij pane keeps running even when the user has the modal closed (or has never opened it). We don't add tmux on top; we use Zellij the way it already works in Agor.

**Detached panes for backgrounded sessions.** Today's Zellij plumbing (`packages/executor/src/commands/zellij.ts:412-444`) creates a new tab per worktree via `zellij action new-tab --name <name> --cwd <path>`. For a backgrounded CLI session, the daemon issues the same call but to a pane the user hasn't focused yet. The session exists, the watcher tails its JSONL, the user latches on later by clicking the session card → xterm modal opens focused on that pane.

**Permission mode for backgrounded sessions.** A backgrounded session has no human at the terminal to answer prompts. If we spawn it with `--permission-mode acceptEdits` (our v1 default for human-driven sessions), the agent will sit and hang on the first non-edit tool. The right defaults are:

| Spawn origin | Default `--permission-mode` |
|---|---|
| User clicks "New session" in UI | `acceptEdits` (Max's call — see Open Q #1) |
| `agor_sessions_spawn` from MCP | `bypassPermissions` (background — there's no user to respond) |
| `agor_sessions_prompt(mode:"fork"\|"subsession")` from MCP | `bypassPermissions` (same reason) |

These map cleanly to the spawn-time-only flag semantics (Max: "I think can only be triggered at startup as an argv" — correct). We bake the choice into the spawn call rather than expose it as a per-call MCP argument in v1.

**"Latching on" UX.** When the user clicks a backgrounded session's card, the xterm modal opens with the Zellij pane already focused. Same code path as opening the terminal for a foreground session — the pane just happens to have been alive in the background. The `cli_watcher_offset` means the conversation-view UI is already up-to-date; the user is reading state the watcher caught up to in real time.

**Recovering from "we lost the handle".** If the daemon restarted or the user's session cookie expired or something unexpected ate the in-memory pane-id mapping, recovery is one `claude --resume <claudeSessionId>` away. The new spawn attaches to the same JSONL (the file is the source of truth, not the in-memory pane handle). Watcher reopens from `cli_watcher_offset`. User reattaches via the modal. Zero data loss.

### Conversation view vs Terminal view (per-session UI toggle)

Each `claude-code-cli` session offers two views, switchable from the session-pane header:

**Conversation view (default for most users).** Agor's standard message feed, rebuilt by the watcher from the JSONL: assistant turns, tool calls, tool results, cost rollup, model, token usage. Bottom of pane: Agor's conversation textarea, wired through PTY injection (see above). This is the view that makes a CLI session feel like an Agor session.

**Terminal view (the truth).** The xterm.js modal embedded directly in the session pane (or available as a tab/popout), showing the actual `claude` REPL in its Zellij pane. Permission prompts appear here. The user types here when they want to interact with the CLI directly (e.g., `/clear`, `/compact`, slash commands, multi-line input).

**Why both.** During beta and probably forever, this matters:
- For users: Conversation view is familiar and integrated; Terminal view is needed for permission prompts and slash commands.
- **For debugging the integration: a side-by-side comparison is invaluable.** When the watcher mis-renders a turn or the cost calculation drifts, having the raw terminal output next to our reconstructed conversation tells us instantly where the translator broke. Recommend shipping a "split view" mode (terminal on right, conversation on left) for v1 as a developer affordance, even before considering it a regular-user feature.

**Toggle persistence.** Per-session, stored as a session-level UI preference. Default is conversation view; once the user switches to terminal view, that becomes their default for that session.

### Permission flow

- v1: default `--permission-mode acceptEdits`. Per-session override in NewSessionModal's CLI tab.
- A new badge component in the conversation-pane header for `claude-code-cli` sessions: "Permissions: handled in terminal — mode `acceptEdits`" with a tooltip + link.
- If the JSONL watcher detects "agent is waiting on a tool_use that hasn't been resolved for > 10s" AND `permission-mode` is `default` / `dontAsk`, render an inline banner: "Open the terminal to respond to a permission prompt."

### Cost & billing-mode UX

- New per-session `billing_mode` column on `sessions` (or computed from `apiKeyEnvVar` presence at spawn): `'subscription' | 'api-key' | 'unknown'`.
- **Same cost UI shape as the SDK adapter** — session total at the bottom of the conversation pane, identical position and styling. Number itself comes from `ccusage/data-loader.calculateCostForEntry` summed across the session.
- UI for `billing_mode === 'subscription'`: cost shown with caption "Estimated; covered by your Claude subscription. Counted against your subscription's rate limits, not against Agent SDK credits."
- UI for `billing_mode === 'api-key'`: cost shown plain (same as SDK adapter today).
- The cost number itself should reconcile to within rounding of what the SDK adapter would show for the same conversation, modulo schema-drift surprises. Bake into the integration test: feed the same conversation fixture through both code paths, assert equality within ε.

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

- `apps/agor-ui/src/components/AgentSelectionGrid/availableAgents.ts` — add new entry with a **"Beta" label**. Install check uses `which claude` + parse `--version`; show "Not installed — see install instructions" when missing.
- `apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx` — both tools selectable; selection swaps in the per-tool config form. **No auto-detect** — both adapters always visible, user picks based on the displayed tradeoffs.
- New `ClaudeCliConfigForm` component (parallel to `CodexSettingsForm`) — see "Claude Code CLI Defaults panel" below.
- User Settings → Default Agentic Config: keyed by tool name; add the new key.

### Tradeoff copy (shown at adapter pick time)

Adjacent to each adapter card in the picker, plain prose:

> **Claude Agent SDK** — Per-token billing via your Anthropic API key. Full Agor integration: structured permission prompts, mid-conversation pane editing, all features. Recommended if you have an API key.
>
> **Claude Code CLI** *(beta)* — Wraps the `claude` binary in your web terminal. Works with your Claude Pro/Max subscription's normal interactive limits (NOT the separate Agent SDK credit pool that starts June 15, 2026). Tradeoff: less integrated UX — permission prompts are answered inside the terminal, not in an Agor modal. Mid-session model switch and session import are v2.

### Claude Code CLI Defaults panel (User Settings → Claude Code CLI → Defaults)

A dedicated defaults screen for the flags that **must be set at spawn time** (the `claude` binary takes them as argv only — no in-session toggle exists). Different shape than the SDK adapter's settings page because:
- Some flags only work at spawn: `--dangerously-skip-permissions`, `--permission-mode`, `--model`, `--effort`, `--mcp-config`, `--add-dir`, `--betas`.
- Some things the user can do live inside `claude` via slash commands (`/permission`, `/clear`, `/compact`, `/model`).

**The defaults panel only exposes the spawn-time-only knobs.** Runtime knobs are left to the user's CLI usage.

Proposed fields:

| Field | Maps to | Notes |
|---|---|---|
| Default model | `--model <alias>` | Same model list as the SDK adapter (claude-opus-4-7, sonnet, haiku, with `[1m]` variants) |
| Reasoning effort | `--effort <level>` | low / medium / high / xhigh / max |
| Permission mode | `--permission-mode <mode>` OR `--dangerously-skip-permissions` | Single dropdown. Options: `default` / `acceptEdits` (out-of-box default) / `plan` / `dontAsk` / `bypassPermissions` / **`Dangerously skip permissions`**. Last option emits `--dangerously-skip-permissions` (the dedicated argv) instead of `--permission-mode bypassPermissions`; same runtime behavior, distinct telemetry per Anthropic's flag design. Warning copy renders adjacent when this option is selected. |
| Extra `--add-dir` paths | `--add-dir <dirs...>` | Whitelist of paths beyond the worktree |
| Append-system-prompt | `--append-system-prompt-file` content | Free text, persisted to a tmp file at spawn |
| Auth mode | env handling | "Use subscription (default)" / "Use API key" radio |

**Out-of-box default for permission mode: `acceptEdits`** — cautious, ergonomic for typical work, can be loosened by the user any time. The user owns this choice from the Defaults panel forward.

**Override for MCP-driven backgrounded spawns** (`agor_sessions_spawn`, fork, subsession): the user's permission-mode default is ignored and `bypassPermissions` is forced — no human is at the terminal to answer prompts, so anything stricter would just hang. This override is per-spawn-origin, not user-configurable. We could later add a Defaults checkbox "Allow MCP-driven sessions to use my permission mode" if anyone asks, but in practice nobody will want to wire a backgrounded agent that can hang on a prompt.

---

## Phased delivery plan

### v1 — Big-bang POC (~7-10 days)

Push the integration as far as we can in one PR. Per Max: *"effectively a POC that pushes how far we can push this approach."* v1.5 effectively folds into v1; v2 is reserved for genuine follow-ups.

**Core integration**
- Add `'claude-code-cli'` to `AgenticToolName` (`packages/core/src/types/agentic-tool.ts:18`), `Tool` registry (`packages/executor/src/handlers/sdk/tool-registry.ts:14`), and `AGENTIC_TOOL_CAPABILITIES` map.
- Add `ccusage` as a runtime dep.
- New executor adapter `packages/executor/src/sdk-handlers/claude-cli/` — spawn config builder, ccusage→`ProcessedEvent` translator, session-lifecycle bridge.
- Daemon-side `claude-cli-watcher` service (`apps/agor-daemon/src/services/claude-cli-watcher.ts`): `fs.watch` per active CLI session + parent slug dir for subagent discovery. Calls `ccusage/data-loader.loadSessionUsageById` on each new chunk, dedupes with `createUniqueHash`, translates, pushes through MessagesService / TasksService.
- Sync markers persisted on the `sessions` row: `cli_watcher_offset` (bytes), `cli_last_event_ts`, `cli_last_event_uuid`. Co-use sync is silent — any process can append to the JSONL and we ingest equivalently.

**Spawn + PTY**
- Zellij pane spawn for CLI sessions, including detached panes for backgrounded MCP-driven spawns (extend `packages/executor/src/commands/zellij.ts`).
- Zellij `action write-chars` wiring for PTY injection from the Agor textarea, MCP calls, and `agor_sessions_prompt(mode:"fork" / "subsession")` starting prompts.
- In-memory per-session FIFO queue for PTY injections; drain on `stop_reason: "end_turn"`.
- MCP backgrounded spawn for `agor_sessions_spawn` and `agor_sessions_prompt(mode:"fork" / "subsession")` — always `bypassPermissions` (no human at the terminal).
- "Latching on" UX: clicking a session card opens the xterm modal focused on that session's existing Zellij pane.

**UI**
- **Conversation view ↔ Terminal view toggle** in the session pane header. Both views populated. Split-view mode for debugging.
- Rename `claude-code` → `claude-agent-sdk` (DB migration + UI labels).
- "Beta" label on `claude-code-cli` in `AgentSelectionGrid`; tradeoff copy adjacent to each adapter card at pick time.
- **Claude Code CLI Defaults panel** (User Settings): model, effort, permission mode (with `Dangerously skip permissions` as a named dropdown option emitting `--dangerously-skip-permissions`), extra `--add-dir`, `--append-system-prompt-file` content, auth mode.
- New `ClaudeCliConfigForm` for per-session overrides of the Defaults.
- **Claude Code CLI Auth panel** (User Settings, sibling to the renamed Claude Agent SDK Auth): `~/.claude/.credentials.json` status, "Run `claude auth login`" CTA in a pre-typed terminal modal.
- Onboarding affordance: missing binary → install instructions; missing auth → `claude auth login`.

**Cost & rate-limit**
- `billing_mode` column on `sessions` (subscription / api-key / unknown), derived from `apiKeyEnvVar` presence at spawn.
- Session-total cost UI in the conversation pane bottom, same shape as the SDK adapter.
- Caption for subscription sessions: "Estimated; covered by your Claude subscription."
- 5-hour billing-window banner powered by `ccusage/data-loader.loadSessionBlockData()`.

**Robustness**
- Subagent JSONL ingestion (`<session-id>/subagents/agent-<id>.jsonl`) — collapsible internal-subagent rows in the conversation view. Retrofit the SDK adapter to surface these too for UI consistency.
- Crash recovery: on daemon restart, re-instantiate watchers for every in-flight CLI session from `cli_watcher_offset`.
- Defensive parser via ccusage's valibot schemas: log + skip unknown event types.
- Tested-version pin: detect `claude --version` outside known-good range, log a startup warning.
- Integration tests:
  - Fixture replay: feed this analysis's own session JSONL through the watcher + ccusage; assert dedup, cost, and event count.
  - Reconciliation: feed the same conversation through SDK adapter and CLI adapter; assert session cost matches within ε.
  - PTY-injection round trip: inject a prompt via the daemon API, assert a `user` event appears in the JSONL within reasonable time.

### v2 — Follow-up niceties (~3-4 days)

Genuine follow-ups, not v1-scope-cuts.

- **Session import:** "Adopt existing Claude session" picker that lists `~/.claude/projects/*/`*.jsonl` (filterable by cwd / age) and ingests one into Agor as a new session. Useful for power users who run `claude` outside Agor first.
- **Mid-session model switch:** respawn `claude --resume --model <new>` after the current turn completes; preserves session-id and JSONL continuity.
- **"Stuck permission prompt" banner** (post-beta-feedback): if users report confusion about CLI prompts going unanswered, add the mid-turn timeout heuristic with a tested threshold and surface "open terminal to respond" in the conversation view. Deferred per Max: "bulk of input would be done through the CLI itself, except when externally prompting (MCP/API)" — so the heuristic is unlikely to be needed in practice.

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

- v1 (big-bang POC): **~7-10 days** for one engineer familiar with the executor + terminal architecture. Bundles what was previously split across v1 / v1.5 / partial-v2, per Max's "push as far as we can in one PR" framing. Net headcount is bounded by:
  - Watcher + translator + Defaults panel are the bulk of new code.
  - Subagent ingestion adds ~half a day (the file-watching pattern is the same as the parent JSONL).
  - View toggle adds 1-2 days for the conversation/terminal split-view component.
  - Existing patterns (Codex adapter, Zellij tab plumbing, MCP scoping, user settings panels) shortcut maybe 1-2 days.
- v2 (follow-up niceties): ~3-4 days. Session import + mid-session model switch + optional stuck-prompt banner if beta surfaces the need.
- Tests are in v1 scope: fixture-replay unit tests, SDK-vs-CLI cost reconciliation, PTY-injection round trip. CI smoke test using `--print` and an API key in CI-only env validates the spawn shape end-to-end.

---

## Open questions for Max

### Resolved (in scoping)

- **Auto-detect default adapter on first run** → No auto-detect. Both adapters always shown in the picker; user picks based on the displayed tradeoffs. CLI carries a "beta" label.
- **PTY injection default on/off / per-session toggle UX** → PTY injection's real purpose is backgrounded calls (MCP/API). User-driven prompts come from the terminal's own REPL prompt. Agor textarea stays wired through PTY injection in v1 as a beta-testing safety net.
- **Cost UI shape** → Same UI as SDK adapter (session total at the bottom). Subscription sessions get a caption. Numbers reconcile within ε to the SDK adapter — integration test.
- **Default permission mode for user-driven sessions** → User-defined in the Defaults panel. Out-of-box value: `acceptEdits`. User can change to any mode, including `Dangerously skip permissions` (emits the dedicated `--dangerously-skip-permissions` argv). MCP-driven backgrounded spawns always force `bypassPermissions`.
- **Conversation ↔ Terminal view toggle: v1 or v1.5?** → v1. Side-by-side debugging is essential while the integration is new.
- **`--dangerously-skip-permissions` checkbox vs dropdown entry** → Single dropdown control. One option emits `--dangerously-skip-permissions` (for Anthropic's telemetry distinction); runtime behavior is the same as `bypassPermissions`.
- **Prompt-injection queue: in-memory or DB-persisted?** → In-memory for v1. Iterate if we find we need persistence.
- **Mid-turn timeout for "open terminal to respond" banner** → No banner in v1. Bulk of input flows through the CLI's own REPL (user already looking at the terminal); PTY injection is the niche case for external prompts. Watcher just records what it sees; UI reflects it. If users report confusion during beta, we add a heuristic banner then with a tested threshold.
- **Co-use detection** → Co-use is a first-class feature; watcher syncs silently regardless of origin. The byte-offset (`cli_watcher_offset`) is the canonical sync marker; we also persist the last processed event's `timestamp` and `uuid` for telemetry / health. No warning UI for "this turn didn't go through `agor_sessions_prompt`" — it's just another turn.
- **Subagent JSONL ingestion in v1 or v2?** → v1, as part of the big-bang scope below. (See revised phased plan.)
- **v1 scope philosophy** → Big-bang POC: pull as much of the integration into v1 as possible. v1.5 effectively folds into v1 (auth panel, onboarding affordance, etc.). v2 is reserved for genuine follow-ups (session import, mid-session model switch).
- **`--debug-file` for live `rate_limit_event`** → Dropped. ccusage's `loadSessionBlockData()` already gives us the 5h-billing-window metric, which is the practical thing subscribers care about. If, in beta, users want a moment-of-rate-limit alert (vs a "how close am I" gauge), we revisit.
- **Session import** → v2.
- **PTY injection ToS classification** → Risk acknowledged. We test the boundaries; if users get banned for it, we add an in-product notice and flip the default to off. The watcher and integration stay intact in that case — only the textarea behavior changes.

### No remaining open questions

All scoping decisions are resolved. Implementation worktrees can spawn from this doc. New questions surfacing during implementation get logged to the PR.

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
