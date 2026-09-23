# Agent-initiated MCP OAuth — "connect me to Notion"

Status, as of this branch:

| Section               | State                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3 — the widget lane  | **Implemented.**                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| §6 — canvas polish    | **Not built**, except item 3 (expiry), which is now an explicit accepted gap — see **D7**.                                                                                                                                                                                                                                                                                                                                                                  |
| §7 — Slack projection | **Implemented**, behind an operator kill switch (§7.1.4). Token, redemption authority, landing page, and the Block Kit post/update projection are all in. Verified in §7.1 and again in §7.1.2; three defects found by the gating review and fixed (§7.1.1), one more found by the pre-merge drive (§7.1.3). The two lanes' delivery machinery is one engine as of §7.1.10. The live hosted failure — a bare `getBaseUrl()` at two call sites — is §7.1.14. |

Numbering warning for anyone reading commit messages against this file: the
branch's `stage2` commits built §7's token + landing page, not §6; `stage3`
built the Block Kit projection. §6 has never been started.

Companion: `docs/internal/in-conversation-widgets-design-2026-05-19.md` (§6.2 anticipated this widget).

---

## 1. The problem

A user — in Slack, or on the canvas — says "connect me to Notion". The agent can
list MCP servers, create them, and attach them. It cannot start an OAuth
authorization-code flow, and until this change there was no way for it to ask
anyone else to either.

What it got instead was a dead end. `agor_mcp_servers_auth_status` answered an
unauthenticated OAuth server with:

> Sign in to this MCP server from an available authentication surface, then retry the task.

There was no such surface reachable from a conversation. An agent relaying that
sentence into a Slack thread left the user with a sentence and nothing to click.
`createOrUpdateNextSteps` said the same thing after a create.

A reactive lane does exist: `MCPSlackRecoveryNotice` (`services/gateway.ts:1701+`,
`register-services.ts:4770+`) posts a Slack Block Kit recovery action when a
**mediated MCP call is rejected with `needs_reauth`**. It is bound to a live task
and fires only after a failure. This feature is its intent-initiated
counterpart: the user asked, so nothing has failed yet and there is nothing to
recover.

---

## 2. Shape of the solution

An `oauth` widget type whose resolution path is the existing browser OAuth flow.

```
 agent                     daemon                          browser              provider
   │                          │                               │                    │
   │ agor_mcp_catalog_list    │                               │                    │
   ├─────────────────────────►│  "Notion" → com.notion/mcp    │                    │
   │                          │                               │                    │
   │ agor_widgets_request_oauth                               │                    │
   ├─────────────────────────►│                               │                    │
   │                          │ ensure server row (inert)     │                    │
   │                          │ mint widget_request message   │                    │
   │◄─────────────────────────┤ { widget_id, status }         │                    │
   │   (turn ends)            │                               │                    │
   │                          │      widget renders ─────────►│                    │
   │                          │                               │ user clicks Connect│
   │                          │◄─ oauth-start ────────────────┤                    │
   │                          │                               ├── authorize ──────►│
   │                          │◄─────────── callback ─────────┼────────────────────┤
   │                          │   grant persisted             │                    │
   │                          │◄─ oauth-resolve ──────────────┤ (poll settled)     │
   │                          │   re-read grant ✓             │                    │
   │                          │   ATTACH to session           │                    │
   │                          │   queue auto-resume prompt    │                    │
   │◄─────────────────────────┤                               │                    │
   │ next turn: tools present │                               │                    │
```

Three properties carry the design:

- **Nothing is granted until a browser-bound human action.** There is no
  headless OAuth start (`register-services.ts` requires an authenticated live
  socket reservation), and this feature deliberately does not invent one.
- **The daemon, not the client, decides whether the flow succeeded.** The
  browser's POST is a notification; the daemon re-reads the persisted grant.
- **Attach happens after the grant lands**, never at mint. §5.1.

---

## 3. What the widget lane shipped

| Piece                                                         | Where                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| Registry generalization: resolution kinds                     | `apps/agor-daemon/src/widgets/registry.ts`                   |
| Shared resolver gains an OAuth lane                           | `apps/agor-daemon/src/widgets/submissions.ts`                |
| `oauth` widget type                                           | `apps/agor-daemon/src/widgets/oauth/index.ts`                |
| `POST /widgets/:id/oauth-resolve`                             | `apps/agor-daemon/src/register-routes.ts`                    |
| Shared grant-liveness read                                    | `apps/agor-daemon/src/services/mcp-oauth-grant-liveness.ts`  |
| Gateway-identity fail-closed guard                            | `apps/agor-daemon/src/utils/gateway-prompt-identity.ts`      |
| `agor_widgets_request_oauth`                                  | `apps/agor-daemon/src/mcp/tools/widgets.ts`                  |
| `agor_mcp_catalog_list`                                       | `apps/agor-daemon/src/mcp/tools/mcp-servers.ts`              |
| Transcript widget UI                                          | `apps/agor-ui/src/components/Widgets/OAuthConnectWidget.tsx` |
| Copy: `auth_status` + `createOrUpdateNextSteps` name the tool | `apps/agor-daemon/src/mcp/tools/mcp-servers.ts`              |

### 3.1 Registry: "resolve" is not "submit"

`WidgetRegistryEntry` became a union over a `resolution` discriminant:

```ts
type WidgetRegistryEntry<TParams, TSubmit, TResultMeta> =
  | SubmitWidgetRegistryEntry<TParams, TSubmit, TResultMeta> // resolution?: 'submit'
  | DaemonVerifiedWidgetRegistryEntry<TParams, TResultMeta>; // resolution: 'daemon_verified'
```

The discriminant is kind-neutral on purpose. Nothing about the machinery is
OAuth-specific — a GitHub App install or a device-code flow is the same shape —
so the next bodiless, daemon-verified widget should not have to register itself
as an OAuth callback to get it. The resolution ACTION is still `'oauth_callback'`:
that names the endpoint the request arrived at and is persisted in
`resolution_claim.action`.

The discriminant is optional on the submit variant, so `env_vars` and
`gateway_token` registered unchanged.

The daemon-verified variant carries `resolveFromDaemonVerification(ctx, evidence, params)` and
**no** `submitSchema` or `applySubmit`. There is no schema for a submit body,
because no submit body is accepted.

Follow-up **F3** corrected what that union discriminated on. As shipped it
encoded two things at once — body-or-no-body, and where `result_meta` came
from — and only the second was actually constrained: a bodiless handler
returned its own meta, a body-taking one could not. `gateway_token`, whose
outcome is decided by a credential probe inside `applySubmit` rather than by
the body, therefore carried that outcome to `buildResultMeta` through a
module-level `WeakMap` keyed on submit-object identity, and the next
form-backed, externally-verified widget would have needed a second one.

`applySubmit` may now **return** `TResultMeta`, with `buildResultMeta` as the
fallback (and optional). The union then discriminates on the one axis that
carries weight — whether the entry accepts a body — which is what decides
payload validation and the endpoint cross-check, and nothing else. The
`WeakMap` is gone; `env_vars` keeps its builder, which is the case a
body-projection builder was always right for. The bodiless variant's handler
still MUST return the meta, because there is no body for a fallback to project.

`submissions.ts` keeps one `doResolveWidget`. Steps 1–3 (load, authorize,
idempotency) and 5–8 (durable claim, auto-resume admission, terminal patch,
`widget:resolved` broadcast) are byte-identical for all three actions. Only the
step-4 dispatch differs. A widget reached through the wrong endpoint is refused,
both directions — since F3 the question is literally "does this entry accept a
body" (`widgetAcceptsSubmitBody`), asked against whether this endpoint brought
one:

- body-taking via `/oauth-resolve` → would skip payload validation entirely.
- bodiless via `/submit` → would resolve on a client's say-so.

`WidgetResolutionClaim.action` widened to `'submit' | 'dismiss' | 'oauth_callback'`
so a recovery reader can tell which lane owned an abandoned claim. Since the
architecture pass that reader is the resolver itself — see **D8**, which is the
one place this lane's resolution semantics differ from the submit-backed ones.

### 3.2 The resolution handler

Before it runs at all, `submissions.ts` calls the entry's `authorizeResolve`,
which re-asks both mint-time questions — the role floor and gateway identity —
ahead of the durable claim. A pending card has no expiry, so "true when minted"
is not evidence of "true now": an admin can switch `align_slack_users` off, or
demote the resolver, while the card sits there. See §5.2 and §5.3.

`resolveFromDaemonVerification` then performs, in order:

1. **Role floor.** Shared-mode grants are workspace-wide credentials, so
   `ROLES.ADMIN` — the same floor `oauth-start` applies. Per-user needs only the
   `ROLES.MEMBER` floor the route already enforces. An undefined role normalizes
   to member and therefore fails closed. (Repeated here as well as in
   `authorizeResolve` so the handler is safe to call directly.)
2. **Pinned-destination revalidation.** The server named in `params.mcpServerId`
   must still be loadable, usable by the caller, enabled, `auth.type === 'oauth'`,
   and in the same `oauth_mode` the widget was minted for.
3. **The grant check.** `resolveMCPOAuthGrantLiveness(db, serverId, submitterUserId)`.
   No live grant → throw. The durable store releases the claim, the widget goes
   back to `pending` with a secret-free `resolution_failure`, and the user can
   press Connect again.
4. **Attach** to the host session.
5. Return `{ mcp_server_id, name, oauth_mode, account_label?, attached }`.

`evidence.attempt_id` is logged and otherwise unused. A client that invents one
resolves nothing.

### 3.2.1 Three milestones, and finishing the two the browser owes

Connecting is not one event. It is three, completed by three different actors:

1. **The grant is persisted.** The provider redirects to Agor's OAuth callback,
   which writes `user_mcp_oauth_tokens`. This one completes on its own.
2. **The widget resolves and the server attaches.** Only the browser's POST to
   `/oauth-resolve` does this; the daemon decides everything about it, but
   nothing asks.
3. **The agent is admitted to resume.** Same POST, downstream of the same
   handler.

The original design had no way to reach (2) or (3) except that POST, so closing
the tab after consent left the worst possible state: a real, spendable
credential behind a widget that still said Connect, a Slack card that said
"sign-in is in progress" forever, and an agent that never woke. Reopening the
page reported success — it read `oauth_succeeded_at`, which is milestone (1) —
while Slack and the agent stayed where they were. Nothing in the system could
finish it, and `WidgetResolutionStore` treated an abandoned `resolving` claim as
terminal by design.

The recovery is one policy plus one state machine.

**The policy is per widget type, and only `oauth` has it.** A
`daemon_verified` registry entry may declare `recovery: 'reclaimable'`, which
means two things for that lane alone: a widget that is already `submitted`
answers `already_resolved: true` instead of `Forbidden`, and a `resolving`
claim taken by the same action and abandoned past
`WIDGET_RECLAIM_ABANDONED_AFTER_MS` (60s) may be taken over. The default stays
`'none'` and the submit-backed widgets keep exactly the semantics they had —
replaying `applySubmit` could duplicate a secret write or a connector restart,
which is what the conservative default is for. `oauth` qualifies because every
step of its handler is a re-read or an idempotent write: the grant read decides
(the request asserts nothing), the attach is a unique-index upsert, and the
auto-resume task is keyed by `widgetAutoResumeTaskId`. Replaying the whole
handler converges on the same three rows and talks to no provider.

`already_resolved` matters more than it looks: it is what lets a recovery
surface tell "you already succeeded" apart from "you may not", which the same
`Forbidden` used to conflate. `already_present` is deliberately excluded — that
status is minted terminal by a short-circuit that never offered a button, so
reporting a resolution for it would report one that never happened.

**The state machine is shared, and that is the point.** The Slack card and the
landing page answer from one `mcpSlackConnectRenderedState` over the widget row,
the delivery record, and the credential read through `resolveMCPOAuthGrantLiveness`
— the same function the resolve gate spends, so a card can never offer a finish
`/oauth-resolve` would refuse. They used to answer from two, and disagreed
exactly where it mattered. The card follows the _credential_, not
`oauth_succeeded_at`: a round-trip can finish and the grant be revoked, and a
grant can be on file from the Catalog drawer with no round-trip here at all.
`refreshable` does not count, because the resolve gate spends only a live grant.

Two states carry the distinction:

- **`finish_required`** — signed in, not attached. Its copy never says
  "connect", because sending someone back through a flow they completed is the
  error this whole state exists to stop, and its button is the resolve POST on
  its own. Slack gets it as a **re-seal, never a re-issue**: same
  `delivery_generation`, same `jti`, same clock, because a re-issue would clear
  the `oauth_succeeded_at` that records the sign-in. A re-seal grants strictly
  less than an issue — it mints nothing and invalidates nothing.
- **`finish_stalled`** — signed in, and no link left to offer. The button is
  dropped rather than shown broken, and the copy is an instruction rather than
  an apology: ask again in the thread, at no second sign-in. That is true
  because a fresh widget's already-connected short-circuit spends the grant
  that is on file. Nothing re-mints on a timer.

The one thing the copy must never say in any of these states is "Nothing was
connected". `expired` is reachable _after_ a round-trip that succeeded and left
no spendable grant, so it now reads "Agor has no usable connection" — which is
the useful fact and also the true one.

The canvas widget reads the same last-observed grant snapshot the rest of the
UI holds, and offers **Finish connecting** rather than a full re-authorization
of an account that is already connected. The snapshot is a hint and nothing
more: the daemon re-reads the grant, and a refusal drops the card back to an
ordinary Connect rather than leaving a button that can only fail.

### 3.3 `agor_mcp_catalog_list`

Read-only, paginated search over `packages/core/src/mcp-catalog/`. It exists so
the agent turns "Notion" into `com.notion/mcp` rather than inventing a URL —
which `agor_mcp_servers_list`'s own description already warns against.

Narrowing goes through `filterCatalog` from `@agor/core/mcp-catalog/query`, the
_same_ function the Catalog UI imports. One implementation of what a search term
matches; a change to it applies on both sides or neither.

Results are a shortlist projection — `name`, `display_name`, `benefit`,
`category`, `capabilities`, `auth_type`, `has_remote`, `website_url` — not the
whole entry. `permission_disclosure` and `starter_prompt` are paragraphs written
for a human reading a drawer; repeating 25 of them crowds out the `name`, which
is the one thing the agent is here for.

### 3.3.1 Where enforcement lives

Mint-time and resolve-time preconditions are `authorizeMint` / `authorizeResolve`
hooks on the **registry entry**, not free functions a caller remembers to call.
`mintWidgetMessage` runs the mint gate — and, since the pre-merge pass,
`parseWidgetMintParams` — for every widget the MCP tools create, and refuses a
widget type this daemon has not registered; `submissions.ts` runs the resolve
gate before the durable claim.

The argument for putting them on the seam is not hypothetical, and the
example is inside this feature rather than ahead of it. `agor_widgets_request_oauth`
has **two** mint paths: the ordinary one, and the `already_present`
short-circuit in `attachAndResume`. The short-circuit was written months after
the tool and was never consciously enrolled in anything — yet it inherited the
role floor, the gateway identity guard, and the unregistered-type refusal,
because the only way to create a widget row is through the seam that runs them.
What it did NOT inherit was the params schema, because that one was not on the
seam: each tool parsed its own params, the short-circuit built its object with
`satisfies OAuthWidgetParams`, and a compile-time check strips nothing at
runtime. So `.strict()` held on one of this type's two paths and not the other
(§5.1). That is precisely the failure the hooks exist to prevent, observed on
the one precondition that was not a hook. It is now one.

The §7 Slack projection is deliberately NOT an example here, contrary to what
this section used to claim: it does not mint. It projects a widget row that
already exists into a Slack message, and `issueMCPOAuthConnectLink` re-proves
its own bindings (`resolveSlackConnectBinding`) rather than inheriting the mint
gate — because the question at projection time is different, and includes ones
mint never asks (is the channel still writable, is the sealed generation still
current).

`agor_widgets_request_oauth` also calls the mint gate EARLY, with no params,
before it resolves a destination — so an unaligned gateway channel is refused
before a catalog install puts an orphan server row in the database. That call is
an optimization: skipping it would cost an orphan row, not a missed check. The
params parse has no such early form, which is why it is a separate call rather
than a fourth argument to the gate.

### 3.4 `agor_widgets_request_oauth`

Accepts exactly one of `mcpServerId` | `catalogEntryName`, plus `reason` and an
optional `sessionId`. Fire-and-forget. In order:

1. **Destination arity.** Neither or both → refuse. Accepting both would leave
   the daemon choosing what the agent meant.
2. **Session authority.** Minting into a session the caller neither owns nor
   administers is refused, matching the `checkSessionOwnerOrAdmin` floor the
   attach itself will apply.
3. **Gateway identity guard** — §5.3.
4. **Resolve the destination.** An existing id is loaded and validated; a
   catalog name is installed through `mcp-catalog/connect`.
5. **Role floor** (shared → admin), applied here as well as at resolve.
6. **Already-connected short-circuit.** A live grant for the prompt actor means
   there is nothing to sign in to: attach, mint a terminal `already_present`
   widget row for the transcript, queue the auto-resume, return.
7. **Supersede**, not stack: any still-`pending` `oauth` widget for the same
   (session, server) is marked `dismissed` — **without** queueing the dismissal
   prompt, because the agent is re-asking, not being told no. Both
   short-circuits supersede too (it happens inside `attachAndResume`), since a
   live Connect button is most obviously stale when the connection it offers
   already exists. The write goes through `WidgetResolutionStore.supersede`, the
   one writer of widget lifecycle state, so the row is patched into every open
   browser instead of staying clickable until a reload.
8. Mint the widget.

Two non-OAuth outcomes are handled rather than failed: a destination whose
effective auth is `none` is attached and resumed immediately (there is nothing
to authorize), and one that turns out to want a pasted API key is refused with a
pointer to the Catalog drawer, which is the surface that collects keys.

### 3.5 UI

`OAuthConnectWidget` renders the card. The click handler reuses
`openMarketplaceOAuthPopup` and `waitForMCPOAuthAttempt`, in the order the Slack
recovery page established:

1. Reserve the popup **synchronously**, while the click still carries user
   activation. Opening it after the `oauth-start` await is what gets it blocked.
2. `oauth-start` → `popup.navigate(...)`.
3. Poll the durable attempt.
4. Only on `succeeded`, POST `/oauth-resolve`.

The disclosure (when the widget came from a catalog entry) renders above the
button, and a shared-mode widget says so in as many words. Terminal states read
the durable row, including the "connected but not attached" case.

---

## 4. Decisions, with their evidence

**D1 — Attach after the grant, never at mint.** Verified: `mcp-catalog-connect.ts`
creates installs `scope: 'session'`, private to the caller, deliberately
unattached. An attached-but-unauthorized OAuth server is _not_ inert in direct
egress mode (`off`/`observe`, the common default): `packages/core/src/mcp/scoping.ts`
marks it `oauthAuthResolution: 'unavailable'` and still hands it to the agent's
MCP client with no bearer. Nothing filters on that field, so the client 401s and
exposes zero tools every turn — the symptom behind #2585 / #2182. In mediated
mode it is merely excluded (`register-routes.ts`, `reason=oauth_reauth_required`).
Attaching at resolution also makes the agent's next turn the first turn where the
server both exists and is authorized, which sidesteps
`MCP_RUNTIME_PROVIDER_CAPABILITIES` entirely — only `claude-code` hot-reloads
transports.

**D2 — Credentials belong to the prompt actor.** Verified in three places:
mediated egress requires `task.created_by === claims.principal_user_id ===
claims.credential_user_id` (`mcp-egress/gateway.ts`); direct projection sets
`credentialUserId = task.created_by` (`register-routes.ts`); the executor
resolves the same via `resolveContextUserId`. So the widget looks the grant up
under `ctx.submitterUserId` (resolve) / `ctx.userId` (mint), never the session
owner. This is also self-consistent: the auto-resume Task is created by the
resolver, so the credential the next turn spends is the one that was just
minted.

**D3 — The browser's claim of success is not evidence.** `/oauth-resolve`
carries no server id, no URL, and no payload the handler trusts. The destination
is pinned in widget params at mint; the outcome is re-read from
`user_mcp_oauth_tokens` through `isMCPOAuthGrantAuthorizedForServer`.

**D4 — Liveness is one function.** `resolveMCPOAuthGrantLiveness` backs the
agent-facing status read (`getOAuthStatus`, `mcp/tools/mcp-servers.ts`), the
mint short-circuit, the resolution gate, and the gateway's pre-prompt "not
authenticated" warning (`services/gateway.ts`). The third is a security
boundary, so it must not be a looser reimplementation of the others. "Live" is
stricter than "a row exists": a grant mid-refresh (`refreshing`), of unknown
outcome (`ambiguous`), expired, or no longer bound to the server's current
OAuth configuration does not count, because none of those is something the next
turn can spend.

This was written before it was true. The agent-facing read carried its own
inline copy of the whole rule — server re-read, lookup-key derivation, binding
check, `refresh_status`, expiry — and the gateway carried a looser one, so a
user one refresh away from usable read _connected_ from the warning surface and
_not connected_ from the mint short-circuit, and the agent offered a Connect
button for a server that already worked. Both now call the shared function.

**The surfaces that answer looser do so from the same read.** The gateway's
warning suppresses itself for `refreshable` — a grant whose access token has
expired, or whose refresh is in flight, but whose refresh token the inject hook
will spend JIT before the executor ever sees it. That widening is a named field
on the one answer, not a second rule, and the asymmetry is deliberate: a wrong
warning tells a Slack thread a connection is broken when the next turn will use
it fine, while a wrong `live` resolves a widget against a credential nobody
re-obtained. Warnings may be optimistic; grants may not. `refreshable` is
readable only by a surface that grants nothing.

**D4.1 — the agent-facing read joined them, at the `main` merge.** Independently
of this branch, [#2576] made `oauthGrantCanAuthenticate` the shared predicate
behind both `getOAuthStatus` and `mcp-oauth-status.ts`, which answers the UI's
auth badge, and widened both to count a refreshable grant as authenticated.
That is the same disjunction as `live || refreshable` — the two agree state for
state — but it contradicted what D4 had just decided for the agent-facing read.

The merge took `main`'s semantics and kept this branch's structure:
`getOAuthStatus` calls the shared read and reports `live || refreshable`. Three
reasons. `oauth_authenticated: false` is precisely what tells an agent to offer
a Connect button, so the strict answer produces the defect D4 exists to prevent,
one surface over. This branch never touches `mcp-oauth-status.ts`, so the strict
answer would have shipped a badge-says-connected / agent-says-not disagreement
that no test on either side can see. And `getOAuthStatus` grants nothing, so
reading `refreshable` there does not bend the rule above — the paths that issue
something still require `live`.

**The residual, and how it was closed.** The merge left the `oauth` widget's
mint short-circuit requiring `live`. So in exactly one state — a bound,
expired-or-refreshing, still-refreshable grant — the agent-facing read said
authenticated while the short-circuit would still render a Connect button. That
was the D4 disagreement, narrowed rather than closed, and widening a gate
belongs in its own reviewed commit rather than inside a conflict resolution.

**CLOSED.** The verdict is now one named function,
`mcpOAuthGrantIsConnected(liveness)` = `live || refreshable`, and every surface
in this lane calls it: the agent-facing read, the gateway's warning, the mint
short-circuit, the Slack card's `grantConnected`, the connect page's preflight,
and the widget's resolution gate. No production caller gates on `live` alone
any more.

The rule that survives is about what a surface DOES, not which field it reads.
A surface may be optimistic when it reports a connection or decides whether to
offer or complete an attach-and-resume: the credential already exists, and the
worst case is a refresh that fails at call time into the reactive recovery lane
built for exactly that. Strict belongs where a credential is ISSUED or sealed —
the callback exchange and the refresh path — and none of the liveness read's
callers is one of those. Nothing about issuance changed in this commit.

**The resolution gate went with it, and the argument is why.** It looks like
the exception and is not: `resolveOAuthWidgetFromCallback` attaches an existing
grant's server to a session and wakes the agent — the same action the mint
short-circuit takes, against the same credential, under the same user. A gate
cannot correctly answer a stricter question than the gate one step earlier
asked; requiring `live` there refused the exact user the mint gate would have
connected for free. What makes it a security boundary is D3 — the decision
comes from a grant row this daemon owns, read under the RESOLVER's identity,
never from the browser's claim — and that is untouched. The 400ms settle wait
for an in-flight refresh stays; it now covers only the narrower remainder
(`ambiguous`, or nothing spendable on file), which is the only `refreshing`
state that still reads unconnected.

**The B1 finish state machine was not merely consistent — it was wrong the
other way.** `mcpSlackConnectRenderedState`'s `grantLive` was keyed on `live`
precisely so a card could not offer a finish the resolver would refuse. Keeping
it there while widening the mint gate would have left no offer/refuse
mismatch — but it was already producing the opposite defect, which is the same
class as the one found in batch B (`2fe5cc73`). Consider this lane's own user:
they sign in, the page goes away before the POST, the card correctly flips to
_Finish connecting_, and then the hour-lived access token that sign-in produced
lapses. The card reverted to a buttonless "sign-in is in progress … this
message updates when it lands", forever, while a perfectly good refreshable
grant sat on file — withholding a finish the user could have completed. The
field is now `grantConnected`, read through the shared verdict in both places
that compute it (the delivery loop and the `/mcp-oauth-connect` preflight), so
card, page and resolver still cannot disagree — now in both directions.

This also makes §7.1.8's closing paragraph true rather than lucky: a
`finish_stalled` card tells the user to ask again in the thread, and the fresh
widget's already-connected short-circuit spends the grant on file. Before this
commit that advice silently failed once the access token had lapsed — which,
given the ten-minute link clock, is the likely case.

Guarded by tests at both ends, because the previous disagreement survived two
reviews by being invisible to every suite: `widgets.oauth.test.ts` asserts the
mint gate fires exactly when the agent-facing read says connected, over every
liveness shape, with the shared verdict left unstubbed as the hinge;
`mcp-servers.auth-status.test.ts` asserts the agent-facing read equals
`mcpOAuthGrantIsConnected` of a REAL database read, state by state. A future
change to one surface alone fails one of them.

[#2576]: https://github.com/preset-io/agor/pull/2576

A fourth shape exists and is intentionally not folded in:
`hasLiveCallerOAuthGrant` (`services/mcp-catalog-credential-match.ts`) applies
the same predicate — idle, unexpired, authorized — over a
`MCPCatalogServerCandidate` projection the caller already holds, not over a
`(db, serverId, userId)` read. It answers a different question (is this
candidate row a reusable credential peer) from a different input, so
converging it would mean giving the shared function a second signature rather
than removing a copy of the rule.

**D5 — The tool calls `mcp-catalog/connect` with `provider` intact.** Found by
running the real stack, not by a unit test: passing `{ ...baseServiceParams,
provider: undefined }` made the install an _internal_ call, and
`resolveCatalogInstall` returns early for those — "internal daemon calls write
the columns directly" — so `catalog_entry_name` was never stamped and the
repository's effective-row validation refused the write with
`catalog_entry_name is required for catalog MCP servers`. An agent calling this
tool is an authenticated external caller acting for a user, so it should meet
exactly the authorization a browser meets. Anything that reuses `connect` from
in-process must keep `provider` or stamp provenance itself.

**D6 — Attach refusal degrades, it does not fail.** Attaching is
`checkSessionOwnerOrAdmin`-gated, so a collaborator allowed to _prompt_ a shared
session may legitimately complete a sign-in and still not be allowed to change
what that session's agent can reach. The grant is real either way. Failing the
resolution would reopen the widget and invite the user to repeat a browser flow
that already worked, fixing nothing — the missing thing is someone else's
permission. So the handler records `attached: false`, and the auto-resume prompt
says what to ask for. Every other error propagates and genuinely reopens the
widget.

That decision is **asked, not inferred**. The handler calls
`checkSessionOwnerOrAdmin` itself before attaching — which is what
`authorizeMcpSessionConfigAccess` reduces to for this provider-less,
executor-scope-free call — rather than catching a `Forbidden` from the route.
Catching was wrong in both directions: `MCPServerNotUsableError` maps to
`Forbidden('That MCP server is private to another user')`, and tenant
write-gate and member-policy refusals are `Forbidden` too, so all three
surfaced as "ask the session owner to attach it" — advice that is false for
each, and for the first one impossible, since the session owner cannot attach a
server private to a third user either.

The mint-time shortcut — already connected, or a catalog entry that needs no
sign-in — follows the same rule through the same helper
(`mayConfigureSessionMcpServers`). It used to supersede the pending card, then
attach, so a collaborator in exactly this position lost the card to an
exception and got no `already_present` row and no resume. It now asks first,
records `result_meta.attached` on the `already_present` row with the same
guidance, and supersedes only after that row exists; any other attach error
propagates with the pending card untouched. A catalog no-auth install made for
such a caller stays what every install from this tool is until attached:
private to them and unattached.

**D7 — A pending widget does not expire, and that is an accepted gap, not an
oversight.** A `pending` oauth widget lives until it is resolved, dismissed, or
superseded. Nothing ages it out.

What that is _not_ is a way in. Every question the mint asked is re-asked at
resolve, against state read then: the role floor, the gateway identity
alignment, the pinned server's existence / usability / enabled-ness / OAuth
mode, and — the one that decides — a grant for the caller that
`mcpOAuthGrantIsConnected` accepts. (That last one said "a **live** grant" until
D4.1 made the verdict `live || refreshable` at every surface in this lane,
including this one. The point is unchanged: the authority comes from a grant row
this daemon reads at resolve time, under the resolver's identity.) A card
rendered a month ago and clicked today grants exactly what it would grant if
minted today, by exactly the person clicking it. The residue is a stale button
in a scrolled-back transcript, and the common way a card goes stale is already
handled: a second request for the same (session, server) supersedes the first
(§3.4.7), as does either short-circuit. "Handled" is bounded, not absolute —
the supersede sweep reads the newest `OAUTH_SUPERSEDE_SCAN_LIMIT` (200) widget
messages of the session, so a pending card further back than that survives a
re-ask. That bound is deliberate (a pending card older than 200 widget messages
is not one anybody is about to click) and it is only a presentation bound.

Age supplies no authority in either direction, and the earlier phrasing here —
"an older card that is missed grants nothing when tapped" — overstated it.
An old pending card tapped today resolves perfectly legitimately if the checks
above pass now; that is the same sentence as "grants exactly what it would
grant if minted today", and it is the resolve-time re-derivation rather than
the age that decides. What an old card cannot do is carry authority it was
minted with. One case supersede cannot reach — a post that outlived its
delivery lease and left a second, unrecorded Slack row — is handled
separately; see §7.1.1.

What building it would cost, weighed against that:

- A TTL needs a terminal `expired` status on `WidgetStatus`, which every widget
  type's UI, the resolution store, and the auto-resume admission have to
  understand — `env_vars` and `gateway_token` included, or the lifecycle
  becomes per-type.
- It needs a sweeper: a periodic, tenant-iterating job that finds overdue
  `pending` rows, patches them through `WidgetResolutionStore`, and broadcasts —
  with the HA ownership discipline every other durable daemon job carries. That
  is the real cost, and it is a new background job, not a field.
- **And §7 already puts a second clock on the same card.** The sealed
  Slack connect token carries its own `expires_at` (§7), tighter than any card
  TTL would be, with a one-use consume CAS. Inventing a widget-level TTL now
  means there are two expiry clocks on one object and a reconciliation
  nobody has designed: which one a Block Kit card reflects, what a resolve does
  when the token is live and the widget expired, whether an expired card can be
  re-offered. Designing the widget clock _with_ the token clock is strictly
  cheaper than designing it twice.

So: deferred deliberately, to be designed alongside the connect token's expiry
rather than apart from it. Two things would change the answer and should reopen it —
a pending widget gaining any authority that is NOT re-derived at resolve (which
would make the card itself a credential), or transcripts accumulating enough
abandoned cards to be a usability problem in their own right. Neither is true
today.

**D8 — Only this lane may finish a resolution somebody else abandoned.** The
feature has three milestones — the provider grant persisted, the widget
resolved and the server attached, the auto-resume admitted — and **only the
first is completed by the OAuth callback.** The other two depend on the
original browser POSTing `/oauth-resolve`. So returning from consent and
closing the page, reloading it, or simply losing that last request left a valid
credential behind a `pending` card, a Slack card still offering Connect, and an
agent that never woke. Worse, an interrupted resolution could land in
`resolving` with a claim the store deliberately never reclaims, at which point
nothing in the system could ever finish the widget.

The generic policy is right for the widgets it protects and wrong here.
`applySubmit` writes env vars and restarts connectors, so replaying one on a
claim of unknown outcome can duplicate a secret write — which is why
`resolution-store.ts` treats an abandoned claim as a diagnosis rather than a
lease. `resolveFromDaemonVerification` has no such effect to duplicate: the
grant read decides nothing from the request, the attach is a unique-index
upsert, and the auto-resume Task is keyed by `widgetAutoResumeTaskId`.

So the policy is **declared, per widget type, on the registry entry**
(`recovery: 'reclaimable'`) rather than inferred from the resolution kind —
`daemon_verified` says how an outcome is established, not that a handler is
replay-safe — and it changes exactly two answers for that lane:

- an `already`-`submitted` widget answers success (`already_resolved: true`)
  instead of `Forbidden`, so a recovery surface can tell "you already finished"
  apart from "you may not";
- a `resolving` claim taken by the same action and held longer than
  `WIDGET_RECLAIM_ABANDONED_AFTER_MS` (60s) is taken over, logged, and finished.

Nothing is widened. Every question the resolve path asks — prompt authority, the
role floor, gateway identity, the pinned destination, a live grant — is still
asked, of the caller doing the recovering, against state read now. A claim
younger than the cutoff is refused exactly as before, so two browsers racing one
card cannot steal from each other, and `dismiss` cannot inherit an OAuth claim's
lease.

The user-facing half is a **finish**, never a second sign-in: `finish_required`
/ `finish_stalled` on the Slack card, `finalize_required` on the landing page
(which runs it on arrival, since the user already decided at the provider), and
a **Finish connecting** button on the canvas card driven by the same
`/mcp-servers/oauth-status` snapshot the rest of the UI reads. All three are
hints about which button to show; the daemon still decides.

What this is NOT is automatic completion. Nothing sweeps for grants that landed
behind unresolved widgets and finishes them unattended — that would make the
attach and the agent's wake-up happen with nobody present, which is a different
decision from letting the person who signed in press a button. D1's "attach
after a browser-bound human action" survives intact.

**D9 — A refusal to admit a link is not a change of authority** (follow-up F2).
Both redemption lanes collapse every binding failure into one generic
`Forbidden`, so a redeemer cannot learn which of a dozen bindings moved. That
silence is aimed at the redeemer; `classifyMCPAuthRecovery` is not the
redeemer, and it was reading the same bare `Forbidden` everything else throws.
So `oauth-start` answered a tampered or malformed connect token with _"The MCP
request authority or OAuth browser reservation changed or expired"_ — a claim
about the user's ACCESS, made on the strength of a signature that did not
verify, sending them to re-check permissions that were fine.

The distinction is Agor-owned and in-process. `MCPLinkAdmissionError`
**subclasses** `Forbidden`: same 403, same `Forbidden` name and `className`,
same single generic message, byte-identical `toJSON`. Nothing a client can
observe tells the two apart — the marker is legible only on the daemon's side
of the boundary, which is the only side that has the right to know. The
classifier branches on it **before** the `Forbidden` branch it is a subclass
of, into `link_not_admitted` / `request_new_link`, whose copy says the link is
spent and to ask the agent for another. The copy is one sentence for every
refusal, so it stays as silent as the throw it classifies.

The five throw sites are the two binding loaders' final refusal, the two
"does not match the requested server" guards, and the both-tokens refusal
(which is raised before the classifying `try` and so changes nothing today —
marked because it is the same kind of refusal, and a later refactor that moves
the `try` should not have to rediscover that).

Nothing is narrowed for anyone else. The four call sites that whitelist
`permission_changed` — `test-oauth`'s catch, discovery's
`probeAndAcquireOAuthToken` rethrow, its connect-error rethrow, and
`/mcp-servers/discover`'s catch — are all reached from provider I/O, not from
link redemption, and `recoveryForOAuthAttemptFailure`'s own
`'permission_changed'` failure code is a different function on a different
input. The reactive recovery lane redeems its token through the same loader and
gets the same corrected answer.

---

## 5. Security requirements

### 5.1 No secret reaches the agent

`result_meta` is `{ mcp_server_id, name, oauth_mode, account_label?, attached }`.
Names, an identity, a mode, and a boolean. This is requirement 1 of the widgets
design and it is stronger on this lane than on the others: the token never
touches the browser at all — the provider redirects to the daemon's own callback,
which exchanges the code and persists the grant.

`account_label` is in the shape and is **never populated today**. Agor persists
no provider-side account identity for an MCP grant (`UserMCPOAuthToken` carries
none), so there is nothing truthful to put in it. §7 may fill it if the
landing page learns one. It is not derived from anything.

`oauthParamsSchema` is `.strict()`, and `mintWidgetMessage` runs the registered
type's `paramsSchema.parse` at the seam (`parseWidgetMintParams`) before the
row is written, so no extra field reaches a widget row through any mint path.

That used to be path-specific and is worth recording, because the shape of the
gap is the same one §3.3.1 is about. The pending path parsed its own params;
the `already_present` short-circuit built them with `satisfies
OAuthWidgetParams`, which is a compile-time check that strips nothing and
narrows nothing at runtime — so `.strict()` held on one of this type's two
mint paths. Nothing was smuggled through the other (every field there is a
literal or a daemon-read value, and the tool's own input schema is a
`z.strictObject`), but the guarantee came from the caller rather than from the
type. Moving the parse onto the seam makes it uniform across all three widget
types and every future mint path, exactly as the mint gate already was.

### 5.2 Role floors

Shared-mode → `ROLES.ADMIN`, at mint _and_ at resolve, in
`assertOAuthWidgetRoleFloor`. That is the same rule the recovery lane applies
and the same rule `oauth-start` applies internally ("Shared MCP OAuth grants can
only be started by an admin").

Per-user → `ROLES.MEMBER`, which `/widgets/:id/oauth-resolve` enforces at the
route with the generic `requireMinimumRole(ROLES.MEMBER)` hook rather than with
`assertMcpCapabilityRole`, the MCP-specific floor. Saying they apply "the same
rule" needs a footnote, because the reason the second one exists is that they
once differed.

They no longer do, on any input. `assertMcpCapabilityRole`'s own comment still
says the generic hook "normalizes through `normalizeRole`, which answers MEMBER
for an absent or empty role, so it admits precisely the caller carrying no role
at all" — that was true when it was written (#2373, 2026-08-18) and stopped
being true the next day, when #2496 added `if (!userRole) return false` ahead of
the normalization in `hasMinimumRole`. Both now refuse an absent role, an empty
role, and any role outside the authority ranking, and both bypass identically
for a provider-less internal call and for an explicit service account. The
remaining difference is defensive typing: `isAtLeastMemberRole` also requires
the role to be a non-empty string before ranking it. That comment is corrected
in place; the two floors are kept separate anyway, so the MCP floor cannot be
loosened by a change made for some unrelated route.

The route is left as it is. It matches `/submit` and `/dismiss`, and the floor
is not what this lane rests on in any case: the resolve gate re-asks the role
floor and the gateway identity question before the durable claim, the pinned
destination is revalidated, and nothing resolves without a live grant.

### 5.3 Fail closed on gateway identity

`services/gateway.ts` resolves an inbound message to its real sender **only when
the channel aligns platform users**. With `align_slack_users: false`, every Slack
member with @mention access prompts as the channel's "Post messages as" account.
A sign-in started from such a session would persist the grant under that one
identity, and the whole channel would then drive it.

`resolveGatewayPromptIdentity` decides this and `agor_widgets_request_oauth`
refuses on a negative, with text written to be relayed verbatim into the thread:
it names the channel, states the consequence, and names the setting to enable,
because the person reading it in Slack is usually not the person who can change
it. Every uncertain answer lands on the refusing side — flag absent, flag
truthy-but-not-`true`, channel unreadable.

Alignment is an **allowlist**, derived from
`GATEWAY_USER_ALIGNMENT_CONFIG_KEYS` — the same declaration `gateway.ts` reads
before deciding whether to fall back to `channel.agor_user_id`. A platform with
no entry is unaligned, not exempt. The first cut had this backwards ("a platform
with no alignment switch cannot admit a foreign prompt in the first place"),
which reported Teams as aligned — Teams is inbound via webhook, a Teams channel
is multi-member, and `gateway.ts:3291` falls through to the channel owner
unconditionally — and reported Shortcut as aligned even though it has a real
`align_shortcut_users` flag the map simply omitted. Shortcut now requires its
flag; Teams, WhatsApp, Telegram, and any future `ChannelType` are refused until
they are listed.

Known gap in the safe direction: `gateway.ts` also honours a per-message
`data.metadata.align_*` override, which is not visible from a Session row, so a
channel aligned only that way reads as unaligned. That costs a spurious refusal
and grants nothing.

The Slack _binding_ is §7. The guard is here because the exposure exists
the moment an agent in a gateway session can mint this widget, which is now.

### 5.4 The disclosure, and the one place this design bends a rule

`mcp-catalog/connect` requires `acknowledged_disclosure` to equal the entry's
`permission_disclosure` verbatim. The rule exists so the endpoint cannot be
reached by a client that skipped the drawer: sending back the text proves the
protocol ran.

When the tool installs from `catalogEntryName`, it satisfies that check with the
entry's own text. This is worth stating plainly rather than burying: **at that
moment no human has read the disclosure.**

Why it is nonetheless the right trade here:

- The row the install creates is inert. It is `scope: 'session'`, private to the
  caller, unattached, and — being unauthorized — grants access to nothing. The
  probe is the only outbound effect, and it goes through `createPinnedFetch` to
  the entry's own URL.
- The disclosure travels onto the widget (`params.permissionDisclosure`) and is
  rendered, expanded, above the Connect button. The user reads it before the only
  moment anything is actually granted.

  **Whole.** It used to be clamped to 1000 characters with an ellipsis, on the
  reasoning that a catalog-owned field should degrade rather than block a
  connect. That reasoning is right for a display name and wrong for this field,
  because this field IS the consent this whole section is an argument about —
  and the tail of a permissions paragraph is where "and can delete them" tends
  to live. An entry longer than `OAUTH_PERMISSION_DISCLOSURE_MAX` (4000, against
  a longest reviewed entry of 808) is now refused before anything is installed,
  with a message that says Agor will not shorten what you are agreeing to. An
  entry nobody can connect is a curation bug somebody fixes; a disclosure
  missing its last sentence is one nobody notices.

  **On every Connect button, not only the first.** The row does not store the
  disclosure, and a later request naming the installed server by `mcpServerId`
  supersedes the widget that carried it. So that path re-reads the entry named
  by `catalog_entry_name` and carries its text the same way, under the same
  length refusal. If the entry has left the catalog (or cannot be read) the
  tool refuses before superseding anything, rather than mint a button with no
  disclosure or a generic one: the text the install acknowledged no longer
  exists to show, and the user can still connect from My Servers. An
  already-connected server is still attached — no button, nothing to precede.

- Pinning `mcp_server_id` at mint is what lets `/oauth-resolve` accept **no**
  caller-supplied destination at all. Deferring the install to the click would
  mean the resolve endpoint taking a server id from the browser, which is a
  confused-deputy surface on the boundary that matters most.

The alternative — mint with only a catalog key, install at click time with the
user's real acknowledgement — preserves the disclosure contract exactly and was
seriously considered. It was not taken because it trades a tighter guarantee at
the resolve boundary for a weaker one, and because the install it avoids grants
nothing. If a future change makes a catalog install non-inert, this decision
must be revisited first.

### 5.5 Multi-tenancy

Every read the widget performs goes through `ctx.runInTenantDatabaseScope` (a new
field on `WidgetSubmitCtx`, threaded from the resolver's existing
`deps.runInTenantDatabaseScope`) or through a Feathers service with the caller's
params. The MCP tool uses `runWithMcpTenantDatabaseScope`. No new table, no new
global, no cross-tenant path: the widget row is a `messages` row, the grant is a
`user_mcp_oauth_tokens` row, and the server is an `mcp_servers` row, all
tenant-scoped already. The catalog is the one deliberately global read — it is a
checked-in file, byte-identical for every tenant, and contains nothing
tenant-owned.

`resolveMCPOAuthGrantLiveness` re-reads the server row from the database rather
than trusting the one the caller holds, because MCP service responses have
already been through token injection and secret redaction and binding authority
must come from stored state.

### 5.6 Realtime

`widgets/:id/oauth-resolve` is declared `audience: 'none'` in
`realtime-publish-policy.ts`. The resolution answers its caller; subscribers
learn the outcome from the `messages` room, through the same `widget:resolved`
broadcast and row patch every other widget uses.

---

## 6. Canvas polish — not built

These finish the canvas experience and harden edges the widget lane left
deliberately simple. **None of them is built.** Item 3 is the only one that has
been decided rather than merely deferred: it is an accepted gap, with its
reasoning in **D7**.

(This section was once called "stage 2". The branch's `stage2` commits built §7,
not this — see the status table at the top.)

1. **Reauth reuse.** `agor_widgets_request_oauth` currently short-circuits on a
   live grant. It should also recognise an _expired or revoked_ grant and say so
   in the widget copy ("Reconnect Notion") rather than rendering a first-time
   Connect. `resolveMCPOAuthGrantLiveness` already distinguishes the cases; only
   the copy and a `params.mode: 'connect' | 'reconnect'` are missing.
2. **Attach-authority preflight.** Today a collaborator learns the attach was
   refused only after signing in (D6). Mint could resolve
   `checkSessionOwnerOrAdmin` up front and render the caveat in the card.
3. **Expiry.** A pending oauth widget lives forever. **Accepted gap — D7.**
4. **Popup-blocked recovery path.** Every surface now at least SAYS the right
   thing: the canvas widget always did, and the two Slack landing pages gained a
   `blocked` state in the pre-merge pass — before it, a refused `window.open`
   rendered as `failed` ("return to Slack and ask again"), which reproduces the
   block exactly, on the client where it is most likely (Slack's mobile in-app
   browser). What is still missing is the recovery itself: a same-tab fallback
   (navigate, return via the callback page) that does not need pop-ups at all.
5. **Onboarding integration.** The Catalog drawer's "Start new session" flow and
   this widget now both install-then-connect. They should share one helper.

## 7. The Slack projection

This gives the widget a Slack face. Three pieces, all built.

| Piece                                        | Where                                                   |
| -------------------------------------------- | ------------------------------------------------------- |
| Sealed connect token + claim matchers        | `apps/agor-daemon/src/utils/mcp-oauth-connect-token.ts` |
| Redemption authority                         | `services/mcp-slack-oauth-authority.ts`                 |
| Durable delivery record on the widget row    | `services/mcp-oauth-connect-delivery.ts`                |
| Card meaning (states, copy, blocks, wake-up) | `services/mcp-slack-connect-card.ts`                    |
| Post/update projection, claims, repair sweep | `services/gateway.ts`                                   |
| Indexed due-work column + migration 0111     | `packages/core/src/db/repositories/messages.ts`         |
| Landing page + the finish recovery           | `apps/agor-ui/src/pages/MCPOAuthConnectPage.tsx`        |
| Operator control for the kill switch         | `services/mcp-slack-connect-control.ts`                 |
| Preflight + redemption routes                | `apps/agor-daemon/src/register-services.ts`             |

The reactive lane was the template, and most of it was reusable:

- **Sealed token.** `MCPSlackRecoveryNotice` carries `token_jti`,
  `token_consumed_at`, `expires_at`, `principal_user_id`, `credential_user_id`,
  `slack_user_id`, `gateway_config_generation`, `mcp_server_config_version`, and a
  one-use consume CAS. The connect token carries the same fields plus
  `widget_id`, `delivery_id`, and `delivery_generation`. It binds the _widget_,
  not just the server, so the landing page resolves exactly the card the user
  tapped, and the generation is what makes a re-issued link supersede the one
  already in the thread.
- **Landing page.** `MCPSlackRecoveryPage` was the shape: preflight, one button,
  pre-opened popup, durable attempt poll, "Return to Slack". The connect page
  differs in its last step — instead of projecting a recovery result, it POSTs
  `/widgets/:id/oauth-resolve`. **That endpoint needed no change**, because it
  takes nothing from the caller but identity.
- **Block Kit projection.** `services/gateway.ts:1701+` posts and reconciles the
  recovery notice with a delivery claim and `slack_message_ts`. The connect
  projection applies the same idempotent post/update discipline, driven off the
  widget row's status transitions rather than a task's — `mcpSlackConnectRenderedState`
  reads the widget's own lifecycle first and consults the delivery record only
  for what a still-pending card offers, so there is no second lifecycle to keep
  in step. It wakes three ways: immediately on a widget transition (through
  `WidgetResolutionStore`'s change callback, which is the single writer of that
  state), on the connect token's own expiry timer, and from the bounded repair
  sweep that the recovery lane already runs per tenant.
- **Identity.** §5.3 already refuses the unaligned case at mint, so the binding
  inherits a session whose prompts carry a real actor. The sealed token still
  pins `slack_user_id` and verifies it at redemption against the originating
  Task's durable `gateway_task_source` — alignment at mint does not prove the
  person who tapped the button is the person who asked. The projection refuses
  the unaligned channel a second time at issue, independently of anything
  rendered, and the card says so in words an admin can act on.

This lane must not introduce a headless start. Sealing a token does not create a
grant; the browser-bound flow remains the only path.

### 7.1 How the projection was verified

Against a real daemon (`tsx src/main.ts`, isolated `AGOR_HOME`, migrated SQLite
database, MCP endpoint and REST routes live), with **Slack's API — and only
Slack's API — replaced**. The fake patches `WebClient.prototype.apiCall`, which
is the single funnel every `@slack/web-api` call goes through, so
`SlackConnector`, the projection, the delivery record, the card builder, the
sealed token, and every authority read ran for real; what was simulated is the
Slack workspace on the far side of the socket. No real Slack workspace was
available, so no case below was driven through a live Slack tenant.

The widget was minted over `POST /mcp` with a personal API key
(`agor_widgets_request_oauth`); the link was redeemed over
`POST /mcp-oauth-connect` with a browser-shaped JWT.

| Case                              | Result                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mint → card posted                | One `chat.postMessage` carrying the card blocks and a `Connect Notion` URL button whose fragment is the sealed token.                                                                                                                                  |
| Preflight, correct signed-in user | `201` with `state: connect_required` and names only.                                                                                                                                                                                                   |
| Resolve → card updates in place   | `chat.update` on the **same** `ts`, button gone, "_Notion connected_". `rendered_state: connected`, due column cleared.                                                                                                                                |
| Agent resumed                     | The `[Agor] User connected "Notion"…` task was created and relayed into the thread.                                                                                                                                                                    |
| Wrong signed-in user              | `403`, the single generic message.                                                                                                                                                                                                                     |
| Alignment lost after mint         | Link `403`; card repainted in place on the backstop, button gone, naming the setting; `binding_invalidated_at` recorded once.                                                                                                                          |
| Superseded widget                 | Old card edited in place to "replaced or cancelled" with **no button**, new card posted beside it, old link `403`.                                                                                                                                     |
| Stale `gateway_config_generation` | Link sealed at generation 1 refused after a token rotation to generation 2 with alignment still on; delivery went out through a connector reloaded from fresh credentials (`auth.test` + `bots.info` before the edit), not the process-local listener. |

What the provider round-trip could not be: `/mcp-servers/oauth-start` performs
real discovery against the vendor endpoint, so the grant was established by
writing a real `user_mcp_oauth_tokens` row and letting `/oauth-resolve` re-read
it — the same substitution §8 step 4 made. Everything the daemon decides about
that row is real; obtaining it from Notion is not.

**This run found one defect, now fixed.** `SlackConnector.sendMessage` stamped
Slack message metadata only for `agor_mcp_recovery`, so the connect card posted
bare and `findMessageByMetadata` — the reconciliation that stops a daemon which
crashed between the post and the `slack_message_ts` write from posting a second
card with a second live button — could never match it. The stamp is now an
allowlist the connector owns, and `MCP_SLACK_CONNECT_EVENT_TYPE` is typed
against it. Re-verified by dropping `slack_message_ts` from a live delivery
record and waking the sweep: the daemon found its own row by metadata and
edited it instead of posting again.

Every suite above this stubs the connector, which is why none of them saw it —
the same shape as D5 and the tenant-scope bug.

### 7.1.1 What the gating review found, and what changed

A correctness review run on a different model family blocked merge on three
defects. All three are fixed; each is worth recording because two of them
changed a contract this document states.

**The third missing tenant scope in this lane.** `/mcp-servers/oauth-start` is
on `TENANT_IDENTITY_ONLY_SERVICE_PATHS` — it must not hold an HTTP-long
transaction across provider I/O — so nothing upstream arms a tenant database
scope for it, and the binding loader's own scope has closed by the time the
start lease renews, the failure marker writes, or `oauth_started_at` is
stamped. Against the production guard each of those threw, and the handler
reported it as an ordinary start failure: a valid request burned the one-use
link, made zero provider calls, and left no `oauth_failed_at` for the card to
render. The fix is structural rather than three more wrappers — the two
repositories are bound to short tenant units of work
(`bindRepositoryToTenantUnitOfWork`, the seam `GatewayService` already uses for
every deferred writer), with the tenant pinned from the request rather than
read from ambient identity. `loadSlackRecoveryBinding` opened no scope at all
and is now wrapped like its connect counterpart; the recovery lane's own
`oauth-start` path had the identical defect.

The failure marker's swallow was separately wrong and is separately fixed. It
still cannot throw — every caller is already reporting an earlier failure — but
it logs, and a marked failure now wakes the card instead of waiting for the
repair sweep. A burned token with no recorded outcome is unrecoverable from
Slack, because the card is the only affordance the thread has.

**The callback compared the channel to itself.** Callback authorization passed
the channel's _current_ `provider_config_generation` as the expected one, and
re-read the server's `config_version` the same way — checks that can never
fail. Rotating the gateway token mid-flow moved the generation 1 → 2 and the
provider callback still returned 200 and persisted the grant.

**Contract change:** `MCPSlackOAuthConnectContext` now carries
`gateway_config_generation` and `mcp_server_config_version`, sealed from the
connect token at redemption, and the pending-flow envelope requires them. The
recovery lane already kept both on its durable notice; this makes the connect
lane say the same thing. An envelope that cannot name what authorized its flow
is refused rather than opened. The preceding fence also now honours
`binding_invalidated_at`, which §7.2 makes terminal: a card already repainted
to say no link can be offered must not let an in-flight flow finish behind it.

**A delivery lease can outlive its post.** The `delivery_claim` is a 30s lease,
so a stalled first post can return after a second claimant took the expired
claim, posted the row that counts, and released it. Completion treated an
absent claim as consent — recording the _other_ card's `slack_message_ts`,
dropping its own receipt, and overwriting the state the winner had just
rendered — leaving two messages for one widget, of which repair only ever edits
one. The stalled post's live Connect button stayed in the thread permanently.
Completion now requires the claim to still be its own, and a delivery that
finds it is not the owner retires the message it posted: deleted where the
connector can, otherwise edited to a buttonless card pointing at the
authoritative row.

That is the stale card **D7** accepted on the grounds that supersede handles
it, in the one case supersede cannot see — the orphaned row is not in the
record. D7's conclusion stands, but its reasoning now depends on this
reconciliation as well as on supersede.

**How they were verified.** A regression test per defect, each failing on the
preceding commit: the two scope cases and the two callback-refusal cases use
the integration harness's opt-in `requireTenantScope` (the guard the earlier
suites lacked, and the reason three scope defects reached a running daemon),
and the two orphan cases use the delivery harness. Then the same real-stack
shape as §7.1 — a real daemon, an isolated home, only Slack's API replaced —
this time driving `/mcp-servers/oauth-start` through **real discovery and
Dynamic Client Registration against `mcp.notion.com`**, which §7.1 had not
done. Run against the pre-fix tree it reproduces all three; against this one
every case passes.

One thing that run showed and a unit test would not: a non-200 from the
callback is not by itself evidence of an authority refusal, because the
provider also rejects a fabricated authorization code. The discriminating
observation is whether the authorization-code exchange started at all — before
the fix it did.

### 7.1.2 The pre-merge real-stack drive

§7.1's drive was repeated for the paths the pre-merge pass touched, in the same
shape — a real daemon (`tsx src/main.ts`), an isolated `HOME`, a migrated
SQLite database, and **Slack's API and only Slack's API replaced** at
`WebClient.prototype.apiCall`.

| Case                                 | Result                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Widget carrying ONLY the mint marker | Seeded from a separate process, so no in-process defer ever existed. The sweep found it and posted one card — sealed token in the fragment — plus the one-time shared-thread notice. |
| Repeat sweep ticks                   | No second post. The delivery record's `next_repair_at` had taken the indexed column over, and the due page was empty.                                                                |
| Kill switch off                      | Nothing posted, nothing minted, widget left `pending`.                                                                                                                               |
| Kill switch back on                  | Card posted.                                                                                                                                                                         |

The first row is what found §7.1.2 below: on the first attempt the daemon
posted nothing, logged nothing, and left the widget untouched.

### 7.1.3 The fourth missing tenant scope

Recorded because it is the same class the gating review found three times
(§7.1.1), it was found the same way, and it was not found by any suite.

The bounded repair sweep runs under `runWithTenantContext` and nothing else:
tenant CONTEXT, not a tenant database SCOPE. Every repository in
`GatewayService` opens its own through `bindRepositoryToTenantUnitOfWork` — but
the app-variable settings each lane reads on its first line are free functions
with nothing to open one, so each threw `MissingTenantDatabaseScopeError`
straight into the sweep's `.catch(() => undefined)`.

- `deliverMcpSlackConnectCard`'s kill-switch read (new, below) — so the durable
  first-card trigger delivered nothing.
- `syncMcpSlackRecoveryNotice`'s `isMcpRuntimeRecoveryEnabled` and
  `getMCPEgressGatewayMode` — **pre-existing**. The recovery lane's repair
  sweep has never repaired a notice.

`GatewayService.readTenantSetting` opens a short scope for these reads; every
caller goes through it, including the request-path one that already has a
scope, because entering an open scope is a no-op and the alternative is one
site deciding it is special.

What the suites could not see is worth stating: **a test that stubs every
repository has no guard to trip.** The two regression tests hand the service a
real scope-guarded handle while leaving the repositories stubbed, which is the
only shape that reproduces the sweep's.

### 7.1.4 The operator kill switch

`isMCPSlackConnectCardEnabled` (`db/repositories/mcp-slack-connect-settings.ts`)
gates the projection, the same way `isMcpRuntimeRecoveryEnabled` gates the
reactive lane. It reads one app variable, `mcp-slack-connect/card_projection`,
and is checked in three places: `deliverMcpSlackConnectCard` before anything is
read or posted, `loadMCPOAuthConnectBinding` before anything is consumed, and
`assertSlackConnectFlowStillAuthorized` before a callback already in the air is
allowed to persist a grant.

The first two, not just the first, because the point is to stop the lane from
**granting** and not merely from repainting: a card already in a thread carries
a live sealed link, and an operator turning this off during an incident is
asking for that link to stop working. The refusal collapses into the lane's one
generic failure, and nothing is consumed — turning it back on restores the
existing link rather than leaving a burned one behind.

**The third is new, and it is the difference between that sentence being true
and being nearly true.** The pre-merge architecture pass found that a link
redeemed a second before the switch was thrown still completed: the consume had
already happened, so nothing downstream asked again, and the provider callback
persisted a grant into a lane an operator had just stopped. The window is one
provider round-trip — small, and exactly the window an incident is inside. Two
options were on the table: narrow the documented promise to "stops new starts
and repainting", or enforce it. Enforced, because the promise is the reason the
switch exists, the cost is one app-variable read on a path that already re-proves
five other bindings, and "your kill switch stops new sign-ins but finishes the
ones in flight" is a sentence nobody wants to discover during an incident. The
refused callback stamps a durable `oauth_failed_at`, which is the state §7.2's
one-re-issue rule already knows how to recover from once the switch goes back on.

### The procedure

`/mcp-slack-connect/card` (`services/mcp-slack-connect-control.ts`, registered
in `register-routes.ts`) is the control surface. Admin for both methods —
unlike `/mcp-egress/status`, nothing it answers is about the caller's own
capabilities, so there is no answer a non-admin needs — and tenant-scoped like
every other route registered through
`createTenantScopedAuthenticatedRouteRegistrar`.

| Step                         | Action                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Read, for an explicit tenant | `GET /mcp-slack-connect/card` → `{ tenant_id, enabled }`. `tenant_id` is echoed so an operator working through several can prove which.  |
| Change                       | `PATCH /mcp-slack-connect/card { "enabled": false }`. A non-boolean is refused rather than written.                                      |
| Verify it took effect        | The PATCH response is a RE-READ through `isMCPSlackConnectCardEnabled` — the same predicate the lane calls — not an echo of the request. |
| Across affected tenants      | One call per tenant, exactly as `mcp_egress_gateway.mode` is. The setting is an app variable and the lane is a tenant-owned resource.    |
| Restore                      | `PATCH { "enabled": true }`. Every refusal the switch caused is recoverable; see below.                                                  |

What happens to work stranded while it was off, which is the part a switch is
useless without:

- **A card that was never posted** keeps its mint marker. The refused-marker
  reschedule (§7.1.5) moved it off the front of the sweep queue but kept the
  trigger, so it is delivered within one backoff period of the switch going
  back on — no more than five minutes, and with no action from the operator —
  provided the widget is still inside the sweep's 24-hour horizon. Past that it
  is gone for good and the user has to ask again.
- **A link that was refused at redemption** was not consumed. The card and its
  token are exactly as they were, so it simply works again.
- **A callback refused in flight** consumed its link and recorded
  `oauth_failed_at`. The card renders `expired` and may be re-offered once with
  a fresh link while the original clock runs (§7.2); past that, asking again in
  the thread mints a new widget.
- **Nothing is stranded on the canvas.** Off is a degraded Slack experience,
  never a removed feature: the widget still renders a live Connect button and
  `agor_widgets_request_oauth` still hands the agent a `session_url` to relay.

`mcp-slack-connect-control.test.ts` drives that procedure against a real
migrated database — read, change, verify, second tenant, restore — so the
runbook above is executable rather than remembered.

What it does not touch is the fallback. The canvas widget still renders a live
Connect button, and `agor_widgets_request_oauth` still hands the agent the
`session_url` and the sentence to relay — or, on a deployment with no
browser-reachable public URL, `link_unavailable` and a sentence that says so
rather than a link nobody can open (§7.1.15/D3). Off is a degraded Slack
experience, never a removed feature — which is also why it is **on by default**: the card
is additive to a link that still works, so a bad card costs a bad-looking Slack
message rather than a broken flow, and a lane that ships dark is a lane nobody
ever reports a bug against.

Two known limits, both deliberate:

- It is **per tenant**, because it is an app variable and the lane is a
  tenant-owned resource. A deployment-wide problem means one write per tenant.
  That matches `mcp_egress_gateway.mode` exactly and is the reason the switch
  is a setting rather than an env var; if incident response needs one action,
  that is a change to make for both settings at once.
- There is **no admin UI**. There is now a `PATCH` route, as the egress mode
  has, and no Settings control in front of it. An incident is worked from an
  authenticated API call either way; a UI is worth adding the first time
  somebody who is not comfortable making one has to.

A value nobody recognises leaves the card **on**. This is not fail-closed on
purpose: an unreadable or mistyped setting should not silently retire an
affordance a thread is already showing, and the operator turning it off is
performing a deliberate act and can spell it.

### 7.1.5 What the correctness review found

A second correctness review, run on another model family after §7.1.3, blocked
merge on two more defects in the delivery projection and reported a third
instance of the tenant-scope class. All three are fixed here.

**A lost claim reconciled its post and ignored its edit.** §7.1.1 taught the
settlement CAS to require the claim to still be its own, and taught a delivery
that finds it is not the owner to retire the message it POSTED. An EDIT was
explicitly excluded — "an edit reuses the row that is already recorded, so only
a fresh post can orphan one" — which is true about orphans and beside the point
about reconciliation.

The interleaving, reproduced with the delivery harness: A starts re-issuing a
durably failed sign-in, which edits the recorded row; A's 30s lease lapses
while Slack is being called; B dismisses the widget, renders `cancelled` onto
the same `ts`, and clears the repair deadline behind it; A's delayed edit lands
last and puts the Connect button back. A correctly loses the completion CAS and
did nothing about it, because nothing was orphaned.

The record then says `cancelled` and the thread shows Connect — and the
disagreement seals itself in, because `rendered_state` is exactly what every
later render compares against. The no-op shortcut, the claim CAS and an
explicit repair all skip a card whose recorded state already matches the state
that would render now. The button cannot authorize the dismissed widget (every
question is re-asked at redemption, D7), so this is misleading-forever rather
than an authorization hole — but "the card reflects the widget row" is the
whole premise of the projection.

`repaintLostMcpSlackConnectRender` is the counterpart to
`retireOrphanedMcpSlackConnectCard`: fenced on the recorded `ts`, it clears the
`rendered_state` the delivery just invalidated, sets `next_repair_at`, and
re-renders from the widget row. A no-op when the winner happened to render the
same state. Bounded in process at `MCP_SLACK_CONNECT_REPAINT_ATTEMPTS`,
because losing the claim twice means another daemon is still writing the row
and the sweep already owns the card by then.

**A refused first-card marker held the front of the sweep queue.** The mint
marker (§7.1.2) is a widget's only durable trigger before a link exists, and
the projection deliberately KEEPS it for the refusals an administrator can undo
— `unaligned`, `authority_moved`, `no_secret`. What it also kept was the
marker's original, permanently overdue timestamp, and the sweep's page is the
oldest fifty rows of due work with no cursor. Fifty stuck markers therefore
owned every page: the healthy cards behind them got no first delivery and no
repair until the blockers changed or aged past the 24-hour horizon.

Two changes, of which the first is the fix:

- `mcpSlackConnectRefusedMarkerDueAt` moves a refused marker forward by five
  minutes. Ageing out is preserved rather than traded away — the reschedule is
  capped at `requested_at + 24h`, the same point the horizon used to drop the
  row, and past that the marker is pinned back to its anchor where the horizon
  excludes it for good. A marker that refreshed its own due time would
  otherwise be immortal.
- `findMcpSlackConnectDuePage` gained a keyset cursor over
  `(mcp_slack_connect_due_at, message_id)` and the sweep walks up to four
  pages per tenant visit. This is defence in depth for whatever else might
  one day fail to advance; the reschedule alone fixes the reported case, and
  is verified to with the page budget set to one.

Reproduced end-to-end in `gateway-mcp-slack-sweep.test.ts` — fifty widgets on
an unaligned channel, one healthy widget behind them, real rows and the real
page query — where it fails on the preceding commit with the healthy card
never delivered.

**The fifth missing tenant scope.** A Socket Mode listener creating a session
carries tenant IDENTITY and no transaction. Every repository on `GatewayService`
opens its own scope through `bindRepositoryToTenantUnitOfWork`, but
`resolveMCPOAuthGrantLiveness` takes a raw handle and builds its own — so the
gateway's pre-prompt warning threw `Missing tenant database scope` on its first
server read, straight into a fail-closed catch. A new Slack thread whose
channel selects an OAuth server the prompting user has no grant for stopped
being told, in its initial prompt, that the server is unavailable.

Reported as non-blocking and fixed anyway: it is one wrapper, and it is the
fifth time this class has bitten. `readTenantSetting` is now
`readInTenantScope`, because the pattern is not about settings — it is about
everything that reaches the database from a caller holding only tenant
context. The catch logs an Agor-owned category instead of swallowing, which is
the same gap §7.1.6 closes on the sweep.

Why no suite saw it, again: the five cases already covering this warning hand
the service an unguarded database, where an unscoped read simply succeeds. The
regression test hands it the production guard and enters through
`runWithTenantContext` alone, the way the listener does.

### 7.1.6 Closing the silence around both lanes

The architecture pass asked why the last two scope defects were invisible. Two
answers, both now addressed.

**They happened before delivery-failure accounting.** `stranded=true` describes
a card nothing will revisit; a card whose repair threw before any Slack call
was made has no attempt, no backoff and no log at all, because both lanes'
per-item repair was `.catch(() => undefined)`. The sweep now tallies those
failures and reports one bounded line per (lane, stage, category) per pass —
tenant, lane, stage, count, the first entity id, and an Agor-owned category,
never the exception and never anything a provider said. `missing_tenant_scope`
is named on its own because it is the class that has now bitten six times.

Two laundering paths in the same shape survived that pass and are closed here:

- **The connect card's grant-liveness read.** `.catch(() => false)` turned any
  failure into "not connected" — the right card and the wrong silence, because
  the delivery then SUCCEEDS and the sweep's per-item `.catch` never sees it.
  The verdict still fails closed; the failure now joins the same tally under
  `stage=grant_liveness` (and reports one line of its own when the delivery did
  not come from a sweep pass).
- **`stranded` was counted, not read.** `logSlackDeliveryFailure` derived
  terminal from `attempt >= 6`, but `applySlackDeliveryFailure` also gives up
  when the next backoff would land past `delivery_retry_until` — so a card
  stranded by an exhausted 15-minute window after four attempts was reported as
  a routine, retryable `warn`. Terminal is now read off the persisted retry
  decision (`slackDeliveryRetryDisposition`), and the new `disposition` field
  separates the four non-retrying endings: `attempts_exhausted`,
  `retry_window_exhausted`, `ownership_lost` (another claimant owns the record,
  so it is theirs to retry) and `accounting_failed` (the durable write itself
  failed, so nothing is known). The first two are `stranded=true` at `error`.

**The fixtures could not see them.** Three things changed:

- The two Slack lanes' integration fixtures no longer opt into the production
  scope guard one test at a time. `createSlackLaneHarness` sets
  `requireTenantScope` unconditionally, so a new case in either lane cannot
  forget it.
- The §7.1.2 restart drive is automated. `gateway-mcp-slack-sweep.test.ts`
  starts from a widget carrying only its mint marker, in a real migrated
  database with real repositories and the guard armed, and reaches the real
  settings, repository and connector boundaries through
  `refreshChannelState` — the entry point a daemon start actually calls.
- The delivery contract is written once for both lanes.
  `gateway-mcp-slack-delivery-contract.test.ts` states lease loss (post and
  edit) and send/commit ambiguity as cases both lanes must satisfy.

That last one found the divergence it was written to find. §7.1.1 taught the
connect lane to retire a post that lost its claim; the recovery lane never
learned it, and neither lane reconciled an EDIT that lost its claim. Both now
share `retireOrphanedSlackCard` and both repaint a render they no longer own.

That extraction has now happened — see **7.1.10**. The contract suite is what
made it checkable, and it is byte-identical across it.

### 7.1.7 The batch-A real-stack drive

Same shape as §7.1 and §7.1.2 — a real daemon (`tsx src/main.ts`), an isolated
`HOME`, a migrated SQLite database, and **Slack's API and only Slack's API
replaced** at `WebClient.prototype.apiCall` — repeated for the delivery paths
this batch touched. Fifty widgets on an unaligned channel and one healthy
widget behind them, all seeded through real repositories before the daemon
started, so nothing in process knew any of them existed.

| Case                                         | Result                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start with 50 refused markers ahead          | One `chat.postMessage`, for the healthy card, with the sealed token in the fragment. All 50 refused markers rescheduled into the future; none retired.                                                              |
| Administrator re-enables `align_slack_users` | All 50 previously blocked cards delivered once their rescheduled time arrived — one post per thread, no duplicates. The marker kept its trigger and gave up its queue position, which is the whole intent.          |
| Delayed edit loses its claim                 | Two `chat.update` calls on the same `ts`: the late edit putting the Connect button back, then the repaint removing it. Durable end state `status: dismissed`, `rendered_state: cancelled`, no claim, no repair due. |
| Restart on the fixed tree                    | No card reposted or repainted; 51 records steady.                                                                                                                                                                   |

The A1 interleaving was driven rather than simulated: the fake Slack layer runs
a **separate process** on the first `chat.update`, which takes the widget row
through the real `MessagesRepository.mutateMetadataLocked` and leaves exactly
what a second claimant leaves — dismissed widget, `cancelled` rendered onto the
recorded `ts`, claim released.

What this drive could NOT discriminate is the tenant-scope fix. The inbound
path it can reach is `POST /gateway` with a personal API key, and that request
holds a tenant database scope for its whole life, so the pre-fix build warns
correctly there too. The path the defect is on — `GatewayService.create` called
**directly** by the Socket Mode listener under `runWithTenantContext` and
nothing else — needs a live Socket Mode connection the fake does not provide.
That entry shape is what the regression test drives, against the production
guard, and it fails on the preceding commit.

### 7.1.8 The batch-B real-stack drive

Same shape again — a real daemon (`tsx src/main.ts`), an isolated `HOME`, a
migrated SQLite database, and **Slack's API and only Slack's API replaced** at
`WebClient.prototype.apiCall` — for the three-milestone recovery B1 added and
the operator control B2 added. Four widgets seeded through real repositories
before the daemon started, each carrying the delivery record a completed
provider round-trip leaves behind: the link consumed, the flow started,
`oauth_succeeded_at` stamped, and no browser ever coming back. The grant itself
is a written `user_mcp_oauth_tokens` row, the same substitution §7.1 and §8
made, because `/mcp-servers/oauth-start` performs real discovery against the
vendor endpoint.

The link was re-sealed by the daemon and taken out of the posted Block Kit
button, so every HTTP call below used the URL a user would actually have
tapped, not one the driver constructed.

| Case                                        | Result                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grant landed, page closed, link live        | Card edited in place to _Finish connecting Notion_ with a re-sealed button. Same `delivery_generation`, same `jti`, same clock.                                          |
| Reopening that page                         | Preflight answered `finish_required` — not `connected`, which is what it used to claim while the widget was still pending and the agent still asleep.                    |
| Pressing the button                         | Widget `submitted`, server attached (one `session_mcp_servers` row), one auto-resume task, card repainted to _Notion connected_, resume message relayed into the thread. |
| Pressing it twice                           | `201` with `already_resolved: true` and `auto_resume_queued: false`. No second attach, no second task — the task id IS `widgetAutoResumeTaskId`.                         |
| Claim abandoned two minutes                 | Card offers the finish; the POST reclaims and completes, logging `event=widget_resolution_reclaimed`.                                                                    |
| Claim five seconds old                      | Card stays _sign-in is in progress_ and the POST is refused. Two browsers racing one card do not take it from each other.                                                |
| Grant landed, link lapsed                   | _Notion is signed in, but not finished_, no button, and no `next_repair_at` — nothing re-mints on a timer.                                                               |
| Kill switch: read / non-admin / non-boolean | `{tenant_id, enabled}`; `403` on both methods for a member; `400` on `"off"`, not a write.                                                                               |
| Kill switch off, two sweep ticks            | Zero `chat.postMessage` and zero `chat.update`. A live link redeemed in that window was refused.                                                                         |
| Kill switch back on                         | Card repainted within one tick, and the same link — never consumed — worked again.                                                                                       |

**This run found two defects, both fixed here**, and neither was reachable from
any suite.

**The finish card offered a button redemption would have refused.**
`mcpOAuthConnectClaimsMatchDelivery` compares whole-second `iat`/`exp` against
the record's ISO timestamps for _equality_; `issueMCPOAuthConnectLink`
second-aligns its clock for exactly that reason, in a comment, one function
away. `resealMCPOAuthConnectLink` inherited that invariant silently and nothing
asserted it — including the test fixture standing in for a real record, which
was itself unaligned and passed only because no test ever tried to redeem what
the card posted. The re-seal now re-reads what it just sealed through
redemption's own two functions and returns `null` when the answer is no, which
makes the card's central promise structural rather than remote. The delivery
loop asks it above the steady-state shortcut, because whether a link can be
produced is part of which state the card is in; deciding it below left the
shortcut, the claim and the expiry timer reasoning about a state the card then
could not render, and redrew a settled `finish_stalled` card every tick. That
also retired the re-entrant bounce, whose "cannot happen twice" argument only
ever held for the lapsed reason. Latent rather than live — only
`issueMCPOAuthConnectLink` writes these records, and it aligns — but the whole
point of this state is that a card cannot offer a finish `/oauth-resolve` would
refuse, and that was true by coincidence.

**A claim whose resolver died was unrecoverable from Slack.**
`mcpSlackConnectRenderedState` has an explicit branch offering the button once
an abandoned claim is old enough for `submissions.ts` to take it over — and the
delivery loop could never reach it, because `resolveSlackConnectBinding`
refuses any widget that is not `pending`. So the exact B1 scenario, one step
further along (the browser got as far as claiming, then died), left a card
reading "sign-in is in progress … this message updates when it lands", forever,
with nothing to press. The binding now admits `resolving`. That grants nothing
extra: a `resolving` widget is a pending one with a claim on it, nothing on the
render path mints, and the one caller that does re-checks `status === 'pending'`
under the row lock — so a claimed widget can only have the link it already has
re-sealed, which is strictly less than an issue.

What this drive could **not** discriminate:

- **B3's disclosure fix.** The bound only bites past 1000 characters and the
  longest disclosure in `curated.yaml` is GitHub's, at 808. Every catalog entry
  therefore arrives byte-identical before and after the change, so the drive
  posts the same text either way. Only the unit tests, which supply a synthetic
  over-long entry, tell the two builds apart — the truncation was latent, and
  the fix is about what the next long disclosure would have lost.
- **The kill switch's in-flight half.** The drive proves delivery stops and
  redemption stops. The third check — `assertSlackConnectFlowStillAuthorized`,
  the one that stops a callback _already in the air_ — sits after a real
  provider round-trip this harness cannot produce, for the same reason §7.1
  gave. The integration test drives that entry shape directly.
- **The cross-tenant step of the operator procedure.** This deployment is
  `mode=static tenant=default`, so "read, change, verify, **next tenant**"
  cannot be walked here; only its first four steps were. The route echoes the
  tenant it acted on and `mcp-slack-connect-control.test.ts` drives a second
  tenant against a real migrated database.
- **The provider round-trip**, as before. Everything the daemon decides about
  the grant is real; obtaining it from Notion is not.

One thing the drive established rather than tested, worth writing down: a
finish link is re-sealed on the ORIGINAL link's clock, and that clock is
`MCP_OAUTH_CONNECT_TOKEN_TTL_MS` — ten minutes from the mint, not from the
sign-in. A provider consent flow eats much of it, so for a real abandoned
sign-in `finish_stalled` is the likely state and `finish_required` is the lucky
one. That is deliberate (§7.2 refuses to extend a consumed link's clock), and it
is why `finish_stalled`'s copy has to be, and is, a true instruction: asking
again in the thread mints a fresh widget, whose already-connected short-circuit
spends the grant that is on file without a second sign-in.

### 7.1.9 The D4.1 real-stack drive

Same shape as §7.1.7 and §7.1.8 — a real daemon (`tsx src/main.ts`), an
isolated `HOME`, a migrated SQLite database, and **Slack's API and only Slack's
API replaced** at `WebClient.prototype.apiCall` — for the one state D4.1 is
about. Two OAuth servers seeded through real repositories, differing only in
the grant on file:

- **Notion** — access token expired an hour ago, refresh token present and
  `refresh_status` idle: `live: false, refreshable: true`.
- **Linear** — same lapse, no refresh token: `live: false, refreshable: false`.

Plus one B1 card: a `pending` widget in a Slack thread whose delivery record
carries a consumed link, `oauth_succeeded_at`, and no browser ever coming back
— pointed at the Notion grant.

The whole probe was run twice against the same seed, once on the pre-commit
rule and once on this one, which is what makes it discriminating rather than
merely reassuring.

| Probe (Notion, refreshable)                | Before (`live`)                                                    | After (`live \|\| refreshable`)                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `agor_mcp_servers_auth_status` over `/mcp` | `oauth_authenticated: true`                                        | `oauth_authenticated: true` (unchanged — this is the surface the merge already widened) |
| `agor_widgets_request_oauth` over `/mcp`   | `status: requested` — **a Connect card posted into the thread**    | `status: already_present`, server attached, auto-resume queued, no card                 |
| The B1 card on the repair sweep            | no edit at all: stayed _Sign-in is in progress_, no button, no end | edited in place to _Finish connecting Notion_ with a re-sealed button                   |
| `POST /mcp-oauth-connect` (preflight)      | not reachable — no card, so no link to open                        | `finish_required`                                                                       |
| `POST /widgets/:id/oauth-resolve`          | 403 _"Sign-in to Notion has not completed. Finish the provider…"_  | `submitted`, `auto_resume_queued: true`, server attached, card repainted to _connected_ |

The before column is the incoherence stated as one transcript: the same daemon
told the agent `oauth_authenticated: true` and then, one tool call later,
posted a Connect card for that server; and the user who had actually signed in
was told to go and sign in.

**Linear is the control and it did not move.** On both builds
`agor_mcp_servers_auth_status` answers `false` and the mint renders a Connect
button — so this is a widening to `refreshable`, not to "a grant row exists".

What this drive could **not** discriminate:

- **The gateway's pre-prompt warning.** It already suppressed for `refreshable`
  before this commit; only its spelling changed (`!live && !refreshable` →
  `!mcpOAuthGrantIsConnected`). Both builds stay quiet about Notion and warn
  about Linear, so the drive cannot tell them apart, and nothing here should be
  read as evidence for that call site beyond "it still behaves".
- **The `refreshing` boundary.** Every grant in the drive is idle; the states
  where the settle wait now does and does not run (`ambiguous`, or a
  `refreshing` row with no refresh token) are reached only by racing the JIT
  refresh, which this harness cannot schedule. Those are pinned in
  `widgets/oauth/index.test.ts` instead.
- **Whether the refresh would actually succeed.** The drive proves Agor treats
  a refreshable grant as connected; it never asks Notion to honour the refresh
  token, for the same reason §7.1 gave. That is precisely the case the reactive
  recovery lane covers, and the argument for optimism here rests on that lane,
  not on the refresh being certain.
- **The provider round-trip**, as before. Every decision the daemon makes about
  the grant is real; obtaining one from Notion is not.

### 7.1.10 The delivery engine, and what stayed in its lane

Two architecture reviews named the duplicated delivery machinery as this
branch's main outstanding debt, and both declined to block merge on it for the
same reason: unifying the two lanes in the PR that fixes four bugs in the
working half is how you break the working half. It is done here anyway, at the
owner's request, so the whole job was to do it without changing behaviour and
to be able to prove that.

The proof is `gateway-mcp-slack-delivery-contract.test.ts`, which is
**unchanged** — byte-identical, hash `e449e210`, verified against the
pre-extraction tree. It is deliberately blind to how a lane satisfies it, which
is exactly what makes it a usable fence here: nothing in it could be quietly
adjusted to accommodate a lane that moved.

`services/mcp-slack-delivery-engine.ts` owns the mechanics:

| Shared                                                                  | Why it was safe                                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applySlackDeliveryFailure`                                             | The two backoff transitions were byte-identical over identically-spelled fields.                                                                   |
| `slackDeliveryClaim`, `slackDeliveryClaimIsLive`                        | Same 30s lease, same CAS predicate; one lane spelled the constant, the other inlined `30_000`.                                                     |
| `slackDeliveryRepairAt`                                                 | The clamp only. Which states count as ACTIVE stays with the lane that owns the states.                                                             |
| `slackRenderWasLost`, `clearSlackRenderedState`, `clearLostSlackRender` | The §7.1.5 lost-edit repair, identical modulo the identity fence.                                                                                  |
| `retireOrphanedSlackCard`                                               | Already shared; moved out of the class unchanged.                                                                                                  |
| `sendSlackCard`                                                         | `findMessageByMetadata` reconciliation plus the post/edit, and the reconciled `ts` the settlement CAS needs to tell a post from an edit.           |
| `acquireSlackDeliveryConnector`                                         | Refusing a draining listener's connector across a generation change, and re-verifying app identity and write target on freshly loaded credentials. |
| `logSlackDeliveryFailure`, `recordSlackDeliveryFailure`                 | Failure accounting and the `stranded=true` line.                                                                                                   |
| `SlackDeliveryTimers`                                                   | Five hand-rolled copies of don't-double-schedule / free-the-key-before-running / `unref` / clear-on-dispose.                                       |
| `SlackDeliveryStore`                                                    | The one real difference between the lanes' storage: a notice on a Task's metadata versus a delivery on the widget message's.                       |

One shared entry is an authority decision, and the table above states it
flatly rather than as mechanics: `acquireSlackDeliveryConnector` refuses to
deliver when the channel now belongs to a different Slack app, or when the
recorded thread is no longer a permitted write target. That is **delivery**
authority — may this daemon, as this app, write this card here — and it is
common to both lanes because it is a property of the channel rather than of
either record. It is not OAuth or redemption authority: nothing in the engine
decides who may sign in, what a link grants, or whether one may be redeemed,
and each lane takes the `app_moved` answer and does its own thing with it. The
module doc says the same, so "the engine holds no authority" is not a
conclusion a reader can draw from either.

What deliberately did **not** move, and would have merged two authority models
if it had:

- **Rendered state.** `mcpSlackRecoveryRenderedState` reads a Task's status,
  recovery generation, settled request id and provider dispatch;
  `mcpSlackConnectRenderedState` reads a widget's own lifecycle. Recovery
  repairs an active task; connect admits a new turn. Different questions.
- **Tokens.** Two audiences (`agor:mcp-slack-recovery`,
  `agor:mcp-oauth-connect`), two binding sets, two issue paths. The connect
  lane additionally re-SEALS rather than re-issues once a grant has landed;
  the recovery lane has no such state.
- **Re-issue and grant liveness.** `mcpSlackConnectMayReissue`, the
  `grantConnected` read, and the `finish_required`/`finish_stalled` split are
  connect-only, because only that lane has three milestones with two owners.
- **`generationCurrent`.** The connect record treats an ABSENT sealed
  generation as current (the field postdates the record); the recovery notice
  always carries one. That is a property of the records, so the predicate
  stays with the caller and only its consequences are shared.
- **The thread-mismatch tail.** Both lanes release the claim identically when
  the channel is disabled or is no longer Slack. When the recorded thread stops
  matching the channel's write policy they diverge: the recovery lane fences
  the write on its claim and leaves `next_repair_at` unset, while the connect
  lane's `invalidateMcpSlackConnectBinding` fences only on
  `binding_invalidated_at` and asks for an immediate repair. The difference is
  small and looks unintentional, but squaring it would be a behaviour change —
  so it is left exactly as it was and recorded here instead.
- **The mint marker.** `slack_connect_due_at`, its retirement and its §7.1.5
  reschedule are connect-only; the recovery lane's trigger is the Task itself.

Also added: `mcp-slack-delivery-engine.test.ts`, 36 cases against the
mechanics directly, checked against three mutations it has to catch (an
off-by-one in the claim-liveness boundary, a dropped claim fence in failure
accounting, and reuse of a draining listener's connector across a generation
change). It is a separate file precisely so the contract suite could stay
byte-identical.

### 7.1.11 The delivery-engine real-stack drive

Same shape as §7.1, §7.1.2 and §7.1.7 — a real daemon (`tsx src/main.ts`), an
isolated `HOME`, a migrated SQLite database, and **Slack's API and only Slack's
API replaced** at `WebClient.prototype.apiCall`. One gateway channel, one
`oauth` widget and one recovery notice, seeded through real repositories before
the daemon started, so nothing in process knew either existed.

| Case                                  | Result                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First card, both lanes                | One `chat.postMessage` each, in their own threads. Each stamped with its OWN `slack_message_metadata` event type (`agor_mcp_connect`, `agor_mcp_recovery`) through the shared `sendSlackCard`, each preceded by the `conversations.replies` reconciliation lookup.                  |
| Link-bearing render                   | The connect card carried a `Connect Drive server` URL button whose fragment is a 1282-character sealed token — the shared claim, mint, send and settle path end to end.                                                                                                             |
| Restart on the extracted tree         | Nothing reposted, nothing repainted. The no-op shortcut and the recorded `rendered_state` held across a process boundary.                                                                                                                                                           |
| State transition, both lanes          | Each lane edited its OWN recorded `ts` in place (`chat.update`, never a second post), took the button away, settled `rendered_state`, released the claim and cleared its due column.                                                                                                |
| Slack refuses every write, both lanes | The identical ladder: `attempt=1/6 retrying=true` through `attempt=6/6 retrying=false stranded=true`, then `delivery_attempt_count=6`, no next retry, no due work, no claim. The strongest single piece of evidence that the two lanes now run one failure and scheduling mechanic. |

What this drive could NOT discriminate:

- **The recovery lane's link-bearing render.** The seeded notice's own clock and
  the task lifecycle the drive forced through raw SQL carried it through
  `expired_or_superseded` and `manual_next_turn`; both are correct decisions
  for the history it was given, but neither offers a button. That lane's token
  issuance is pinned in `gateway-mcp-slack-recovery.test.ts`, not here.
- **Lease loss and its two repairs.** A single daemon with no concurrent
  claimant cannot orphan a post or lose an edit. That is precisely what the
  contract suite drives, by injecting a second claimant mid-Slack-call — which
  is why it, and not a drive, is the fence this refactor is held to.
- **The tenant-scope class**, for the reason §7.1.7 gave: the entry shape the
  defect lives on needs a live Socket Mode connection the fake does not
  provide.
- **The provider round-trip**, as always. Every decision the daemon makes is
  real; obtaining a grant from a vendor is not.

### 7.1.12 A registration coverage gate for the tenant-scope class, and what it does not catch

Five instances of one defect class, three of them found after a reviewer had
already looked, and one of them (§7.1.3) proof that the shipped recovery lane's
repair sweep had never once repaired a notice. Every fix so far was per-site.

**What this is: a Feathers registration coverage gate, plus a safer
data-access convention.** It makes the policy **explicit at registration** —
adding a service without deciding where its scope comes from stops being
something a pull request can do quietly — and it leaves the platform-wide sweep
undone. An earlier draft of this section, and a reviewer's summary to the
owner, described it as making the defect class _structurally impossible_. It
does not do that, the difference is large, and the limits are now written down
both here and at the mechanism (see "What it does not catch" below).

**The classification.** Every service the daemon registers now declares where
its tenant database scope is armed — `scoped`, `identity-only`, or a narrowly
reviewed `system`, each with a written `why`
(`utils/tenant-service-classification.ts`). The two existing hook inventories
are the declaration for the paths they name: `TENANT_OWNED_SERVICE_PATHS` means
`scoped` and `TENANT_IDENTITY_ONLY_SERVICE_PATHS` means `identity-only`, because
those lists are what actually installs the hook and a second copy would be a
second place to be wrong. The new table is only for services registered outside
both — which is exactly where every one of the five defects lived.

`assertTenantServiceClassification(app)` runs at boot as Phase 3.6, next to
`assertRealtimePublishPolicyCoverage` and for the same reason: it reads the
registration table rather than request data, so a deployment that boots in CI
boots in production.

**What this feature classified.** `identity-only`: `mcp-oauth-connect` and
`mcp-slack-recovery` (the sealed-token browser preflights — the two
registrations whose missing scope made a valid link look revoked),
`widgets/:id/{submit,oauth-resolve,dismiss}`, `mcp-catalog/{connect,start-session}`,
and `mcp-servers/oauth-callback`. `scoped`: `mcp-slack-connect/card`,
`mcp-member-policy` and `mcp-egress/status`, all registered through the
tenant-scoped route registrar. `system`:
`mcp-servers/oauth-browser-reservations`, which touches no database at all — its
reservation lives in a process-local map and its authority comes from the live
Socket.IO connection projection.

**The facade.** `createTenantBoundDataAccess`
(`utils/tenant-bound-data-access.ts`) is what an `identity-only` service holds
instead of a `TenantScopeAwareDatabase`. It exposes three things — `repository`,
`read`, `write` — and every one of them enters a tenant database scope first.
There is no accessor that returns the underlying handle, so the move that
produced all five defects (hand `db` to a free function over `app_variables`, or
to a shared reader that builds its own repositories) is not reachable from a
holder of it. `GatewayService` now binds every repository and its
`readInTenantScope` through one, and keeps the raw handle only for the two
things the facade deliberately cannot do: explicit SYSTEM scopes for
cross-tenant listener discovery, and dialect inspection that must answer outside
any scope. Both are named and commented as the exceptions they are.

The binder's pinned `tenantId` is right for request-owned deferred work and is
now documented at its definition as what it is: **not authorization.** It names
a partition the surrounding work already established; it decides nothing about
who the caller is or what they may do, and it must never be traceable to caller
input that skipped identity resolution. The facade's pinned form makes that hard
to reach for by accident — it refuses to construct without a written `because`,
so a grep for `pinned` is a complete review list.

**The baseline.** Classifying every authenticated service in the daemon is a
platform sweep and does not belong in a feature pull request, so the 57 services
that predate the mechanism are listed and permitted. The list may only shrink,
and three ratchets say so: a **new or newly-unclassified** service fails the boot
assertion; an entry that has since been classified or is no longer registered
fails the test with "remove it from the baseline"; and
`check:multitenancy-boundaries` compares the `BASELINE-ENTRY` **names** in the
file against an approved inventory in the script itself. What is left in it is
deliberate — the session/branch/repo/artifact RPC routes, `authentication`,
`health`, the streaming services — none of which this feature understands well
enough to classify correctly, which is the whole reason the baseline exists
rather than a guess. 57 stays, and there is deliberately no deadline on it: a
deadline buys speculative classifications rather than correct ones.

That third ratchet counted markers until this pass, and a count cannot express
"may only shrink". Classify or delete one old entry, list one different
newly-registered service, and the total is still 57 with every check green — a
replenishable allowance rather than a closed debt inventory. Both reviewers
found that independently. Membership closes it in both directions: an unapproved
name fails, and so does an approved name that left the file without leaving the
script, which is what stops a name from being re-listed later.
`scripts/check-multitenancy-boundaries.test.mjs` drives the replacement case
(one out, one in, same count) alongside the 58th-entry case, and states the old
rule inline so the escape is visible rather than described.

**What the tests see that the old ones could not.** §7.1.3 recorded the reason
this class was never caught: _a test that stubs every repository has no guard to
trip._ `tenant-bound-data-access.test.ts` therefore runs a real migrated SQLite
database behind `createTenantScopedDatabaseProxy(..., { requireScope: true })`
and shows both halves on the same handle — `isMCPSlackConnectCardEnabled(db)`,
the actual kill-switch read from the actual defect, rejects with
`MissingTenantDatabaseScopeError` under `runWithTenantContext` alone, and
resolves through `data.read(...)` from the identical caller shape. The
classification suite proves a brand-new unclassified service is refused by name
and that a classified one is admitted from any of the three inventories.

**What it does not catch.** The gate compares `Object.keys(app.services)`
against the declaration tables. It reads no handler, inspects no registrar and
instruments no query, so a declaration is a claim rather than a proof. All of
these pass today, and
`apps/agor-daemon/src/utils/tenant-service-classification.limits.test.ts` drives
each one and pins the passing result — a test that documents what the mechanism
does not catch, so the next reader cannot over-read it:

| Escape                                                                                 | Why it gets through                                                                                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| An `identity-only` service that keeps a raw handle and makes the unscoped call         | Nothing checks the handler. Only the runtime guard objects, and only once it runs.                                |
| A `scoped` entry in the supplemental table whose registration never installed the hook | Only `TENANT_OWNED_SERVICE_PATHS` and the scoped route registrar install one; a hand-written `scoped` asserts it. |
| New code inside an already-classified service, or a timer or sweep callback it starts  | The unit of declaration is a registered path, not a line of code.                                                 |
| Express handlers — `app.post('/mcp-egress/:serverId', …)` is a live example            | They are not in `app.services` at all.                                                                            |
| Anything registered after the one-time boot assertion                                  | Phase 3.6 runs once.                                                                                              |

The facade is likewise **not a capability sandbox**: `read` and `write` hand the
callback the scoped handle, which it may retain or pass on, and `read` is a name
rather than an enforcement — nothing stops a `read` callback from writing.
`tenant-bound-data-access.test.ts` pins both. What it does remove is the raw
handle from the holder's reach, which is the move all six defects began with.

Closing the escapes means connecting classification to the actual registrar or
to injected dependencies. That is a platform change and is deliberately not in
this branch.

**Not touched.** No authorization decision, no route registration, and no
service moved between the hook inventories. This is about _where a scope is
armed_, not _who may do what_.

### 7.1.13 Three blocking defects from the final correctness review

Two of the three are in platform code this branch absorbed rather than in the
Slack lane, and the third is the lane's own third instance of one rule.

**B1 — a shared scope store could serve the wrong database.** §9's follow-up F4
keyed the tenant scope stores and the proxy-target map on `Symbol.for` so they
are the process's rather than each bundled copy's, which is what makes core's
scoping mean anything in a built artifact. What that sharing did not come with
is any check that the scope on the store belongs to the database being asked
about. `scopedTarget` routed every guarded proxy to `store.db`, and
`runWithTenantDatabaseScope` joined whatever scope was open — both
database-agnostic within one module copy already; `Symbol.for` extended the
reach to previously independent copies.

Driven on the **built artifact**, because source resolution is what hid F4:
`packages/core/dist/db/index.js` imported twice under different URLs, which is
two independent evaluations of the file a daemon actually loads. Two SQLite
databases, told apart by one app variable — A's card projection off, B's on.

| Probe (two built copies, databases A and B)      | Before                                   | After                             |
| ------------------------------------------------ | ---------------------------------------- | --------------------------------- |
| B's guarded proxy outside any scope              | `MissingTenantDatabaseScopeError`        | `MissingTenantDatabaseScopeError` |
| B's guarded proxy **inside A's scope**           | `false` — **A's row, through B's proxy** | `MissingTenantDatabaseScopeError` |
| A scope opened explicitly for B, from inside A's | `false` — A's handle again               | `true` — B's row                  |
| A's proxy inside A's scope (control)             | `false`                                  | `false`                           |

The fix is a fence, not a redefinition: both scope shapes now carry `rootDb`,
the fully unwrapped handle the scope was opened on, and routing and nested
admission compare it before serving. Two handles count as the same database —
the base, and the scoped handle the scope itself produced — so passing a
transaction handle back into an entry point still joins rather than being told
it is foreign. Nothing about what a scope _means_ changed, which is the line
the fix was asked to stay behind.

Called out precisely: this is confirmed **wrong-database routing**, not a
demonstrated cross-tenant read. Agor runs one database per daemon, so the
reachable population is test and tooling processes that hold two.

What it could **not** discriminate: the drive is SQLite, so it shows routing
and not RLS. On PostgreSQL the same fence decides which base a transaction is
opened on; the PostgreSQL lane (393 tests, 79 files) is green, which says the
fence broke nothing there, not that a second PostgreSQL database was driven.

**B2 — the tenant-bound facade answered with no tenant.** With neither a pin
nor ambient identity, `read`/`write` still entered
`runWithTenantDatabaseScope(db, undefined, …)`. That is not a weaker scope: with
no tenant it opens one the proxy guard does not accept and hands the callback
the _unwrapped_ base handle, so the callback reached the database with no guard
and no RLS tenant — and `write` had nothing to check the per-tenant write gate
against, so it skipped it. A deferred caller that lost its identity became
silently successful, the exact inverse of this facade's purpose. It now throws
`MissingTenantIdentityError`, as a rejection rather than a synchronous throw.

**Callers checked.** `GatewayService` is the only holder. It binds 13
repositories through `repository()`, has six `read` call sites (all through its
own `readInTenantScope`, all inside `runWithTenantContext` or a request), and
**no `write` call site at all**. None relied on the permissive path. `repository()`
is deliberately left as it was: it is core's `bindRepositoryToTenantUnitOfWork`
verbatim, shared with every other binder in the codebase, so tightening it is a
platform change rather than this facade's. Core's own tolerance of an absent
tenant also stays — §9's standalone refresh path has never had trusted tenant
identity and requiring one there would be an authorization change.

**B3 — an abandoned dismissal advertised as a recoverable finish.** The third
time this lane has produced an offer the resolver would refuse, and the second
time the rule was written down before being broken. `mcpSlackConnectRenderedState`
checked the resolution claim's AGE against `WIDGET_RECLAIM_ABANDONED_AFTER_MS`
but not its ACTION. `submissions.ts` admits an abandoned claim only for its own
action, and this card's button posts `oauth_callback` — so after "Not now" was
tapped, the resolver died holding a `dismiss` claim, and sixty seconds passed,
the card and the page both said _Finish connecting_ over a POST that comes back
"already resolving; cannot oauth_callback again". The state machine now requires
`resolution_claim.action === 'oauth_callback'`, which also excludes `submit` —
this lane is `daemon_verified`, so nothing else could ever finish it.

**The real-stack drive, re-run.** Same seed on a build without the fix and with
it, through `createSlackLaneHarness` — a real registered app, a real migrated
SQLite database with `requireTenantScope` armed, real repositories, and a link
minted by `issueMCPOAuthConnectLink` rather than hand-built:

| Surface                                               | Before                                                        | After                                   |
| ----------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `POST /mcp-oauth-connect` (the page the button opens) | `finish_required`                                             | `sign_in_pending`                       |
| The Slack card, through the delivery loop             | edited to _Finish connecting Notion_, with a re-sealed button | no edit; record stays `sign_in_pending` |
| `resolveWidget(…, { kind: 'oauth_callback' })`        | `already resolving`                                           | `already resolving`                     |
| The widget row afterwards                             | still `resolving`, claim untouched                            | still `resolving`, claim untouched      |

What it could **not** discriminate:

- **The refusal half moved at all.** It does not: the resolver's answer is
  identical on both builds, which is the whole point — the card changed to
  agree with it. Its column is a control, pinned in
  `widgets/submissions.test.ts` (an abandoned `dismiss` claim refuses
  `oauth_callback`, the mirror of the case that was already there).
- **The two halves in ONE process.** `register-services.oauth-sqlite.
integration.test.ts` registers services and not routes, so
  `/widgets/:id/oauth-resolve` is not reachable from it; the card row comes
  from the delivery-loop harness in `gateway-mcp-slack-connect.test.ts` and the
  resolver row from the resolver's own suite. Three real surfaces, three
  harnesses — not one transcript.
- **What the card should say instead.** It falls through to the pre-existing
  `sign_in_pending` copy, which used to read "Sign-in is in progress. Finish it
  in the browser tab Agor opened" — imprecise for a reader who tapped "Not now"
  and has no such tab. The card offering nothing is the property that was
  broken and it is fixed; the wording is now conditional ("If you started a
  sign-in, finish it in the browser tab Agor opened"), which is true of both
  arrivals at this state. A separate rendered state would say it better and
  would mean a new persisted `rendered_state` value for a copy difference, so
  that is still not done.

### 7.1.14 The seventh instance, and why `getBaseUrl` now demands a handle

The live Slack failure was not in the Slack lane's logic. It was one argument.

`GatewayService.mcpSlackConnectDeps` called a **bare** `await getBaseUrl()`.
Under `multi_tenancy.mode: required_from_auth` — which the cloud stack runs —
`getBaseUrl` ignores `AGOR_BASE_URL` entirely and resolves the tenant's own
origin from durable routing, which needs an explicit database handle or an
ambient tenant database scope. Every entry into `deliverMcpSlackConnectCard`
carries tenant CONTEXT and neither of those: `deferWithTenantContext` has left
the request's scope by the time it runs, the repair sweep and the expiry timers
use `runWithTenantContext`, and both `register-services.ts` callers sit on
`identity-only` routes. So it threw
`Tenant public links require a tenant database` on the **first line** of
delivery — above the refusal classifier, above the marker retirement, above the
claim. The lane reported `reason=unexpected`, classified nothing, posted
nothing, and retried on the unbounded clock until it stranded.

`gatewaySessionConnectUrl` (`mcp/tools/widgets.ts`) made the identical bare
call inside a `try/catch` returning `null`, which is why the same deployment's
`agor_widgets_request_oauth` came back with no `session_url` and no
`relay_to_user`, and the agent promised a button instead of handing over a
link. That is the fallback §7.1.4's runbook promises on every platform when the
card is off or refused, so both halves of the lane's degradation story were out
at once.

Three things changed.

**The two call sites pass `this.db` / the MCP tenant scope.** The connect lane
also gained the `if (!baseUrl) throw` guard the recovery lane
(`mcpSlackRecoveryUrl`) has always had and this one lacked. A handle is not
routing: an uninitialised tenant answers `''`, `getMcpOAuthConnectUrl('')`
answers `''` too, and the button URL degrades to a bare `#token=<jwt>`. Slack
rejects those blocks — and since the one-use token is minted before the post,
each of the six attempts burned a fresh link before stranding. Refusing is one
classified failure with nothing consumed.

**`getBaseUrl(db)` no longer accepts a caller with no handle.** This is the
seventh instance of the tenant-scope class on this branch, and §7.1.12's
`createTenantBoundDataAccess` facade could not catch it precisely because the
parameter was optional: "forgot to pass it" compiled. Making it required was
mechanical — all ~40 existing call sites already complied, and the only edits
were the two defects plus six assertions in tests that pin the static/local
path, which now hand it a proxy that throws if the handle is touched. **No
caller legitimately needs the old shape.** A caller already inside an open
scope writes `getCurrentTenantDatabase()` rather than nothing, so the reliance
is visible at the call site; there is deliberately no named no-handle variant,
because adding one would reopen the hole for the next caller.

**The suites stopped hiding the argument.** `gateway.test.ts` and
`gateway.github.test.ts` replaced `getBaseUrl` with a constant, which answers
the same string with or without a handle; both now drive the real resolver from
`AGOR_BASE_URL`. `gateway.postgres.test.ts` — the lane closest to the hosted
deployment — keeps a spy, but one that DELEGATES to the real function and
records its argument, so "was it called with a handle" is assertable. The
hosted branch itself is now driven against a real routing row by
`test/hosted-tenant-routing-fixture.ts` in
`gateway-mcp-slack-connect.test.ts` (the card's button URL is on the tenant
origin; an uninitialised tenant gets no card and no burned token) and in
`widgets.oauth.test.ts` (the relayed `session_url` is on the tenant origin, and
is omitted rather than invented when routing has not landed). Both pin the
defective shape by cast, so they fail if the required parameter is ever relaxed
rather than only if the fix is reverted.

**What the HA harness could and could not take.** `scripts/test-ha-tenant-links.mjs`
asserted tenant-origin correctness for BOARD urls only — built inside a
repository that holds `this.db`, and therefore incapable of the defect. It now
also covers the session deep link over REST, read back through the _other_
replica, and through the real `/mcp` endpoint, which is the boundary that arms
tenant context only; plus the ingress shells for the session link and
`/ui/connect/mcp`, the two places this lane sends a person.

It does **not** assert the two fixed call sites end to end, and that is a
property of the stack rather than a shortcut. `session_url` is returned only
for a gateway Session, and `custom_context.gateway_source` is server-managed —
`protectGatewaySourceMetadata` refuses it for every provider-carrying create,
so the only way to make one is a real inbound platform message, which starts an
agent. The card's URL exists only inside a Block Kit post to a real Slack
workspace; the delivery record it leaves behind is stripped from every API read
by `stripWidgetSlackConnectDelivery`, and the URL was never in it. The
hosted-mode unit coverage above is their fence; the harness adds the half no
unit test can have, which is two live tenants on two live origins resolved by a
real daemon.

### 7.1.15 What made a one-line bug take thirty seconds a card to read

`428f4929f` fixed the argument. Three defects around it are why one missing
argument presented as an unreadable loop rather than as a failure, and all
three are closed here.

**D1 — an unclassified exception bypassed delivery accounting.**
`recordSlackDeliveryFailure` writes only when the lane still owns both the
delivery record and the live claim it took, and it is reached from exactly one
narrow `try` plus connector acquisition. Everything above it — the kill-switch
read, `mcpSlackConnectDeps`, `resolveSlackConnectBinding`,
`resealMCPOAuthConnectLink`, the channel read, `issueMCPOAuthConnectLink` —
threw straight past it. In the incident there was no delivery record at all, so
there was nowhere to write even in principle, and the throw also landed above
`rescheduleMcpSlackConnectDueMarker`: `slack_connect_due_at` kept its
permanently-overdue mint timestamp and the sweep re-selected the widget every
thirty seconds for the full 24-hour horizon. **2880 attempts, no card, no
accounting, one `reason=unexpected`.**

Both lanes' delivery now runs inside one outer `try/catch` that routes an
unclassified exception into whichever durable trigger the widget actually has,
and then **rethrows** so the sweep's per-pass tally still counts and classifies
the pass:

- **Claim held** → `unexpected_failure`, a new `MCPSlackDeliveryFailureReason`
  and the only member that is not a decision. It clears the leaked claim,
  counts the attempt, applies the ladder, and strands through the existing
  disposition.
- **No delivery record** → the marker is rescheduled, 30s → 5 min, still
  anchored to `requested_at` and still aged out at `requested_at + 24h`.

The claim is tracked in one mutable ref for the whole delivery rather than per
frame, because each lane re-renders itself internally (a binding that moved, a
revalidated connector, a lost repaint) and the ladder must be consumed once per
pass however many times the card re-rendered inside it.

**No attempt counter was added to the marker**, for §7.2's reason unchanged: a
refused visit costs one binding read and makes no Slack call, which is exactly
what a throw in the prologue is, and a durable counter would strand a card that
a transient blip would otherwise have let recover.

One behaviour change, stated plainly: where a delivery record exists, an
unclassified throw now consumes the ladder, so a genuinely transient fault can
strand a card that previously would have retried past it. That is the intended
trade against a leaked claim plus an unbounded retry.

**Not closed, and named rather than hidden:** a throw with a delivery record
present but no claim taken — the kill-switch read, say — still has nothing this
pass owns to consume, so it rethrows into the tally and the record's own
overdue `next_repair_at` brings it back. It is now a classified line per pass
rather than a silence, which is the part that made the incident unreadable; the
remaining bound would need the durable counter §7.2 declined.

**D2 — an unbuildable link is a classified refusal, not a throw.** The template
was one line above the bug: `masterSecret` has always tolerated an absent
secret and let `resolveSlackConnectBinding` classify it `no_secret`. So
`mcpSlackConnectDeps` now writes `getBaseUrl(this.db).catch(() => '')` — which
replaces the `if (!baseUrl) throw` guard `428f4929f` added — and a new
`SlackConnectBindingRefusal` member **`no_public_url`** sits beside the
`no_secret` guard, covering both `''` and a value no other browser could open.
No rendered-state or copy change: like `no_secret` it falls through
`mcpSlackConnectRenderedState`'s `unaligned || authority_moved` test, so the
`!delivery && !binding.ok` branch reschedules the marker and renders nothing.
Reversible by construction — an administrator fixing the configuration gets the
card within one backoff.

The second condition is the one nothing checked. A static deployment that never
configured a public URL falls back to `http://localhost:3030`, which today
_succeeded_ and posted a card whose button works for nobody but whoever is
sitting at the daemon; `gatewaySessionConnectUrl` rejected `0.0.0.0` and not
`localhost`, and `fetchExistingSessionUrlForGatewayUser` was the copy it was
taken from. One shared predicate — `isBrowserReachableUrl`: non-empty, parses,
not a bind address, not loopback — now answers for all three.

The refusal is **logged once per pass** through the existing tally, as
`stage=binding reason=no_public_url`. A first-card refusal previously returned
in silence, which is a real part of why this was hard to read.

The recovery lane's `mcpSlackRecoveryUrl` threw on an empty base URL — the same
D1 shape, above its own settlement CAS while holding the claim — so it now
answers `undefined`, which is what that lane has always answered for an absent
`AGOR_MASTER_SECRET` and a consumed token: the card goes out, without a button.

**D3 — the tool's contract made absence mean the opposite of the truth.**
`agor_widgets_request_oauth`'s description said that a result containing
`session_url` means a gateway thread where the user cannot see the inline card
— defining its ABSENCE as "not a gateway thread, the user can see the card".
`gatewaySessionConnectUrl` returned `null` for both "canvas session" and
"gateway session, link unbuildable". In the incident the agent did exactly what
it was told and promised a button nobody could see.

It now returns a discriminated
`{ kind: 'not_gateway' } | { kind: 'url', url } | { kind: 'unavailable', reason }`.
`unavailable` surfaces `link_unavailable` in the tool result with a
ready-to-relay sentence that names no configuration key, no hostname, no
internal category and no URL — it gets pasted into a Slack channel, and the
admin-actionable detail stays in the daemon log. The description now says that
absence of both keys is the canvas case, and that the tool **never promises a
card at all**: `queueMcpSlackConnectCard` is fire-and-forget over the sweep, so
the tool genuinely cannot know whether one will ever be posted. A link is the
only thing it can honestly promise. The widget is still minted — the canvas
surface worked, and is what the user actually used.

**The failure classifier.** `reason=unexpected` under-served
`context/guidelines/logging.md`, which asks for a stable category/code, the
operation, the relevant UUIDs and retryability. The repo already had the
pattern in `gatewayFailureCode`: a closed Agor-owned code set derived from
error SHAPE, never the message. `classifyGatewayReadFailure` moved to
`utils/gateway-read-failure.ts` (the MCP tool boundary needs it too) and
widened from a two-value type test to `missing_tenant_scope`,
`missing_tenant_identity`, `no_public_base_url`, `repository_error`,
`unexpected`. It matches on `name` and a stable `code` rather than
`instanceof`, for §9/F4's module-identity reason, and walks the `cause` chain
because the tenant-scope class arrives wrapped in a `RepositoryError` as often
as not.

`getTenantPublicBaseUrl`'s two bare `new Error(...)`s became
`TenantPublicBaseUrlError` with a stable `code`, mirroring
`PublicBaseUrlNotConfiguredError.code`. Every MCP Slack `onError` and `.catch`
that printed a fixed sentence and discarded its error — including
`deferWithTenantContext`'s, which has always PASSED one — now emits one
classified line with the lane and the Agor-owned ids. Never the message, the
stack, or anything the provider said.

The incident's own exception classifies as `missing_tenant_scope`, which is the
class §7.1.14 names it as; with D2's refusal line beside it, 14:57:12 would
have read `stage=binding reason=no_public_url` instead of thirty seconds of
`reason=unexpected`.

**Coverage.** The D1 property is stated once, for both lanes, in
`gateway-mcp-slack-delivery-contract.test.ts` — a channel read that throws once
the claim is on the record (which is what separates it from the binding read
above it, rather than a call index either lane could change), asserted as the
END STATE: nothing sent, the claim gone, the attempt counted, a backoff
scheduled, `reason=unexpected_failure` logged, and the exception rethrown. Both
lanes fail it without the fix. D1's marker branch and both D2 conditions are in
`gateway-mcp-slack-connect.test.ts`; the recovery lane's buttonless card is in
`gateway-mcp-slack-recovery.test.ts`, which asserted nothing about the button
before this. D3 is in `widgets.oauth.test.ts`, including that the relayed
sentence carries no URL and no configuration key. The two new utilities have
their own suites.

**Out of scope, still open.** No Agor-side deadline on any Slack call —
`withGatewayTimeout` exists and is used only for `stopListening` — and the
`setThreadStatus` guard. Separate ticket.

_Since closed for the card lanes._ Every MCP Slack card call is bounded by
`MCP_SLACK_SEND_TIMEOUT_MS`, and the shared web client carries a 15s request
timeout and `fiveRetriesInFiveMinutes`. The deadline stops the caller waiting
but cannot cancel the request, and that ladder kept an abandoned card write
retrying for about five minutes: it could land after a later attempt settled
the card and paint the older state back, and a terminal state schedules no
repair. (`@slack/web-api` v7 takes no `AbortSignal` per call, so cancellation
was not an option.) Card writes therefore ask the connector for one attempt
whose request timeout is the remaining budget
(`SLACK_REQUEST_TIMEOUT_METADATA_KEY`); everything else keeps the ladder. A
write that still lands after its deadline is handed back to its lane and
reconciled like one that lost its claim — an edit of the owned row is repainted
from the authority, a post beside it is retired, and a post onto a record with
no row is left for the next attempt's metadata lookup to adopt.

### 7.1.16 Datadog's redirect-URI mismatch, and one client name for the whole fleet

The next live failure was not in this lane either, and not in the Slack
projection at all. Against `com.datadoghq/mcp` on the HA cell, discovery
succeeded, DCR succeeded — `Dynamic client registered` — and the provider's
authorize endpoint answered `invalid_request — Mismatching redirect URI`.

**The thing it was not.** That Agor sends one redirect URI to DCR and a
different one to authorize was refuted with a probe rather than argued away.
There is one construction site (`config/deployment.ts:175`); `haCallbackUrl` is
that string or `null`, never a third value; HA hard-asserts equality
(`register-services.ts`); one getter returns a startup constant; and
`startMCPOAuthFlowWithAS` binds `actualRedirectUri` once, using it for both
`redirect_uris:[…]` and the authorize parameter. A probe in HA mode with a real
DCR round trip printed `identical = true`.

**A hypothesis, disproven and reverted.** `client_name` is the constant
`'Agor MCP Client'` at both DCR call sites, so every install registers under
the same name. The working theory was that Datadog deduplicates registrations by
name and handed this cell an earlier client bound to a different origin's
callback. The name was changed to carry the callback host and saved server id.
That did not fix it: on the sandbox, Datadog fails at authorize with the same
`Mismatching redirect URI` under **both** names, while the same integration
works on production, which sends the constant. The name is neither the cause
here nor the fix.

It was reverted, because the change was not free. `clientName` is an input to
`bindingFingerprint` (`mcp-oauth-client-registration-authority.ts`), so a new
value makes every stored registration miss on its next OAuth start: the row is
superseded and the server re-registers with its provider under a request that
provider has never seen. That included production's working Datadog
registration, with nothing to show the new registration would be honoured.
`MCP_OAUTH_DCR_CLIENT_NAME` now carries that warning, and
`mcp-oauth-client-registration-authority.postgres.test.ts` pins that a
registration sealed from the deployed request is found and opened by the live
flow with no new registration. Every other fingerprint input, the binding
version, the sealed-material shape, `open()`'s checks and the registration
lookup were compared against `main` and are unchanged by this work.

The sandbox's cause is still open. If a fresh Datadog registration is wanted
there, `POST /mcp-servers/oauth-client-registration-reset` (admin-gated: bumps
`config_version`, deletes the server's grants, invalidates pending flows and
registrations) is the tool — its stored client, registered with
`token_endpoint_auth_method: 'none'`, otherwise reads `ready` indefinitely.

**The blind spot, and its proxy.** A redirect-URI mismatch is rejected
**front-channel**. The provider refuses on its own page and never redirects, so
Agor cannot observe it at all — not in a callback, not in a token response, not
in any provider payload. The only durable trace is a pending flow that expires
with no callback, which is now classified `authorization_never_returned`
(distinct from `authorization_timed_out`, which stays where a callback did
arrive), and whose guidance leads with an unregistered callback URL. Beside it,
one `event=oauth_authorize_built` line per attempt states the binding Agor
used — origins only, never a path, a full URL, a secret, or the provider's
payload, plus `client_source`, `redirect_matches_registered`, and
`client_name`.

The authorize URL also now asserts that the redirect URI it is about to send is
the one the client was registered under, refusing with a named
`redirect_uri_mismatch` (classified `redirect_configuration_required`, because
the provider said nothing — Agor refused its own request) rather than shipping a
URL already known to be wrong. Both values are Agor's and come from one binding
today, which is exactly why it is asserted rather than trusted: there is no
second chance to classify this one.

**The fixture gap that let all of this through.** `/register` was served only
under `rejectDynamicRegistration` (418) or `holdDynamicRegistration`, and the
latter echoed back exactly the `redirect_uris` it was sent. There was no
`/authorize` handler **at all** — tests read `state` off the URL and never
fetched it. So nothing compared registered-vs-authorized, and no fixture
modelled a provider that echoes one thing and stores another. `/authorize` is
now a real endpoint that checks the request's `redirect_uri` against what the
provider REGISTERED, and `registrationStoresRedirectUri` reproduces a provider
that binds one value while echoing another. It is refused at `/authorize`, and
the test asserts the end state that makes this class hard: no callback, no
token, and an attempt still `pending`. (A name-deduplication option was removed
with the name change.)

**Correction to §7.1.14.** The claim that the daemon host serves no `/ui` under
`uiServingMode: "separate"`, and that a link on the cell origin would therefore
404, is false — `https://sdx-us1a-v4.dp-sdx-us1a.cloud-sdx.agor.live/ui/`
answers `HTTP/2 200 text/html` from nginx. The tenant origin is still the right
one for the card's button, but because `/mcp-oauth-connect` needs the browser's
tenant context, not because the cell origin 404s.

### 7.2 Deliberately not built

- **No Slack interaction handler.** The button is a plain URL; Agor registers
  no `action_id` callback for it. Nothing is granted until the browser
  completes a provider flow, so there is nothing for an interaction payload to
  decide.
- **A retired card stays retired.** `binding_invalidated_at` is terminal:
  re-enabling alignment does not make a weeks-old card clickable again. Asking
  again mints a fresh widget, which re-asks every question.
- **One re-issue, not a counter.** A durably failed sign-in may be re-offered
  while the previous link's own clock still runs; the re-issue clears
  `oauth_failed_at`, so another human attempt is required before another.
- **No widget-level TTL.** Still D7, and §7's own `expires_at` is the one clock
  the card reflects.
- **The refused-marker backoff is flat, not growing.** `mcpSlackConnectRefusedMarkerDueAt`
  moves a blocked first-card marker forward by a fixed five minutes, because
  the marker is a bare ISO timestamp with nowhere to keep an attempt count.
  Accepted as a limit rather than fixed, and the arithmetic is why: a refused
  visit costs one binding read and makes **no Slack call**, the sweep's page
  budget already bounds per-pass work, and the 24-hour horizon bounds a
  marker's whole life at ~288 visits. Growing backoff would trade that for a
  durable counter, a second field on the widget row, and a slower recovery for
  the case the reschedule exists to serve — an administrator flipping
  `align_slack_users` back on while the user waits. Two things reopen it: a
  refused visit acquiring any network call or provider cost, or the 24-hour
  horizon being lifted, either of which makes the flat rate a real load rather
  than a rounding error.
- **Personal API keys cannot reach `/mcp-oauth-connect`.** Both it and the
  pre-existing `/mcp-slack-recovery` are registered outside
  `TENANT_OWNED_SERVICE_PATHS`, so nothing arms a tenant scope for the API-key
  strategy's own lookup and both answer `500 Missing tenant database scope`.
  Browser JWTs — the only caller either route has — are unaffected. Pre-existing
  and shared with the recovery lane; not introduced or fixed here.

---

## 8. How the widget lane was verified

Unit and integration suites (`widgets/oauth/index.test.ts`,
`widgets/submissions.test.ts`, `mcp/tools/widgets.oauth.test.ts`,
`mcp/tools/mcp-catalog-list.test.ts`, `mcp/tools/mcp-servers.auth-status.test.ts`,
`utils/gateway-prompt-identity.test.ts`, `components/Widgets/OAuthConnectWidget.test.tsx`)
plus a real-Chromium suite (`OAuthConnectWidget.browser.test.tsx`, run under
`vitest.browser.config.ts` across four viewports) for the parts jsdom cannot
model — user activation around `window.open`, and layout.

**The grant check is tested directly, against real rows.** The two suites above
that reach `resolveMCPOAuthGrantLiveness` both `vi.mock` the module away, so
their strongest-looking assertion — `toHaveBeenCalledWith(..., 'srv-notion',
'user-actor')` — pins the argument handed to a stub and says nothing about
which row is read or what the rule decides. That is the same failure shape as
D5 and the tenant-scope bug, both of which only a real-stack run caught. So
`services/mcp-oauth-grant-liveness.test.ts` drives the function over a migrated
database and real `mcp_servers` / `user_mcp_oauth_tokens` rows: the
shared→`NULL` / per_user→user lookup split, the `refresh_status` rule, expiry,
the binding re-check (by moving the server's endpoint under a bound grant), and
the server re-read. `mcp-servers.auth-status.test.ts` and the gateway warning
test were converted off their storage stubs for the same reason — the former
stubbed `getToken` to always return `null`, so its authenticated branch never
ran — and the former now also asserts that the agent-facing verdict equals the
shared read's `live || refreshable` state by state, which is the assertion that
would have caught the disagreement D4 describes. Two of its cases changed
answer at the `main` merge; see D4.1.

The whole lane was then driven against the branch's managed environment (a real
daemon + UI on :9099/:11099) over HTTP and the MCP endpoint:

1. `agor_mcp_catalog_list({search:'notion'})` → `com.notion/mcp`.
2. `agor_widgets_request_oauth({catalogEntryName})` → a `session`-scoped,
   caller-owned, **unattached** install plus a `pending` widget row carrying the
   pinned `mcpServerId` and the disclosure.
3. `POST /widgets/:id/oauth-resolve` with a fabricated `attempt_id` → **403**,
   widget back to `pending` with a secret-free `resolution_failure`, nothing
   attached. This is the property the whole design rests on.
4. With a grant row present → `submitted`, `result_meta` of names only plus
   `attached: true`, the server attached, and
   `[Agor] User connected "Notion" and it is now attached to this session…`
   queued as a user-role message.
5. A second request for the same (session, server) marked the earlier pending
   widget `dismissed` rather than stacking a second button.

Step 2 is where D5 was found.

---

## 9. Adjacent things deliberately not fixed

- **Catalog search did not match `benefit`. Fixed as follow-up F1.**
  `filterCatalog` searched `name | title | description`. Of the 62 entries in
  the shipped `curated.yaml`, all 62 state `benefit`, **17 state `title`**, and
  none states `description` — so catalog search was a search over the
  reverse-DNS `name` plus those 17 titles. That covered the product-name lookup
  this feature needs ("notion" → `com.notion/mcp`) and no prose at all. It now
  also matches `benefit`; `starter_prompt` and `permission_disclosure` stay out,
  being a suggestion and a consent paragraph rather than a statement of what the
  server is.

  Because `filterCatalog` is one implementation, this changed the Catalog UI's
  results too — the intended outcome, and the reason it was deferred rather than
  waved through. Measured against the shipped file: every product-name lookup is
  unchanged (`notion` 1→1, `linear` 1→1, `mcp` 58→58), the job phrases that
  previously returned an empty grid now resolve (`issues` 0→3, `logs` 0→5,
  `design` 0→4, `specs` 0→2 — Notion and Postman), and single common words
  broaden a lot (`the` 0→39, `read` 0→22). The last is the honest cost of
  searching a sentence, it is what a one-line benefit is for, and the grid
  states "N of M" beside it.

  The practical severity of the gap was low, which is why the miscount above (an
  earlier draft of this section, and `query.ts`'s own sort comment, said no
  entry states a `title`) changed nothing in the code. `catalogDisplayName` is
  title-or-capitalized-publisher-segment, and the publisher segment is by
  construction a substring of `name`, so every display name was reachable by a
  search over `name` whether the entry states a title or not. The 17 titles only
  added reach where the title is not a substring of the name — `AWS Knowledge`
  against `com.amazonaws/knowledge-mcp`, say. The `query.ts` comment was
  corrected then; `matches` now carries the field list and the reason.

- **Instance six: the standalone token refresh read unscoped. Fixed as
  follow-up F4, and it was worse in production than this note first said.**
  Found by the mechanism in §7.1.12, doing exactly what it was built for.
  Arming the tenant scope guard by default on `register-services.oauth-sqlite.
integration.test.ts` turned 9 of its tests red (this note previously counted
  them as 11 assertions; the unit re-measured here is tests) and the probe said
  why: `RepositoryError Failed to get OAuth token: Missing tenant database
scope`.

  `refreshAndPersistToken` (`packages/core/src/tools/mcp/oauth-refresh.ts`)
  branches on dialect. `refreshPostgres` opens a scope around every repository
  operation; the standalone SQLite path did not — `loadObservedStandaloneGrant`
  and `refreshStandalone` built `new UserMCPOAuthTokenRepository(deps.db as
Database)` from the raw handle, and their caller `acquireMCPOAuthGrant` has
  already closed its own short units by the time it calls them.

  **What the drive showed.** The note's consequence was inferred, not observed,
  so before fixing anything it was driven on a real daemon (`tsx src/main.ts`,
  isolated `HOME`, migrated SQLite, real repositories) against one seed: a
  shared OAuth grant whose access token lapsed an hour ago and whose refresh
  token is good, pointed at a local fake token endpoint. The same seed was
  driven on a build without the fix and a build with it.

  | Surface (real daemon, real grant)                                | Before                      | After                                        |
  | ---------------------------------------------------------------- | --------------------------- | -------------------------------------------- |
  | `POST /mcp-servers/oauth-auth-headers` (the JIT path)            | `{ error: 'needs_reauth' }` | `{ authorization: 'Bearer …' }`              |
  | `POST /mcp-servers/oauth-refresh` (the MCP pill's "refresh now") | `token_refresh_failed`      | `{ success: true, expires_at }`              |
  | Requests reaching the provider                                   | **none**                    | exactly one per refresh, with the good token |
  | The saved grant afterwards                                       | untouched, still lapsed     | rotated pair, `refresh_generation` 0 → 1     |

  So the inference held, and the "before" column is the whole finding stated as
  one transcript: a grant Agor could have refreshed, that it never asked the
  provider about, reported to the user as a sign-in that had gone away. It also
  understated the blast radius twice. The manual refresh button is a second
  affected surface, `mcp-servers/discover` is a third, and — the part the
  fixture could not see —

  **the failure in production is earlier and dialect-independent.** `@agor/core`
  is built with `splitting: false`, so every tsup entry inlines its own copy of
  each shared module. The daemon loads `@agor/core/db` (which builds the guarded
  handle) and `@agor/core/tools/mcp/oauth-refresh` (which does the refresh), and
  each owned a private `AsyncLocalStorage` and a private proxy-target `WeakMap`.
  Consequences: `isPostgresDatabaseHandle` could not unwrap the handle it was
  given, so the dialect check on the first line of `refreshAndPersistToken`
  itself tripped the guard; and a scope armed inside core would not have been
  seen by the proxy anyway. Under vitest, which resolves `@agor/core` to source,
  there is one copy and neither is visible — which is exactly why the fixture's
  evidence stopped at `getToken`. Nothing about this is specific to SQLite: on
  the same built artifact the PostgreSQL branch would have failed at the same
  line.

  **The fix**, in two parts, neither of which changes when a refresh happens,
  what it persists, or any authorization decision:

  1. `standaloneWork` — the standalone path's counterpart to the PostgreSQL
     path's `tenantWork`. Every repository read and write on that path now
     enters a short tenant database scope, and the provider round-trip stays
     between units rather than inside one. It differs from `tenantWork` in one
     deliberate way: it does not _require_ trusted tenant identity, because the
     standalone path never has. Daemon callers all supply `tenantId`; making it
     mandatory would be an authorization change.
  2. The tenant scope stores and the proxy-target map are now keyed on
     `Symbol.for`, so they are the process's rather than each bundled copy's.
     `createTenantBoundDataAccess` was the preferred mechanism and does not fit
     here — it lives in the daemon and `oauth-refresh.ts` is core — but this is
     what makes core's own scoping mean anything in a built artifact.

  **Callers checked**, all three of which were affected and are now green:
  `mcp-servers/oauth-auth-headers` and `mcp-servers/discover` (both via
  `acquireMCPOAuthGrant`) and the `mcp-servers/oauth-refresh` route. All three
  are `identity-only`, which is the point: identity is armed for the request and
  a database scope deliberately is not, so the scope has to come from the code
  doing the work.

  **Coverage.** `oauth-refresh.tenant-scope.test.ts` drives the standalone path
  against a real migrated SQLite database behind `requireScope: true` with only
  the network replaced — 3 of its 4 cases fail without part 1. Three cases in
  `tenant-scope.test.ts` reproduce the module duplication in one process with
  `vi.resetModules()` and fail without part 2.

  `vi.resetModules()` is a faithful model and not the packaging contract:
  under vitest `@agor/core` resolves to SOURCE, so the copy count, the export
  map and the `import`/`source` conditions are all different from what a daemon
  loads — which is exactly the gap that let this defect reach production while
  the fixture's evidence stopped at `getToken`, and why B1 was found on built
  modules. So `packages/core/scripts/packaged-tenant-scope-smoke.mjs` now runs
  in CI's build lane, after `dist` exists, importing `@agor/core` and
  `@agor/core/db` through the package's own `exports` with no bundler and no
  test runner in the way. It asserts the two entries really are separate
  copies, then drives scope creation across them, a guarded proxy built by one
  and admitted by the other's scope, dialect inspection outside any scope (the
  line F4 actually failed on), and B1's `rootDb` fence. Checked against both
  defects on the artifact: un-sharing the `Symbol.for` stores in one dist entry
  fails the first probe, and neutering `scopeServesDatabase` fails the last. And `requireTenantScope` on the
  SQLite harness is now **on by default**, which is what a daemon runs with;
  the two tests that flipping it broke needed the harness to install the
  tenant-owned services' scope around-hook, which `registerHooks` installs in
  the daemon and this service-only harness never ran.

- **`gateway_token`'s `buildResultMeta` `WeakMap`. Fixed as follow-up F3.** The
  submit-resolved variant could not return its own `result_meta`, so
  `gateway-token/index.ts` carried its computed outcome across the two calls in
  a module-level `WeakMap` keyed on submit-object identity. `applySubmit` may
  now return the meta; the `WeakMap` and the widget's `buildResultMeta` are
  both gone, and with them the fallback that answered a WeakMap miss with a
  blank channel id and `enabled: false` — the right shape and the wrong answer.
  See §3.1 for what the union discriminates on now.

  **And the union now requires one of the two.** An optional `buildResultMeta`
  beside `applySubmit: … => Promise<TResultMeta | void>` still described a third
  arrangement that is never correct: a real `TResultMeta`, no builder, and a
  handler free to return nothing, which leaves `submissions.ts` passing
  `undefined` to a `buildAutoResumePrompt` declared to receive the shape. That
  is the same failure F3 had just removed by another route, so the submit
  variant is now a union of "builder present, handler may return void" and "no
  builder, handler must return the meta". A widget that computes no meta is
  unchanged (`TResultMeta` is `void`). Asserted in
  `apps/agor-daemon/src/widgets/registry.test-d.ts` rather than a `.test.ts`,
  because the daemon's `tsconfig.json` excludes test files, so a
  `@ts-expect-error` in one is checked by nothing.

- **Two `globalAnalyticsLogger`s, one per bundled entry. Not fixed here.** The
  same `splitting: false` module-identity property behind F4 also gives every
  entry that inlines `analytics/logger.ts` a private copy of the
  `globalAnalyticsLogger` singleton — six of them in the current `dist`,
  `dist/db` and `dist/analytics` among them — so which one a caller configures
  depends on which entry it imported. It predates this branch, is unrelated to the OAuth lanes, and gets
  its own follow-up rather than a fix inside a feature pull request. The same
  goes for the broader identity audit the packaged smoke test suggests — the
  env lock, the OAuth caches, connector registration, and every `instanceof`
  across entries (which the smoke test deliberately does not assert: it matches
  errors by `name`).
