# Teams Gateway

Correctness and security contract for the Microsoft Teams connector. Operator
setup (Azure Bot, manifest, identity modes, allowlists, upgrade, troubleshooting)
lives in the
[Message Gateway guide](../../apps/agor-docs/content/guide/message-gateway.mdx#setting-up-microsoft-teams-integration);
this note covers what the code must preserve.

Code: [`teams.ts`](../../packages/core/src/gateway/connectors/teams.ts),
[`teams-gateway-ingress.ts`](../../apps/agor-daemon/src/routes/teams-gateway-ingress.ts),
[`teams-gateway-worker.ts`](../../apps/agor-daemon/src/services/teams-gateway-worker.ts),
[`gateway-authority.ts`](../../apps/agor-daemon/src/services/gateway-authority.ts),
[`gateway.ts`](../../apps/agor-daemon/src/services/gateway.ts).

## Governing rule

> **Teams owns conversation history. Agor owns the durable routing facts needed
> to resume safely, plus one bounded encrypted inbound buffer.**

Teams calls Agor over HTTPS; any daemon replica may receive an activity. Nothing
process-local (adapter instances, token caches, wake signals) is an authority.
Durable state is limited to:

1. tenant-scoped channel config with `provider_config_generation` and
   `provider_installation_id` fences;
2. inbound idempotency rows (`gateway_inbound_events`), one durable outcome per
   `(channel, teams:activity:[conversation, activityId])`;
3. the thread/session mapping and `teams_last_admitted_activity_id` (epoch-ms
   activity IDs, compared numerically);
4. one encrypted conversation address per (channel, thread);
5. the final-response outbox (`teams_message_deliveries`).

**Bounded exception:** the inbound row carries the encrypted normalized activity
only until admission or dead-letter, never past `payload_expires_at`. Completion
nulls it, and tenant export never carries it. No other Teams message body,
transcript, or token is stored or logged. A proactive seed stores only the
Agor-authored `message_text`, as on Slack and Discord.

## Ingress (`POST /gateway/teams/:gatewayChannelId/activities`)

Order matters; a failure persists nothing.

1. One route-mounted JSON body cap (1 MiB).
2. System-scope lookup of the channel's tenant, limited to enabled Teams
   channels. Unknown and disabled channels answer the same way.
3. Tenant-scoped config read.
4. Agents SDK `authorizeJWT`: signature, `aud = app_id`, Bot Framework issuer.
   There is no setting that disables validation.
5. Identity: `msteams` endorsement from a cached JWKS, tenant `tid` equals the
   configured Microsoft tenant, `serviceUrl` equals the token's `serviceurl`
   claim, service host on the allowlist.
6. Optional team/channel/user allowlists. They filter; they are not identity.
7. Normalize, then filter: non-message activities and unmentioned group/channel
   messages return 200 and store nothing. Lifecycle events that remove the bot
   revoke the stored address instead.
8. One transaction writes the encrypted inbound row and upserts the encrypted
   address, then the route returns 200.
9. The receiving replica's worker is woken; polling remains the cross-replica
   fallback.

HTTP 200 means durably queued, not executed. 5xx is reserved for transient
storage failure (sustained 5xx can make Teams back off the bot); a retry from an
older configuration generation gets 200.

## Admission

The worker claims a pending row under a lease, in a lane keyed by
(tenant, channel, thread), and calls `GatewayService.create` with the claimed
event as verified authority. Teams creates without that authority are refused.

**Admission fence.** `GatewayService` passes a `gatewayAdmissionFence` callback
in Feathers params to the prompt route, which runs it inside the Task-insert
transaction. A function cannot cross REST or socket transport, so only an
in-process caller can supply one; a gateway-sourced Task whose provider is in
`GATEWAY_ADMISSION_FENCED_CHANNEL_TYPES` is refused without it. The Teams fence
re-reads the channel and event rows under lock and requires the same generation,
installation, app/tenant identity, thread, live lease, and unexpired payload.

**Lock order:** session turn lock → gateway channel row → inbound event row.
Channel configuration writes lock the channel row first, so a revocation that
commits first refuses the Task; one that commits after cannot retract it.

Task and Session IDs derive from the event ID, so a retry after a crash
reconciles the existing Task. The cursor advances only after durable admission,
from its expected predecessor.

## Identity

- **Aligned** (`align_teams_users: true`, the wizard default): an explicit
  `user_map` entry (AAD object ID → immutable Agor User ID) wins; otherwise the
  sender's email from the Bot Connector member API (`email`, falling back to
  `userPrincipalName`) is matched to an Agor account. Unmatched senders are
  rejected with a "not linked" notice and never fall back to a fixed user.
  Transient lookup failures retry the queued activity. Whether the member API
  returns email for guests is unconfirmed.
- **Fixed:** `agor_user_id`; every sender runs as that user. `user_map` is
  rejected in this mode, and the UI warns that everyone in the tenant shares
  that user's access.

Both lookups run inside the channel's tenant. Credential-minting paths treat a
Teams Session as aligned only when `align_teams_users` is true.

## Enablement

A channel becomes enabled only through a passing credential probe:
`TeamsConnector.testConnection` requests an uncached client-credentials token
for the Bot Framework resource in the configured tenant and checks the token's
app and tenant claims. The service then binds `provider_installation_id` to that
`app_id` through the generation-fenced verified seam; the repository refuses an
enabled Teams row without that binding, and public write DTOs cannot set it.
Every change that leaves a channel enabled, including a password-only rotation,
is probed first. Rotation keeps the generation; other config changes bump it,
which fences queued work and stored addresses.

The App ID is unique per tenant among enabled Teams channels, not globally:
routing is by channel UUID and enablement is credential-verified, so two tenants
using the same app cannot read each other's traffic.

## Final-response delivery

Assistant messages enqueue in the Message transaction, addressed by the Task's
`gateway_task_source` (`thread_session_map_id`); a Task sourced from another
provider, another session, or a deleted mapping enqueues nothing. Each mapping
is a serial lane.

- Token and client are prepared before the effect marker, so their failure is
  retryable, not ambiguous. Each chunk writes its marker, sends once with a
  deadline, and checkpoints a receipt; a retry never resends a receipted chunk.
- Replies are chunked under the 100 KB limit (UTF-16 units). A 413 before any
  chunk is posted re-plans with a smaller budget; after that it dead-letters.
  Very long replies end with a link to the Agor session.
- 429 and 412 retry with `Retry-After`; 401 refreshes the token and retries;
  pre-send network errors retry. 502, 503, 504 or a transport error after send
  are terminal `ambiguous`, never resent. 500 and other 4xx dead-letter.

Delivery failure never rolls back the Task or re-admits the prompt. System
notices (denials, "not linked", the session link) and typing indicators are
best-effort direct sends through the same fenced address loader and host
allowlist, outside the outbox. `outbound_enabled` gates only proactive sends.

## Notices, typing, and attachments

- The session link is posted once, by the event that created the session, as
  on Slack and Discord; follow-ups and a loser of the mapping race post
  nothing. A redelivered first message that finds its own session announces it.
- Typing is process-local and bounded (`teams-typing.ts`), and only in
  personal and group chats until channel threads are verified live: admission
  or a task-progress signal starts it on whichever replica sees it, every
  refresh re-reads the Task and channel inside the tenant, and it ends on a
  terminal Task, a posted reply, or shutdown. A failed or refused send or the
  deadline ends it for that Task on that replica. Loops are capped per tenant.
  Duplicate or missing indicators across replicas are acceptable.
- Attachments (`files: true`): inline images are fetched with the bot token,
  and only from Bot Connector hosts (`isTeamsTokenHost`); personal-chat files use
  their pre-authenticated SharePoint `downloadUrl` with no credential. Every
  redirect hop is re-checked against the same per-file host rule, so the token
  never follows a redirect elsewhere. Download URLs live only in the encrypted
  inbound payload and are never logged or stored elsewhere; staged files are
  session executor uploads. One deadline covers all of a message's files and
  fits the inbound lease with catch-up. Channel and group-chat files
  (SharePoint) and everything else are named in the prompt as unread, so an
  attachment-only mention is still admitted.
- The prompt carries the sender email only when aligned identity resolved it
  from the member API for that prompt; it is not stored in mapping metadata.

## Conversation addresses

Addresses have no TTL. Each queued activity refreshes the address and re-arms a
revoked one. An address is bound to the verified app and Microsoft tenant, not
the configuration generation: a credential or tenant change makes it stale, an
allowlist or catch-up edit does not. Deliveries in flight at the moment of any
edit still cancel at the effect-start fence.
Bot removal (`installationUpdate` remove, bot in `membersRemoved`, team or
channel deletion) and provider errors proving the bot can no longer post revoke
the address; deliveries then cancel as revoked. Hosts outside the Bot Framework
allowlist are refused before a token is attached.

## Catch-up

On unless a stored setting turns it off. A channel mention
reads replies after the cursor through the shared provider-history path and
formats them as an untrusted block. RSC is per team, so a Graph 403 means "not
granted here", not a bad token. A failed read admits the current mention and
leaves the cursor unchanged. When more replies arrived than the cap allows, the
newest ones are kept (and trimmed oldest-first to the byte limit) with an
omission note, and the cursor advances, as Slack does. Personal and group chats
have no catch-up.

## Agent history tools

`agor_gateway_teams_thread_history_get` and `agor_gateway_teams_channel_posts_list`
are a separate opt-in (`agent_tools: { channel_history: true }`); absent, `[]` or
`false` refuse before any Teams call, and unknown keys or non-booleans fail
validation.

- Targets are standard channels this gateway channel has a fenced, unrevoked
  address for (proof a verified activity arrived there), within the team and
  channel allowlists. Private and shared channels, personal chats, and group
  chats are refused. Another tenant's `gatewayChannelId` looks missing.
- Session callers must be on the row's target branch; callers without session
  context need admin or `all` branch permission.
- The service URL comes only from the fenced address; Graph is the only other
  origin. The cursor is the Graph `$skiptoken` value, never a URL, and the
  request URL is rebuilt from validated IDs. A `nextLink` off the Graph origin
  fails the read.
- One Graph page per call under one 20 s deadline; `Retry-After` is waited out
  only while short. A Graph 403 is `rsc_not_granted` for that team.
- The tools never advance a cursor, admit a Task, or store Teams content.
  Output is labeled untrusted and carries attachment names, never URLs or
  tokens.

The address row keeps the team ID, the team's M365 group ID, and the channel
type in plaintext: non-secret routing facts Teams sends on some activities. The
address itself stays encrypted.

## Proactive sends

`outbound_enabled` (default false; the migration sets it false on every Teams
row) opts in to `agor_gateway_emit_message` with a `channel:<19:…@thread.tacv2>`
target. The send is synchronous and not durable, as on Slack and Discord.

- The service URL, tenant, and team come only from a fenced, unrevoked
  standard-channel address: the target channel's own, or another channel's in a
  team whose Bot Connector channel listing includes the target. There is never a
  configured or agent-supplied service URL. Allowlists apply to both the channel
  and its team.
- The first chunk creates the post with `POST v3/conversations` (read directly:
  the SDK adapter drops `activityId`); at most three chunks. A provider-proven
  non-acceptance with a short `Retry-After` is retried once. An unknown outcome
  stores no seed and is reported as possibly posted. A failure after the first
  chunk keeps the seed and reports a partial post.
- The seed's `platform_thread_id` is exactly `channel|root`, the key
  normalization gives every activity in that reply chain, so admission needs no
  alias. Only channel conversations reach the seed gate.
- A reply must still @mention the bot (the post says so); the mention rule is
  unchanged. A seeded session skips catch-up and moves the cursor to the reply,
  and its answers go through the outbox like any other mapping.

## Migration

`0118_teams_gateway_ha` (PostgreSQL) / `0117_teams_gateway_ha` (SQLite) runs
online. It disables existing Teams channels for reviewed re-enable and builds no
unique index on `messages`; the outbox's message and mapping foreign keys are
plain, as for Discord, while channel foreign keys stay tenant-composite.

## Non-goals

Teams SDK 2.x or a global `serviceUrl`; multi-tenant bot registrations; Graph
transcript mirrors; SharePoint file reads or sending files back; replay or repair APIs for ambiguous
deliveries; Tasks for messages that did not mention the bot.
