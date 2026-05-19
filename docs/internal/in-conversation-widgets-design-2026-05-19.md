# In-Conversation Interactive Widgets — Design Doc

Author: Max (drafted by Claude assistant)
Status: **Draft — not for merge.** Implementation worktrees branch off the PR definitions in §7.
Companion brief: `design-in-conversation-widget-primitive` worktree.

---

## 1. TL;DR

Agor needs a way for agents to render small interactive UI inline in the conversation transcript — a form, a button, a picker — that captures user input **without that input ever entering the LLM's context**.

**Motivating use case:** during onboarding (and beyond) the agent often needs an env var (`HUBSPOT_API_KEY`, `GITHUB_TOKEN`) before it can do its job. Today: "please go to User Settings → Env Vars and add X." User context-switches; flow breaks. **Wanted:** the agent calls `agor_widgets_request_env_vars({ names, reason })`, a form pops into the transcript, the user types and submits inline, the secret goes **directly from the React widget to the daemon** (not through the model), and the agent receives a sanitized confirmation event (`{ names, status }`, no values) and continues.

**This is the first instance of a broader primitive** — Agor Custom Widgets. v1 ships the framework + the env-var widget. The same primitive will host OAuth-connect, file picker, MCP-server selector, confirmation prompt, and similar agent-driven micro-interactions.

**Three hard requirements drive the design:**

1. **Secret never enters the LLM context.** Triple-checked across every code path. Value flows browser → daemon, never browser → agent → daemon.
2. **Agent stays informed.** A sanitized confirmation event (`{ widget_id, widget_type, status, names, scope }`) reaches the agent so it can resume work.
3. **Extensible.** v1 architecture supports 3+ future widget types without re-architecture (validated in §6).

---

## 2. Prior art audit (what we reuse, what we don't)

| Pattern | PR | Verdict |
|---|---|---|
| `permission_request` messages + executor pause/resume (`canUseTool`) | merged | **Closest production reference.** Reuse the message-as-state, pause-the-tool-call, broadcast-via-Feathers shape. Differs only in *who initiates* (we initiate from an MCP tool, not a SDK hook). |
| `appendSystemMessage` helper + `MessageType` discriminant union | #1166 | **Reuse directly.** Add `'widget_request'` to `MessageType` and to the helper's `type` union (`apps/agor-daemon/src/utils/append-system-message.ts:36`). |
| `ArtifactConsentModal` + `artifact_trust_grants` table + TOFU strict-subset matching | #1147 | **Mine for UX patterns, not architecture.** Artifact consent is a *modal* triggered from an artifact card; widgets render *inline in the transcript*. Reuse the scope-selector copy, the "submit just nominates scope" pattern, and the strict-subset principle. Do **not** reuse the table — widgets are per-session ephemera, not durable grants. |
| `AskUserQuestion` SDK tool (`input_request` message type, `InputRequestService`, `InputRequestBlock`) | #658 → ripped in #1181 | **Dead.** The SDK tool is in `CLAUDE_CODE_DISALLOWED_TOOLS` (`packages/executor/src/sdk-handlers/claude/constants.ts:33`). The widget primitive is the long-term replacement; a `confirmation`/`question` widget closes the gap that disallowing left (see §6 and §7 PR 3). |
| Env-var storage (`users.data.env_vars` JSON map, AES-256-GCM via `encryptApiKey`, scope enum, blocklist, `^[A-Z_][A-Z0-9_]*$` regex) | existing | **Reuse the existing users service.** The env-var widget submit handler is a thin shim that PATCHes `/users/:id` with a single-key `env_vars` patch. Validation, encryption, scope handling, blocklist enforcement all already live there. |
| MCP tool registry (`apps/agor-daemon/src/mcp/tools/*.ts`, `registerTool(name, {description, inputSchema, annotations}, handler)`, `ctx.sessionId`, `textResult(...)`) | existing | **Slot a new `widgets.ts` file alongside other domains.** Standard pattern. |

---

## 3. Architecture

### 3.1 Message type: `widget_request`

Add a new `MessageType` value: `'widget_request'`. A widget message is just a row in `messages` with:

```ts
{
  type: 'widget_request',
  role: MessageRole.SYSTEM,
  content: '...short human-readable text, e.g. "Please provide HUBSPOT_API_KEY"...',
  metadata: {
    widget: {
      widget_id: MessageID,        // same as message_id — single source of truth
      widget_type: 'env_vars',     // discriminant for the widget registry
      params: { ... },             // widget-type-specific payload (validated by registry schema)
      status: 'pending' | 'submitted' | 'dismissed' | 'timed_out',
      requested_at: ISO8601,
      resolved_at?: ISO8601,
      // RESULT_META is widget-type-specific, scrubbed of secret material.
      // For env_vars: { names_submitted: string[], scope: 'global' | 'session' }
      result_meta?: Record<string, unknown>,
    }
  }
}
```

Why message-as-state (vs. a separate `pending_widgets` table):

- **Transcript persistence comes for free.** Reload shows the widget in its final state.
- **Single source of truth.** The same row drives the agent's tool-call result, the WebSocket event, and the transcript renderer.
- **Schema cost is one new enum value**, not a new table + migration + RLS.

We add a real table only if/when we need indexed cross-session queries ("show me all pending widgets across the workspace"). Not v1.

### 3.2 MCP tool surface

Register one tool **per widget type** under a new file `apps/agor-daemon/src/mcp/tools/widgets.ts`:

```ts
server.registerTool(
  'agor_widgets_request_env_vars',
  {
    description:
      'Ask the user to provide one or more environment variables via an in-conversation form. ' +
      'The user types the values directly into the UI; the values never enter your context. ' +
      'You receive a confirmation event with the variable names that were submitted (no values).',
    annotations: { destructiveHint: false },
    inputSchema: z.object({
      names: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
        .min(1).max(10)
        .describe('UPPER_SNAKE env var names. Same validation as User Settings.'),
      reason: z.string().min(1).max(500)
        .describe('Short explanation shown to the user — why do you need these?'),
      instructions: z.string().max(2000).optional()
        .describe('Optional markdown — e.g. "Get a key at https://app.hubspot.com/..."'),
      default_scope: z.enum(['global', 'session']).default('global')
        .describe('Suggested scope. User can override in the form.'),
    }),
  },
  widgetsRequestEnvVarsHandler
);
```

Why per-widget tools (vs. one generic `agor_widgets_request(type, params)`):

- **Schema validation is per-widget**, and Zod schemas at registration time give the agent a typed contract via MCP `tools/list`.
- **The agent sees a discoverable name** (`agor_search_tools` already filters by domain — `widgets` becomes a domain).
- **Progressive disclosure**: each tool's description teaches the agent the exact contract, including the "no values in your context" guarantee.

The handler logic is shared via a small helper (see §3.4) so adding a widget type ≈ defining its Zod schema, its React component, and its submit handler.

### 3.3 Daemon flow (the pause/resume model)

```
┌──────────┐                ┌─────────────┐               ┌────────┐               ┌────────┐
│  Agent   │                │ Daemon (MCP │               │   UI   │               │  User  │
│ (Claude) │                │   server)   │               │ client │               │        │
└────┬─────┘                └──────┬──────┘               └────┬───┘               └────┬───┘
     │                             │                           │                        │
     │ MCP: agor_widgets_request_  │                           │                        │
     │  env_vars({names, reason})  │                           │                        │
     │ ──────────────────────────► │                           │                        │
     │                             │                           │                        │
     │                             │ appendSystemMessage(      │                        │
     │                             │   type='widget_request',  │                        │
     │                             │   metadata.widget={...,   │                        │
     │                             │     status:'pending'})    │                        │
     │                             │                           │                        │
     │                             │ Feathers 'messages         │                        │
     │                             │  created' WS event ──────►│                        │
     │                             │                           │ render WidgetBlock     │
     │                             │                           │ ──────────────────────►│
     │                             │                           │                        │
     │                             │ await resolution          │ types HUBSPOT_API_KEY  │
     │                             │ (long-poll, see §3.5)     │ ◄──────────────────────│
     │                             │                           │                        │
     │                             │ POST /widgets/:id/submit  │                        │
     │                             │ {values, scope}           │                        │
     │                             │ ◄─────────────────────────│                        │
     │                             │                           │                        │
     │                             │ users.patch              │                        │
     │                             │  (encrypt, store)         │                        │
     │                             │                           │                        │
     │                             │ messages.patch           │                        │
     │                             │  (widget.status =         │                        │
     │                             │   'submitted',            │                        │
     │                             │   result_meta = {names,   │                        │
     │                             │   scope})                 │                        │
     │                             │                           │                        │
     │                             │ widget:resolved event ────┼───────────────────────►│
     │                             │                           │ re-render badge       │
     │                             │                           │                        │
     │ MCP tool returns:           │                           │                        │
     │  { widget_id,               │                           │                        │
     │    status: 'submitted',     │                           │                        │
     │    names: [...],            │                           │                        │
     │    scope: 'global' }        │                           │                        │
     │ ◄────────────────────────── │                           │                        │
     │                             │                           │                        │
     │ resumes — retries           │                           │                        │
     │ original API call           │                           │                        │
```

Key properties:

- **Executor doesn't exit.** It's blocked at the MCP tool call (HTTP request to the daemon, same shape as any other long-running tool). This is the same pause model that `permission_request` uses; the difference is the pause lives in the *daemon* (waiting on the human) rather than the *executor* (waiting on `canUseTool`).
- **The MCP tool result carries names + status + scope, never values.**
- **Transcript persistence is automatic** because the widget IS a message row.

### 3.4 Widget registry

```ts
// packages/core/src/types/widget.ts
export type WidgetType = 'env_vars'; // extended over time

export interface WidgetRegistryEntry<TParams, TSubmit, TResultMeta> {
  type: WidgetType;
  /** Zod schema validating MCP tool input */
  paramsSchema: z.ZodType<TParams>;
  /** Zod schema validating POST /widgets/:id/submit body */
  submitSchema: z.ZodType<TSubmit>;
  /** What goes back to the agent (and into result_meta on the message). NEVER includes secret values. */
  buildResultMeta: (submit: TSubmit) => TResultMeta;
  /** Side-effect: persist the submitted values to wherever they belong */
  applySubmit: (ctx: SubmitCtx, submit: TSubmit) => Promise<void>;
}

// frontend mirror
export const widgetComponents: Record<WidgetType, React.FC<WidgetProps>> = {
  env_vars: EnvVarRequestWidget,
};
```

A new widget type is three files: a Zod-typed registry entry on the daemon, a React component on the UI, a registration line on each side. No core changes needed.

### 3.5 Long-poll vs. event subscription

The MCP tool handler needs to block until the widget resolves (or times out). Two implementation options:

| Option | How | Trade-off |
|---|---|---|
| **Long-await on internal event bus** (recommended) | Handler subscribes to `widget:resolved:<widget_id>` on the FeathersJS app's event emitter; awaits with a 30-min timeout (configurable via `widgets.default_timeout_ms`). | Same in-process pattern `PermissionService.waitForDecision()` uses. Lives in daemon memory — survives WS disconnects from the UI but not daemon restart. |
| **Poll the message row** | Handler polls every 2s for `widget.status !== 'pending'`. | Simpler but wastes cycles. Skip. |

**Daemon restart handling**: on startup, scan `messages WHERE metadata->widget.status='pending'` bound to running sessions; if executor is still alive (PID check / `awaiting_widget` task status), it's already disconnected from the in-process await — the executor sees an MCP error and retries, the user sees the widget either still pending or already submitted. **Simplest fix**: mark all pending widgets as `timed_out` on daemon restart, surface a follow-up system message ("The widget request for HUBSPOT_API_KEY was cancelled by a daemon restart — re-prompt the agent to ask again."). Same pattern PR #1166 uses for orphaned sessions.

### 3.6 HTTP timeout for the MCP request

This is the **single biggest implementation risk** (see §8). MCP tool calls flow over HTTP; a 30-minute open request will hit infrastructure timeouts (reverse proxies, load balancers, browser-side fetch idle). Mitigations:

1. **Keep-alive heartbeats**: SSE-style chunked response that emits empty whitespace every 25s (the MCP transport already streams). Implementation lives in the MCP server framework, not per-tool.
2. **Shorter default timeout** (configurable): start with 10 min — same as `permission_request` (`DEFAULT_PERMISSION_TIMEOUT_MS = 600_000`). Bump if friction proves real.
3. **Polling fallback**: if a tool times out at the HTTP layer but the widget is still `pending`, the agent's natural retry semantics call it again with the same `widget_id` (idempotency key) — daemon resumes the await on the *same* widget row instead of creating a new one. Stretch goal; not blocking v1.

---

## 4. The env-var widget (concrete v1)

| Piece | Path | Reuses |
|---|---|---|
| MCP tool | `apps/agor-daemon/src/mcp/tools/widgets.ts` (new) | `registerTool` pattern from `worktrees.ts` |
| Daemon submit endpoint | `POST /widgets/:widget_id/submit` (new route) | FeathersJS service for `widget-submissions` |
| Persistence | Thin shim → `app.service('users').patch(userId, { env_vars: { [name]: { value, scope } } })` | existing users service, `encryptApiKey`, blocklist, regex |
| Message update | `app.service('messages').patch(widget_id, { metadata.widget: {...} })` | existing messages service |
| Event | `app.io.to(sessionRoomName(sessionId)).emit('widget:resolved', {...})` | existing per-session room |
| UI dispatch | `MessageBlock.tsx`: `if (message.type === 'widget_request') return <WidgetBlock message={message} />` | `PermissionRequestBlock` precedent at MessageBlock.tsx:256-294 |
| Widget component | `apps/agor-ui/src/components/Widgets/EnvVarRequestWidget.tsx` | form shape from `EnvVarEditor.tsx` |
| Confirmation event for agent | MCP tool return: `{ widget_id, status, names, scope }` | `textResult()` |

### UI sketch

```
┌──────────────────────────────────────────────────────────────┐
│ 🔐  Agent needs env vars                                     │
│                                                              │
│ HUBSPOT_API_KEY needed to call the Hubspot API.              │
│                                                              │
│ Get a key at https://app.hubspot.com/private-apps            │
│                                                              │
│  HUBSPOT_API_KEY  [••••••••••••••••••••••••••]              │
│  Scope: ( ) Session  (•) Global                              │
│                                                              │
│            [ Dismiss ]      [ Save & continue ]              │
└──────────────────────────────────────────────────────────────┘
```

After submission:

```
┌──────────────────────────────────────────────────────────────┐
│ ✅  HUBSPOT_API_KEY saved (Global)                           │
│     Submitted by max@preset.io at 14:23                      │
└──────────────────────────────────────────────────────────────┘
```

After dismissal:

```
┌──────────────────────────────────────────────────────────────┐
│ ⊘   HUBSPOT_API_KEY request dismissed                        │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Security analysis

### 5.1 The "secret never enters the LLM context" property

**Claim:** in no code path does a submitted secret value reach the agent's MCP transport, message content, message preview, or any tool-call result.

**Proof by code path enumeration:**

| Path | Carries values? | Justification |
|---|---|---|
| Agent → MCP tool call (`agor_widgets_request_env_vars`) | **No** | Input schema accepts `names` (strings) + `reason`. No `values` field exists. Zod rejects extras. |
| Daemon → `appendSystemMessage` → message row | **No** | `metadata.widget.params` is the agent-provided payload (names, reason, instructions); `content` is human-readable preview. Both are filled from the agent's tool args — agent had no values. |
| Feathers `messages created` WebSocket event | **No** | Payload is the message row above. |
| UI → `POST /widgets/:id/submit` | **Yes** | Direct browser-to-daemon HTTP request. Auth via the user's session cookie / JWT. **This is the only place values exist on the wire**, and it never traverses the agent. |
| Daemon submit handler → `users.patch` | **Yes (encrypted in transit at app layer)** | Standard env-var write path. `encryptApiKey()` is called inside the users service before DB write. |
| Daemon → message status update (`messages.patch`) | **No** | Updates `metadata.widget.status` and `result_meta = { names, scope }`. Explicit allow-list — we patch by field, never spread the submit body. |
| `widget:resolved` Feathers event | **No** | Payload is `{ widget_id, status, result_meta }`. |
| MCP tool return value → agent | **No** | Returns `{ widget_id, status, names, scope }`. No `values` field. |
| Transcript reload | **No** | Re-reads the message row; values were never stored on it. |
| Logs | **No (must enforce)** | Submit handler MUST NOT log the request body. Add an explicit lint or test: `expect(logs).not.toContain(submittedValue)`. |

The only access path to values after submission is the standard env-var read path (decrypt at runtime when launching an executor). That path is unchanged from today.

### 5.2 Authz / CSRF

`POST /widgets/:widget_id/submit` is authenticated via existing FeathersJS session auth. The handler MUST verify:

1. The caller's `user_id` matches `widget_message.session.created_by` **OR** the caller has `prompt`-tier RBAC on the worktree (`others_can >= prompt`). This mirrors who can already prompt the session.
2. The widget is still `pending` (idempotency — double-submit is a no-op, not a re-write).
3. The widget's `requested_at` is within the configured TTL.

CSRF: same protections as every other authenticated daemon endpoint (existing CORS + same-origin policy + JWT).

### 5.3 RBAC and multi-user

If a *different* user submits the widget (in a `prompt`-tier multi-user setup): the env var is written to **the executor's identity's** env_vars (= session creator's), because that's whose env the agent will read at retry. **The submitting user is recorded in `result_meta.submitted_by`** for audit. Surfaced to the agent ("submitted by <user>") so the agent can adjust messaging.

This is consistent with `dangerously_allow_session_sharing: false` semantics (default-safe). When session sharing is enabled and a collaborator submits a value, the value lands in the original owner's env — that's an explicit security trade-off documented under that flag.

### 5.4 Transcript persistence implications

The widget message persists forever in the transcript with `{ names, status, result_meta }` — **names of submitted env vars are visible** to anyone who can read the transcript. This is the same surface as User Settings → Env Vars (names visible, values hidden), so no new exposure. Worth a one-line callout in the UI ("Variable names are logged in the transcript; values are not.").

### 5.5 Threat model

| Threat | Mitigation |
|---|---|
| Malicious agent crafts the `reason`/`instructions` to phish the user | Inputs rendered as **markdown with a strict allow-list** (no `<script>`, no inline event handlers, no auto-load images). Reuse the same sanitizer the artifact consent modal uses. |
| Agent uses a widget to extract a value indirectly (e.g. asks for "type your value, then say it back to me") | The widget message *names* what's requested; an agent prompting the user to type a value in-chat *instead of* using the widget is a UX failure but not new attack surface — same as today. Mitigation is the disclaimer copy on the widget itself: "Type values here, never paste them into chat." |
| Submission endpoint accepts unsolicited writes (no preceding widget request) | Endpoint requires a valid `widget_id` matching a `pending` widget message bound to the caller's session. No widget-less submissions. |
| Replay attack with a captured submit payload | Once submitted, status → `submitted`; resubmission rejected on status check. |
| Stored XSS via env-var name | Existing `^[A-Z_][A-Z0-9_]*$` regex precludes anything renderable as HTML. |

---

## 6. Extensibility — validating against 3 future widgets

If the abstraction is wrong, adding the second widget reveals it. Sketches:

### 6.1 `agor_widgets_request_confirmation` — replaces the disallowed AskUserQuestion

```ts
inputSchema: z.object({
  title: z.string().max(120),
  body: z.string().max(2000),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    style: z.enum(['default', 'primary', 'danger']).default('default'),
  })).min(2).max(5),
  default_option_id: z.string().optional(),
})
// submit body: { option_id: string }
// result_meta: { option_id, option_label }  // label is fine — it's agent-provided
// MCP return: { widget_id, status, option_id, option_label }
```

**Fit check:**
- Renders inline in transcript. ✓
- Submit has no secret material. ✓
- Generalizes: A/B/C prompts, "delete this?", "which environment?".
- Replaces the gap left by disallowing AskUserQuestion. **This becomes PR 3** (§7).

### 6.2 `agor_widgets_request_oauth` — connect a third-party account

```ts
inputSchema: z.object({
  provider: z.enum(['github', 'slack', 'linear', 'hubspot', ...]),
  scopes: z.array(z.string()).min(1),
  reason: z.string().max(500),
})
// submit body: empty — submission happens via OAuth callback, not user form
// applySubmit: writes to existing OAuth tokens table
// result_meta: { provider, granted_scopes: string[], account_label: string }
// MCP return: { widget_id, status, provider, granted_scopes, account_label }
```

**Fit check:**
- Widget renders a "Connect GitHub" button. Click → popup → OAuth callback hits a *separate* daemon endpoint (`/oauth/:provider/callback`) which then flips the widget status.
- Token never goes anywhere near the agent. ✓
- The submit endpoint is virtual here — resolution happens via the OAuth callback. Registry's `applySubmit` becomes "wait for OAuth, then write to tokens table."

**One real seam discovered:** not every widget resolves via `POST /widgets/:id/submit`. OAuth resolves via callback. We accommodate this by making `widget:resolved` the canonical resolution event, and treating `POST .../submit` as one of *several* possible resolution mechanisms. Worth calling out in the registry shape — `applySubmit` becomes optional, and the registry can declare alternative resolution paths.

### 6.3 `agor_widgets_request_mcp_server` — select / attach an MCP server

```ts
inputSchema: z.object({
  purpose: z.string().max(300)
    .describe('Why you need an MCP server — e.g. "browse Linear tickets"'),
  suggested_server_kinds: z.array(z.string()).optional(),
})
// submit body: { mcp_server_id: string } | { kind: 'add_new', config: {...} }
// applySubmit: noop if existing, else creates an mcp_servers row scoped to the session
// result_meta: { mcp_server_id, name, kind }
// MCP return: { widget_id, status, mcp_server_id, name, kind }
```

**Fit check:**
- Renders a picker with installed servers + an "Add new" affordance.
- Adding a new server may itself trigger an OAuth widget — **widgets can chain** by having one widget's resolution kick off the next. Worth noting; not blocking v1.
- No secret material in the submit body (server config holds credentials, but those are written via the existing mcp-servers service which handles encryption).

**Verdict:** the registry shape holds. The one refinement is generalizing "submit" → "resolve," accommodating OAuth-style callbacks. We bake that in from v1 by phrasing the abstraction as "the widget resolves" rather than "the widget is submitted via a single endpoint."

---

## 7. Phased delivery — concrete next-step PRs

### PR 1: `feat(widgets): in-conversation widget primitive`

Scope:
- Add `'widget_request'` to `MessageType` (sqlite + postgres schemas + types).
- Extend `appendSystemMessage` helper's `type` union to include `widget_request`.
- Add `metadata.widget` shape to `Message['metadata']` type (typed via a discriminated union over `widget_type`).
- New FeathersJS service `widget-submissions` registering `POST /widgets/:widget_id/submit` — handler dispatches by `widget_type` to a daemon-side registry (initially empty).
- Daemon event bus: `widget:resolved` per-widget-id channel, plus per-session-room broadcast.
- New MCP tool domain marker (`domain: 'widgets'` for `agor_search_tools`).
- UI: `WidgetBlock` dispatcher component in MessageBlock that switches on `metadata.widget.widget_type`, plus a placeholder "Unknown widget type" fallback.
- Daemon-restart handling: on startup, mark all `pending` widgets as `timed_out` and append a follow-up system message (mirror PR #1166).
- Config: `widgets.default_timeout_ms` (default 600_000) in `~/.agor/config.yaml`.

No widget types ship in PR 1. The framework is callable but produces no actual widgets yet. Tests cover the registry, the submit endpoint's auth/idempotency, and the WebSocket broadcast.

**Estimated effort:** ~3-4 eng-days.

### PR 2: `feat(widgets): env_vars widget`

Scope:
- Register `env_vars` widget type in the daemon registry: Zod schemas, `applySubmit` = thin shim around `users.patch`.
- Register `agor_widgets_request_env_vars` MCP tool in `apps/agor-daemon/src/mcp/tools/widgets.ts`.
- React component `EnvVarRequestWidget.tsx` (reuses form shape from `EnvVarEditor.tsx`).
- Wire `widgetComponents['env_vars']` mapping on the UI.
- Submit handler reuses existing env-var validation (`validateEnvVar`, `isEnvVarAllowed`, regex) and encryption (`encryptApiKey`) — zero net-new logic.
- Confirmation event shape per §5.1.
- Docs: `apps/agor-docs/pages/guide/in-conversation-widgets.mdx` (user-facing) with the env-var section as the canonical example.
- Storybook story for the widget in all three states (pending, submitted, dismissed).

**Estimated effort:** ~2-3 eng-days.

### PR 3 (optional, validates extensibility): `feat(widgets): confirmation widget`

Scope:
- Register `confirmation` widget type (Zod schemas per §6.1).
- React component with N option buttons; danger style for `style: 'danger'`.
- MCP tool `agor_widgets_request_confirmation`.
- **Critically:** updates `CLAUDE.md` / Claude's system prompt with guidance: "Use `agor_widgets_request_confirmation` for binary/multi-choice decisions instead of asking inline." This closes the gap left by disallowing `AskUserQuestion`.

**Estimated effort:** ~1.5 eng-days. Mostly UX polish.

### Sequencing

PR 1 → PR 2 → (optional) PR 3. PR 2 cannot land before PR 1 (depends on the registry). PR 3 is independent of PR 2 — could swap order if confirmation is more urgent than env-var capture.

---

## 8. Risks and open questions

| # | Risk / question | Mitigation |
|---|---|---|
| R1 | **HTTP timeout for the blocked MCP request.** A 10-min await over fetch will trip on infra timeouts. | Keep-alive whitespace heartbeats every 25s; configurable timeout; idempotent re-call by `widget_id` if the agent retries. |
| R2 | **Daemon restart while a widget is pending** breaks the in-process await. | On startup, mark pending widgets as `timed_out`, append a follow-up system message (mirrors PR #1166). |
| R3 | **Widget message persists forever in the transcript.** The *names* of submitted env vars are visible to anyone who can read the transcript. | Same surface as User Settings → Env Vars. One-line disclaimer on the widget. If sensitive, the user can dismiss and add via Settings. |
| R4 | **Widget-version drift** when v2 changes a widget's submit schema. | `metadata.widget.schema_version: number` baked in from v1. UI's `WidgetBlock` renders old versions in a degraded read-only mode. |
| R5 | **Dismissal UX.** Does the agent treat dismissal as "user said no, stop" or "user said not-now, try again later"? | Confirmation event includes `status: 'dismissed'`. Agent prompt guidance: "On dismissal, ask the user once whether they want to proceed without; do not re-request immediately." |
| R6 | **Multi-user authz for submission.** Who can submit on behalf of whom? | §5.2 — submitter must match session creator or have `prompt`-tier worktree RBAC. Cross-user submit attributed in `result_meta.submitted_by`. |
| R7 | **Logging leakage.** Submit handler must not log values. | Lint rule + explicit test in PR 2 (`expect(logs).not.toContain(value)`). |
| R8 | **Agent uses chat (not the widget) to extract values** by phishing the user. | Widget copy: "Never paste values into chat — only into the form above." Out of scope for code mitigations. |
| Q1 | **One generic `agor_widgets_request` tool vs. one tool per type?** | Recommended: one per type (§3.2). Typed contracts, better progressive discovery, better agent UX. |
| Q2 | **Should widgets support a "value already exists" short-circuit?** E.g. agent asks for `HUBSPOT_API_KEY`, user already has it set globally → widget auto-resolves with status `already_present`. | **Recommended yes** for env-vars specifically (saves a user click). Daemon checks env-vars presence at request time and immediately resolves the widget if all requested names already exist in the user's scope. The agent gets `status: 'already_present', names_present: [...]` and can proceed without UI flicker. |
| Q3 | **OAuth widget timeout** — OAuth flows can take minutes. Does the 10-min default suffice? | Per-widget-type override on `widget.timeout_ms` baked into the registry entry. OAuth defaults to 15 min. |

---

## 9. Coordination with adjacent work

| Worktree / PR | Relationship |
|---|---|
| `fix-issue-1177-ask-user-question-hang` (merged as #1181) | **Disallowed AskUserQuestion.** PR 3 of this design (the confirmation widget) is the long-term replacement — it gives agents a structured way to ask the user inline that doesn't depend on the dead SDK feature. No code conflict; conceptual handoff. |
| `design-notification-system` (PR #1135, open) | **Widgets are in-transcript, notifications are out-of-transcript.** No overlap. Worth a one-line cross-reference in both docs. |
| `feat(artifacts)!: declarative format + TOFU consent flow` (PR #1147, merged) | **Shares UX language**, not architecture. Reuse the scope-selector copy and the markdown sanitizer; do not reuse `artifact_trust_grants` table. |
| `system-message-on-daemon-restart` (PR #1166, merged) | **Direct reuse** of `appendSystemMessage` + the daemon-restart-marks-orphans pattern. |
| `design-internal-llm-service` (in flight) | Adjacent (both are "app-invoked" patterns) but no direct integration. |
| `improve-onboarding-openclaw-integration` / onboarding flows | **Primary consumer of v1.** Onboarding zone-triggers can now ask for env vars inline instead of redirecting to Settings. |

---

## 10. Open call (for Max)

Decisions I'd like an explicit thumbs-up/down on before PR 1 lands:

- **D1:** Message-row-as-state vs. separate `pending_widgets` table. Recommendation: message-row (§3.1). Add a table only when we need cross-session queries.
- **D2:** One MCP tool per widget type vs. one generic tool. Recommendation: per type (§3.2).
- **D3:** Default timeout: 10 min (matches `permission_request`)? Or longer for env-vars (user may walk away to fetch a key)?
- **D4:** Q2 — auto-resolve `already_present` for env-vars at request time?
- **D5:** Should PR 3 (confirmation widget) ship in the same release as PR 2, or be deferred? It validates the abstraction earliest if it ships together.

---

_References (file:line)_

- `apps/agor-daemon/src/utils/append-system-message.ts:27-77` — helper to extend
- `apps/agor-daemon/src/mcp/tools/worktrees.ts:59-95` — MCP tool registration template
- `apps/agor-daemon/src/mcp/tools/search.ts:75-140` — progressive-discovery wiring
- `apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx:256-294` — dispatch precedent (PermissionRequestBlock)
- `apps/agor-ui/src/components/EnvVarEditor.tsx` — form shape to mirror
- `packages/core/src/types/message.ts:33-41` — `MessageType` union to extend
- `packages/core/src/db/encryption.ts` — `encryptApiKey` (do not reimplement)
- `packages/core/src/config/env-validation.ts:30-90` — env-var validation (regex + blocklist)
- `packages/executor/src/permissions/permission-service.ts:94-149` — pause/resume reference for the daemon-side await
- `packages/executor/src/sdk-handlers/claude/constants.ts:33` — AskUserQuestion disallowed
- `apps/agor-ui/src/components/ArtifactConsentModal/ArtifactConsentModal.tsx` — scope-selector UX to mine
