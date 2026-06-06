# In-Conversation Interactive Widgets — Design Doc

Author: Max (drafted by Claude assistant)
Status: **Draft — not for merge.** Implementation worktrees branch off the PR definitions in §7.
Companion brief: `design-in-conversation-widget-primitive` worktree.

---

## 1. TL;DR

Agor needs a way for agents to render small interactive UI inline in the conversation transcript — a form, a button, a picker — that captures user input **without that input ever entering the LLM's context**.

**Motivating use case:** during onboarding (and beyond) the agent often needs an env var (`HUBSPOT_API_KEY`, `GITHUB_TOKEN`) before it can do its job. Today: "please go to User Settings → Env Vars and add X." User context-switches; flow breaks. **Wanted:** the agent calls `agor_widgets_request_env_vars({ names, reason })`, a form pops into the transcript, the user types and submits inline, the secret goes **directly from the React widget to the daemon** (not through the model), and a **sanitized system-authored prompt** is auto-queued into the agent's next turn (`[Agor] User submitted HUBSPOT_API_KEY (scope: global). Retry the operation that needed it.`) so it can continue.

**This is the first instance of a broader primitive** — Agor Custom Widgets. v1 ships the framework + the env-var widget. The same primitive will host OAuth-connect, file picker, MCP-server selector, confirmation prompt, and similar agent-driven micro-interactions.

**Three hard requirements drive the design:**

1. **Secret never enters the LLM context.** Triple-checked across every code path. Value flows browser → daemon, never browser → agent → daemon.
2. **Agent stays informed, asynchronously.** The MCP tool returns immediately (fire-and-forget). When the user submits, a sanitized system-authored task is **auto-queued** via the "Never lose a prompt" (#1068) infrastructure; the agent picks it up in its next turn — no executor pause, no HTTP timeout, works in Slack/gateway contexts unchanged.
3. **Extensible.** v1 architecture supports 3+ future widget types without re-architecture (validated in §6).

---

## 2. Prior art audit (what we reuse, what we don't)

| Pattern                                                                                                                                                               | PR                     | Verdict                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Never lose a prompt" — daemon-owned user-messages + task-centric queue**                                                                                           | #1068                  | **Direct dependency.** Widget submissions inject a system-authored task into the existing prompt queue. The agent picks it up exactly as it would a user-typed message in an idle/busy session. This is what lets us be fully decoupled.                                                                                                                |
| `permission_request` messages + executor pause/resume (`canUseTool`)                                                                                                  | merged                 | **Architecturally adjacent**, but we diverge on resolution. `permission_request` blocks the executor at `canUseTool`; widgets do **not** block — they fire, the tool returns, and the agent ends its turn. We share only the "message row as widget state" shape and the Feathers broadcast channel.                                                    |
| `appendSystemMessage` helper + `MessageType` discriminant union                                                                                                       | #1166                  | **Reuse directly.** Add `'widget_request'` to `MessageType` and to the helper's `type` union (`apps/agor-daemon/src/utils/append-system-message.ts:36`).                                                                                                                                                                                                |
| `ArtifactConsentModal` + `artifact_trust_grants` table + TOFU strict-subset matching                                                                                  | #1147                  | **Mine for UX patterns, not architecture.** Artifact consent is a _modal_ triggered from an artifact card; widgets render _inline in the transcript_. Reuse the scope-selector copy, the "submit just nominates scope" pattern, and the strict-subset principle. Do **not** reuse the table — widgets are per-session ephemera, not durable grants.     |
| `AskUserQuestion` SDK tool (`input_request` message type, `InputRequestService`, `InputRequestBlock`)                                                                 | #658 → ripped in #1181 | **Dead.** The SDK tool is in `CLAUDE_CODE_DISALLOWED_TOOLS` (`packages/executor/src/sdk-handlers/claude/constants.ts:33`). It was killed because pause/resume hangs in async contexts (Slack). The widget primitive's **decoupled** design is what makes it survivable; the confirmation widget (§7 follow-up PR) closes the gap that disallowing left. |
| Env-var storage (`users.data.env_vars` JSON map, AES-256-GCM via `encryptApiKey`, scope enum, blocklist, `^[A-Z_][A-Z0-9_]*$` regex)                                  | existing               | **Reuse the existing users service.** The env-var widget submit handler is a thin shim that PATCHes `/users/:id` with a single-key `env_vars` patch. Validation, encryption, scope handling, blocklist enforcement all already live there.                                                                                                              |
| MCP tool registry (`apps/agor-daemon/src/mcp/tools/*.ts`, `registerTool(name, {description, inputSchema, annotations}, handler)`, `ctx.sessionId`, `textResult(...)`) | existing               | **Slot a new `widgets.ts` file alongside other domains.** Standard pattern.                                                                                                                                                                                                                                                                             |

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
      names: z
        .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
        .min(1)
        .max(10)
        .describe('UPPER_SNAKE env var names. Same validation as User Settings.'),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe('Short explanation shown to the user — why do you need these?'),
      instructions: z
        .string()
        .max(2000)
        .optional()
        .describe('Optional markdown — e.g. "Get a key at https://app.hubspot.com/..."'),
      default_scope: z
        .enum(['global', 'session'])
        .default('global')
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

### 3.3 Daemon flow (decoupled fire-and-forget)

```
┌──────────┐         ┌─────────────┐         ┌────────┐         ┌────────┐
│  Agent   │         │ Daemon (MCP │         │   UI   │         │  User  │
│ (Claude) │         │   server)   │         │ client │         │        │
└────┬─────┘         └──────┬──────┘         └────┬───┘         └────┬───┘
     │ MCP call            │                      │                  │
     │ agor_widgets_       │                      │                  │
     │  request_env_vars   │                      │                  │
     │ ──────────────────► │                      │                  │
     │                     │ appendSystemMessage  │                  │
     │                     │  type='widget_       │                  │
     │                     │   request'           │                  │
     │                     │  metadata.widget=    │                  │
     │                     │   {…,status:         │                  │
     │                     │   'pending'}         │                  │
     │                     │                      │                  │
     │                     │ 'messages created'   │                  │
     │                     │  WS event ─────────► │ render           │
     │                     │                      │  WidgetBlock ──► │
     │                     │                      │                  │
     │ tool returns        │                      │                  │
     │ IMMEDIATELY:        │                      │                  │
     │  { widget_id,       │                      │                  │
     │    status:          │                      │                  │
     │   'requested' }     │                      │                  │
     │ ◄────────────────── │                      │                  │
     │                     │                      │                  │
     │ ends turn —         │                      │                  │
     │ session goes IDLE   │                      │                  │
     │                     │                      │                  │
     │                     │   ⏱  (seconds, minutes, or hours later) │
     │                     │                      │                  │
     │                     │                      │ types value      │
     │                     │                      │ ◄─────────────── │
     │                     │ POST /widgets/:id/   │                  │
     │                     │  submit              │                  │
     │                     │  {values, scope}     │                  │
     │                     │ ◄─────────────────── │                  │
     │                     │                      │                  │
     │                     │ users.patch          │                  │
     │                     │  (encrypt, store)    │                  │
     │                     │                      │                  │
     │                     │ messages.patch       │                  │
     │                     │  widget.status=      │                  │
     │                     │   'submitted'        │                  │
     │                     │                      │                  │
     │                     │ tasks.create         │                  │
     │                     │  (system-authored,   │                  │
     │                     │   buildAutoResume    │                  │
     │                     │   Prompt(            │                  │
     │                     │    result_meta))     │                  │
     │                     │                      │                  │
     │                     │ 'widget:resolved' ─► │ re-render badge  │
     │                     │                      │                  │
     │ NEW TASK arrives    │                      │                  │
     │ as user-role        │                      │                  │
     │ message:            │                      │                  │
     │ "[Agor] User        │                      │                  │
     │  submitted          │                      │                  │
     │  HUBSPOT_API_KEY    │                      │                  │
     │  (scope: global).   │                      │                  │
     │  Retry the          │                      │                  │
     │  operation that     │                      │                  │
     │  needed it."        │                      │                  │
     │ ◄────────────────── │                      │                  │
     │                     │                      │                  │
     │ resumes —           │                      │                  │
     │ retries original    │                      │                  │
     │ API call            │                      │                  │
```

Key properties:

- **The MCP tool is fire-and-forget.** It inserts the widget message and returns within milliseconds. The agent reads the tool description and ends its turn voluntarily. No HTTP timeout, no executor pause, no daemon-side await.
- **The widget message is the durable resolution surface.** It survives daemon restarts, executor exits, hours-long user gaps, page reloads. State lives entirely in `metadata.widget` on the row.
- **Resolution arrives via the existing prompt queue.** When the user submits, the daemon writes the env var AND creates a system-authored task (`role: 'user'`, `created_by: 'system'`) using the same code path as a human-typed prompt (#1068's daemon-owned user-message infrastructure). Idle sessions kick off immediately; busy sessions queue it.
- **The prompt is auto-built by the widget registry.** Each widget type contributes a `buildAutoResumePrompt(result_meta)` function (and a `buildDismissedPrompt(...)` for the dismissal path). The agent sees an ordinary user-role message; from its perspective there's no widget machinery to reason about.
- **Async-context-friendly.** Slack/gateway sessions work unchanged — the user might respond hours later from their phone; the task just queues.

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
  /** What goes back into result_meta on the message + into the auto-resume prompt. NEVER includes secret values. */
  buildResultMeta: (submit: TSubmit) => TResultMeta;
  /** Side-effect: persist the submitted values to wherever they belong */
  applySubmit: (ctx: SubmitCtx, submit: TSubmit) => Promise<void>;
  /** The user-role prompt auto-queued into the agent's next turn on submit. Plain text, no values. */
  buildAutoResumePrompt: (result_meta: TResultMeta, params: TParams) => string;
  /** The user-role prompt auto-queued on dismissal. Always explicit ("don't immediately re-ask") to avoid loops. */
  buildDismissedPrompt: (params: TParams) => string;
}

// frontend mirror
export const widgetComponents: Record<WidgetType, React.FC<WidgetProps>> = {
  env_vars: EnvVarRequestWidget,
};
```

A new widget type is three files: a Zod-typed registry entry on the daemon (with the two prompt-builders), a React component on the UI, a registration line on each side. No core changes needed.

**Example prompt builders for `env_vars`:**

```ts
buildAutoResumePrompt: (rm) =>
  `[Agor] User submitted ${rm.names_submitted.join(', ')} (scope: ${rm.scope}). ` +
  `You can now retry the operation that needed ${rm.names_submitted.length === 1 ? 'it' : 'them'}.`,

buildDismissedPrompt: (params) =>
  `[Agor] User dismissed the request for ${params.names.join(', ')}. ` +
  `Do not re-request immediately — ask whether to proceed without, or move on to other work.`,
```

### 3.5 Task-queue integration (the resolution path)

When `POST /widgets/:widget_id/submit` succeeds, the submit handler does four things in one transaction:

1. **Persist values** — call `registry[widget_type].applySubmit(ctx, submit)`. For env-vars, this is `users.patch(userId, { env_vars: { [name]: { value, scope } } })`. Encryption + validation happen inside the existing users service.
2. **Patch the widget message** — `messages.patch(widget_id, { metadata: { ..., widget: { status: 'submitted', result_meta, resolved_at } } })`. The transcript renderer flips to the "submitted" badge.
3. **Queue the auto-resume task** (if `auto_resume !== false` was passed to the original tool call) — create a new task via the existing task-creation path with:
   - `role: 'user'`
   - `created_by_user_id: <submitter>` (audit) but `metadata.system_authored: true` and `metadata.widget_id` for traceability
   - `content: registry[widget_type].buildAutoResumePrompt(result_meta, params)`
   - The "Never lose a prompt" infrastructure handles queueing-vs-immediate-dispatch based on session busy state.
4. **Emit `widget:resolved`** — broadcast on the per-session Feathers room so any other connected UI clients refresh.

Dismissal (`POST /widgets/:widget_id/dismiss`) follows the same path but skips step 1 and uses `buildDismissedPrompt` in step 3.

**No daemon-side await. No long-running HTTP. No timeout on the widget itself.** The widget is durable in the messages table; it can sit `pending` for an hour or a day. The user, the session, or the worktree can move on freely.

### 3.6 What happens if the agent doesn't end its turn?

The MCP tool's `description` explicitly instructs: _"This is a fire-and-forget request. The widget is now visible to the user. End your turn after this tool call — you will receive a new user-role message when the user responds, and can resume work then."_ If the agent ignores this and keeps reasoning, it just continues without the value (and will likely fail and retry on a later turn). The next-turn message arrives normally when the user submits — the queueing infrastructure doesn't care whether the session was idle or in the middle of something.

We do **not** rely on tool description alone for correctness; ignoring the contract is annoying but not harmful, and the agent's standard "tool said it succeeded → I'll see results later" reasoning typically works without the explicit instruction.

---

## 4. The env-var widget (concrete v1)

| Piece                  | Path                                                                                                                                                                                     | Reuses                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| MCP tool               | `apps/agor-daemon/src/mcp/tools/widgets.ts` (new)                                                                                                                                        | `registerTool` pattern from `worktrees.ts`                     |
| MCP tool return        | `{ widget_id, status: 'requested' }` — fires immediately, agent ends turn                                                                                                                | `textResult()`                                                 |
| Daemon submit endpoint | `POST /widgets/:widget_id/submit`, `POST /widgets/:widget_id/dismiss` (new routes)                                                                                                       | FeathersJS service `widget-submissions`                        |
| Persistence            | Thin shim → `app.service('users').patch(userId, { env_vars: { [name]: { value, scope } } })`                                                                                             | existing users service, `encryptApiKey`, blocklist, regex      |
| Message update         | `app.service('messages').patch(widget_id, { metadata.widget: { status, result_meta, resolved_at } })`                                                                                    | existing messages service                                      |
| **Auto-resume task**   | `app.service('tasks').create({ session_id, role: 'user', content: buildAutoResumePrompt(rm), metadata: { system_authored: true, widget_id } })` — picks up via the existing prompt queue | "Never lose a prompt" #1068                                    |
| Event broadcast        | `widget:resolved` Feathers event on the session room                                                                                                                                     | existing per-session room                                      |
| UI dispatch            | `MessageBlock.tsx`: `if (message.type === 'widget_request') return <WidgetBlock message={message} />`                                                                                    | `PermissionRequestBlock` precedent at MessageBlock.tsx:256-294 |
| Widget component       | `apps/agor-ui/src/components/Widgets/EnvVarRequestWidget.tsx`                                                                                                                            | form shape from `EnvVarEditor.tsx`                             |

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

| Path                                                                    | Carries values?                             | Justification                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent → MCP tool call (`agor_widgets_request_env_vars`)                 | **No**                                      | Input schema accepts `names` (strings) + `reason`. No `values` field exists. Zod rejects extras.                                                                                                                                                                                             |
| Daemon → `appendSystemMessage` → message row                            | **No**                                      | `metadata.widget.params` is the agent-provided payload (names, reason, instructions); `content` is human-readable preview. Both are filled from the agent's tool args — agent had no values.                                                                                                 |
| Feathers `messages created` WebSocket event                             | **No**                                      | Payload is the message row above.                                                                                                                                                                                                                                                            |
| MCP tool return value → agent (synchronous)                             | **No**                                      | Returns `{ widget_id, status: 'requested' }`. Fires immediately, before the user has even seen the widget. Cannot contain values by definition.                                                                                                                                              |
| UI → `POST /widgets/:id/submit`                                         | **Yes**                                     | Direct browser-to-daemon HTTP request. Auth via the user's session cookie / JWT. **This is the only place values exist on the wire**, and it never traverses the agent.                                                                                                                      |
| Daemon submit handler → `users.patch`                                   | **Yes (encrypted in transit at app layer)** | Standard env-var write path. `encryptApiKey()` is called inside the users service before DB write.                                                                                                                                                                                           |
| Daemon → message status update (`messages.patch`)                       | **No**                                      | Updates `metadata.widget.status` and `result_meta` (e.g. `{ names_submitted, scope }`). Explicit allow-list — we patch by field, never spread the submit body.                                                                                                                               |
| **Daemon → auto-resume task creation** (the prompt the agent next sees) | **No**                                      | `tasks.create` content is `buildAutoResumePrompt(result_meta)`. The registry's prompt-builders take `result_meta` only — they have no access to the submit body. Add unit test: prompt-builder must accept `result_meta` only, not the raw submit payload (type system + runtime assertion). |
| `widget:resolved` Feathers event                                        | **No**                                      | Payload is `{ widget_id, status, result_meta }`.                                                                                                                                                                                                                                             |
| Transcript reload                                                       | **No**                                      | Re-reads the message row; values were never stored on it. The auto-resume task is a normal task row containing only `result_meta`-derived text.                                                                                                                                              |
| Logs                                                                    | **No (must enforce)**                       | Submit handler MUST NOT log the request body. Add an explicit test: `expect(logs).not.toContain(submittedValue)`.                                                                                                                                                                            |

The only access path to values after submission is the standard env-var read path (decrypt at runtime when launching an executor). That path is unchanged from today.

### 5.2 Authz / CSRF

`POST /widgets/:widget_id/submit` is authenticated via existing FeathersJS session auth. The handler MUST verify:

1. The caller's `user_id` matches `widget_message.session.created_by` **OR** the caller has `prompt`-tier RBAC on the worktree (`others_can >= prompt`). This mirrors who can already prompt the session.
2. The widget is still `pending` (idempotency — double-submit is a no-op, not a re-write).
3. The widget's `requested_at` is within the configured TTL.

CSRF: same protections as every other authenticated daemon endpoint (existing CORS + same-origin policy + JWT).

### 5.3 RBAC and multi-user

If a _different_ user submits the widget (in a `prompt`-tier multi-user setup): the env var is written to **the executor's identity's** env_vars (= session creator's), because that's whose env the agent will read at retry. **The submitting user is recorded in `result_meta.submitted_by`** for audit. Surfaced to the agent ("submitted by <user>") so the agent can adjust messaging.

This is consistent with `dangerously_allow_session_sharing: false` semantics (default-safe). When session sharing is enabled and a collaborator submits a value, the value lands in the original owner's env — that's an explicit security trade-off documented under that flag.

### 5.4 Transcript persistence implications

The widget message persists forever in the transcript with `{ names, status, result_meta }` — **names of submitted env vars are visible** to anyone who can read the transcript. This is the same surface as User Settings → Env Vars (names visible, values hidden), so no new exposure. Worth a one-line callout in the UI ("Variable names are logged in the transcript; values are not.").

### 5.5 Threat model

| Threat                                                                                                      | Mitigation                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious agent crafts the `reason`/`instructions` to phish the user                                        | Inputs rendered as **markdown with a strict allow-list** (no `<script>`, no inline event handlers, no auto-load images). Reuse the same sanitizer the artifact consent modal uses.                                                                                                                 |
| Agent uses a widget to extract a value indirectly (e.g. asks for "type your value, then say it back to me") | The widget message _names_ what's requested; an agent prompting the user to type a value in-chat _instead of_ using the widget is a UX failure but not new attack surface — same as today. Mitigation is the disclaimer copy on the widget itself: "Type values here, never paste them into chat." |
| Submission endpoint accepts unsolicited writes (no preceding widget request)                                | Endpoint requires a valid `widget_id` matching a `pending` widget message bound to the caller's session. No widget-less submissions.                                                                                                                                                               |
| Replay attack with a captured submit payload                                                                | Once submitted, status → `submitted`; resubmission rejected on status check.                                                                                                                                                                                                                       |
| Stored XSS via env-var name                                                                                 | Existing `^[A-Z_][A-Z0-9_]*$` regex precludes anything renderable as HTML.                                                                                                                                                                                                                         |

---

## 6. Extensibility — validating against 3 future widgets

If the abstraction is wrong, adding the second widget reveals it. Sketches:

### 6.1 `agor_widgets_request_confirmation` — replaces the disallowed AskUserQuestion

```ts
inputSchema: z.object({
  title: z.string().max(120),
  body: z.string().max(2000),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        style: z.enum(['default', 'primary', 'danger']).default('default'),
      })
    )
    .min(2)
    .max(5),
  default_option_id: z.string().optional(),
});
// submit body: { option_id: string }
// result_meta: { option_id, option_label }  // label is fine — it's agent-provided
// auto-resume prompt: "[Agor] User chose: ${option_label}."
```

**Fit check:**

- Renders inline in transcript. ✓
- Submit has no secret material. ✓
- Generalizes: A/B/C prompts, "delete this?", "which environment?".
- Replaces the gap left by disallowing AskUserQuestion. **This becomes the follow-up PR** (§7).

### 6.2 `agor_widgets_request_oauth` — connect a third-party account

```ts
inputSchema: z.object({
  provider: z.enum(['github', 'slack', 'linear', 'hubspot', ...]),
  scopes: z.array(z.string()).min(1),
  reason: z.string().max(500),
})
// submit body: empty — resolution happens via OAuth callback, not user form
// applySubmit: writes to existing OAuth tokens table
// result_meta: { provider, granted_scopes: string[], account_label: string }
// auto-resume prompt: "[Agor] User connected ${provider} (${account_label}). You can now retry."
```

**Fit check:**

- Widget renders a "Connect GitHub" button. Click → popup → OAuth callback hits a _separate_ daemon endpoint (`/oauth/:provider/callback`) which then resolves the widget the same way `POST /widgets/:id/submit` would (write result_meta, queue auto-resume task, emit `widget:resolved`).
- Token never goes anywhere near the agent. ✓
- **The decoupled flow makes this trivial.** OAuth flows are inherently async (popup → user-action → callback); the widget primitive doesn't care which daemon endpoint resolves the widget, only that _something_ does. The pause/resume model would have had to invent a special async lane for this; we don't.

**Registry generalization:** `applySubmit` is one of several resolution paths. The OAuth widget type's registry entry exposes a `resolveFromOAuthCallback` function instead, called from `/oauth/:provider/callback`. The post-resolution machinery (patch message, queue auto-resume, emit event) is identical and lives in a shared helper.

### 6.3 `agor_widgets_request_mcp_server` — select / attach an MCP server

```ts
inputSchema: z.object({
  purpose: z
    .string()
    .max(300)
    .describe('Why you need an MCP server — e.g. "browse Linear tickets"'),
  suggested_server_kinds: z.array(z.string()).optional(),
});
// submit body: { mcp_server_id: string } | { kind: 'add_new', config: {...} }
// applySubmit: noop if existing, else creates an mcp_servers row scoped to the session
// result_meta: { mcp_server_id, name, kind }
// auto-resume prompt: "[Agor] User selected MCP server '${name}'. You can now use it."
```

**Fit check:**

- Renders a picker with installed servers + an "Add new" affordance.
- Adding a new server may itself trigger an OAuth widget — **widgets can chain** by having one widget's resolution kick off the next. Worth noting; not blocking v1.
- No secret material in the submit body (server config holds credentials, but those are written via the existing mcp-servers service which handles encryption).

**Verdict:** the registry shape holds. The one refinement is generalizing "submit" → "resolve," accommodating OAuth-style callbacks. We bake that in from v1 by phrasing the abstraction as "the widget resolves" rather than "the widget is submitted via a single endpoint."

---

## 7. Delivery

The feature ships as **a single PR** (the one this doc is in: #1224). The framework alone has no user-facing capability — it needs at least one concrete widget type to be exercised end-to-end and to be worth merging. Internally the PR has two parts; the confirmation widget is a separate follow-up PR.

### Part 1 — The primitive (`feat(widgets): in-conversation widget primitive`)

Scope:

- Add `'widget_request'` to `MessageType` (sqlite + postgres schemas + types, migrations).
- Extend `appendSystemMessage` helper's `type` union to include `widget_request`.
- Add `metadata.widget` shape to `Message['metadata']` type (typed via a discriminated union over `widget_type`, with `schema_version: number` baked in).
- Daemon-side registry shape at `apps/agor-daemon/src/widgets/registry.ts` (empty in Part 1; widget types register themselves in their own PRs). The registry entry type includes `paramsSchema`, `submitSchema`, `applySubmit`, `buildResultMeta`, `buildAutoResumePrompt`, `buildDismissedPrompt`.
- New FeathersJS service `widget-submissions` registering `POST /widgets/:widget_id/submit` and `POST /widgets/:widget_id/dismiss`. Auth: caller must match session creator OR have `prompt`-tier worktree RBAC. Idempotency: status must be `pending`.
- Submit handler dispatches by `widget_type` to the registry (no-op for empty registry), then: patches the message row, creates an auto-resume task via the existing task-creation path (`tasks.create` with `role: 'user'`, `metadata.system_authored: true`, `metadata.widget_id`), emits `widget:resolved`.
- `widget:resolved` Feathers event on the per-session room.
- New MCP tool domain marker (`domain: 'widgets'` for `agor_search_tools` filtering).
- UI: `WidgetBlock` dispatcher component in `apps/agor-ui/src/components/MessageBlock/` that switches on `metadata.widget.widget_type`, plus a placeholder "Unknown widget type" fallback for forward-compat with newer widgets in older clients.

**Explicitly NOT in Part 1** (no longer needed under the decoupled model):

- ~~Daemon-restart marking pending widgets as `timed_out`~~ — widgets are durable in the messages table; daemon restart is transparent. Nothing to do.
- ~~`widgets.default_timeout_ms` config option~~ — the decoupled model has no timeout. A widget sits `pending` until submitted or dismissed (or the session is archived, at which point the widget tombstones along with the rest).
- ~~Long-poll / event-bus await on the MCP tool side~~ — the tool returns immediately; nothing to await.

Part 1 alone is callable but produces no actual widgets — it's not shippable on its own; Part 2 (below) lands in the same PR.

**Status:** ✅ landed on PR #1224 in commits `0b9ef5b2`, `71b70367`, `a3f3b7b2`. 17 unit tests pass.

### Part 2 — The env_vars widget (`feat(widgets): env_vars widget`)

Scope:

- Register `env_vars` widget type in the daemon registry: Zod schemas, `applySubmit` = thin shim around `users.patch`, `buildAutoResumePrompt` and `buildDismissedPrompt` per §3.4.
- Register `agor_widgets_request_env_vars` MCP tool in `apps/agor-daemon/src/mcp/tools/widgets.ts`. Tool params include `auto_resume: boolean` (default `true`).
- React component `EnvVarRequestWidget.tsx` (reuses form shape from `EnvVarEditor.tsx`).
- Wire `widgetComponents['env_vars']` mapping on the UI.
- Submit handler reuses existing env-var validation (`validateEnvVar`, `isEnvVarAllowed`, regex) and encryption (`encryptApiKey`) — zero net-new logic.
- **`already_present` short-circuit** (per D4, resolved yes): submit handler checks at request time whether the user already has all `names` in scope. If yes, immediately patches `metadata.widget.status = 'already_present'`, skips the form render, and queues the auto-resume task with a "values were already configured" prompt.
- Docs: `apps/agor-docs/pages/guide/in-conversation-widgets.mdx` (user-facing) with the env-var section as the canonical example.
- RTL/component coverage or live-dev QA cases for the widget in pending, submitted, dismissed, and already-present states.

### Follow-up PR (separate, validates extensibility): `feat(widgets): confirmation widget`

Scope:

- Register `confirmation` widget type (Zod schemas per §6.1).
- React component with N option buttons; danger style for `style: 'danger'`.
- MCP tool `agor_widgets_request_confirmation`.
- **Critically:** updates `CLAUDE.md` / Claude's system prompt with guidance: "Use `agor_widgets_request_confirmation` for binary/multi-choice decisions instead of asking inline." This closes the gap left by disallowing `AskUserQuestion`.

**Estimated effort:** ~1.5 eng-days. Mostly UX polish.

### Sequencing

Parts 1 and 2 ship together on PR #1224 (this PR — they're sequenced commits, not separate PRs). The confirmation widget is a separate follow-up PR that consumes the framework; it doesn't depend on `env_vars` and could be reordered if needed.

---

## 8. Risks and open questions

| #   | Risk / question                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Widget message persists forever in the transcript.** The _names_ of submitted env vars are visible to anyone who can read the transcript.                        | Same surface as User Settings → Env Vars. One-line disclaimer on the widget. If sensitive, the user can dismiss and add via Settings.                                                                                                                                                                                                                                                                                                         |
| R2  | **Widget-version drift** when v2 changes a widget's submit schema.                                                                                                 | `metadata.widget.schema_version: number` baked in from v1. UI's `WidgetBlock` renders old versions in a degraded read-only mode for forward-compat.                                                                                                                                                                                                                                                                                           |
| R3  | **Dismissal UX.** Does the agent treat dismissal as "user said no, stop" or "user said not-now, try again later"?                                                  | Auto-queued dismissal prompt is explicit: _"Do not re-request immediately — ask whether to proceed without, or move on to other work."_ See `buildDismissedPrompt` example in §3.4.                                                                                                                                                                                                                                                           |
| R4  | **Multi-user authz for submission.** Who can submit on behalf of whom?                                                                                             | §5.2 — submitter must match session creator or have `prompt`-tier worktree RBAC. Cross-user submit attributed in `result_meta.submitted_by`.                                                                                                                                                                                                                                                                                                  |
| R5  | **Logging leakage.** Submit handler must not log values.                                                                                                           | Explicit test in the env_vars Part (`expect(logs).not.toContain(value)`). Submit handler accepts the body and immediately hands it to the registry's `applySubmit`; no intermediate variable that gets stringified.                                                                                                                                                                                                                           |
| R6  | **Agent uses chat (not the widget) to extract values** by phishing the user.                                                                                       | Widget copy: "Never paste values into chat — only into the form above." Out of scope for code mitigations.                                                                                                                                                                                                                                                                                                                                    |
| R7  | **Stale widget message** — user submits 4 hours later in a session that's already moved on. Auto-queued task arrives mid-context-switch.                           | Acceptable. Same surface as "queued prompt arrives in a session you forgot about" — already a thing the user lives with. Mitigated by the prompt being self-explanatory (`[Agor] User submitted X. Retry the operation that needed it.`). Worth a small "Discard pending widgets on session archive" hook — when a session is archived, all its `pending` widgets transition to `dismissed` (no auto-resume task, since the session is gone). |
| R8  | **Agent ignores the "end your turn" contract** and keeps reasoning after firing the tool.                                                                          | Harmless — the auto-queued task arrives whenever the user submits. The agent's intermediate reasoning just turns out to have been speculative. Tool description nudges, doesn't enforce.                                                                                                                                                                                                                                                      |
| R9  | **Auto-resume task fires on a session whose user is offline.** No one notices the queued prompt.                                                                   | Standard task-queue semantics (#1068) — the prompt is durable, will fire when the executor next picks up. If the session is permanently abandoned, the task tombstones with the rest of the session.                                                                                                                                                                                                                                          |
| Q1  | **One generic `agor_widgets_request` tool vs. one tool per type?**                                                                                                 | Recommended: one per type (§3.2). Typed contracts, better progressive discovery, better agent UX.                                                                                                                                                                                                                                                                                                                                             |
| Q2  | **`already_present` short-circuit?** E.g. agent asks for `HUBSPOT_API_KEY`, user already has it set globally → widget auto-resolves with status `already_present`. | **Resolved yes** for env-vars specifically (saves a user click). Daemon checks presence at request time and short-circuits to `status: 'already_present'` + an auto-resume task ("`HUBSPOT_API_KEY` was already configured. You can proceed.") without rendering a form. Lives in Part 2 scope.                                                                                                                                               |

---

## 9. Coordination with adjacent work

| Worktree / PR                                                                 | Relationship                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix-issue-1177-ask-user-question-hang` (merged as #1181)                     | **Disallowed AskUserQuestion.** The follow-up confirmation-widget PR is the long-term replacement — it gives agents a structured way to ask the user inline that doesn't depend on the dead SDK feature. No code conflict; conceptual handoff. |
| `design-notification-system` (PR #1135, open)                                 | **Widgets are in-transcript, notifications are out-of-transcript.** No overlap. Worth a one-line cross-reference in both docs.                                                                                                                 |
| `feat(artifacts)!: declarative format + TOFU consent flow` (PR #1147, merged) | **Shares UX language**, not architecture. Reuse the scope-selector copy and the markdown sanitizer; do not reuse `artifact_trust_grants` table.                                                                                                |
| `system-message-on-daemon-restart` (PR #1166, merged)                         | **Direct reuse** of `appendSystemMessage` + the daemon-restart-marks-orphans pattern.                                                                                                                                                          |
| `design-internal-llm-service` (in flight)                                     | Adjacent (both are "app-invoked" patterns) but no direct integration.                                                                                                                                                                          |
| `improve-onboarding-openclaw-integration` / onboarding flows                  | **Primary consumer of v1.** Onboarding zone-triggers can now ask for env vars inline instead of redirecting to Settings.                                                                                                                       |

---

## 10. Open call (for Max)

Decisions Max has signed off on (commit history of this doc):

- **D1:** Message-row-as-state vs. separate `pending_widgets` table. **Resolved: row.** Add a table only when we need cross-session queries.
- **D2:** One MCP tool per widget type vs. one generic tool. **Resolved: per type.**
- **D3:** ~~Default timeout~~. **Resolved: no timeout.** Decoupled flow makes timeouts unnecessary. A widget sits `pending` until submitted, dismissed, or its session is archived.
- **D4:** `already_present` short-circuit for env-vars. **Resolved: yes** — saves a user click; ships as part of the env_vars widget Part.
- **D5:** **Resolved: decoupled fire-and-forget flow** (no executor pause, no daemon-side await). MCP tool returns immediately; user submission auto-queues a system-authored task via "Never lose a prompt" (#1068).
- **D6:** Default `auto_resume: true` on submit. Per-call opt-out via tool param. Dismissal also auto-queues with explicit "don't immediately re-ask" framing. **Resolved: yes.**

- **D7:** ~~Should the confirmation widget ship in the same PR?~~ **Resolved: no.** This PR (#1224) is framework + env_vars only. Confirmation widget is a separate follow-up PR — keeps this one focused on the motivating use case and lets the AskUserQuestion-replacement work proceed on its own timeline.

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
- `packages/executor/src/permissions/permission-service.ts:94-149` — pause/resume reference _(NOT followed)_ — kept as a cite for the alternative we rejected
- `packages/executor/src/sdk-handlers/claude/constants.ts:33` — AskUserQuestion disallowed
- `apps/agor-ui/src/components/ArtifactConsentModal/ArtifactConsentModal.tsx` — scope-selector UX to mine
