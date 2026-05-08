# Copilot SDK Audit — 2026-05-08

Audit of Agor's GitHub Copilot integration vs. the upstream SDK as of May 2026.
Scope: identify gaps, prioritize fixes, propose a phased plan. **Doc only — no code in this PR.**

---

## TL;DR

- We integrate **`@github/copilot-sdk`** (the official Node SDK that wraps the Copilot agent runtime). Pinned at **`^0.2.2`**; upstream just hit **public preview at `0.3.0`** on 2026-04-02.
- Our adapter is **mature**: streaming, MCP (stdio + HTTP), interactive permissions, AbortController-based cancellation, model picker UI, per-tool credential scoping. No `TODO`/`FIXME` in the folder.
- Real gaps are not in the basics — they're in **BYOK auth passthrough**, **dynamic model discovery**, and **session fork/import** (the latter explicitly deferred in the capability matrix).
- Cloud Coding Agent has **no third-party API surface** worth integrating — orchestration via PR/issue webhooks is the only path. Skip.
- **MCP is well-aligned already.** Cloud-agent caveats (tools-only, no remote OAuth MCP) only matter if we ever target it.

---

## 1. What we ship today

**Adapter:** `packages/executor/src/sdk-handlers/copilot/`
- `copilot-tool.ts:54` — `CopilotTool implements ITool`. Capability matrix at top of file: ✅ streaming / ✅ thinking / ✅ create+resume / ✅ MCP / ✅ permissions; ❌ session import; ❌ session fork (emulated).
- `prompt-service.ts:262` — `new CopilotClient({ useStdio: true, githubToken: ... })`. SDK spawns the `copilot` CLI internally.
- `prompt-service.ts:421` — AbortController-based cancellation (working).
- `permission-mapper.ts:175` — full bridge to Agor's `PermissionService`, MCP requests (`kind: "mcp"`) auto-approved when from attached server.
- `models.ts:16` — `COPILOT_MODELS` is a **hardcoded list of 5 models** (gpt-4o, gpt-4o-mini, claude-sonnet-4-20250514, o3-mini, o4-mini).
- `event-mapper.ts` — maps 40+ SDK events to streaming callbacks.

**Auth chain** (`prompt-service.ts:264–268`):
```
apiKey arg  →  COPILOT_GITHUB_TOKEN  →  GH_TOKEN  →  GITHUB_TOKEN
```
Token sourced from `~/.agor/config.yaml` `credentials.COPILOT_GITHUB_TOKEN` via `apps/agor-daemon/src/setup/credentials.ts`. UI: `apps/agor-ui/src/components/UserSettings/.../copilotForm`.

**Provenance:** First landed in `f935ed5e` (PR #811, 2026-03-28). Last refactor: PR #1068 (2026-04-25, task-queue rework). ~6 weeks old, actively maintained.

---

## 2. What's new upstream (mid-2025 → 2026-05-08)

Citations are primary-source. Items marked **(unverified)** could not be confirmed in changelog/docs within search budget.

### `@github/copilot-sdk` itself

| When | What | Source |
|---|---|---|
| 2026-04-02 | **SDK enters public preview at v0.3.0.** Same runtime as Copilot CLI + cloud agent. Node/TS, Python, Go, .NET, Java surfaces. | [changelog](https://github.blog/changelog/2026-04-02-copilot-sdk-in-public-preview/) |
| ongoing | npm `0.3.0` shipping; `CopilotClient` / `CopilotSession` / `defineTool()` / `approveAll` / `PermissionRequest` types stable | [npm](https://www.npmjs.com/package/@github/copilot-sdk), [repo](https://github.com/github/copilot-sdk) |

### Copilot CLI (the binary the SDK spawns)

| When | What | Source |
|---|---|---|
| 2026-01-14 | Built-in agents (Explore/Task/Plan/Code-review), `/compact`, `/context`, auto-compaction at 95%, `--resume`, `GITHUB_ASKPASS` for headless | [changelog](https://github.blog/changelog/2026-01-14-github-copilot-cli-enhanced-agents-context-management-and-new-ways-to-install/) |
| 2026-02-25 | **CLI GA.** Models on offer in CLI: Claude Opus 4.6, Sonnet 4.6, GPT-5.3-Codex, Gemini 3 Pro. `--allow-all`/`--yolo` autopilot. Sandbox MCP servers (macOS/Linux). | [changelog](https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/), [autopilot docs](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot) |
| 2026-05-06 | Enterprise-managed plugins (public preview) | [changelog](https://github.blog/changelog/2026-05-06-enterprise-managed-plugins-in-github-copilot-cli-are-now-in-public-preview/) |

### MCP

| When | What | Source |
|---|---|---|
| 2025-07-14 | MCP in VS Code GA — kicked off the cross-surface rollout | [changelog](https://github.blog/changelog/2025-07-14-model-context-protocol-mcp-support-in-vs-code-is-generally-available/) |
| ongoing | MCP now first-class across VS Code / JetBrains / Eclipse / Xcode / CLI / cloud agent. Cloud agent: **tools only**, no remote OAuth MCP. | [docs](https://docs.github.com/en/copilot/concepts/context/mcp), [cloud-agent MCP](https://docs.github.com/en/copilot/concepts/agents/coding-agent/mcp-and-coding-agent) |

### BYOK

| When | What | Source |
|---|---|---|
| 2026-01-15 | BYOK enhancements: Anthropic, OpenAI, Microsoft Foundry, xAI, AWS Bedrock, Google AI Studio, any OpenAI-compatible. Responses API, max-context-window config, streaming. | [changelog](https://github.blog/changelog/2026-01-15-github-copilot-bring-your-own-key-byok-enhancements/) |
| 2026-04-22 | BYOK in VS Code GA | [changelog](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/) |

### Custom instructions

| When | What | Source |
|---|---|---|
| 2025-09-03 | Path-scoped `*.instructions.md` with `applyTo` (code review) | [changelog](https://github.blog/changelog/2025-09-03-copilot-code-review-path-scoped-custom-instruction-file-support/) |
| 2026-04-02 | **Org-level custom instructions GA.** Priority: personal > repo > org. | [changelog](https://github.blog/changelog/2026-04-02-copilot-organization-custom-instructions-are-generally-available/) |

### Cloud Coding Agent

GA 2025-05-13 ([discussion](https://github.com/orgs/community/discussions/159068)). **No public REST or event API for orchestrators** beyond standard PR/issue webhooks. GitHub-hosted runners only. Skip for Agor.

### Items flagged unverified in primary sources

- A Copilot-specific PAT scope split.
- An explicit cancellation API in the SDK (we already use AbortController; works fine).
- SOC/audit-log specifics for BYOK.

---

## 3. Gap matrix

| Upstream capability | Agor today | Gap | Severity |
|---|---|---|---|
| SDK 0.3.0 GA | Pinned `^0.2.2` | One minor bump | **Low** (separate PR) |
| Dynamic model discovery (`client.listModels()`) | Hardcoded list of 5 stale model strings (`models.ts:16`) | Not wired — comment even acknowledges it | **Medium** |
| BYOK (Anthropic/OpenAI/Bedrock/etc keys for Copilot runtime) | `githubToken` only (`prompt-service.ts:262`) | No provider-key passthrough; docstring mentions BYOK but it isn't plumbed | **Medium** |
| Session fork (native) | Emulated via `createSession()` (capability matrix flag) | Verify SDK 0.3.0 surface; if native, drop the emulation | **Medium** |
| Session import | Deferred (capability matrix flag) | Same — verify and adopt if available | **Low** |
| Sandbox MCP servers (CLI flag) | Not exposed; we attach MCP servers but no per-server sandbox tier | Per-MCP sandbox isn't a thing in SDK yet (CLI-side); revisit when SDK exposes it | **Low** |
| `userPromptSubmitted` hook (CLI, May 2026) | N/A; we own pre-prompt logic at the daemon | No action — orthogonal | **N/A** |
| Org-level custom instructions | We send `systemMessage` (`prompt-service.ts:301`) | Could surface that we already cover the equivalent via Agor's prompt-template/zone system | **Low** (doc-only) |
| Enterprise-managed plugins | N/A | Out of scope | **N/A** |
| Cloud Coding Agent | Not integrated | No API to integrate against; intentional skip | **None** |
| Cancellation | AbortController works (`prompt-service.ts:421`) | No gap | **None** |
| MCP integration | stdio + HTTP, auto-approve for attached servers | No gap | **None** |
| Auth chain | PAT → `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` | Matches SDK precedence; no gap | **None** |

---

## 4. Recommendations (prioritized)

### Quick wins — separate small PRs

1. **Bump `@github/copilot-sdk` `^0.2.2` → `^0.3.0`.** SDK GA + same runtime as before. Smoke-test session create/resume + streaming + permission roundtrip + MCP. Standalone PR (lockfile churn). _Effort: S. Risk: low if 0.3.0 is wire-compatible; verify against [release notes](https://github.com/github/copilot-sdk/releases) before pinning. Coordination: none — `bump-claude-code-and-codex` (#1114) already merged._
2. **Refresh `COPILOT_MODELS` constants while we're at it.** Add Claude Opus 4.6, Sonnet 4.6, GPT-5.3-Codex, Gemini 3 Pro to the static fallback list, and update `COPILOT_CONTEXT_LIMITS` / `COPILOT_MODEL_METADATA`. Pure data, no behavior change. Can ship with the bump or right after.

### Medium bets — focused PRs each

3. **Wire `client.listModels()` for dynamic discovery.** Today `models.ts` is a stale hardcoded list whose docstring already admits the SDK supports discovery. Pattern: call once on client start, cache for the session, fall back to `COPILOT_MODELS` on failure. Surfaces in the model picker. _Effort: S–M. Risk: low. Behavior change: visible new entries in the picker._
4. **BYOK passthrough.** The runtime accepts provider keys (Anthropic / OpenAI / Bedrock / Google / OpenAI-compatible) per the [Jan 2026 BYOK changelog](https://github.blog/changelog/2026-01-15-github-copilot-bring-your-own-key-byok-enhancements/). Let users attach a provider key alongside their GitHub token in `copilotForm`, plumb it through `CopilotClient` config. Pairs naturally with PR #1077's per-tool credential storage. _Effort: M. Risk: medium (auth surface area). Coordination: align with the per-tool credential-scoping work flagged in `project_credential_scoping_gap.md` — this exposes more keys per-SDK._
5. **Verify and adopt native session fork / import** if 0.3.0 exposes them. Drop the "emulated via new sessions" workaround in the capability matrix. Touches `copilot-tool.ts` and the fork/spawn paths. _Effort: M. Risk: medium — fork semantics affect genealogy._

### Big bets — design-doc territory, not this PR

6. **Permission-tier alignment across adapters.** Copilot's `approveAll` vs. custom `PermissionRequest` callback is a near-1:1 map to Agor's `worktree_rbac` tiers. Same shape exists for Claude Code (allowed-tools) and Codex (sandbox). There's an opportunity to lift permission-mode mapping into the shared `AgenticToolAdapter` base. _Coordinate with `codex-permission-flow` and `audit-codex-permission-flow` worktrees before touching shared abstractions._
7. **MCP sandbox metadata.** When the SDK eventually exposes per-MCP-server sandbox flags (the CLI already has them on macOS/Linux), Agor's MCP catalog should be able to declare `sandbox: "filesystem" | "network" | "none"` per server and pass that through. Not actionable yet — flag for revisit when SDK exposes it.

### Explicit non-goals

- ❌ Cloud Coding Agent integration. No public orchestrator API; the only handle is the issue/PR webhook surface, which Agor doesn't try to be a frontend for.
- ❌ Big-bang adapter rewrite. Per project rules, phased PRs only.
- ❌ Bumping SDK in this PR. Doc PR; let the bump be its own PR with smoke-test plan.

---

## 5. Suggested PR sequence

| # | PR | Scope | Blocks |
|---|---|---|---|
| 1 | _this PR_ | This audit doc | — |
| 2 | `chore(deps): bump @github/copilot-sdk to ^0.3.0` | Quick win 1 + 2 (SDK pin + model list refresh) | — |
| 3 | `feat(copilot): wire client.listModels() for dynamic model discovery` | Medium bet 3 | depends on #2 |
| 4 | `feat(copilot): BYOK provider-key passthrough` | Medium bet 4 | depends on #2; coordinate with per-tool credential scoping |
| 5 | `feat(copilot): adopt native session fork/import (drop emulation)` | Medium bet 5 | depends on #2; verify 0.3.0 surface first |
| later | Permission-tier abstraction across adapters | Big bet 6 | coordinate w/ Codex permission-flow worktrees |

---

## 6. Outstanding questions / unknowns

- Does SDK 0.3.0 break wire compatibility with any of our event-mapper assumptions? Need to diff [`event-mapper.ts`](../../packages/executor/src/sdk-handlers/copilot/event-mapper.ts) handlers against 0.3.0 event names before merging the bump.
- Does `CopilotClient` config in 0.3.0 accept BYOK provider keys natively, or does the runtime expect them as env vars (e.g., `ANTHROPIC_API_KEY`) inside the spawned CLI process? Affects whether (4) is a `new CopilotClient({ providerKeys })` change or an `env: {...}` change.
- Verify session-fork/import API names in 0.3.0 — Phase 2 research couldn't confirm exact surface.

These are diff-against-the-SDK questions; cheap to resolve when the bump PR is opened.

---

_Authored 2026-05-08. See [`CLAUDE.md`](../../CLAUDE.md) "Where to look first" for adapter/permission/MCP context._
