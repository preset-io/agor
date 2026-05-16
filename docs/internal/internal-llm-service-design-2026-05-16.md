# Internal LLM Service — Design Doc — 2026-05-16

A new daemon-side service (`InternalLLMService`) that lets **Agor itself** invoke LLMs for app-internal UX wins — starting with auto-titling new sessions. Distinct from the executor (which runs user-driven agents) and from the MCP tools (which expose Agor to agents). Provider-abstracted, key-resolved through existing per-user plumbing, async fire-and-forget, budget-capped, opt-out-able.

**Status:** design only. No code lands from this worktree until Max signs off.

---

## TL;DR

- Agor's UX has many places that would benefit from a **cheap, fast LLM call** the *app* makes on the user's behalf (titling, summarizing, classifying).
- Today there are zero such calls — all LLM work flows through user-driven sessions in `packages/executor/`.
- Build a small daemon-side `InternalLLMService` with: provider-abstracted `quick()` / `summarize()` primitives, key resolution via the existing `resolveApiKey()` (per-user → config → env → daemon-level fallback), per-user budget caps with a daemon-level cap-of-caps, in-memory cache, install-mode-aware opt-in default, and a single per-user opt-out toggle.
- Ship **v0 = session titling only** on the daemon-level fallback key with no budget enforcement and a manual "re-title" button. Add budget tracking, more use cases, and per-use-case model config in v1.

---

## Phase 1 audit — current state

### Session titling today

- `Session.title?: string` — optional, comment says "user-provided or auto-generated" but no actual generation exists. Source of truth: [`packages/core/src/types/session.ts:197-200`](../../packages/core/src/types/session.ts). DB materialization: `data` JSON blob, [`packages/core/src/db/schema.sqlite.ts:112`](../../packages/core/src/db/schema.sqlite.ts).
- Population paths:
  - **Fork:** `title: data.prompt.substring(0, 100)` — first 100 chars of fork prompt. [`apps/agor-daemon/src/services/sessions.ts:297`](../../apps/agor-daemon/src/services/sessions.ts).
  - **Spawn:** `title: data.title || data.prompt.substring(0, 100)`. [`apps/agor-daemon/src/services/sessions.ts:468`](../../apps/agor-daemon/src/services/sessions.ts).
  - **UI new-session modal:** `title: config.title || undefined` — leaves blank when user doesn't type one. [`apps/agor-ui/src/hooks/useSessionActions.ts:80`](../../apps/agor-ui/src/hooks/useSessionActions.ts).
- Display fallback chain: [`apps/agor-ui/src/utils/sessionTitle.ts:48-82`](../../apps/agor-ui/src/utils/sessionTitle.ts) — `title → description → agentic_tool name → session_id`. Used by `WorktreeCard`, `SessionCard`, `SessionPanel`.
- **No dedicated rename UI.** Only generic patches via `useSessionActions.updateSession()`. [`apps/agor-ui/src/hooks/useSessionActions.ts:106-176`](../../apps/agor-ui/src/hooks/useSessionActions.ts).

### Existing internal LLM hooks

**None.** Searched `apps/agor-daemon/`, `packages/core/`, all non-executor packages for Anthropic / OpenAI / Gemini SDK imports — only auth and test fixtures matched. All LLM I/O today is user-driven via `packages/executor/`.

### Key plumbing (the part we'll reuse)

- Per-user encrypted keys live in `users.data.agentic_tools[toolName][keyName]`. Storage and CRUD: [`packages/core/src/db/repositories/user-api-keys.ts`](../../packages/core/src/db/repositories/user-api-keys.ts).
- Centralized resolution: [`packages/core/src/config/key-resolver.ts:53-142`](../../packages/core/src/config/key-resolver.ts). Precedence: **per-user → config.yaml `credentials` → env var → native auth fallback**. Tool-scoped via optional `context.tool` argument (PR #1077) — internal service MUST pass `tool` to avoid cross-bucket leakage.
- Credential keys supported today: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`. [`packages/core/src/config/types.ts:637-669`](../../packages/core/src/config/types.ts).
- **No daemon-level distinction** today. We'll add one in this design (see Architecture §key resolution).

### Cost / accounting infra

**None.** Token counts are recorded per-task on `task.data.raw_sdk_response` / `normalized_sdk_response`, but there is no cost ledger, no per-user budget enforcement, no monthly cap, no usage dashboard. We need a small new table.

### WebSocket plumbing (what we'll piggyback on)

FeathersJS already emits `created` / `patched` / `removed` service events that the UI subscribes to in [`apps/agor-ui/src/hooks/useAgorData.ts`](../../apps/agor-ui/src/hooks/useAgorData.ts). For async titling, we patch `sessions[id].title` on LLM resolve → `patched` event flows → UI re-renders. **No new real-time infra needed.**

### Coordination

- `docs/internal/` does **not** yet contain a notification-system design doc. The `design-notification-system` worktree is in flight; cross-references below assume both will be reconciled before either ships.
- Codex / Claude integration work is hardening the per-user key path that this service will reuse. No competing changes detected.

---

## 1. Motivating use case — session titling

### Recommended UX

**Trigger matrix.**

| Origin | Trigger LLM titling? | Why |
|---|---|---|
| User-created session (UI new-session modal, CLI `agor session create`) | **Yes**, async after `create` returns | Fresh topic; user benefits from a meaningful card on the board |
| Spawn (`agor_sessions_spawn`) | **Yes**, async after spawn returns | Spawn is a new subtopic with its own prompt; deserves its own title |
| Fork (`agor_sessions_prompt mode:"fork"`) | **No** — inherit `parent.title + " · fork"` | Forks are sibling branches of the same conversation; they share the parent's *topic* |
| User typed a title at creation time | **No** | Manual wins, full stop. We tag `title_source: 'user'` so re-title also respects it. |

**Timing — fire when?**

Two reasonable points:

1. **Right after session creation** — only the user's prompt + worktree context are available. Cheapest. Title may be vague.
2. **After the first assistant turn completes** — better context, but doubles cost and delays the UX win by tens of seconds to minutes.

**Recommendation:** v0 fires *once*, immediately after creation, with prompt + worktree name + worktree description + most recent commit subject as context. Refinement after first turn is a v2 candidate, gated on metrics (re-title button CTR — see below).

**UX flow.**

1. Session is created with `title: undefined` (or `title: prompt.substring(0, 100)` as the safe fallback so cards are never blank).
2. Daemon fires `InternalLLMService.quick({ use_case: 'titling', ... })` fire-and-forget. The promise is **not awaited** by the create handler.
3. While in flight, the card shows the fallback. (Optional: a subtle shimmer / `…` suffix — *not blocking; not error-prone*.)
4. On resolve: daemon `patches` session with `{ title: newTitle, title_source: 'llm' }`. FeathersJS `patched` event flows to UI. Card re-renders.
5. If the user manually edits the title at any point: `title_source: 'user'`, and the auto-titling pipeline never overwrites it.
6. **Re-title button** in the session panel kebab menu — uses the conversation so far (more context, Haiku-tier still). Allowed even when `title_source: 'user'` (explicit user action). Updates `title_source: 'llm'`.

**Failure modes.** All silent fallbacks. None block session creation.

| Failure | Behavior |
|---|---|
| LLM call errors (network, 5xx) | Keep fallback title. Log at `warn`. Don't toast. |
| Quota / budget exceeded | Keep fallback title. Log once per user-period at `info`. |
| User opted out | Skip the call entirely. No log spam. |
| No API key resolved at any level | Skip the call. Log once per process at `info`. |
| Timeout (default 10s) | Keep fallback title. Log at `warn`. |

**Rate / dedup.**

- Don't re-fire titling within 10 minutes for the same session (in-memory mutex by `session_id`).
- Skip if `title_source: 'user'`.
- Re-title button bypasses dedup but still respects budget.

**Privacy concern.** Medium. The session prompt is sent to whichever provider is configured. The user's actual session traffic *already* goes through the executor to the same provider — so for solo / team installs where users are already running Claude/Codex/etc., the privacy delta is small. For installs that proxy executor traffic through an internal endpoint (`ANTHROPIC_BASE_URL`) but want internal Agor housekeeping to use a different vendor, the use-case-level model config (see §Architecture) lets them point titling at a different provider.

**Default.** See §Privacy.

---

## 2. Other internal-LLM use cases — ranked

Brainstormed candidates evaluated on **Value** (UX impact), **Cost** (¢/call), **Freq** (calls/user/day), **Privacy** (data leakage), and a shipping recommendation. Cost estimates use Haiku 4.5 baseline (~$1/M input, ~$5/M output).

| # | Use case | Value | Cost | Freq | Privacy | Recommendation |
|---|---|---|---|---|---|---|
| 1 | **Session titling** (motivating case) | High | ~0.1¢ | 5–50 | Med | **v0 — ship first** |
| 2 | **Worktree archive summaries** — "what did this worktree accomplish?" at archive time | High | 1–5¢ | 1–5 | Med | **v1 — ship 2nd** |
| 3 | **Spawn-report digests** — N agent reports → 1-line "your fleet finished" summary for parent session | High | ~0.5¢ | 1–3 | Low (already user content) | **v1 — ship 3rd** |
| 4 | **Notification grouping + summaries** — collapse N similar events into 1 (cross-ref `design-notification-system`) | High *if* notifications are noisy | 0.1–0.5¢ | 5–50 | Med | **v1 — coordinate with notification design** |
| 5 | **Auto-zone suggestion** — propose which zone a worktree fits when dropped on a board with zones (do not auto-move, suggest) | Med | ~0.1¢ | 5–20 | Low | **v2 experiment** |
| 6 | Worktree name suggestion at create time | Med | ~0.1¢ | 1–10 | Med | v2 experiment (user might want control here) |
| 7 | Daily digest emails / cards | Med | 1–5¢ | 1/day | Med | v2 — after summaries land |
| 8 | "What changed?" commit-batch summaries on board | Med | 1–3¢ | 1–5 | Med | v2 |
| 9 | Anomaly detection (cost spikes, stuck loops) | High *if* signal-to-noise good | 0.1–1¢ | 0–5 | Low | **Defer** — needs metrics infra first |
| 10 | Next-step prompt suggestions after a session settles | Low–Med | 0.5¢ | 1–10 | Med | Defer — easy to feel intrusive |
| 11 | Smart search reranking | Low | 0.5¢ | 5–50 | Med | Defer — search isn't broken enough |
| 12 | Auto-link to issue/PR | Med | 0.5¢ | 1–5 | Med | Defer — needs GitHub depth |
| 13 | Mystery-assistant description backfill | Low (one-time, niche) | 0.5¢ | one-shot | Low | Defer or do as a CLI one-shot, not a service feature |
| 14 | Smart toast dedup | Low | 0.1¢ | 1–10 | Low | Defer — fold into notification grouping |
| 15 | Auto-tags / labels | Low–Med | 0.1¢ | 5–20 | Med | Defer until we have a tag system that needs them |

**Picks for v1 (after titling):** #2 worktree archive summaries, #3 spawn-report digests, #4 notification grouping (joint with notification design). #5 auto-zone is a fun v2 experiment.

The pattern across the top 5 is the same: **short input → short output, async, one toggle and one budget cover them all**. That's why a single `InternalLLMService` is worth building rather than scattered LLM calls per feature.

---

## 3. Architecture — `InternalLLMService`

### Interface sketch

```ts
// packages/core/src/internal-llm/types.ts

export type InternalLLMUseCase =
  | 'titling'
  | 'worktree_summary'
  | 'spawn_report_digest'
  | 'notification_summary'
  | 'classify';

export interface InternalLLMRequest {
  use_case: InternalLLMUseCase;
  /** Templated/composed prompt. Caller owns the template. */
  prompt: string;
  /** Optional system prompt — useful for "you are titling a session" framing. */
  system?: string;

  // Attribution + scope (all optional but at least one of user_id/worktree_id
  // strongly recommended for audit + per-user budgeting):
  user_id?: UserID;
  worktree_id?: WorktreeID;
  session_id?: SessionID;

  /** Stable memoization key. When omitted, defaults to SHA(prompt+model+use_case). */
  cache_key?: string;

  /** Hard ceiling on output tokens. Cheap classes default to 64; summaries 512. */
  max_output_tokens?: number;

  /** Override the configured model for this use case. Rarely needed. */
  model_override?: string;
}

export interface InternalLLMResponse {
  text: string;
  source: 'cache' | 'provider';
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  tokens_in: number;
  tokens_out: number;
  /** Estimated cost in micro-USD (1¢ = 10000). Stored as int for ledger sanity. */
  cost_usd_micros: number;
  duration_ms: number;
}

export interface InternalLLMService {
  /** Short, cheap, structured output. Titling, classification, single-line summaries. */
  quick(req: InternalLLMRequest): Promise<InternalLLMResponse>;
  /** Medium-effort summarization with explicit target length. */
  summarize(req: InternalLLMRequest & { target_words?: number }): Promise<InternalLLMResponse>;
  /** Per-user monthly usage. UI / Settings reads this. */
  getUsage(userId: UserID, period?: 'current_month'): Promise<{ cost_usd_micros: number; call_count: number; cap_usd_micros: number }>;
}
```

**Design notes on the interface:**

- Two primitives is enough for the top 5 use cases. Adding `classify(labels)` and `rerank(items)` later is cheap; resist adding more now.
- No streaming in v0. Internal calls produce short results; the WebSocket-patch model is already real-time enough from the user's perspective.
- The caller owns the prompt template (e.g., `apps/agor-daemon/src/internal-llm/use-cases/titling.ts`) — the service doesn't templatize. Keeps the service generic and provider-agnostic.

### Key resolution model — recommendation: **C, hybrid with named precedence**

Reusing `packages/core/src/config/key-resolver.ts:53-142` with a small extension:

1. **Per-user key** (when `req.user_id` is set and user has a configured key for the target provider) — preferred, billed to user.
2. **Daemon-level "internal LLM" key** — a *new* config block scoped specifically to internal calls, separate from the existing `credentials` block that the executor consumes. Rationale: an admin may want internal Agor housekeeping to bill against a separate budget / vendor than user-driven sessions.
3. **Existing `credentials.*` config** — fall back if no internal-LLM-specific key.
4. **Env vars** — last resort.

New config shape:

```yaml
# ~/.agor/config.yaml
internal_llm:
  enabled: true                          # master toggle (default: see Privacy §)
  # Daemon-level fallback keys (separate budget from user-driven `credentials:`)
  fallback_credentials:
    ANTHROPIC_API_KEY: sk-…
    # OPENAI_API_KEY: …
    # GEMINI_API_KEY: …
  # Per-use-case model selection. Provider inferred from model id.
  use_cases:
    titling:
      model: claude-haiku-4-5-20251001
      max_output_tokens: 32
      timeout_ms: 10000
    worktree_summary:
      model: claude-haiku-4-5-20251001
      max_output_tokens: 512
      timeout_ms: 30000
    # …
  # Budget caps. Soft = warn; hard = refuse.
  budget:
    per_user_monthly_usd: 5.00           # null = unlimited
    daemon_monthly_usd: 100.00           # cap-of-caps; null = unlimited
    soft_warn_at_pct: 80
  # Cache
  cache:
    enabled: true
    ttl_seconds: 3600
```

**Precedence inside the resolver call:**

```ts
// pseudo
const userKey = req.user_id && await resolveApiKey(keyName, { userId: req.user_id, db, tool: undefined /* see note */ });
if (userKey?.apiKey) return { key: userKey.apiKey, billing: 'user' };
const fallback = config.internal_llm?.fallback_credentials?.[keyName];
if (fallback) return { key: fallback, billing: 'daemon' };
const legacy = config.credentials?.[keyName];
if (legacy) return { key: legacy, billing: 'daemon' };
const env = process.env[keyName];
if (env) return { key: env, billing: 'daemon' };
return null; // skip the call entirely
```

**Tool-scoping note (relevant to the memory):** Internal LLM calls are *not* tied to one agentic tool — they're tied to a *provider*. The right behavior is to pass `tool: undefined` to `resolveApiKey()` so the resolver scans all tool buckets for the requested provider key, since "any of the user's Anthropic keys works for internal Anthropic calls". This is a deliberate exception to the "always pass tool" guidance — and it's safe because we're not *spawning a process* with the resolved key; we're making one in-daemon HTTP call and discarding it.

### Model selection

- **v0 default:** `claude-haiku-4-5-20251001` for `titling`. Fast (~500ms p50), cheap (~$1/M in).
- Per-use-case model knob in config — admin can swap to GPT-4o-mini, Gemini Flash, or Claude Sonnet per use case.
- Provider inferred from model id prefix (`claude-*` → Anthropic, `gpt-*` / `o*-mini` → OpenAI, `gemini-*` → Gemini).
- Don't hardcode model ids in code. Single registry in `packages/core/src/internal-llm/models.ts`.

### Cost tracking + budgets

New table:

```sql
CREATE TABLE internal_llm_usage (
  usage_id TEXT PRIMARY KEY,          -- UUIDv7
  user_id TEXT,                       -- NULL when fired without user attribution
  worktree_id TEXT,                   -- audit scope
  session_id TEXT,                    -- audit scope
  use_case TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd_micros INTEGER NOT NULL,
  billing_source TEXT NOT NULL,       -- 'user' | 'daemon'
  cached BOOLEAN NOT NULL DEFAULT FALSE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_internal_llm_usage_user_month
  ON internal_llm_usage(user_id, created_at);
```

- Per-user monthly aggregate computed on-the-fly (small table, indexed scan is fine for v1; rollup table if it gets big).
- Soft warn at 80% of cap: emit one notification per user per month.
- Hard cap: refuse new calls, surface in `getUsage()`, log at `info`. Caller fallback path takes over (truncated prompt etc).
- Daemon-level cap-of-caps: enforced the same way against `billing_source = 'daemon'` rows.

### Caching

- **v0:** in-process LRU keyed by `SHA256(use_case + model + prompt + system)`. TTL from config (default 1h). Avoids duplicate calls during burst-creation of forks/spawns from the same parent.
- **v1:** DB-backed cache for "stable inputs" (e.g., titling the same prompt twice → same title) — useful if a user hits "regenerate" right after the auto-title.
- **Manual re-title bypasses cache.**

### Provider abstraction

Three thin adapters in `packages/core/src/internal-llm/providers/`:

```ts
interface LLMProvider {
  name: 'anthropic' | 'openai' | 'gemini';
  complete(opts: {
    model: string;
    apiKey: string;
    system?: string;
    prompt: string;
    max_output_tokens: number;
    timeout_ms: number;
  }): Promise<{ text: string; tokens_in: number; tokens_out: number }>;
}
```

- `anthropic.ts` — uses `@anthropic-ai/sdk` Messages API. Enable prompt caching for the system prompt (cheap wins for titling).
- `openai.ts` — uses `openai` SDK Chat Completions.
- `gemini.ts` — uses `@google/genai` `generateContent`.

Each adapter <100 lines. No lock-in.

Cost-estimate table per (provider, model) in `models.ts`. The provider returns tokens; we compute `cost_usd_micros` in the service layer so cost math is in one place.

### Async UX integration

- `quick()` returns a `Promise` that the caller (e.g., the sessions service `create` hook) **fires and does not await**. The create handler returns the session to the API caller immediately.
- On resolution: caller patches the entity (`this.patch(sessionId, { title, title_source: 'llm' })`). FeathersJS service event flows to UI.
- **No new WebSocket plumbing needed.** Use the existing FeathersJS `patched` channel — UI already listens in `useAgorData.ts`.

### Privacy + consent

**One toggle covers all internal LLM uses.** Per-feature opt-outs are too granular for v0.

Three places it's controlled:

1. **`internal_llm.enabled` (daemon-level master)** — admin can disable the whole feature.
2. **`users.data.preferences.allow_internal_llm`** — per-user opt-out. Defaults to the install-mode default.
3. **Per-use-case `enabled: false` knob** — only for ops who want to disable specific use cases (rare).

**Install-mode-aware default** (consistent with the deployment-mode memory):

| Mode | `internal_llm.enabled` default | Per-user default |
|---|---|---|
| `dev` / `local` / `solo` | `true` | `true` |
| `team` | `false` (consent gate) | `true` once master is on |
| `production` (hardened) | `false` (consent gate) | `false` (explicit opt-in) |

Settings UI surface:

- A single toggle: **"Allow Agor to use AI for internal features"** — with a "what this means" expander listing the use cases, data sent, provider configured, and current monthly usage.
- Below it: usage summary card — `$X.YY of $Y.YY used this month` from `getUsage()`.

**Data-flow doc** (lives in `apps/agor-docs/pages/guide/internal-llm.mdx` — write at v0):

- What's sent for each use case (titling: the prompt + worktree name; summary: the conversation excerpt; etc.).
- Who receives it (configured provider: Anthropic / OpenAI / Gemini).
- What's logged in `internal_llm_usage` (request metadata, **not** prompt content).
- How to disable (one toggle).
- How to inspect / reset budget.

### Failure handling — invariants

Every use case must define a **deterministic fallback** that doesn't need the LLM:

| Use case | Fallback |
|---|---|
| Titling | `prompt.substring(0, 100)` (today's behavior — already the right answer) |
| Worktree summary | Omit the summary field; UI renders without it |
| Spawn-report digest | List the N report titles unchanged; no compression |
| Notification grouping | Show items individually |
| Auto-zone | Use the board's default zone |

No internal LLM call may **block** a user-facing flow. The async patch model enforces this naturally.

---

## Phased delivery

### v0 — titling only (next worktree after sign-off)

- New service `apps/agor-daemon/src/services/internal-llm.ts` (NOT a FeathersJS-exposed REST service — pure daemon-internal singleton).
- New config block `internal_llm.*` with `fallback_credentials` + `use_cases.titling` only.
- One provider: Anthropic (Haiku 4.5).
- Wire into `sessions.create` (and `sessions.spawn`) as fire-and-forget post-create hook.
- New `title_source` field on `Session` (`'user' | 'llm' | 'truncated'`) to gate auto-overwrite.
- "Re-title" button in session panel kebab menu.
- One per-user opt-out toggle in Settings (default per install mode).
- In-memory LRU cache.
- **No** budget enforcement, **no** usage table, **no** OpenAI/Gemini adapters yet.
- Failure fallback: keep truncated title; never block.

**Effort estimate:** ~3–5 dev-days for a focused implementation worktree.

### v0.5 — accounting + opt-out polish

- `internal_llm_usage` table + migration.
- `getUsage()` query, surfaced in Settings.
- Soft warn at 80%; hard cap refuses calls.
- Daemon-level cap-of-caps.

**Effort:** ~2–3 dev-days.

### v1 — provider abstraction + 2 more use cases

- OpenAI + Gemini adapters.
- Worktree archive summaries (#2).
- Spawn-report digests (#3).
- Notification grouping (#4) — joint design with `design-notification-system`.
- Per-use-case model config.

**Effort:** ~5–10 dev-days.

### v2 — speculative

- Auto-zone suggestion experiment (#5).
- Daily digests (#7).
- Anomaly detection (#9) — gated on a metrics/events subsystem we don't have yet.
- DB-backed cache for stable-input recomputation.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Privacy backlash if team installs surprise users with LLM-bound prompt data | Install-mode-aware default; `team` and `production` are opt-in. Loud admin warning in dashboard when toggling on. |
| Cost surprise — runaway loop bills the daemon $$$ | Hard daemon-level cap-of-caps; per-user cap; in-memory dedup mutex per (session_id, use_case). |
| Quality — Haiku writes dumb titles | Ship with manual re-title from day 1. Measure CTR of re-title button as the quality signal. Iterate on prompt template before iterating on model. |
| Model lock-in | Adapter pattern + provider inferred from model id. Three providers from v1. |
| Cross-bucket key leakage (memory note: api_keys not scoped per-SDK at spawn) | Doesn't apply — internal service never spawns a process. It resolves a key in-daemon, makes an HTTPS call, discards the key. No spawn env, no leakage. |
| Title gets clobbered after user typed one | `title_source` field; auto-pipeline checks `title_source !== 'user'` before patching. Manual re-title overrides this (explicit user action). |
| Telemetry contains sensitive prompts | `internal_llm_usage` stores **only metadata**, never prompt content. Documented in guide. |
| Conflict with notification design (which may also want LLM grouping) | This service is the substrate; the notification design becomes a consumer. Joint review before either ships v1. |

---

## Open questions for Max

1. **Default for `team` mode:** I've recommended `internal_llm.enabled: false` (consent gate). Counter-argument: team admins probably want it on by default and let users individually opt out. Which is the right team-mode posture?
2. **Provider for v0:** Anthropic Haiku 4.5 is my default. If the typical Agor install already has `OPENAI_API_KEY` configured (because they're running Codex), do we want OpenAI in v0 too? Or strictly Anthropic + ship others in v1?
3. **`title_source` field on `Session`:** This adds one column / one JSON key. Worth it for the user-typed-vs-LLM distinction, or do we squash with a "if user has ever patched title manually, never overwrite" flag in `data`? I lean toward the explicit field — three values is easier to reason about than a boolean overload.
4. **Re-title scope:** Should the "re-title" button be a worktree-level action too ("re-summarize this worktree's purpose")? Or strictly session-level in v0? I lean session-only in v0, and worktree-summary as #2 in v1 covers the worktree case differently.
5. **Truncation fallback default:** Today the fork/spawn flow already populates `title: prompt.substring(0, 100)`. New user-created sessions currently leave it `undefined`. Should we standardize on "always pre-populate the truncated fallback" so cards are never blank during the LLM call's in-flight window? I say yes — simpler UI, no shimmer needed.

---

## File pointers (where v0 lands)

When implementation begins, expected touch points:

- `packages/core/src/internal-llm/{types.ts, models.ts, providers/anthropic.ts}` — new module.
- `packages/core/src/config/types.ts` — add `internal_llm.*` block (+ `AgorConfig.internal_llm`).
- `packages/core/src/types/session.ts:197` — add `title_source?: 'user' | 'llm' | 'truncated'`.
- `apps/agor-daemon/src/services/internal-llm.ts` — daemon singleton, not REST-exposed.
- `apps/agor-daemon/src/services/sessions.ts:283,388` — wire fire-and-forget titling into create/fork/spawn.
- `apps/agor-daemon/src/internal-llm/use-cases/titling.ts` — prompt template + caller-side fallback.
- `apps/agor-ui/src/components/SessionPanel/` — "Re-title" menu item.
- `apps/agor-ui/src/components/Settings/` — single opt-out toggle + usage card.
- `apps/agor-docs/pages/guide/internal-llm.mdx` — user-facing data-flow doc.
- `docs/internal/credential-leak-defenses-2026-05-11.md` — cross-reference (no leakage path here; explain why).

No CLI command for v0.
