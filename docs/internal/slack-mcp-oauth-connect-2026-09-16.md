# Agent-initiated MCP OAuth — "connect me to Notion"

Status, as of this branch:

| Section               | State                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3 — the widget lane  | **Implemented.**                                                                                                                                                                                                                                                                                             |
| §6 — canvas polish    | **Not built**, except item 3 (expiry), which is now an explicit accepted gap — see **D7**.                                                                                                                                                                                                                   |
| §7 — Slack projection | **Implemented**, behind an operator kill switch (§7.1.4). Token, redemption authority, landing page, and the Block Kit post/update projection are all in. Verified in §7.1 and again in §7.1.2; three defects found by the gating review and fixed (§7.1.1), one more found by the pre-merge drive (§7.1.3). |

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

**Exactly one surface answers looser, and it does so from the same read.** The
gateway's warning also suppresses itself for `refreshable` — a grant whose
access token has expired but whose refresh token the inject hook will spend
JIT, before the executor ever sees it. That widening is a named field on the one
answer, not a second rule, and the asymmetry is deliberate: a wrong warning
tells a Slack thread a connection is broken when the next turn will use it
fine, while a wrong `live` resolves a widget against a credential nobody
re-obtained. Warnings may be optimistic; grants may not. `refreshable` is
documented as readable only by a surface that grants nothing.

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

**D7 — A pending widget does not expire, and that is an accepted gap, not an
oversight.** A `pending` oauth widget lives until it is resolved, dismissed, or
superseded. Nothing ages it out.

What that is _not_ is a way in. Every question the mint asked is re-asked at
resolve, against state read then: the role floor, the gateway identity
alignment, the pinned server's existence / usability / enabled-ness / OAuth mode,
and — the one that decides — a live grant for the caller. A card rendered a
month ago and clicked today grants exactly what it would grant if minted today,
by exactly the person clicking it. The residue is a stale button in a
scrolled-back transcript, and the common way a card goes stale is already
handled: a second request for the same (session, server) supersedes the first
(§3.4.7), as does either short-circuit. One case supersede cannot reach — a
post that outlived its delivery lease and left a second, unrecorded Slack row —
is handled separately; see §7.1.1.

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
| Landing page                                 | `apps/agor-ui/src/pages/MCPOAuthConnectPage.tsx`        |
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
and is checked in exactly two places: `deliverMcpSlackConnectCard` before
anything is read or posted, and `loadMCPOAuthConnectBinding` before anything is
consumed.

Both ends, not just the first, because the point is to stop the lane from
**granting** and not merely from repainting: a card already in a thread carries
a live sealed link, and an operator turning this off during an incident is
asking for that link to stop working. The refusal collapses into the lane's one
generic failure, and nothing is consumed — turning it back on restores the
existing link rather than leaving a burned one behind.

What it does not touch is the fallback. The canvas widget still renders a live
Connect button, and `agor_widgets_request_oauth` still hands the agent the
`session_url` and the sentence to relay. Off is a degraded Slack experience,
never a removed feature — which is also why it is **on by default**: the card
is additive to a link that still works, so a bad card costs a bad-looking Slack
message rather than a broken flow, and a lane that ships dark is a lane nobody
ever reports a bug against.

Two known limits, both deliberate:

- It is **per tenant**, because it is an app variable and the lane is a
  tenant-owned resource. A deployment-wide problem means one write per tenant.
  That matches `mcp_egress_gateway.mode` exactly and is the reason the switch
  is a setting rather than an env var; if incident response needs one action,
  that is a change to make for both settings at once.
- There is **no admin UI**. The egress mode has a `PATCH` route; this has only
  `setMCPSlackConnectCardEnabled`. Adding a surface is worth doing the first
  time an operator actually reaches for it.

A value nobody recognises leaves the card **on**. This is not fail-closed on
purpose: an unreadable or mistyped setting should not silently retire an
affordance a thread is already showing, and the operator turning it off is
performing a deliberate act and can spell it.

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
widget's gate state by state, which is the assertion that would have caught the
disagreement D4 describes.

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
  `name | title | description`. Of the 62 entries in the shipped
  `curated.yaml`, all 62 state `benefit`, **17 state `title`**, and none states
  `description` — so catalog search is a search over the reverse-DNS `name`
  plus those 17 titles. That covers the product-name lookup this feature needs
  ("notion" → `com.notion/mcp`) but not prose ("track bugs"). Widening it is a
  one-line change in `query.ts` that would also change Catalog UI results, so it
  is out of scope here. The tool's description says what `search` actually
  matches and points at `category`/`capability` for browsing, and
  `mcp-catalog-list.test.ts` pins the current behaviour so the gap is visible
  rather than surprising.

  The practical severity is low, which is why the miscount above (an earlier
  draft of this section, and `query.ts`'s own sort comment, said no entry states
  a `title`) changed nothing in the code. `catalogDisplayName` is
  title-or-capitalized-publisher-segment, and the publisher segment is by
  construction a substring of `name`, so every display name is reachable by a
  search over `name` whether the entry states a title or not. The 17 titles only
  add reach where the title is not a substring of the name — `AWS Knowledge`
  against `com.amazonaws/knowledge-mcp`, say. The `query.ts` comment is
  corrected.

- **`gateway_token`'s `buildResultMeta` `WeakMap`.** The submit-resolved variant
  still cannot return its own `result_meta`, so `gateway-token/index.ts` carries
  its computed outcome across the two calls in a module-level `WeakMap`. The
  OAuth variant shows the cleaner shape (handler returns the meta). Unifying
  them is a refactor of a working, well-tested widget and was not attempted.
