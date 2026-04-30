# Agentic Tool Auth Consolidation

**Status:** Exploration (PR1 narrowly scoped; broader vision deferred to follow-ups)
**Related:** [`apps/agor-ui/src/components/SettingsModal/UserSettingsModal.tsx`](../../apps/agor-ui/src/components/SettingsModal/UserSettingsModal.tsx), [`apps/agor-ui/src/components/ApiKeyFields.tsx`](../../apps/agor-ui/src/components/ApiKeyFields.tsx), [`packages/core/src/types/user.ts`](../../packages/core/src/types/user.ts), [`onboarding-wizard-v2.md`](./onboarding-wizard-v2.md) (motivating example #1)

---

## Goal

Make User Settings → Agentic Tools the **single home** for everything related to a given tool: its credentials AND its defaults. Today, credentials live in a sibling "API Keys" section that spans tools, and the Claude Pro/Max OAuth path lives in env-var-land (`CLAUDE_CODE_OAUTH_TOKEN`) despite conceptually being Claude Code authentication.

This is the foundational, atomic step. It ships the two clearest UX wins without locking in any of the deeper schema/UI redesigns we're considering — each of those becomes its own follow-up (see [Future Work](#future-work)).

---

## Today's friction

1. **Two parallel axes that overlap.** The settings modal has a global "API Keys" section (Anthropic / OpenAI / Gemini / Copilot tokens) AND per-tool sections (Claude Code, Codex, Gemini, OpenCode). The per-tool sections hold model + permissions + MCP, but no auth. A user thinking "I want to set up Claude Code" has to bounce between two places.

2. **Claude Pro/Max OAuth lives in env-var-land.** The token is read from `CLAUDE_CODE_OAUTH_TOKEN` on the spawned process env, which means we currently document "set this env var via User Settings → Env Vars" — a magic string the user has to know. There's no first-class place for it under Claude Code's own config screen, despite that being where it conceptually belongs. (See `onboarding-wizard-v2.md` motivating example #1 for the user-flow impact.)

3. **The "Personal API Keys" section is a third unrelated concept** living next door. Those are Agor's own `agor_sk_*` programmatic API tokens — totally separate from LLM credentials, but the naming overlap doesn't help.

---

## In scope (this PR)

### 1. Add `CLAUDE_CODE_OAUTH_TOKEN` as a first-class field in `api_keys`

The existing `users.data.api_keys` storage already holds 4 fields (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`). We add a 5th: `CLAUDE_CODE_OAUTH_TOKEN`. Same encryption pattern, same shape — no structural redesign.

```ts
// packages/core/src/types/user.ts (existing shape, one field added)
api_keys?: {
  ANTHROPIC_API_KEY?: boolean;
  OPENAI_API_KEY?: boolean;
  GEMINI_API_KEY?: boolean;
  COPILOT_GITHUB_TOKEN?: boolean;
  CLAUDE_CODE_OAUTH_TOKEN?: boolean;  // NEW
};
```

### 2. Migrate the OAuth env var into the new field

Idempotent JSON transform per user, runs once at daemon startup:

```
IF users.data.env_vars.CLAUDE_CODE_OAUTH_TOKEN exists
   AND users.data.api_keys.CLAUDE_CODE_OAUTH_TOKEN does NOT exist:
     - copy the encrypted value (no re-encryption — same master secret)
     - delete the env_vars entry
     - log "migrated CLAUDE_CODE_OAUTH_TOKEN for user <id>"
```

Skip if `api_keys.CLAUDE_CODE_OAUTH_TOKEN` already populated. Invisible to users beyond the env var disappearing from one section and showing up in another.

### 3. Executor reads from the new location

`packages/executor/src/sdk-handlers/claude/` resolves Claude Code credentials in this order, exporting whichever wins as the corresponding env var on the spawned process:

1. `users.data.api_keys.CLAUDE_CODE_OAUTH_TOKEN` (subscription) — preferred when set
2. `users.data.api_keys.ANTHROPIC_API_KEY` (API key) — fallback
3. System-level fallback (existing behavior, unchanged)

This matches the SDK's own precedence (OAuth token wins over API key when both are set) and matches user expectations.

### 4. UI: dissolve the global "API Keys" section into per-tool screens

- **Delete**: the "API Keys" sidebar entry under the "Agentic Tools" group, and the standalone `ApiKeyFields` block it renders.
- **Add**: an "Authentication" section (rendered above the existing model/permission/MCP block) on each tool's screen, containing only the credentials relevant to that tool:

  | Tool | Authentication fields |
  |---|---|
  | Claude Code | `ANTHROPIC_API_KEY` (API key path) + `CLAUDE_CODE_OAUTH_TOKEN` (subscription path) |
  | Codex | `OPENAI_API_KEY` |
  | Gemini | `GEMINI_API_KEY` |
  | OpenCode | (no central token today — defer) |
  | Copilot | `COPILOT_GITHUB_TOKEN` |

- **Inline instructions** on the Claude Code screen: short blurb explaining that the OAuth token is for Pro/Max subscribers and points to `claude setup-token` for obtaining it. API key path links to console.anthropic.com.
- Both Anthropic API key and OAuth token coexist as inputs — no method radio yet (see deferral below). The executor's existing precedence handles "both set" cleanly.
- **Rename** the unrelated "Personal API Keys" section to "Agor API Tokens" while we're here, to kill the naming overlap. Pure label change.

### 5. Doc updates

- `apps/agor-docs/pages/guide/` — wherever the "set CLAUDE_CODE_OAUTH_TOKEN as an env var" instructions live, update to point at the new location.
- Brief addition to `context/concepts/auth.md` (or wherever credentials are documented) noting the per-tool auth model.

---

## Out of scope (explicit deferrals)

Each becomes a separate, focused follow-up PR. None of them require redoing this PR's work.

- **Auth method radio** (API key OR Subscription as a mutually-exclusive choice). This PR shows both fields and lets the executor pick; the radio adds an explicit user-facing toggle.
- **`AgenticToolConfig` / `AgenticToolAuth<C>` discriminated-union refactor.** The full type-system cleanup we jammed on (per-tool variants, capability-driven UI, encryption-boundary credential reps). Big payoff but additive — current flat `api_keys` storage can keep working until then.
- **Test connection button** + `AuthTester` base/override pattern (generic prompt fallback, per-tool `models.list` overrides).
- **Capabilities-map extension** (`authMethods`, `hasPermissionMode`, `testAuthStrategy` flags driving generic UI).
- **Storage-vs-active credential split** with `CredentialStored` / `CredentialRuntime` / `CredentialPresence` representations and explicit encryption-boundary transforms.
- **System-level fallback policy** per tool (`disabled` / `forced` / `overridable` / `per_user_only`). Schema scaffolding only when we get there; current behavior (per-user with system env var fallback) stays.
- **Codex / Gemini subscription auth** (`codex login`, Google account auth). Tier-2 paths.
- **Onboarding wizard rewrite** — see [`onboarding-wizard-v2.md`](./onboarding-wizard-v2.md). This PR makes the wizard's API Keys step work better incidentally (OAuth token now has a real home) but doesn't restructure the wizard.
- **Default-config templates** ("what does a new user inherit on creation"). KISS: hardcoded factory defaults remain the only path; users tweak from there.

---

## Migration & encryption notes

- The migration is a **structural lift**, not a re-encryption. The encrypted byte-string under `env_vars.CLAUDE_CODE_OAUTH_TOKEN.value_encrypted` moves verbatim into `api_keys.CLAUDE_CODE_OAUTH_TOKEN`. Master secret unchanged, decryption path unchanged.
- The migration is **idempotent**: re-running has no effect once `api_keys.CLAUDE_CODE_OAUTH_TOKEN` is populated.
- The migration is **non-destructive on conflict**: if both fields somehow end up set (race, manual edit, etc.), the existing `api_keys` entry wins and the env_vars entry is left alone (logged as a warning).
- Frontend never sees the encrypted value — `User.api_keys` exposes booleans only, identical to today.

---

## Future work

The discriminated-union type model and capability-driven UI we designed is captured here as the north star, even though none of it ships in this PR:

- **`AgenticToolConfig`** — per-tool runtime knobs (model, permissions, MCP, codex-specific) as a discriminated union keyed on `tool`. Reusable shape (`ToolConfigsByTool`) at user-defaults / system-defaults / session-override layers.
- **`AgenticToolAuth<C>`** — credentials union, parametrized over the credential representation (`CredentialStored` for DB JSON, `CredentialRuntime` for daemon in-memory, `CredentialPresence` for the wire). Storage carries all known credentials regardless of `active_method`; the active union is derived for executor consumption only.
- **Capabilities map extension** — `AGENTIC_TOOL_CAPABILITIES[tool].authMethods`, `hasPermissionMode`, `testAuthStrategy: 'models-list' | 'generic-prompt'` to drive generic UI rendering.
- **`AuthTester` interface** — base `test()` method using a tiny "answer with a single word 'true'" prompt, per-tool overrides for free `models.list` calls (Anthropic, OpenAI, Google all expose this).

When we land those, the migration is trivial: `api_keys.<KEY>` → `tool_auth.<tool>.{api_key|oauth_token|...}` as a structural lift, same pattern as this PR's env-var → api_keys move.

---

## Open questions (answer when relevant follow-up lands)

- Instance-level admin policy in team mode — allowed at all, and if so under what disclaimers? (See deployment-mode taxonomy in CLAUDE.md.)
- For tools with multiple auth methods, should switching method preserve inactive credentials in storage? (Lean yes — no harm, lets users flip back without re-pasting.)
- Test-button cost surfacing — show "(sends a tiny prompt, costs fractions of a cent)" inline so users know what they're paying for?
