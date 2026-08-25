# Discord Gateway — Slack-Aligned Design (Revision 5)

**Status:** Proposed architecture for the next implementation revision

**Scope:** Discord inbound gateway behavior and its narrow compatibility boundary

This document is a self-contained design input. It defines behavior and
boundaries; it does not define the implementation task breakdown.

## Governing decision

Discord should adopt the same correctness model as Slack:

> **The provider owns conversation history. Agor owns only the durable routing
> facts needed to resume safely.**

The Discord Gateway connection is a restartable transport, not a conversation
store. A live mention is the only trigger for a Task. On that trigger, Agor
authorizes the event, resolves or creates the public thread, reads the last
admitted Discord message ID, fetches a bounded ordered slice from Discord REST,
admits one Agor Task, and advances the cursor only after admission. Response
delivery is downstream of that boundary.

This decision keeps ordinary Discord discussion ordinary, makes a daemon
restart recoverable, and prevents an unavailable or stale Agor copy of Discord
history from becoming an accidental second source of truth.

## Current versus target

| Concern              | Current Discord beta                                                                                                      | Target architecture                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live transport       | One Gateway connection with a persisted Discord session/sequence checkpoint                                               | Restartable, lease-fenced transport; the checkpoint is only a resume hint for the connection                                                                 |
| Trigger              | Mentioned text received in `MESSAGE_CREATE`                                                                               | Structured bot mention outside code, received with Message Content intent; only a live mention starts work                                                   |
| Threading            | Accepts configured parent messages and existing public threads; uses `discord:message:*` and `discord:thread:*` encodings | Canonical provider thread identity; top-level summons use idempotent public-thread-per-summon creation, while existing-thread compatibility remains readable |
| Context              | Live message only; no Discord history catch-up                                                                            | Bounded Discord REST history from the mapping cursor through the live mention, normalized in Snowflake order and marked untrusted                            |
| Cursor               | Gateway sequence can resume the transport; no durable per-thread admitted-history cursor                                  | Durable last-admitted provider message cursor on the tenant-owned thread/session mapping                                                                     |
| Identity             | Explicit fixed `agor_user_id`                                                                                             | Aligned Discord identity when configured, or an explicit fixed-user fallback; alignment never silently falls back                                            |
| Content/capabilities | Text-only beta; attachments and other rich message forms are rejected                                                     | Text-only inbound core remains bounded; file and agent-tool capabilities are explicit, independently gated configuration                                     |
| Proactive outbound   | Text-only `channel:<snowflake>` seeds with durable reply aliases                                                          | Preserved as a separate compatibility path; inbound summon threading must not reinterpret or duplicate a seed                                                |

The existing listener ownership, inbound idempotency, tenant scoping, and
restart behavior are the foundation to retain. The target adds Discord-specific
history and thread semantics; it does not make the listener checkpoint a
conversation cursor.

## Target architecture and the meaning of stateless

**Stateless does not mean durable-free.** It means that provider transport and
session state are process-local and optional:

- a daemon may hold a Discord client, WebSocket session, shard state, REST
  client, caches, and in-flight request buffers in memory;
- any of that state may disappear on restart, ownership handoff, configuration
  refresh, or transport failure;
- a new owner must be able to recreate the transport from tenant-scoped channel
  configuration and continue safely.

Durable correctness is limited to these facts:

1. **Tenant-scoped listener ownership and fencing.** One current owner may
   receive and acknowledge an event. A stale owner cannot route, checkpoint, or
   acknowledge after its lease is lost.
2. **Inbound idempotency.** A stable Discord event identity has one durable
   processing outcome. A retry reconciles the same event and Task instead of
   creating a second Task.
3. **Thread/session mapping.** A tenant and gateway channel map a canonical
   Discord public thread to one Agor session, with compatibility aliases where
   required.
4. **Last-admitted Discord message ID.** Each mapping records the greatest
   provider message ID whose bounded context was admitted into a Task. This is
   a Snowflake cursor, compared as an unsigned integer, never as a JavaScript
   floating-point number.

No Discord message body, transcript, attachment payload, or reconstructed
conversation is durable Agor state. Discord remains the history source of
truth. In particular, **do not mirror Discord conversation history into S3,
the Agor database, logs, caches intended to survive restart, or another
transcript store.** If a later attachment-staging slice is separately
accepted, its files are bounded and ephemeral, scoped to the admitted session
and task, and are not conversation-state storage.

## End-to-end flow

```text
Discord live mention
        │
        ▼
structured mention + provider/guild/parent/allowlist authorization
        │
        ▼
aligned identity or explicit fixed-user fallback
        │
        ▼
resolve existing public thread or idempotently create one
        │
        ▼
load tenant mapping and last-admitted Snowflake cursor
        │
        ▼
bounded Discord REST history: cursor < messages ≤ live mention
        │                 (ordered, untrusted, no durable transcript)
        ▼
admit one Agor Task
        │
        ├── failure: keep cursor; do not create a delayed Task
        │
        ▼
advance cursor to the admitted mention ID
        │
        ▼
deliver the Task result to the mapped Discord thread
```

### 1. Receive a live mention

The listener accepts `MESSAGE_CREATE` from the configured guild only. The
provider configuration must request the `GUILDS`, `GUILD_MESSAGES`, and
privileged **Message Content** intent, and the Discord application must have
that privileged intent enabled. Without Message Content, the listener fails
closed for the history-dependent mode; it must not pretend that a mention-only
exception is sufficient for ambient catch-up.

The trigger is a **structured mention** of the configured bot, verified against
the message content outside both fenced and inline code. A plain token inside a
code span is not a summon. The adapter must use Discord's structured mention
identity and the raw content positions together; a regex-only check is not the
authorization rule. After validation, remove only the bot mention from the
prompt text. An empty summon is ignored rather than admitted.

At launch, accept only ordinary user-authored text messages in a public text
channel or a public thread whose parent is allowed. Ignore bot and system
messages, webhooks, DMs, private threads, other guilds, unsupported message
types, and messages in unconfigured parents. No missed event is turned into a
background Task.

### 2. Authorize and resolve identity

Authorization is performed from fresh tenant-owned channel configuration and
provider data, not from caller-supplied metadata:

1. verify the configured application/bot identity, guild, public parent, and
   current channel/thread relationship;
2. require the author in `allowed_user_ids` or require at least one current
   member role in `allowed_role_ids`;
3. resolve the Agor execution identity using the configured alignment policy.

With alignment enabled, resolve the Discord user ID through a tenant-owned
provider-to-Agor identity mapping. An unmatched or unresolvable identity is
rejected; it never inherits the fixed user. With alignment disabled, require an
explicit channel `agor_user_id` and run every accepted prompt as that user.
The fixed user is a deliberate fallback, not an implicit default. The resolved
user determines the branch, execution-home, permissions, agent configuration,
and audit identity for the new or existing session.

The provider allowlist and the Agor identity are separate decisions: being an
allowed Discord role does not by itself grant a different Agor user, branch, or
capability.

### 3. Resolve or create the provider thread

The target launch mode is `public_thread_per_summon`:

- a mention already inside an allowed public thread resolves to that thread;
- a top-level mention is the starter message for one public thread under its
  allowed parent;
- the bot replies in that thread, not by filling the parent channel with
  agent output.

Creation is idempotent per summon. Before creating, reconcile in this order:

1. an inbound idempotency record's stored provider-thread result;
2. a provider lookup for a public thread whose starter message is the live
   summon;
3. a single create call, followed immediately by durable recording of the
   resulting thread identity.

A retry must never blindly create another public thread. The provider thread
identity and the live summon message ID are the stable pair used to bind the
result. If Discord cannot prove the existing thread or creation result, reject
the context-poor attempt and preserve the cursor; do not guess a different
thread.

The `thread_mode` setting is explicit even when only
`public_thread_per_summon` is enabled at launch. An `existing_public_thread`
compatibility mode may be read for current beta channels, but no new mode is
introduced without its own authorization, idempotency, and delivery contract.

### 4. Load the mapping and cursor

The lookup key is tenant + gateway channel + canonical Discord provider thread.
If a mapping exists, load its session and `discord_last_admitted_message_id`. If
it does not, use an empty cursor and create the mapping as part of the normal
first-admission race; database uniqueness elects one mapping when two accepted
deliveries contend.

The Discord Gateway sequence checkpoint is not used as this cursor. A sequence
identifies transport progress; a mapping cursor identifies conversation
context that was actually admitted to Agor.

### 5. Fetch bounded Discord REST history

The live mention triggers the only catch-up read. The provider adapter fetches
the thread's messages after the saved cursor and through the live mention,
using Discord REST pagination. Each page is at most Discord's provider limit;
the adapter applies configured caps for total messages, pages, normalized
characters/bytes, and wall-clock time. It obeys `Retry-After` and bounded
backoff, then stops with a typed failure rather than retrying indefinitely.

Discord returns message pages in an order that must not be passed through
unchanged. Normalize, validate, and sort by Snowflake order, oldest first.
The adapter must prove that the result covers the interval from the cursor to
the live mention. Hitting a cap before proving that boundary is incomplete
history, not a successful truncated prompt.

The context packet is assembled in memory only:

- messages after the cursor and through the mention are ordered by provider
  Snowflake;
- the live mention is labeled as the current summon and is not duplicated if
  the REST page also returns it;
- bot/self messages and unsupported non-text forms are excluded from the
  prompt by the configured policy, while the cursor boundary still advances
  over provider messages that were successfully covered;
- every retained message is labeled as **untrusted Discord context**. It is
  reference material, not an Agor instruction, identity assertion, or
  capability grant.

If history fails, is rate-limited beyond the bound, lacks Message Content, or
cannot prove coverage through the live mention, reject this admission. Keep
the prior cursor unchanged. A later live mention retries the bounded read; no
autonomous delayed Task is created for a mention that was missed during the
failure window.

### 6. Admit the prompt as one Task

Build the gateway context and ordered catch-up packet, then call the normal
session prompt admission path. A new session and mapping may be admitted only
for this authorized live summon. A busy session receives a queued Task under
the normal session queue rules; that is still Task admission and is the point
at which the Discord message ID becomes eligible to advance.

Inbound event idempotency and stable Task identity cover the crash window where
the Task is committed but the provider callback has not yet completed. A
redelivery must find and reconcile that Task, not run the prompt a second time.

### 7. Advance the cursor after Task admission

Only after the Task admission result is durable may the mapping advance its
cursor to the live mention's Snowflake. The update is monotonic under the
mapping row's concurrency control: a retry or later delivery cannot move it
backward. The cursor write must not happen before history succeeds or before
Task admission.

If admission fails, the cursor remains at its previous value. If admission
succeeds but the cursor write is interrupted, the idempotent event retry
reconciles the admitted Task and completes the monotonic cursor update. This
prevents both lost context and duplicate prompts.

### 8. Deliver the response

The session's response is delivered to the canonical Discord thread after
inbound admission. Delivery uses the configured text policy, suppresses
generated mentions by default, and respects Discord's message-size limit with
deterministic chunking. Delivery failure does not roll back a Task or move the
inbound cursor backward; it belongs to the separate final-delivery reliability
boundary below.

## Catch-up contract

| Event                                    | Result                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Human replies without mentioning the bot | Discord remains the source of truth; no Task and no cursor movement                                      |
| Later live mention arrives               | Fetch messages strictly after the mapping cursor through that mention, in provider order                 |
| History succeeds and Task is admitted    | Advance the cursor to that mention's Snowflake                                                           |
| History fails or is incomplete           | Reject context-poor admission; preserve the cursor                                                       |
| Task admission fails                     | Preserve the cursor; retry only from a later live mention or provider redelivery of the same event       |
| Daemon/listener restarts                 | Recreate transport; use the durable mapping cursor for conversation catch-up, not the transport sequence |

This is deliberately not a polling job. A human's missed mention is not an
instruction for Agor until a later live mention opens a new admission boundary.

## Configuration contract

The Discord channel configuration should make every authority-bearing choice
visible and tenant-scoped:

| Area                   | Required design                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application and guild  | `application_id`, `guild_id`, and one bot credential; the token's bot identity must match the application and guild access must be verified                               |
| Allowed parents        | One or more public text-channel Snowflakes; child public threads are derived from these parents, not accepted as arbitrary channel targets                                |
| Provider authorization | `allowed_user_ids` and/or `allowed_role_ids`; empty allowlists are not an accidental open gateway                                                                         |
| Agor identity          | `align_discord_users` with a tenant-owned Discord-to-Agor mapping, or explicit fixed `agor_user_id`; alignment failures reject rather than fall back                      |
| Thread mode            | Explicit `public_thread_per_summon`; read-only compatibility for current existing-thread encodings may be retained during migration                                       |
| Catch-up bounds        | Maximum pages, messages, prompt bytes/characters, request time, and bounded rate-limit retry policy; values must be validated and have safe ceilings                      |
| File capability        | Explicit `files` capability, disabled by default for the inbound core. Attachment staging is not part of this design slice                                                |
| Agent-tool capability  | Explicit per-channel `agent_tools` allowlist, empty or least-privilege by default; a provider read/write tool must not appear merely because the bot can read Discord     |
| Proactive outbound     | `outbound_enabled` and an allowed `channel:<snowflake>` target remain branch-bound and text-only for compatibility; proactive sends do not silently create summon threads |

Configuration changes stop and restart the affected transport with fresh
credentials and a fresh capability snapshot. Secrets are encrypted at rest,
never included in history context, and never trusted from inbound metadata.

## Discord constraints that are part of the design

- Message Content is a privileged intent and must be enabled for ambient
  catch-up; the design does not rely on the limited content exception for a
  mentioned live event.
- Mention detection is structured and code-aware. Mentions in inline or fenced
  code are not triggers.
- Public-thread-per-summon creation is idempotent by the live summon message,
  inbound event record, and provider lookup; retries do not create duplicate
  threads.
- Snowflakes are ordered cursors. Compare them with integer-safe logic and
  reject malformed or non-monotonic provider IDs.
- REST history is paginated, bounded, and rate-limit aware. Provider limits are
  lower bounds on safety, not permission to make an unbounded transcript read.
- DMs are not supported at launch. Adding DMs requires a separate authorization,
  identity, history, and privacy decision.
- Public thread visibility and bot permissions are checked for the configured
  parent and the derived thread. A successful token probe is not proof that
  every future thread delivery will succeed.

## Durable ownership, multitenancy, and security

Listener claims, inbound event records, channel configuration, mappings,
sessions, Tasks, and proactive seeds are tenant-owned or tenant-derived. Every
provider callback carries the tenant identity and current listener fence back
into a short tenant-scoped database unit of work. Missing, stale, or conflicting
tenant identity fails closed.

The owner fence is checked before provider acknowledgement, thread binding,
session creation, Task admission, cursor advancement, and inbound completion.
The old owner may keep a process-local socket briefly, but its callback cannot
produce a durable effect after fencing. The next owner can restart the
transport and reload only the durable routing facts.

Authorization is repeated at the gateway boundary even when the connector
already filtered the event. Provider IDs, guild, parent, roles, mention state,
and thread identity are revalidated against fresh tenant configuration. An
allowed provider user is not an Agor user until identity resolution succeeds.

Catch-up context is an untrusted input boundary. It must be clearly delimited
from the current summon, capped before prompt construction, and never allowed
to alter the target branch, session owner, capabilities, or listener state.

## Failure and recovery

| Failure                                                                              | Recovery rule                                                                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Invalid credentials, missing intent, malformed config, unsupported DM/private parent | Mark the listener in an operator-action state; do not partially accept events                                    |
| Gateway disconnect or resumable transport error                                      | Stop the connector, retry with bounded backoff, and use the fenced transport checkpoint when valid               |
| Invalid/expired Gateway session                                                      | Start a fresh session; the mapping cursor remains authoritative for later catch-up                               |
| REST rate limit or transient outage                                                  | Honor provider delay within the configured bound; on exhaustion preserve cursor and reject the current admission |
| Listener lease lost                                                                  | Fence the callback, stop the old transport, and let a new owner redeliver by stable event identity               |
| Crash after public thread creation                                                   | Reconcile the thread by summon message/event metadata before any retrying create call                            |
| Crash after Task admission before cursor write                                       | Reconcile the stable Task, then advance the cursor; never create another Task                                    |
| Crash before Task admission                                                          | Leave the cursor unchanged; a redelivery or later live mention re-reads Discord history                          |
| Response delivery failure                                                            | Keep inbound admission complete; retry only through the final-delivery boundary, never by replaying the prompt   |

The transport checkpoint may reduce reconnect work, but it cannot prove that
conversation context reached Agor. Only the mapping cursor after Task admission
can make that claim.

## Final-delivery HA is a separate decision

Core inbound correctness must not wait for a generalized provider-action
framework. The initial design keeps response delivery on the existing mapped
thread path and treats delivery as a separate reliability question.

If rollout evidence shows that a daemon handoff can lose an already-admitted
final response beyond the accepted delivery guarantee, the smallest option is a
narrow `deliver_message` outbox:

1. write one tenant-scoped outbox row for one final Agor message and mapped
   provider thread, with a unique message identity;
2. let one fenced worker claim the row for a short lease;
3. reconstruct a fresh connector from the channel's tenant-scoped config,
   deliver the text, and record the provider receipt/aliases;
4. retry bounded transient failures without re-admitting the inbound Task.

This option is triggered only by observed final-delivery loss/duplication or a
new explicit HA requirement. It is not an inbound history store, does not
buffer Discord conversation, and does not grow into a framework for reactions,
thread creation, edits, deletes, presence, or arbitrary provider actions.

## Compatibility and migration

The beta's provider identifiers remain readable during migration:

- `discord:message:<parent>:<message>` remains a reply alias for a top-level
  message or proactive seed chunk;
- `discord:thread:<parent>:<thread>` remains a compatibility alias for an
  existing public thread;
- `gateway_reply_aliases` and durable proactive seed rows continue to resolve
  replies to the same session.

New writes should use a canonical provider identity that records guild, parent,
provider thread, and starter message separately rather than relying on a
composite string's interpretation. Existing mappings are not rewritten by
guessing. On their first successful target-mode admission, a missing cursor is
bootstrapped with a bounded provider-history read ending at the live mention;
the cursor is then set to that admitted mention. No old root or reply alias is
treated as evidence that an arbitrary history interval was already admitted.

Current beta channels with a fixed `agor_user_id` remain valid through the
explicit fixed-user mode. Channels opting into alignment must provide a
tenant-owned mapping before they are enabled. Existing top-level proactive
seeds remain text-only channel sends; their first eligible human reply still
consumes the seed once and starts or resumes its mapped session. Seed replies
must not create a second summon thread or be fed through ordinary mention
catch-up until a separately accepted compatibility rule says so.

The rollout must fail closed when a channel has not enabled Message Content or
when its old configuration cannot be translated to an explicit target mode.
There is no silent reinterpretation of old identifiers, allowlists, or proactive
targets.

## Proof strategy

Proof should test the provider and durable boundaries, not only pure prompt
formatting:

1. **Provider adapter:** structured mention parsing; inline/fenced code
   exclusion; Message Content eligibility; public-parent/thread filtering;
   Snowflake comparison; chronological normalization; chunk and pagination
   bounds; rate-limit retry ceilings.
2. **Idempotent thread creation:** repeated delivery of one summon creates one
   public thread; a crash after provider acceptance reconciles the same thread;
   concurrent deliveries elect one canonical mapping.
3. **Catch-up admission:** history after the cursor is ordered and untrusted;
   missed unmentioned replies create no Task; a successful Task moves the
   cursor; a history or Task failure leaves it unchanged; a queued Task counts
   as admitted.
4. **Restart and fencing:** transport restart, invalid-session recovery,
   lease loss, stale callback, duplicate event, and crash-window Task
   reconciliation do not duplicate prompts or cross tenant boundaries.
5. **Security:** unauthorized user/role, wrong guild/parent, private thread,
   DM, code-only mention, missing aligned identity, conflicting tenant, and
   fixed-user leakage all fail closed.
6. **Delivery separation:** an outbound failure after inbound admission does
   not re-run the Task; if the narrow outbox is later enabled, its uniqueness
   and lease behavior are tested independently.

The design is ready for implementation only when these checks can distinguish
provider transport progress, provider history coverage, Task admission, and
final response delivery. A clean listener start or REST probe alone proves none
of those end-to-end claims.

## Rollout slices

1. **Contract slice:** explicit Discord configuration, Message Content intent
   eligibility, structured/code-aware mention gate, identity modes, and public
   parent/thread rules.
2. **History slice:** bounded REST adapter, Snowflake cursor semantics, ordered
   untrusted context, and rejection/preservation behavior on incomplete history.
3. **Admission slice:** idempotent public-thread creation, mapping cursor
   ownership, post-Task advancement, duplicate/crash recovery, and tenant
   negative coverage.
4. **Compatibility slice:** current beta encodings and proactive seed aliases,
   explicit migration behavior, and removal criteria for compatibility reads.
5. **Operational slice:** restart/fence evidence and response-delivery
   observation. Decide separately whether measured final-delivery gaps justify
   the narrow `deliver_message` outbox.

## Explicit non-goals

This design does not add:

- progress messages, typing, presence, or other live status surfaces;
- attachment ingestion, attachment persistence, or a durable file mirror;
- a mapped-thread history RPC or shared conversation-history store for agents;
- automatic application, guild, role, permission, or channel mutation;
- repair, replay, or cursor-edit APIs;
- DMs at launch;
- a generalized multi-kind provider-action framework;
- a generalized outbound outbox before final-delivery evidence requires the
  narrow `deliver_message` option;
- autonomous Tasks for mentions missed while the listener was unavailable;
- a Discord transcript in the Agor database, S3, logs, or any other durable
  storage.

## Public implementation references

The current public implementation and adjacent contracts are available in the
[Discord connector](../../packages/core/src/gateway/connectors/discord.ts),
[Slack connector](../../packages/core/src/gateway/connectors/slack.ts),
[gateway service](../../apps/agor-daemon/src/services/gateway.ts),
[gateway types](../../packages/core/src/types/gateway.ts), and the public
[Message Gateway guide](../../apps/agor-docs/content/guide/message-gateway.mdx).
