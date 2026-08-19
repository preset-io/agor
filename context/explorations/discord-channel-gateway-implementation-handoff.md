# Discord gateway implementation handoff

**Status:** implementation brief for a Codex Agor subsession
**Date:** 2026-08-19
**Companion design:**
[`discord-channel-gateway-launch-design.md`](./discord-channel-gateway-launch-design.md)

This is the short, code-oriented handoff. The companion design is the complete
research record, including official Discord citations, threat model, setup UX,
HA semantics, test matrix, runbook, and staged PR plan. Read both before editing.

> **Superseding inbound recovery decision (2026-08-19):** Discord Gateway
> Resume is a best-effort, process-local SDK optimization only. Do not persist or
> transfer SessionInfo and do not run invalid-Resume parent/thread inventory
> reconciliation. An unobserved summon during downtime creates no delayed Task.
> The user mentions again after recovery; that live mention reads bounded thread
> history after the last admitted summon and includes the missed summon as
> chronological context when available. The Task cursor advances only after
> admission. All outbound ownership/fencing/nonce requirements remain unchanged.

## Mission and launch gate

Implement a dedicated Discord bot gateway for Agor Cloud. It is a **Gateway
WebSocket inbound transport plus Discord REST**, not polling and not an HTTP
interactions endpoint. Launch means PostgreSQL HA is complete and tested; a
working single-process connector is only an intermediate spike.

> **Activation decision (2026-08-19):** the reviewed Discord connector is now
> registered for PostgreSQL staging and included in the audited durable-listener
> provider set. There is no separate compile-time launch flag. SQLite remains
> fail-closed at service, repository, routing, and listener-start boundaries;
> a saved disabled channel must pass Apply/Test and hold a verified application
> binding before it can be enabled.

Do not commit or open a PR. Keep changes reviewable in the staged order from the
design. Follow `AGENTS.md`, especially tenant scoping, shared canonical types,
secret handling, logging, tests, and the instruction not to run a workspace
build or start background processes.

## Non-negotiable product decisions from Max

1. **Threaded only.** A top-level explicit bot mention in an allowlisted parent
   text channel creates one public Discord thread and one new Agor session. The
   parent channel is never the session. A mention inside a supported public or
   forum thread can create a mapping/session at that summon with bounded recent
   human thread context; earlier messages do not become Tasks.
2. **Every agent turn in a guild requires an explicit structured mention.**
   Humans can keep talking in the mapped thread while the agent is idle. On the
   next mention, catch the agent up with bounded human messages since the last
   successfully admitted summon. Reuse/refactor Slack's cursor, normalization,
   untrusted-history prompt template, and 200-message bound rather than creating
   a Discord-only copy.
3. **User alignment** is the exact product name and should match Slack's UX.
   `align_discord_users` defaults on and maps exact Discord Snowflakes to Agor
   user IDs, failing closed. When off, **Run as user** (`agor_user_id`) is
   required and all accepted users deliberately share that execution identity,
   just like Slack's fixed mode.
4. **HA is a launch requirement.** This is for Agor Cloud. Do not call the
   feature implemented until listener leasing/fencing, coordinated
   per-installation REST limits, takeover, and the PostgreSQL failure/kill-point
   matrix pass. Cross-process Gateway Resume/reconciliation is not required.
5. Match Slack defaults unless Discord semantics require otherwise. Do not add
   a Discord-specific session/prompt cap; normal executor compaction handles
   long sessions.
6. Presence/progress matters. Reuse safe Slack progress state, throttling, Todo
   and tool summaries. Discord output is per-thread typing plus one editable
   progress message and coarse aggregate bot presence; do not claim Slack-style
   native streaming parity.
7. Launch reads of the **current mapped thread** are enabled by default like
   Slack `thread_history`. Broad channel/guild reads, reactions, proactive
   arbitrary destinations, and DMs are later capability-gated work. Discord can
   open a 1:1 DM over REST, but inbound DMs are flat and need a separately
   approved reply-reference/outbound-seed routing model.

## Important correction: use the existing thread map

Do **not** add a Discord thread/message mirror or a second Discord-specific
index table. `thread_session_maps` is already the canonical database index from
an external conversation to an internal session:

```text
(tenant, gateway_channel_id, external_thread_id) -> (branch_id, session_id)
```

The normal route is
`ThreadSessionMapRepository.findByChannelAndThread(channel.id, threadId)`.
Persist only Agor-owned mappings and their provider metadata/cursors. We will
receive ordinary `MESSAGE_CREATE` traffic over the socket, but unmentioned
messages are ignored and not stored; a later explicit summon uses Discord REST
history and the mapping cursor to catch up.

The only mapping-creation cases are explicit summons:

- For a top-level parent-channel message, use the source message Snowflake as
  the future public thread channel ID (Discord's thread-from-message ID is the
  source message ID). `prepareDelivery` idempotently creates/resolves that
  thread before the existing gateway creates the session/map.
- For an explicit summon inside an allowed public/forum thread, the external
  thread ID is the message's `channel_id`. A mapping miss may create the one
  mapping/session and include bounded recent thread context ending at this
  mention.
- For an unmentioned event, pass/drop. It never creates a mapping or agent task.

A small disposable SDK/cache for resolving a **mentioned but unmapped**
thread's `guild_id`, `parent_id`, and type is transport state, not business
state. It must fail closed and must not become a database mirror.

Use one canonical thread-ID encoding everywhere (connector, map, callbacks,
history MCP, dedupe tests). Do not rely on channel names. Snowflakes are opaque
strings.

## Slack architecture to preserve

### Setup and secrets

- `GatewayChannelsTable.tsx` owns the Slack create/edit wizard, alignment
  defaults, capability toggles, redacted-secret sentinel, test flow, and
  generated manifest. Discord has no importable app manifest. Use a manual
  Developer Portal checklist, secure bot-token entry, connection probe, and a
  generated installation URL. Where supported, narrowly patch the current
  Discord application defaults only after verifying `/applications/@me`.
- `gateway-channels.ts` validates CRUD and alignment invariants; repositories
  encrypt `GATEWAY_SENSITIVE_CONFIG_FIELDS`, redact API output, preserve stored
  secrets on sentinel/blank edits, and revoke the active listener generation on
  config changes.
- Enabled Discord configurations require `bot_token`. Never store application
  public keys/client secrets unless a later OAuth/HTTP-interactions feature
  actually needs them. Never log tokens or raw message content.

### Runtime call graph

```text
Settings UI / secure token widget
  -> gateway-channels Feathers service
  -> encrypted GatewayChannel repository row
  -> GatewayService listener supervisor
  -> connector.startListening(options checkpoint/saveCheckpoint)
  -> provider event filter + canonical providerEventId/threadId
  -> GatewayService.handleListenerInboundMessage
       per-(tenant, channel, thread) serialization
       PostgreSQL listener-fenced GatewayInboundEvent claim
       provider prepareDelivery + durable delivery metadata
  -> GatewayService.create
       ThreadSessionMap lookup (canonical external-session route)
       defense-in-depth mention + allowlist checks
       User alignment / Run as user resolution
       existing session or stable-id session+map creation
       provider-neutral bounded catch-up
       /sessions/:id/prompt with stable Task ID and messageSource='gateway'
       advance catch-up cursor only after Task admission
       complete provider event under listener fence
  -> executor callbacks / routeMessage
  -> find mapping by session
  -> active connector REST send/edit/typing/status
  -> Discord public thread
```

### Durable ownership and idempotency

- `GatewayChannelRepository` provides database-time listener
  `claim/renew/isCurrent/saveCheckpoint/release`, opaque claim tokens, instance
  and boot IDs, generation invalidation, and tenant-aware discovery.
- `GatewayInboundEventRepository` is the durable provider-event ledger. It
  claims a stable occurrence, fences delivery metadata/completion, recognizes
  completed duplicates, and reclaims expired processing. It intentionally does
  not persist provider payloads.
- `handleListenerInboundMessage` fences before preparation, routing, Task
  admission, and completion. It serializes one external thread locally. Preserve
  that call path; do not bypass it from the Discord connector.
- Discord `MESSAGE_CREATE.id` is the durable provider event key. WebSocket
  sequence is a transport checkpoint, not event identity.
- Discord SessionInfo stays process-local. Resume while the same SDK manager can;
  after process loss or Invalid Session, Identify fresh. On ownership loss, stop
  the socket before releasing the lease; a stale callback must fail fencing.
- Do not scan for unobserved summons. Dedupe live/replayed events that Agor does
  observe through `GatewayInboundEvent`. A later live mention performs bounded
  thread history catch-up from the mapping's post-Task cursor.
- Coordinate REST rate-limit buckets across replicas sharing the same Discord
  installation. Honor Discord rate-limit headers, bucket IDs, `retry_after`,
  global limits, and jitter; do not use blind retry loops.

### Slack behavior that exists because of prior incidents

Preserve these hard-won invariants:

- arbitrary replies in unrelated threads cannot create privileged sessions;
- ordinary unrelated traffic is silently ignored, not answered with debug
  spam;
- structured mentions are used and code-block/lookalike mention text is not an
  invocation;
- aligned identity fails closed instead of falling back to the channel owner;
- `messageSource='gateway'` prevents provider echo;
- secrets remain encrypted/redacted across create, edit, test, and draft-token
  flows;
- provider config changes restart/fence listeners;
- catch-up cursors advance only after the Task is durably admitted;
- progress output is sanitized and throttled;
- tenant discovery is system-global only long enough to find `(tenant_id,
channel_id)`, then every read/write re-enters trusted tenant scope;
- active connector reuse matters for stateful transports and callbacks.

Useful history is summarized in section 2 of the companion design. In
particular inspect the commits around Slack thread verification, alignment,
code-mention rejection, silent traffic filtering, catch-up cursors, safe
progress, and PostgreSQL listener HA before simplifying anything.

## Discord launch protocol/config summary

- Transport: official Gateway WebSocket for live events; REST for
  `/gateway/bot`, channel/thread resolution, thread creation, history, create/
  edit/delete message, typing, files, and application configuration/probe.
- Intents: `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT` (`33281`). Message
  Content is privileged and required for unmentioned catch-up bodies. Do not
  request members, presences, or DM intents at launch.
- Scopes: installation URL needs `bot` only at launch. Do not add
  `applications.commands` until commands exist.
- Minimum bot permissions should be derived from launch capabilities, not use
  Administrator: View Channels, Send Messages, Create Public Threads, Send
  Messages in Threads, Read Message History, Attach Files when enabled, and
  Embed Links only if actually used.
- Guild and parent allowlists use exact Snowflakes. Public text threads and
  forum posts only. Reject private threads, DMs/group DMs, voice, media, and
  unknown types at launch.
- All outbound Discord messages must disable all allowed mentions. Escape/split
  output safely for Discord's limits. Treat embeds, rich components, and
  interaction callbacks as later work.
- Official packages recommended by the design are modular `@discordjs/ws`,
  `@discordjs/rest`, and `discord-api-types`, not full `discord.js` and not a
  home-grown lifecycle implementation. Revalidate current versions, Node 22
  support, transitive dependencies, and resume/rate-limit hooks before adding.

## First implementation sequence

Follow the companion design's PR sequence even though no PR is opened here:

1. **SDK spike and contracts:** pin/validate modular dependencies; implement
   pure Snowflake/thread helpers, structured-mention filtering, Markdown
   splitting, config/capability types, secret requirements, and focused tests.
2. **Provider-neutral refactor:** extract Slack catch-up orchestration and safe
   history rendering without changing Slack behavior. Extract generic app-info
   and progress capabilities only where concrete Discord needs prove the seam.
3. **Discord connector/runtime:** REST probe, Gateway lifecycle, canonical
   events, allowlists, public thread creation in `prepareDelivery`, mapping/
   alignment, REST catch-up, callbacks, typing/progress/finals, and safe files.
4. **Cloud HA:** fenced fresh-Identify takeover, distributed REST coordination,
   bounded live-summon catch-up, and kill-point tests.
5. **Setup UI/docs/MCP:** manual Portal checklist, secure token flow, generated
   install URL, test/enable sequencing, mapped-thread history tool, guide and
   runbook.
6. **Launch gate:** only now add `discord` to
   `DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES` and expose enablement in Cloud.

Prefer small shared primitives over a premature universal provider framework.
Discord should fit the existing gateway control plane, durable listener/event
machinery, mapping/session routing, identity policy, callbacks, attachment
confinement, and progress state. Keep provider-specific Gateway resume/sharding,
Discord REST buckets, thread creation, Snowflake cursors, formatting, Portal
setup, and presence behind the connector/provider adapter.

## Ground-truth file map

- Types/config: `packages/core/src/types/gateway.ts`,
  `packages/core/src/config/types.ts`
- Connector contract/registry: `packages/core/src/gateway/connector.ts`,
  `connector-registry.ts`, `gateway/index.ts`
- Slack reference: `packages/core/src/gateway/connectors/slack.ts`,
  `slack-manifest.ts`, and their tests
- Mapping/event/channel repositories:
  `packages/core/src/db/repositories/thread-session-map.ts`,
  `gateway-inbound-events.ts`, `gateway-channels.ts`
- Schemas/migrations: `packages/core/src/db/schema.sqlite.ts`,
  `schema.postgres.ts`, the migration guide, and existing gateway HA migrations
- Runtime supervisor/router: `apps/agor-daemon/src/services/gateway.ts`
- CRUD/probe/app info: `gateway-channels.ts`, `gateway-channels-test.ts`,
  `gateway-channels-app-info.ts`
- Progress/callback attachment paths: gateway service and
  `apps/agor-daemon/src/services/attachments.ts`
- MCP capabilities: `apps/agor-daemon/src/mcp/tools/gateway-channels.ts`
- Setup UI: `apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx`
- Secure secret widget: `apps/agor-daemon/src/widgets/gateway-token/`
- HA tests: `packages/core/src/db/gateway-listener-ha.postgres.test.ts` plus
  daemon gateway tests
- User docs: `apps/agor-docs/pages/guide/` (or current `content/guide/` path)

## Definition of done for the delegated session

Work as far through the staged implementation as can be done safely in one
session, beginning with the foundational contracts/refactor and retaining
working tests at each slice. Report:

- files changed and why;
- targeted tests run and results;
- what remains before HA launch readiness;
- any design decision that genuinely requires Max rather than silently choosing
  a Slack-inconsistent default.

Do not add a broad Discord data mirror, do not weaken tenant/RBAC checks, do not
ship a single-daemon shortcut as launch behavior, and do not substitute polling
or ordinary webhooks for the Discord Gateway.
