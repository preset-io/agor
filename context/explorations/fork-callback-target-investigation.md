# #2654: fresh runtime identity for callback targets

## Rationale

This mitigates stale-context **explicit callback targets**, not server defaulting.
In the reported failure pattern, fork B creates child C while explicitly naming
original A as the callback destination. The server identifies caller B correctly
and honors the requested destination A. Inherited history is a plausible source
of the stale selection, but the precise model-context cause is not established.
A, B, and C here are synthetic labels, not incident identifiers.

The baseline routing regression already passed before production changes:
omitting `callbackSessionId` with `enableCallback: true` targets the actual caller;
intentional authorized alternate targets remain supported. Silently redirecting
explicit A to B would break valid orchestration and is not part of this change.

## Design and provider boundaries

One pure shared renderer accepts the trusted execution's Agor `SessionID`.
It distinguishes current identity from fork ancestry, spawn parents, and provider
SDK thread IDs; warns that inherited conversation/workspace IDs can be stale;
and recommends omission-first self callbacks. It performs no ancestry lookup,
credential access, conversation parsing, or mutable identity caching.

The identity is refreshed at six provider request boundaries:

- **Codex:** appended to `thread.runStreamed` input on normal turns, including
  first fork and subsequent resume. Persisted Agor user prompts and client/config
  fingerprints are unchanged; internal `/approvals` controls remain untouched.
- **Claude Code:** appended after static orientation in each query's
  `systemPrompt.append`, including fork/resume. User messages, native `/compact`
  commands, and human-origin attribution remain unchanged.
- **OpenCode:** appended after static orientation in each `session.prompt`
  request's `body.system`. User text parts remain exact. Initial and resumed
  requests are covered; Agor does not support OpenCode session forks.
- **Gemini, GitHub Copilot, Cursor:** added at the normal initial turn send sites,
  not every tool-result continuation. Coverage does not imply native fork support.

The shared static orientation remains identity-free. The small identity block is
stable within one session, changes across sessions, and adds a bounded token cost.
No callback routing, authorization, schema, historical session, or persisted Agor
user-message behavior changes. The stale generated identity tail was removed from
shared `AGENTS.md` (`CLAUDE.md` remains its symlink), with regression coverage against
reintroducing it. This stale workspace identity is not a proven incident cause.
The unused workspace identity append helper remains untouched.

Session/zone tool descriptions and the sessions guide recommend
`enableCallback: true` with omitted `callbackSessionId` for self-reporting,
including cross-branch creation. Intentional authorized alternate destinations
and the `agor_sessions_prompt` callback alternative remain available.

## Regression evidence

- Request-contract assertions failed before identity injection and passed after
  it. They cover current identity alongside inherited examples, first/resumed
  turns, roots, nested coordinators, and separation from provider IDs.
- A disposable SQLite-backed harness exercises real fork/spawn services, token
  hooks, Claude query construction, authenticated HTTP MCP, relationship
  persistence, and completion callback task admission/queue wakeup. Its eleven
  scenarios include omitted targets, explicit authorized overrides, disabled
  callbacks, cross-branch provenance, genealogy opt-out, and nested coordinators.
  Stale transport/header hints do not override current runtime credentials.
- Tenant-derived execution identity stays separate from system/global static
  orientation. A negative request assertion checks that a later tenant's system
  payload does not contain the prior tenant's identity. Existing focused MCP
  tenant-conflict/access negatives remain covered. No new tenant lookup, cache,
  credential flow, or authorization boundary is introduced.

### Recorded verification

An earlier implementation run passed **306 tests** across focused executor,
core, OpenCode, and daemon suites. A later advisory-change run passed **73 tests**
(OpenCode 12, core 7, branch tools 54). These are distinct runs with overlapping
coverage, not an aggregate count of unique tests. Correctness, architecture,
guidance-delta, and adversarial reviews were completed before publication-only
sanitization; the runtime and regression code were retained unchanged.

Representative commands from those successful runs:

```sh
pnpm --filter @agor/core exec vitest run src/templates/session-context.test.ts
pnpm --filter @agor/agentic-tool-opencode exec vitest run src/runtime/opencode-tool.test.ts
pnpm --filter @agor/daemon exec vitest run src/mcp/fork-callback-routing.test.ts src/mcp/server.test.ts src/mcp/tokens.test.ts src/mcp/tools/sessions.test.ts src/utils/session-mcp-token-hook.test.ts src/services/tasks.callbacks.test.ts src/services/sessions.sdk-home-scope.test.ts
pnpm --filter @agor/daemon exec vitest run src/mcp/tools/branches.test.ts

env -u AGOR_DATA_HOME -u AGOR_OUTER_SANDBOX HOME="$(mktemp -d)" AGOR_MASTER_SECRET=agor-executor-test-secret pnpm --filter @agor/executor exec vitest run src/sdk-handlers/codex/prompt-service.test.ts src/sdk-handlers/claude/query-builder.test.ts src/sdk-handlers/gemini/prompt-service.test.ts src/sdk-handlers/copilot/prompt-service.test.ts src/handlers/sdk/cursor.test.ts src/handlers/sdk/opencode.test.ts

pnpm --filter @agor/core exec tsc -p tsconfig.build.json --noEmit --incremental false
pnpm --filter @agor/executor typecheck
pnpm --filter @agor/daemon typecheck
pnpm --filter @agor/agentic-tool-opencode typecheck
pnpm check:multitenancy-boundaries
```

Affected TypeScript Biome checks and documentation formatting also passed.
Missing workspace declarations initially blocked typechecks; bounded
user-authorized declaration-only builds resolved those prerequisites. No runtime
bundles or managed development environment were needed. Changed OpenCode/core
tests also passed targeted TypeScript compiler API checks; production package
configs generally exclude tests.

## Limits

No live provider/model call or replay of historical sessions was performed.
These tests prove request payloads, runtime MCP caller identity, persisted callback
destinations, and queued completion admission—not model obedience or running-queue
delivery. A model can still explicitly choose a stale authorized destination.

SDK execution, executor launch/queue draining, model listing, and message reads
are stubbed. Repository-backed read adapters do not install the full Feathers
hook stack. This is not end-to-end PostgreSQL RLS, gateway, or live SDK proof.
No UI change required browser validation or a managed environment.

In pinned OpenCode 1.14.33, `body.system` is persisted as user-message metadata
and subsequently assembled into provider system context. This avoids extra user
text, **not all provider-history persistence**. See the tagged runtime
[`prompt.ts`](https://github.com/anomalyco/opencode/blob/v1.14.33/packages/opencode/src/session/prompt.ts)
and [`llm.ts`](https://github.com/anomalyco/opencode/blob/v1.14.33/packages/opencode/src/session/llm.ts).
Plugins can transform that context; compaction and native subagent behavior are
not established by these request tests. Claude native Task-tool subagent
inheritance of `systemPrompt.append` also remains unverified.
