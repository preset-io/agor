# Agent-initiated MCP OAuth — "connect me to Notion"

Status: **stage 1 implemented.** Stages 2 and 3 are designed here and not built.
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

## 3. What stage 1 shipped

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
**no** `submitSchema`, `buildResultMeta`, or `applySubmit`. Two consequences fall
out of that rather than being enforced separately:

- There is no schema for a submit body, because no submit body is accepted.
- `result_meta` is **returned by the handler** instead of derived from a
  request. The sanitized facts come from rows the daemon just read. (The
  `gateway_token` widget needed a module-level `WeakMap` to carry its computed
  outcome from `applySubmit` to `buildResultMeta`; the OAuth lane has no such
  seam. That `WeakMap` is left alone — see §8.)

`submissions.ts` keeps one `doResolveWidget`. Steps 1–3 (load, authorize,
idempotency) and 5–8 (durable claim, auto-resume admission, terminal patch,
`widget:resolved` broadcast) are byte-identical for all three actions. Only the
step-4 dispatch differs. A widget reached through the wrong endpoint is refused,
both directions:

- submit-resolved via `/oauth-resolve` → would skip payload validation entirely.
- OAuth-resolved via `/submit` → would resolve on a client's say-so.

`WidgetResolutionClaim.action` widened to `'submit' | 'dismiss' | 'oauth_callback'`
so a recovery reader can tell which lane owned an abandoned claim.

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
`mintWidgetMessage` runs the mint gate for every widget the MCP tools create and
refuses a widget type this daemon has not registered; `submissions.ts` runs the
resolve gate before the durable claim. Stage 3's Slack projection inherits both
by minting through the same seam rather than by deciding to.

`agor_widgets_request_oauth` also calls the mint gate EARLY, with no params,
before it resolves a destination — so an unaligned gateway channel is refused
before a catalog install puts an orphan server row in the database. That call is
an optimization: skipping it would cost an orphan row, not a missed check.

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

**D4 — Liveness is one function, not three.** `resolveMCPOAuthGrantLiveness`
backs the agent-facing status read, the mint short-circuit, and the resolution
gate. The third is a security boundary, so it must not be a looser
reimplementation of the first two. "Live" is stricter than "a row exists": a
grant mid-refresh (`refreshing`), of unknown outcome (`ambiguous`), expired, or
no longer bound to the server's current OAuth configuration does not count,
because none of those is something the next turn can spend.

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
none), so there is nothing truthful to put in it. Stage 3 may fill it if the
landing page learns one. It is not derived from anything.

`oauthParamsSchema` is `.strict()`, so no extra field can be smuggled onto the
widget row by a caller of the tool.

### 5.2 Role floors

Shared-mode → `ROLES.ADMIN`, at mint _and_ at resolve. Per-user → `ROLES.MEMBER`,
which `/widgets/:id/oauth-resolve` enforces at the route. Same rule the recovery
lane applies, and the same rule `oauth-start` applies internally
("Shared MCP OAuth grants can only be started by an admin").

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

The Slack _binding_ is stage 3. The guard is here because the exposure exists
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

## 6. Stage 2 — what is next

Stage 2 finishes the canvas experience and hardens the edges stage 1 left
deliberately simple.

1. **Reauth reuse.** `agor_widgets_request_oauth` currently short-circuits on a
   live grant. It should also recognise an _expired or revoked_ grant and say so
   in the widget copy ("Reconnect Notion") rather than rendering a first-time
   Connect. `resolveMCPOAuthGrantLiveness` already distinguishes the cases; only
   the copy and a `params.mode: 'connect' | 'reconnect'` are missing.
2. **Attach-authority preflight.** Today a collaborator learns the attach was
   refused only after signing in (D6). Mint could resolve
   `checkSessionOwnerOrAdmin` up front and render the caveat in the card.
3. **Expiry.** A pending oauth widget lives forever. It should age out, matching
   the recovery notice's `expires_at` discipline, so an abandoned card does not
   sit in a transcript indefinitely.
4. **Popup-blocked recovery path.** The card currently tells the user to allow
   pop-ups. A same-tab fallback (navigate, return via the callback page) would be
   better, and stage 3 needs one anyway for Slack's in-app browser.
5. **Onboarding integration.** The Catalog drawer's "Start new session" flow and
   this widget now both install-then-connect. They should share one helper.

## 7. Stage 3 — Slack projection

Stage 3 gives the widget a Slack face. Explicitly **not built** in stage 1: the
sealed connect token, the landing page, and the gateway projection.

The reactive lane is the template, and most of it is reusable:

- **Sealed token.** `MCPSlackRecoveryNotice` carries `token_jti`,
  `token_consumed_at`, `expires_at`, `principal_user_id`, `credential_user_id`,
  `slack_user_id`, `gateway_config_generation`, `mcp_server_config_version`, and a
  one-use consume CAS. A connect token needs the same fields plus `widget_id`.
  It must bind the _widget_, not just the server, so the landing page resolves
  exactly the card the user tapped.
- **Landing page.** `MCPSlackRecoveryPage` is the shape: preflight, one button,
  pre-opened popup, durable attempt poll, "Return to Slack". The connect page
  differs in its last step — instead of projecting a recovery result, it POSTs
  `/widgets/:id/oauth-resolve`. **That endpoint already exists and needs no
  change**, because it takes nothing from the caller but identity.
- **Block Kit projection.** `services/gateway.ts:1701+` posts and reconciles the
  recovery notice with a delivery claim and `slack_message_ts`. The connect
  projection needs the same idempotent post/update discipline, driven off the
  widget row's status transitions rather than a task's.
- **Identity.** §5.3 already refuses the unaligned case at mint, so the stage-3
  binding inherits a session whose prompts carry a real actor. The sealed token
  must still pin `slack_user_id` and verify it against the aligned Agor user at
  redemption, exactly as the recovery token does — alignment at mint does not
  prove the person who tapped the button is the person who asked.

Stage 3 must not introduce a headless start. Sealing a token does not create a
grant; the browser-bound flow remains the only path.

---

## 8. How stage 1 was verified

Unit and integration suites (`widgets/oauth/index.test.ts`,
`widgets/submissions.test.ts`, `mcp/tools/widgets.oauth.test.ts`,
`mcp/tools/mcp-catalog-list.test.ts`, `mcp/tools/mcp-servers.auth-status.test.ts`,
`utils/gateway-prompt-identity.test.ts`, `components/Widgets/OAuthConnectWidget.test.tsx`)
plus a real-Chromium suite (`OAuthConnectWidget.browser.test.tsx`, run under
`vitest.browser.config.ts` across four viewports) for the parts jsdom cannot
model — user activation around `window.open`, and layout.

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

- **Catalog search does not match `benefit`.** `filterCatalog` searches
  `name | title | description`. No entry in the shipped `curated.yaml` states
  `title` or `description` — all 62 use `benefit` — so catalog search is
  effectively a search over the reverse-DNS `name`. That covers the product-name
  lookup this feature needs ("notion" → `com.notion/mcp`) but not prose
  ("track bugs"). Widening it is a one-line change in `query.ts` that would also
  change Catalog UI results, so it is out of scope here. The tool's description
  says what `search` actually matches and points at `category`/`capability` for
  browsing, and `mcp-catalog-list.test.ts` pins the current behaviour so the gap
  is visible rather than surprising.
- **`gateway_token`'s `buildResultMeta` `WeakMap`.** The submit-resolved variant
  still cannot return its own `result_meta`, so `gateway-token/index.ts` carries
  its computed outcome across the two calls in a module-level `WeakMap`. The
  OAuth variant shows the cleaner shape (handler returns the meta). Unifying
  them is a refactor of a working, well-tested widget and was not attempted.
