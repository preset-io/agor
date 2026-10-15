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

Modes, the user map, and the "not linked" reply are in the [guide][teams-guide].
Contracts:

- Aligned: a `user_map` entry (AAD object ID → immutable Agor User ID) wins;
  otherwise the Bot Connector member API email (`email`, then
  `userPrincipalName`) is matched, using the Bot Framework scope of the
  activity's service URL. An unmatched sender never falls back to a fixed user;
  a transient lookup failure retries the queued activity.
- Fixed (`agor_user_id`): `user_map` is rejected.
- Both lookups run inside the channel's tenant. Credential-minting paths treat a
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
  fits the inbound lease with catch-up. Channel activities omit SharePoint
  files, so a channel mention is re-read over Graph (`ChannelMessage.Read.Group`)
  inside that deadline; a `reference` file is read only if it sits under the
  channel's own `filesFolder` (`ChannelSettings.Read.Group`), not merely in the
  team library every channel shares, through the driveItem's short-lived
  `downloadUrl`. When the message itself cannot be read, the activity's own
  file notes stand. That read needs a tenant admin grant
  (`Sites.Selected` on the team site, or `Files.Read.All`); without it, and for
  group-chat files and other types, the file is named in the prompt as unread,
  so an attachment-only mention is still admitted.
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

What the two tools read and how to enable them is in the [guide][teams-guide].
Contracts:

- `agent_tools.channel_history` absent, `[]` or `false` refuses before any Teams
  call; unknown keys or non-booleans fail validation.
- A target needs a fenced, unrevoked address (proof a verified activity arrived)
  and passes the team and channel allowlists. Teams sends the channel type on
  some activities only, so any stored thread marked private or shared refuses
  its whole channel. Another tenant's `gatewayChannelId` looks missing.
- Session callers must be on the row's target branch; callers without session
  context need admin or `all` branch permission.
- The service URL comes only from the fenced address; Graph is the only other
  origin. The cursor is the Graph `$skiptoken` value, never a URL, and the
  request URL is rebuilt from validated IDs. A `nextLink` off the Graph origin
  fails the read.
- One Graph page per call under one 20 s deadline; `Retry-After` is waited out
  only while short. A Graph 403 is `rsc_not_granted` and, unlike catch-up's, is
  not cached team-wide (it may be specific to one channel).
- The tools never advance a cursor, admit a Task, or store Teams content. Output
  is labeled untrusted and carries attachment names, never URLs or tokens.

The address row keeps the team ID, the team's M365 group ID, and the channel
type in plaintext: non-secret routing facts Teams sends on some activities. The
address itself stays encrypted.

## Proactive sends

Enabling `outbound_enabled`, targets, and the reply rule are in the
[guide][teams-guide]. The migration sets `outbound_enabled` false on every Teams
row. The send is synchronous and not durable, as on Slack and Discord.

- The service URL, tenant, and team come only from a fenced, unrevoked
  standard-channel address: the target channel's own, or another channel's in a
  team whose Bot Connector channel listing includes the target. There is never a
  configured or agent-supplied service URL. Allowlists apply to both the channel
  and its team. Channel listings run after the tenant database unit closes.
- The first chunk creates the post with `POST v3/conversations` (read directly:
  the SDK adapter drops `activityId`); at most three chunks, and the reply hint
  closes the first. A provider-proven non-acceptance with a short `Retry-After`
  is retried once.
- An unknown outcome stores no seed and is reported as possibly posted. A
  failure after the first chunk keeps the seed and reports a partial post. A
  seed that cannot be recorded after the post is live is reported as posted,
  never as a failure that invites a resend. A refused post never revokes the
  addresses replies use.
- The seed's `platform_thread_id` is exactly `channel|root`, the key
  normalization gives every activity in that reply chain, so admission needs no
  alias. Only channel conversations reach the seed gate. The reply that opens a
  seeded session skips catch-up and moves the cursor to itself; later mentions
  read catch-up as usual. Answers go through the outbox.
- A `user:<email | Entra object ID>` target is resolved with the Bot Connector
  member API on the teams of fenced anchors; the recipient must pass
  `allowed_user_aad_object_ids`, and DMs are refused while `allowed_team_ids`
  or `allowed_channel_ids` is set, since ingress refuses personal-chat replies
  under either. `POST v3/conversations` opens (or reuses) the
  1:1 chat; it posts nothing, so its failures are reported as not sent. The
  send is recorded with the chat ID as its thread and is never a seed: the
  reply lands in the person's one personal-chat session, whose next prompt
  includes the DMs sent since its last admitted message (message IDs are epoch
  milliseconds, so they order sends and replies) as untrusted context, as on
  Discord.

## Reactions

With `inbound_reactions`, a `messageReaction` activity is queued like a
message. Teams reports reactions only on the bot's own messages. A reaction
reaches only a conversation that already has a session; it never creates one,
consumes a seed, reads catch-up, moves the cursor, or posts a notice when it is
refused. A channel reaction must name its thread through the conversation's
root message, or it is ignored. The prompt quotes the reacted message from that
conversation's own deliveries or proactive sends. Limits are per daemon process:
one prompt per reaction per minute, three per conversation per minute.

## Migration

`0118_teams_gateway_ha` (PostgreSQL) / `0117_teams_gateway_ha` (SQLite) runs
online. It disables existing Teams channels for reviewed re-enable and builds no
unique index on `messages`; the outbox's message and mapping foreign keys are
plain, as for Discord, while channel foreign keys stay tenant-composite.

## Non-goals

Teams SDK 2.x or a global `serviceUrl`; multi-tenant bot registrations; Graph
transcript mirrors; SharePoint reads beyond files attached to a channel mention, or sending files back; replay or repair APIs for ambiguous
deliveries; Tasks for messages that did not mention the bot.

[teams-guide]: ../../apps/agor-docs/content/guide/message-gateway.mdx#setting-up-microsoft-teams-integration
