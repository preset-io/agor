# Cursor SDK Support Analysis — 2026-05-25

**Author:** Cursor SDK support audit (`analyze-cursor-sdk-support` worktree)  
**Status:** Draft for Max review. Cursor is surfaced as a beta provider and this branch now includes an initial local-runtime `@cursor/sdk` adapter. Runtime support is still early and should remain beta until smoke-tested with real Cursor keys/worktrees.
**Recommendation:** **Keep as beta; continue the local-runtime integration behind explicit beta labeling. Do not make it default/recommended until permission, usage, and live-runtime risks are resolved.**

---

## TL;DR

Cursor's new TypeScript SDK is a credible fit for Agor's provider model, but it is still public beta and it adds a native-heavy package/runtime surface that deserves live smoke testing before non-beta support.

1. **What exists today:** `@cursor/sdk` exposes `Agent.create`, `Agent.resume`, `agent.send`, `run.stream`, `run.wait`, `run.cancel`, artifact APIs, model/repository discovery, local/cloud runtimes, inline MCP config, custom subagents, and a structured error hierarchy. The launch post says the SDK uses the same runtime/harness/models as Cursor desktop, CLI, and web, can run locally or on Cursor cloud, and is billed with standard token-based consumption pricing ([Cursor changelog](https://cursor.com/changelog/sdk-release), [Cursor blog](https://cursor.com/blog/typescript-sdk)). The npm package currently inspected was `@cursor/sdk@1.0.13`.
2. **Best Agor fit:** local runtime against the Agor branch worktree (`local: { cwd: branch.path }`) because Agor already owns branches, RBAC, Unix identity, git state capture, MCP session tokens, and process lifecycle. Cursor cloud runtime is valuable, but conflicts with Agor's branch-centric “worktree as card” model unless treated as a separate remote-execution mode.
3. **Largest blocker:** no obvious public permission callback equivalent to Claude/Copilot. Cursor has hooks and sandbox options, and the background/cloud agent docs warn cloud agents auto-run terminal commands, but the SDK public types do not expose an Agor-style interactive permission request channel. Treat v1 as “autonomous/auto-approved inside Agor's OS sandbox,” similar to OpenCode, until proven otherwise.
4. **Maturity risk:** Cursor marks the SDK public beta; their Terms say beta services are evaluation/non-production, as-is, and may be discontinued ([Terms §1.6](https://cursor.com/en-US/terms-of-service)). That argues for beta labeling plus an operator-visible experimental flag/runtime guard.
5. **Implementation shape:** add a `cursor` agentic tool, credentials (`CURSOR_API_KEY`), model discovery/cache, `CursorTool` adapter that maps `SDKMessage` events to Agor messages/tool widgets, session persistence via `sdk_session_id = Cursor agentId`, run tracking via task metadata, MCP injection via inline `mcpServers`, and cancellation via `Run.cancel()`.

---

## Sources reviewed

### External primary sources

- Cursor SDK changelog, 2026-04-29: package install, public beta, local/cloud runtime, streaming example, Cloud Agents API v1 updates ([cursor.com/changelog/sdk-release](https://cursor.com/changelog/sdk-release)).
- Cursor SDK announcement blog, 2026-04-29: cloud dedicated VMs, reconnectable runs, PR/artifacts, self-hosted/local runtime, MCP/skills/hooks/subagents, token-based pricing ([cursor.com/blog/typescript-sdk](https://cursor.com/blog/typescript-sdk)).
- Cursor SDK TypeScript docs entry linked from the package README: [cursor.com/docs/api/sdk/typescript](https://cursor.com/docs/api/sdk/typescript) (also linked as `/docs/sdk/typescript` from the changelog).
- Cursor public package inspected with `npm view @cursor/sdk` and `npm pack @cursor/sdk` on 2026-05-25: `@cursor/sdk@1.0.13`, Node `>=18`, license “SEE LICENSE IN LICENSE.md”, dependencies and `.d.ts` API surface.
- Cursor cookbook examples repo: says SDK supports local and cloud runtimes, event streaming, prompts, models, cancellation, artifacts, and conversation state; API keys come from the Cursor integrations dashboard and are exposed as `CURSOR_API_KEY` ([github.com/cursor/cookbook](https://github.com/cursor/cookbook)).
- Cursor MCP docs: supports `stdio`, `SSE`, and Streamable HTTP transports; tools/prompts/resources/roots/elicitation; project/global `.cursor/mcp.json`; MCP tools ask for approval by default in Cursor chat ([docs.cursor.com/context/model-context-protocol](https://docs.cursor.com/context/model-context-protocol)).
- Cursor background/cloud agent docs: cloud/background agents run in isolated Ubuntu VMs, have internet access, clone GitHub repos, run on separate branches, and auto-run terminal commands with prompt-injection/data-exfiltration caveats ([docs.cursor.com/en/background-agent](https://docs.cursor.com/en/background-agent)).
- Cursor Terms of Service: service includes APIs/docs/tools, paid add-ons can be usage-based, beta services are non-production/as-is/discontinuable, and auto-code execution risk is user's responsibility ([cursor.com/en-US/terms-of-service](https://cursor.com/en-US/terms-of-service)).

### Agor code/docs reviewed

- SDK comparison guide source: `apps/agor-docs/pages/guide/sdk-comparison.mdx`.
- Agentic tool names/capabilities/API key map: `packages/core/src/types/agentic-tool.ts:11`, `packages/core/src/types/agentic-tool.ts:38`, `packages/core/src/types/agentic-tool.ts:198`, `packages/core/src/types/agentic-tool.ts:205`.
- Session model and default permission mode: `packages/core/src/types/session.ts:59`, `packages/core/src/types/session.ts:108`, `packages/core/src/types/session.ts:123`, `packages/core/src/types/session.ts:221`, `packages/core/src/types/session.ts:237`.
- Per-user credential/default config surfaces: `packages/core/src/types/user.ts:100`, `packages/core/src/types/user.ts:118`, `packages/core/src/types/user.ts:127`, `packages/core/src/types/user.ts:154`, `packages/core/src/types/user.ts:254`.
- Global config credential whitelist: `packages/core/src/config/config-manager.ts:635`, `packages/core/src/config/types.ts:698`, `packages/core/src/config/types.ts:710`.
- Executor payload/registry surfaces: `packages/executor/src/payload-types.ts:74`, `packages/executor/src/index.ts:23`, `packages/executor/src/handlers/sdk/tool-registry.ts:16`, `packages/executor/src/handlers/sdk/tool-registry.ts:120`.
- Shared executor lifecycle/callbacks/token normalization: `packages/executor/src/handlers/sdk/base-executor.ts:31`, `packages/executor/src/handlers/sdk/base-executor.ts:109`, `packages/executor/src/handlers/sdk/base-executor.ts:274`, `packages/executor/src/handlers/sdk/base-executor.ts:302`, `packages/executor/src/handlers/sdk/base-executor.ts:428`, `packages/executor/src/sdk-handlers/normalizer-factory.ts:31`.
- MCP scoping/template resolution: `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:69`, `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:144`.
- Provider precedents: Claude wrapper `packages/executor/src/handlers/sdk/claude.ts:20`, Codex wrapper `packages/executor/src/handlers/sdk/codex.ts:17`, OpenCode special-case session handling `packages/executor/src/handlers/sdk/opencode.ts:26`.

---

## What Cursor SDK exposes today

Based on `@cursor/sdk@1.0.13` package types plus Cursor's launch materials:

| Area                   | Current Cursor SDK surface                                                                                                                                                                                                                       | Agor implication                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package                | `@cursor/sdk`, ESM/CJS exports, `Agent` and `Cursor` namespaces. `package.json` says Node `>=18`; Agor root already requires Node `>=22.12.0`.                                                                                                   | Compatible with Agor's Node floor. Add dependency to `packages/executor` only; avoid browser imports.                                                                                     |
| Native deps/platform   | Package depends on `sqlite3` and optional platform packages: `@cursor/sdk-darwin-*`, `@cursor/sdk-linux-*`, `@cursor/sdk-win32-x64`.                                                                                                             | CI/install smoke tests must cover Linux x64. Native dependency makes this higher-risk than pure TS SDKs.                                                                                  |
| License/terms          | Package license points to Cursor Terms. Terms cover APIs/docs/tools and beta/auto-execution risk.                                                                                                                                                | Legal/product review before broad enablement; include feature-flag warning.                                                                                                               |
| Auth                   | `AgentOptions.apiKey`; `CursorRequestOptions.apiKey`; docs/examples use `process.env.CURSOR_API_KEY`; cookbook says create key in Cursor integrations dashboard.                                                                                 | Add `CURSOR_API_KEY` to `ApiKeyName`, per-user encrypted bucket, maybe global config only if Cursor service-account/team keys are acceptable.                                             |
| Runtime                | `AgentOptions.local.cwd` accepts a string or string array; local options include `settingSources` and `sandboxOptions`. `cloud` options include env, repos, current-branch work, auto-PRs, and env vars. Blog also mentions self-hosted workers. | v1 should use local runtime with Agor branch path. Cloud runtime is a later, separate mode because it creates remote branches/PRs outside Agor's worktree lifecycle.                      |
| Models                 | `model?: { id, params? }`; `Cursor.models.list()` returns ids, aliases, params, variants; README suggests `composer-latest`.                                                                                                                     | Static defaults are possible, but model discovery/cache is better. Need UI model provider entry.                                                                                          |
| Session/resume         | `Agent.create({ agentId? })`; `Agent.resume(agentId)`; `SDKAgent.agentId`; `agent.send()` creates a `Run`; `Agent.list`, `Agent.get`, `Agent.messages.list`.                                                                                     | Store `agentId` in `sessions.sdk_session_id`. Store active `run.id` in task metadata/raw response if needed for cancellation/reconnect.                                                   |
| Runs/cancellation      | `Run` has `id`, `agentId`, `stream()`, `conversation()`, `wait()`, `cancel()`, status callbacks, `result`, `model`, `durationMs`, `git`. Static `Agent.getRun` and `Agent.cancelRun`.                                                            | Maps cleanly to Agor task lifecycle and `AbortController`; implement `stopTask()` around current `Run.cancel()`.                                                                          |
| Streaming/events       | `run.stream()` yields `SDKMessage`: `system`, `user`, `assistant`, `tool_call`, `thinking`, `status`, `request`, `task`. `agent.send` also accepts `onStep` and `onDelta` callbacks.                                                             | Good fit for Agor `StreamingCallbacks`; use `assistant` text blocks for chunks, `thinking` for thinking callbacks, `tool_call` for tool widgets. Need tests for duplicate/partial events. |
| Tool calling/editing   | Exported tool-call types include shell/read/write/edit/delete/grep/glob/semantic search/MCP/todos/subagent/create-plan/read-lints. `SDKToolUseMessage` has `name`, `status`, `args`, `result`, truncation flags.                                 | Normalize to Agor `tool_use`/`tool_result` blocks. Cursor can produce rich widgets, likely closer to OpenCode/Copilot than Codex.                                                         |
| MCP                    | `mcpServers?: Record<string, McpServerConfig>` on agent and send options; configs support `stdio`, `http`, `sse`, env/headers/OAuth fields. Blog says MCP can come from `.cursor/mcp.json` or inline.                                            | Reuse Agor MCP scoping, inject built-in Agor MCP as Streamable HTTP with Authorization header, and convert user MCP rows to Cursor `McpServerConfig`.                                     |
| Skills/hooks/subagents | Blog says SDK agents pick up `.cursor/skills`, `.cursor/hooks.json`, and named subagents via `agents?: Record<string, AgentDefinition>`.                                                                                                         | Mostly leave native. Potential collision with Agor skills/AGENTS.md should be documented. Avoid writing `.cursor/*` in v1.                                                                |
| Permissions/sandbox    | Public types expose `sandboxOptions?: { enabled: boolean }`, but no Agor-style permission callback. Cursor MCP docs mention chat approval by default; background-agent docs say cloud agents auto-run terminal commands.                         | Treat as auto-approved/autonomous inside Agor's Unix/worktree sandbox. Do not promise interactive approvals until a Cursor hook/callback can block decisions safely.                      |
| Usage/cost             | Public types expose `RunResult.durationMs`, `model`, `git`, but no token/cost fields in inspected `.d.ts`. Changelog/blog say billing is token-based.                                                                                            | v1 may not populate Agor token/context pills unless hidden runtime events contain usage. Store raw responses and leave normalized usage blank initially.                                  |
| Errors                 | `CursorSdkError` with `code`, `status`, `isRetryable`, `endpoint`, `requestId`, plus `AuthenticationError`, `RateLimitError`, `ConfigurationError`, `AgentBusyError`, `IntegrationNotConnectedError`, `NetworkError`, `UnknownAgentError`.       | Map directly to user-facing task errors; retryable/auth/rate-limit affordances can be surfaced cleanly.                                                                                   |

---

## Comparison row for the SDK guide

If Cursor support is added, this is the likely row/column content for the existing guide's categories:

| Feature                     | Cursor SDK       | Notes                                                                                                      |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Streaming responses**     | ✅ Text + tools  | `run.stream()` yields assistant/tool/thinking/status messages; `onDelta` may provide finer-grained deltas. |
| **Stop mid-execution**      | ✅ Yes           | `Run.cancel()` / `Agent.cancelRun()`, with cloud run-scoped cancellation.                                  |
| **Session import/export**   | ❌ No            | Agent/message list APIs exist, but no portable transcript/import format found.                             |
| **Session forkable**        | ❌ Not found     | Resume exists; fork primitive not found in public SDK types.                                               |
| **MCP integration**         | ✅ Native        | Inline `mcpServers` plus `.cursor/mcp.json`; supports stdio/http/sse.                                      |
| **Permission requests**     | ⚠️ Not exposed   | Sandbox/hooks exist, but no typed blocking permission callback found. Treat as auto-approved for v1.       |
| **Project instructions**    | ✅ Cursor-native | `.cursor/rules`, skills, hooks, and Cursor context/indexing; AGENTS.md behavior needs empirical check.     |
| **Tool execution**          | ✅ Rich events   | `SDKToolUseMessage` and exported typed tool-call unions for shell/read/write/edit/MCP/subagents/todos.     |
| **Session continuity**      | ✅ SDK-managed   | Store `SDKAgent.agentId` in `sessions.sdk_session_id`; sends create per-prompt `Run`s.                     |
| **Token usage tracking**    | ❌ Not exposed   | Token-based billing exists, but inspected public types lack usage/cost payloads.                           |
| **Context window tracking** | ❌ Not exposed   | No context-window counters in inspected public types. Could estimate from Agor DB later.                   |

Positioning against existing integrations:

- **Closest to OpenCode/Copilot** for event-rich tool lifecycle and SDK-managed sessions.
- **Better than Codex/Gemini** for resume ergonomics if `agentId` is durable across process restarts.
- **Worse than Claude/Copilot** for permissions unless Cursor exposes a blocking hook.
- **Worse than Claude/Codex/OpenCode** for Agor token/cost UI today, because no usage payload was visible in public types.
- **Potentially strongest native harness** for indexing/semantic search/skills/hooks/subagents, but that is also the largest black box and maturity risk.

---

## Proposed Agor architecture

### 1. Product/config surfaces

Smallest viable config additions:

- Add `cursor` to `AgenticToolName`, payload `ToolTypeSchema`, executor registry `Tool`, and static capabilities.
  - Existing enums/maps live at `packages/core/src/types/agentic-tool.ts:38`, `packages/executor/src/payload-types.ts:74`, and `packages/executor/src/handlers/sdk/tool-registry.ts:16`.
- Add `CURSOR_API_KEY` to `ApiKeyName`, `TOOL_API_KEY_NAMES`, `AgenticToolsConfig`, `AgenticToolConfigField`, and possibly `ConfigCredentialKey` / `AgorCredentials`.
  - Per-user encrypted SDK credentials are modeled in `packages/core/src/types/user.ts:127` and scoped by the daemon resolver before executor spawn (`packages/executor/src/handlers/sdk/base-executor.ts:274`).
  - Max question: should Cursor keys be user-only like Copilot, or allowed globally like OpenAI/Gemini? Service-account API keys make global plausible; personal Cursor API keys argue user-only.
- Add default model config and model list:
  - Minimal: static `composer-latest` / `composer-2` defaults.
  - Better: `Cursor.models.list()` server-side cache behind auth, with fallback static aliases.
- Keep Cursor visibly marked as beta wherever providers are selected. A hard feature flag can still be added later if live smoke testing exposes runtime instability.

### 2. Executor handler/tool adapter

Create a normal SDK-path adapter, not a Zellij/PTY adapter:

- `packages/executor/src/handlers/sdk/cursor.ts` analogous to `claude.ts`/`codex.ts` for normal `executeToolTask` flow.
- `packages/executor/src/sdk-handlers/cursor/cursor-tool.ts` implementing `BaseTool.executePromptWithStreaming()` and `stopTask()`.
- Optional `cursor/normalizer.ts` returning no usage at first but preserving model/duration/git if present.
- Add dependency `@cursor/sdk` to `packages/executor/package.json` only. Do **not** expose it through `packages/core` browser-safe exports.

Execution flow:

1. Resolve session and branch path.
2. Resolve `CURSOR_API_KEY` through existing key resolver.
3. If `session.sdk_session_id` exists: `Agent.resume(agentId, { apiKey, local: { cwd: branch.path } })`.
4. Else: `Agent.create({ apiKey, model, local: { cwd: branch.path, sandboxOptions }, mcpServers })`, then patch `sessions.sdk_session_id = agent.agentId`.
5. Create the Agor user message.
6. `const run = await agent.send(prompt, { model, mcpServers, onStep, onDelta })`.
7. Save `run.id` in raw task metadata as soon as available.
8. Iterate `for await (const event of run.stream())` and map to Agor streaming + final messages.
9. Await terminal result (`run.wait()` if stream does not return final state), patch task status/model/git/duration.
10. `agent.close()`/async dispose in finally.

### 3. Normalized message/event mapping

Suggested v1 mapping from Cursor `SDKMessage`:

- `system(subtype:init)`: store in raw SDK response; maybe use `tools[]` for diagnostics.
- `assistant.message.content[].type === 'text'`: stream chunks with `onStreamStart`/`onStreamChunk`/`onStreamEnd`, then create final assistant message.
- `thinking`: use `onThinkingStart`/`onThinkingChunk`/`onThinkingEnd`; include duration in metadata when present.
- `tool_call`: create/update `tool_use` and `tool_result` content blocks keyed by `call_id`; map `running`/`completed`/`error` to Agor tool lifecycle.
- `status`: optional lightweight system/status events; do not spam message rows unless terminal/error.
- `task`: map subagent/task progress as tool/status content after inspecting real events.
- `request`: unknown; preserve raw until understood.

Agor already has a provider-neutral callback contract at `packages/executor/src/sdk-handlers/base/types.ts:36` and daemon broadcast implementation at `packages/executor/src/handlers/sdk/base-executor.ts:109`.

### 4. MCP handling

Reuse `getMcpServersForSession()` and template resolution (`packages/executor/src/sdk-handlers/base/mcp-scoping.ts:69`, `:144`). Convert Agor MCP rows to Cursor SDK configs:

- Built-in Agor MCP: `type: "http"`, `url: daemonUrl + "/mcp"`, and an `Authorization: Bearer <session.mcp_token>` header.
- `stdio`: `{ type: 'stdio', command, args, env, cwd }`.
- HTTP/SSE: `{ type: 'http' | 'sse', url, headers }` plus OAuth fields only after verifying Cursor's exact OAuth expectations.

Open question: Cursor supports `.cursor/mcp.json`; Agor should prefer inline `mcpServers` so session-specific selection, OAuth token injection, and `mcp_token` scoping remain daemon-controlled.

### 5. Permissions/sandbox

V1 should be explicit: **Cursor SDK provider is autonomous.**

- Use Agor's existing branch Unix isolation/RBAC as the outer boundary.
- For local runtime, set `local.cwd = branch.path`; evaluate `sandboxOptions.enabled = true` in the spike and document actual effects.
- Do not wire Agor permission modals until Cursor exposes either:
  - a blocking SDK permission callback,
  - hook events that can deny/allow synchronously per operation, or
  - a reliable config policy language Agor can generate per task.

This is similar to OpenCode's current “auto-granted by Agor” behavior, but should be even more conservatively labeled because Cursor's harness includes rich native tools and context indexing.

### 6. Usage/cost/context

Initial state:

- Persist raw `RunResult` and any stream terminal event.
- Populate task `model` from `run.model` / agent model.
- Populate duration from `run.durationMs` if present.
- Leave token/cost/context fields empty unless real events reveal usage data.

Follow-up options:

- Ask Cursor whether usage metrics are intentionally absent or available in a hidden/stable event.
- Estimate context from Agor message history for UI only, clearly labeled “estimated,” if Max wants parity.
- Never infer billing cost without token counts; Cursor bills standard token-based pricing but the SDK types inspected do not expose the counters.

---

## Risks and blockers

| Risk/blocker                        | Severity   | Notes/mitigation                                                                                                                               |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Public beta / non-production terms  | High       | Cursor calls SDK public beta; Terms say beta services are as-is and can be discontinued. Ship behind feature flag only.                        |
| Native dependency/platform packages | Medium     | `sqlite3` and optional platform packages can break CI, Alpine, strict Linux envs, or isolated executor users. Add install smoke test.          |
| Permission surface unclear          | High       | No public blocking permission callback found. V1 must be autonomous/sandboxed only.                                                            |
| Token/cost absent                   | Medium     | Agor UI would lack pills/cost for Cursor unless Cursor adds usage events. Not a blocker for execution.                                         |
| Cursor local state location         | Medium     | Need empirical test where local agent stores state and whether `agentId` survives under Agor's Unix user/home isolation.                       |
| Cursor indexing/caches              | Medium     | Local runtime may create `.cursor`/home caches or read broad project state; verify secrets behavior and `.gitignore`/`.cursorignore` handling. |
| Cloud runtime model mismatch        | Medium     | Cursor cloud clones GitHub and creates branches/PRs externally; Agor branch cards would no longer be source of truth. Defer cloud mode.        |
| Licensing/redistribution            | Low/Medium | Package license is proprietary/Terms-based. Using as dependency may be fine, but get product/legal comfort before enabling for all users.      |
| Credentials/secrets                 | Medium     | Cursor API key must stay per-tool scoped like existing credentials; local agent can read env/files exposed to its Unix process.                |
| Headless suitability                | Low/Medium | SDK is explicitly programmatic/headless, but local runtime behavior in a daemon/executor process must be smoke-tested.                         |

---

## Recommendation

**Expose as beta, then prototype local runtime only, with no permission-modal promise.**

Reasons to prototype now:

- The SDK surface matches Agor's executor architecture better than the older Cursor CLI would.
- `agentId` + run-scoped streaming/cancel is a clean fit for `sdk_session_id` and task lifecycle.
- Cursor's harness (indexing, semantic search, MCP, skills, hooks, subagents) could be a strong differentiator for Agor users who already use Cursor.

Reasons not to ship broadly yet:

- Beta/Terms posture.
- Native package/runtime unknowns.
- Missing permission and usage/cost surfaces.
- Cloud runtime semantics overlap/conflict with Agor's own branch/worktree orchestration.

---

## Proposed implementation plan split into PRs

### PR 1 — Provider skeleton as beta

- ✅ Add `cursor` to core/executor/UI type unions and static capability maps.
- ✅ Add `CURSOR_API_KEY` credential plumbing.
- ✅ Surface Cursor as a beta provider in agent selection/settings, matching the OpenCode beta posture.
- ✅ Add package dependency (`@cursor/sdk`) to executor.
- Add import/install smoke test for Linux CI.

### PR 2 — Local runtime happy path

- ✅ Implement initial local runtime with `Agent.create/resume`, `agent.send`, `run.stream`, `run.wait`, `run.cancel`.
- ✅ Persist `agentId` in `sessions.sdk_session_id`; store terminal run/raw messages in task raw metadata.
- ✅ Create user/assistant messages and basic text streaming.
- Tests with mocked `@cursor/sdk`.

### PR 3 — Tool/thinking/status event normalization

- ✅ Initial mapping for `tool_call`, `thinking`, and terminal errors to Agor messages/tool callbacks.
- Further refine `status`, `task`, and duplicate/partial event behavior after live SDK traces.
- Add `cursor/normalizer.ts` for model/duration/git and no-token explicit behavior.
- Golden tests for representative SDK events.

### PR 4 — MCP injection

- ✅ Convert Agor session/global MCP server configs to Cursor `McpServerConfig`.
- ✅ Inject built-in Agor MCP with session bearer token.
- Tests for stdio/http/sse conversion, env template resolution, and OAuth/header handling.

### PR 5 — UI polish and model discovery

- Add Cursor model defaults and `Cursor.models.list()`-backed cache/API if desired.
- Settings copy warning: beta, autonomous execution, token-based billing, Cursor Terms.
- Add docs guide row once behavior is verified.

### PR 6 — Optional cloud runtime spike

- Treat Cursor cloud as separate runtime mode, not default `cursor` provider behavior.
- Decide how remote branches/PR URLs become Agor branch cards or artifacts.
- Only after local provider is stable.

---

## Concrete next-step checklist

- [ ] Run a live local smoke test with a throwaway Cursor key in an Agor worktree:
  - [ ] Does `Agent.create({ local: { cwd } })` run headlessly under executor user?
  - [ ] Where is local state stored?
  - [ ] Does `Agent.resume(agentId)` work after process exit?
  - [ ] What exact `SDKMessage` sequence arrives for text, shell, file edit, MCP, and error?
  - [ ] Does `Run.cancel()` stop shell/file edits cleanly?
  - [ ] Does `sandboxOptions.enabled` materially constrain writes/commands?
  - [ ] Are token/cost metrics hidden anywhere in stream/onDelta/onStep/raw result?
- [ ] Ask Cursor/support/forum about stable permission and usage APIs.
- [ ] Add import/install smoke test before enabling in CI.
- [ ] Update `apps/agor-docs/pages/guide/sdk-comparison.mdx` only after behavior is empirically verified.

## Open questions for Max

1. Is an **autonomous/no-permission-modal** provider acceptable if clearly labeled and constrained by Agor Unix isolation?
2. Should cloud runtime be explicitly out-of-scope for v1, or should the spike include a “remote Cursor branch artifact” concept?
3. Is losing token/cost/context pills acceptable for an experimental provider?
4. Do we want to expose Cursor-native `.cursor/skills`/hooks/subagent affordances in Agor UI, or leave them as repo-native files only?
