# Discord Gateway

Correctness and security contract for the Discord connector. Operator/user
behavior (config fields, catch-up defaults and ceilings, DMs, setup, proactive
sends, channel-history tool) lives in the
[Message Gateway guide](../../apps/agor-docs/content/guide/message-gateway.mdx#discord-behavior);
this note covers what the code must preserve.

Code: [`discord.ts`](../../packages/core/src/gateway/connectors/discord.ts),
[`discord-history.ts`](../../packages/core/src/gateway/connectors/discord-history.ts),
[`discord-identifiers.ts`](../../packages/core/src/gateway/discord-identifiers.ts),
[`discord-message-delivery-worker.ts`](../../apps/agor-daemon/src/services/discord-message-delivery-worker.ts),
[`gateway.ts`](../../apps/agor-daemon/src/services/gateway.ts).

## Governing rule

> **Discord owns conversation history. Agor owns only the durable routing facts
> needed to resume safely.**

The Gateway WebSocket is a restartable transport. Client, session/sequence,
shard state, caches, and in-flight buffers are process-local and may vanish on
restart, lease handoff, or config refresh. Durable state is limited to:

1. tenant-scoped listener ownership and fencing;
2. inbound idempotency (one durable outcome per Discord event identity);
3. the thread/session mapping (tenant + gateway channel + canonical provider
   thread → one session), plus reply aliases and proactive seeds;
4. `discord_last_admitted_message_id` on the mapping — a Snowflake compared as
   an unsigned integer (BigInt/string), never a JS number;
5. the final-response delivery outbox (`discord_message_deliveries`).

Never persist Discord message bodies or reconstructed transcripts (DB, S3,
logs, restart-surviving caches). Staged inbound images (`files:true`) are
session/task-scoped executor uploads, not conversation storage.

The Gateway sequence checkpoint is **not** the conversation cursor: it measures
transport progress; only the mapping cursor proves context reached Agor.

## Inbound admission order (server channels)

1. **Trigger.** Only a live `MESSAGE_CREATE` from the configured guild with a
   structured bot mention outside inline/fenced code. Message Content intent is
   mandatory (`message_content_enabled: true`); never rely on the mention-only
   content exception. Strip only the bot mention; an empty summon is ignored.
   Bots/self, webhooks, private threads, other guilds, unconfigured parents, and
   unsupported message types are ignored. Missed events never become background
   Tasks.
2. **Authorize** from fresh tenant config, repeated at the gateway service even
   if the connector filtered: guild, public parent, thread→parent relationship,
   author in `allowed_user_ids` or holding an `allowed_role_ids` role.
3. **Identity.** `align_discord_users: true` → tenant-owned Discord→Agor map;
   unmapped authors are rejected and never fall back to the fixed user.
   Otherwise an explicit fixed `agor_user_id`. Being allowlisted in Discord
   grants no Agor user, branch, or capability by itself.
4. **Thread** (`thread_mode: public_thread_per_summon`). In-thread mentions use
   that thread; top-level mentions create one public thread per summon.
   Creation is idempotent: reuse the idempotency record's stored thread, then
   look up a thread started by the summon message, and only then create once
   and record immediately. If the thread can't be proven, reject and keep the
   cursor — never guess.
5. **History.** Fetch REST history strictly after the cursor through the live
   mention, sort oldest-first by Snowflake, dedupe the mention, and label it
   untrusted. Bounds (pages, messages, bytes, timeout, rate-limit retries/delay)
   are enforced; a cap hit before covering the interval is **incomplete**, not
   a truncated success. Any failure → reject admission, cursor unchanged.
6. **Admit one Task** via the normal session prompt path. A queued Task on a
   busy session counts as admitted. Event idempotency plus stable Task identity
   make redelivery reconcile the existing Task instead of re-running it.
7. **Advance cursor** only after admission is durable, monotonically under the
   mapping row's concurrency control. A crash between admission and the cursor
   write is repaired by the idempotent retry.

An unmentioned human reply creates no Task and moves no cursor; the next live
mention re-reads the interval. This is not a polling system.

Catch-up content is an untrusted input boundary: delimited from the current
summon, capped before prompt construction, and unable to change target branch,
session owner, capabilities, or listener state.

## Fencing and tenancy

All listener claims, event records, channel config, mappings, seeds, and
deliveries are tenant-owned. Every provider callback carries tenant identity and
the current listener fence into a short tenant-scoped unit of work; missing,
stale, or conflicting tenant identity fails closed. The fence is checked before
provider ack, thread binding, session creation, Task admission, cursor advance,
and inbound completion — a stale owner's socket may linger but cannot produce a
durable effect. Config changes restart the transport with fresh credentials and
capability snapshot. Bot tokens are encrypted at rest and never trusted from
inbound metadata or placed in context.

## Final-response delivery

Assistant messages on a Discord-mapped session enqueue one
`discord_message_deliveries` row in the same transaction as the Message
(`enqueueForMessageInTransaction`), unique per message; proactive-seed mappings
are excluded. The worker runs on every daemon, independent of listener
ownership:

- Each mapping is a serial lane: a row is claimable only when no older
  nonterminal row exists for that mapping.
- Claims are leased and generation-fenced; every provider call renews the
  claim and is bounded by a timeout. Route/installation is re-read immediately
  before each send.
- Each chunk carries a deterministic nonce (delivery id + chunk index). Before
  sending, the worker looks the nonce up; a durable "effect started" marker is
  written before the send. After an ambiguous failure (timeout/connection loss)
  it must prove the nonce landed before retrying; unprovable outcomes retry only
  within the recovery grace window, then dead-letter. Only errors proving
  non-acceptance clear the marker.
- Per-chunk receipts and reply aliases are checkpointed so a retry never resends
  a delivered chunk.

Delivery failure never rolls back the Task, re-admits the prompt, or moves the
inbound cursor. The outbox is only for final messages — not history, reactions,
edits, presence, or a general provider-action framework.

## Identifiers and compatibility

The canonical thread key is the bare provider thread Snowflake. Still parsed
(`parseDiscordThreadKey`): `discord:message:<channel>:<message>` (top-level
message / seed-chunk reply alias), `discord:thread:<parent>:<thread>` (legacy
thread), and `discord:dm:<channel>:<user>`. Existing mappings are never
rewritten by guessing; a mapping with no cursor is bootstrapped by a bounded
read ending at the live mention. Aliases are not evidence that any history
interval was admitted. Old implicit configs that can't be translated to the
explicit contract stay disabled.

Proactive `channel:<snowflake>` sends are durable seeds: the first eligible
human reply consumes the seed and starts the mapped session without creating a
summon thread or going through mention catch-up.

## Channel-history agent tool

`agor_gateway_discord_channel_history_get` is a separate opt-in
(`agent_tools: { channel_history: true }`); absent/`[]`/`false` reject without
calling Discord, and unknown keys, non-booleans, or non-empty arrays fail
validation. Invariants beyond the guide:

- Targets are limited to allowlisted parents and public threads under them; a
  denial reveals nothing about the target. Another tenant's `gatewayChannelId`
  is indistinguishable from a missing one.
- Session callers must be on the row's target branch; callers without session
  context need admin or `all` branch permission.
- Check View Channel + Read Message History first — Discord returns an empty
  list, not an error, without Read Message History. Empty `content` on an
  ordinary user message with no rich payload means Message Content is missing
  and fails the read. Forwards read from the first `message_snapshots` entry.
- Page/byte budgets yield partial results with `has_more` and a cursor;
  timeout and rate-limit budgets span the whole call and are errors. An
  oversize first message is truncated so paging progresses.
- The tool never advances a catch-up cursor, admits a Task, or stores Discord
  content outside the calling session's tool result. Output is labeled
  untrusted; the token never appears in input, output, errors, or logs.

## Non-goals

Typing/progress/presence surfaces; durable history or attachment mirrors;
automatic Discord app/guild/role/permission mutation; repair, replay, or
cursor-edit APIs; autonomous Tasks for mentions missed while offline.
