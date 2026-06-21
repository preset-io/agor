# Prompt-cache drift investigation

Date: 2026-06-21
Branch: `investigate-sdk-prompt-cache-drift`

## Executive summary

Agor is not manually implementing provider prompt caching. For Claude Code / Claude Agent SDK and Codex, Agor mostly controls the *shape* of the per-turn SDK/CLI request: appended system instructions, MCP/tool configuration, model/effort, working directory, permission/sandbox settings, and the SDK session/thread ID used for resume. Provider-side prompt caching is then handled by Claude Code / Anthropic or by OpenAI/Codex.

The main cache-busting bug found was in Agor's own appended system prompt: it included `session.sdk_session_id`. That value is absent on the first turn and present on later turns, so the rendered prompt changed immediately after first capture of the provider session/thread ID. Since provider caches match exact request prefixes, this is a high-likelihood one-time cache miss for the second turn of every new session (and possibly for any first resume after SDK ID migration). This has been fixed by removing `sdk_session_id` from the rendered Agor system prompt.

A secondary risk was nondeterministic MCP server ordering. All SDK integrations serialize MCP/tool config into provider-visible instructions or tool definitions; even a semantically identical but differently ordered server list can alter the cacheable prefix. This has been fixed by sorting effective MCP servers deterministically after template resolution and de-duplication.

## Upstream cache semantics checked

### Claude / Claude Code

Claude Code documentation says Claude Code manages prompt caching automatically and resends full context every turn; server-side caching reuses the exact unchanged prefix. A system-prompt change invalidates everything after it, while normal conversation growth appends at the end and should cache-hit the prior prefix. The docs explicitly list model, effort, MCP/tool-definition changes, plugin-provided MCP changes, compaction, and Claude Code upgrades as cache invalidators. They also note that permission-mode changes are cache-safe, and editing root/user `CLAUDE.md` mid-session does not apply until a restart/clear/compact, so it does not invalidate the active session cache.

Sources:
- https://code.claude.com/docs/en/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

The Anthropic API docs distinguish server-side prompt caching from any local session state: the API checks whether a prompt prefix up to a cache breakpoint exists in a recent cache; if not, it processes and writes the prefix. Usage fields are `cache_creation_input_tokens`, `cache_read_input_tokens`, and `input_tokens`, where total input is their sum.

### OpenAI / Codex

OpenAI Prompt Caching is automatic for supported models and requires exact prefix matches. Static content and tools should be at the beginning; variable content should be later. Usage exposes cached input tokens (`cached_tokens` in Responses/Chat usage details). OpenAI also exposes `prompt_cache_key` and `prompt_cache_retention` at the API layer, but Agor currently talks through the Codex SDK/CLI rather than directly constructing Responses API calls.

Sources:
- https://developers.openai.com/api/docs/guides/prompt-caching
- `/tmp/openai-docs-cache/codex-manual.md` (fetched from https://developers.openai.com/codex/codex-manual.md on 2026-06-21)

The Codex manual says SDK callers start a thread, call `run()` again to continue it, or `resumeThread(threadId)` to resume a past thread. It documents AGENTS.md discovery, `model_instructions_file`, MCP config, and per-thread options, but does not document a Codex-SDK-level prompt-cache control knob analogous to the raw Responses API `prompt_cache_key`.

## Agor per-turn input construction

### Shared Agor system prompt

`packages/core/src/templates/session-context.ts` renders `packages/core/src/templates/agor-system-prompt.md` with session, owner, branch, and repo metadata. This rendered text is injected into:

- Claude: `systemPrompt: { type: 'preset', preset: 'claude_code', append: agorSystemPrompt }` (`packages/executor/src/sdk-handlers/claude/query-builder.ts`).
- Codex: a per-session temp file passed as `model_instructions_file` (`packages/executor/src/sdk-handlers/codex/prompt-service.ts`).
- Gemini: a per-session temp file passed via `geminiMdFilePaths` (`packages/executor/src/sdk-handlers/gemini/prompt-service.ts`).
- Copilot: `systemMessage: { mode: 'append', content: systemMessage }` (`packages/executor/src/sdk-handlers/copilot/prompt-service.ts`).

Values currently in that prompt that can change mid-session:

- session ID: stable.
- agentic tool: stable for a session.
- owner name/email: mutable, but rare.
- branch path/name/ref: generally stable, but branch metadata edits can change it.
- branch notes: user-editable and likely to change.
- repo name/slug/local path: generally stable.

Removed from prompt:

- `sdk_session_id`: high-risk drift because it is assigned after the first successful provider turn.

### Claude Agent SDK

Agor constructs a fresh `query()` call per prompt. It passes:

- `cwd` from the branch path.
- Claude Code preset plus appended Agor system prompt.
- `settingSources: ['user', 'project', 'local']` so Claude Code loads user/project/local settings and project instructions.
- disallowed tool list.
- selected model, beta flags from model suffix, effort, optional advisor model via `extraArgs.advisor`.
- permission mode from request/session config.
- optional API key.
- MCP servers: built-in Agor HTTP server plus effective global/session MCP servers, including resolved auth headers/env.
- `resume` or `forkSession` depending on `session.sdk_session_id` and genealogy.
- user prompt as an async iterable to keep stdin open for `getContextUsage()`.

Notable behavior:

- If MCP servers were added after creation, Agor clears `sdk_session_id` and starts fresh so the SDK can see the new MCP set. This is intentional but destroys conversation/cache continuity for that session.
- If `last_updated` is older than 24h, Agor treats the Claude SDK session as stale and starts fresh. This can cause slow first feedback after a long idle gap, but Claude cache TTLs are also usually expired by then.
- Agor records Claude raw SDK `usage` / `modelUsage`; normalizer preserves `cacheReadInputTokens` / `cacheCreationInputTokens`.

### Codex SDK

Agor caches a `Codex` SDK instance and only recreates it when a fingerprint changes: API key, base URL, native-auth mode, config payload, or `AGOR_MCP_*` env token snapshot. Per turn it writes the Agor prompt to a stable per-session temp filename and configures:

- `model_instructions_file` pointing at that temp file.
- `mcp_servers` including built-in Agor and effective global/session MCPs; bearer tokens are routed through env vars.
- `ThreadOptions`: working directory, sandbox mode, approval policy, network access, model, reasoning effort.
- `resumeThread(session.sdk_session_id, threadOptions)` or `startThread(threadOptions)`.

Notable behavior:

- Rewriting the same instructions file every turn is fine if contents stay identical, but prior to this fix the contents changed after `sdk_session_id` capture.
- The client fingerprint includes MCP bearer token values. Token rotation intentionally reinitializes the client and may alter config/env; this is correct for auth, but can cost a cache miss.
- Codex reports `turn.completed.usage.cached_input_tokens`; Agor maps it to `cache_read_tokens` and stores the raw event.

### Gemini / Copilot

Gemini caches a per-session client keyed by invocation model. It constructs `Gemini.Config` with target/cwd, model, approval mode, MCP servers, and `geminiMdFilePaths` containing a per-session Agor prompt temp file. It reloads history from Gemini's filesystem session recording.

Copilot creates a fresh `CopilotClient` per prompt, then `resumeSession()` or `createSession()` with working directory, model, permission handler, MCP servers, and appended system message.

Both receive the same Agor rendered prompt and effective MCP server list, so the `sdk_session_id` removal and MCP sorting reduce drift for them too.

## Ranked cache-busting risks found

1. **High / fixed: `sdk_session_id` in Agor system prompt.** The value appears only after the first provider turn, mutating the system/instruction prefix for the next turn.
2. **Medium / fixed: effective MCP server ordering.** DB/service ordering was not made explicit. MCP/tool definitions may live in the provider-visible prefix, especially for Claude when tools are not deferred or are `alwaysLoad`.
3. **Medium / intentional: MCP server set or auth changes.** Adding/removing/toggling servers, dynamic tool lists, HTTP reconnects, auth-token rotation, and missing auth can all change provider-visible tool/config shape. Claude Code documents MCP/tool-definition changes as possible invalidators.
4. **Medium / intentional: model and effort changes.** Claude Code documents model and effort as cache keys. Agor passes both per turn.
5. **Medium / intentional: stale/fresh-session fallbacks.** Clearing `sdk_session_id` after 24h or after MCP changes restarts provider state. After 24h the server cache is probably cold anyway, but it still affects local resume behavior and first feedback.
6. **Low-Medium: mutable branch notes / owner profile / branch metadata in Agor prompt.** Useful context, but if edited mid-session and re-rendered each turn, it changes the prefix. Consider appending such updates as user/system conversation messages instead of changing the top-level Agor prompt.
7. **Low: temp paths.** Codex/Gemini use stable per-session file names (`agor-codex-instructions-<session>.md`, `agor-gemini-<session>.md`). File path itself is provider config and stable per session; content is the important part.
8. **Low: environment variables.** Most env changes affect process auth/tool setup rather than prompt prefix. MCP template env values can change resolved server config and therefore prefix.

## Instrumentation status

Existing coverage is better than expected:

- Claude raw SDK results include top-level `usage` and/or `modelUsage`; Agor normalizes cache read/write tokens.
- Codex `turn.completed.usage.cached_input_tokens` is mapped to `cache_read_tokens`, and token-count `event_msg` snapshots are used for context-window display.
- Gemini `usageMetadata.cachedContentTokenCount` is mapped to `cache_read_tokens`.
- Copilot currently records only basic input/output/total tokens from SDK events; no cache fields were found.

Recommended next instrumentation:

1. Add per-turn safe fingerprints to logs and task metadata: hash of rendered Agor prompt, normalized MCP server structural fingerprint (names/transports/tool counts/header/env key counts, not secrets), model, effort, cwd, permission/sandbox mode, and resume/fresh/fork mode.
2. Add a cache-hit summary to task analytics/UI: `cache_read_tokens`, `cache_creation_tokens`, uncached input, and cache-read ratio.
3. For Claude specifically, log `modelUsage` by model when cache read/write tokens are zero on resumed sessions with large context.
4. For Codex, expose `cached_input_tokens` and `reasoning_output_tokens` from raw usage in the task details panel.

## Changes implemented

- Removed `session.sdk_session_id` from `buildSessionContext()` and from `agor-system-prompt.md` so the Agor prompt no longer changes just because provider resume state was captured.
- Sorted effective MCP servers deterministically by source (`global` before session-assigned), name, then ID in `getMcpServersForSession()`.
- Added a unit test asserting deterministic MCP ordering.

## Verification

Attempted targeted test:

```bash
pnpm --filter @agor/executor test -- src/sdk-handlers/base/mcp-scoping.test.ts
```

Result: could not run because this worktree has no installed `node_modules` and `vitest` was not found. I did not run `pnpm install` or any build command because agent instructions say not to run builds unless explicitly asked and the user's watch/dev environment owns compilation.

## Recommendations

1. Keep the fixes above.
2. Avoid adding any per-turn-changing fields to `agor-system-prompt.md`. Treat it as cache-prefix content.
3. Move highly mutable operational status (branch notes edits, transient environment diagnostics, timestamps, queue/task metadata) into appended conversation messages when needed, not into the rendered system prompt.
4. Consider replacing Claude's 24h stale-session heuristic with a provider-specific resume health check before clearing `sdk_session_id`, or make it configurable. Cache TTL is likely expired after 24h, but local transcript resume may still be valuable.
5. Add the fingerprint/cached-token instrumentation above before making more speculative changes.
