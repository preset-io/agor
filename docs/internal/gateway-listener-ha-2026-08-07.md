# Gateway listener HA and provider kill-point audit

Date: 2026-08-07

## Scope and authority

PostgreSQL is the durable authority for listener ownership, polling checkpoints,
provider-event identity, thread/session mapping, Tasks, and Messages. Redis is
not consulted by any listener claim, renewal, fence, checkpoint, or event
transition; it remains Socket.IO fanout only. There is no fleet leader or
central worker controller. Every daemon scans the same bounded candidate space
and contends independently for each channel row.

SQLite preserves the historical process-local listener registry and one-shot
startup. It receives schema parity and durable helper support, but does not run
the distributed lease worker.

## Ownership contract

- One lease row lives on each `gateway_channels` row. A claim holds an opaque
  random token, monotonically increasing diagnostic generation, claim time,
  expiry, and daemon instance/boot labels.
- PostgreSQL claims and renewals use `CURRENT_TIMESTAMP` while holding the
  channel row lock. Production callers cannot substitute daemon time.
- The lease is 30 seconds. Local owners are renewed before discovery. The
  recurring scan has a 5-second nominal cap with 20% jitter (6 seconds maximum),
  while full pages advance after at most 250 ms. Discovery returns only
  unclaimed/expired candidates. For `C` simultaneously claimable channels, a
  hard-dead owner is therefore replaceable within roughly **36 seconds +
  ceil(C/25) × 250 ms + bounded query/provider connection time**. Database
  unavailability pauses ownership progress rather than falling back to process
  presence.
- Configuration update, disable, and credential rotation atomically clear the
  token and increment the generation. Delete cascades the event records. A
  callback must still hold the live opaque token before event admission,
  provider acknowledgement, inbound routing, checkpoint advance, and event
  completion.
- Graceful drain stops recurring discovery, rejects new callbacks, stops each
  provider transport with a 5-second bound, and waits up to 5 seconds for
  already-admitted callbacks. It releases only after successful transport stop
  and callback drain. A timeout leaves the database lease to expire.
- Discovery is keyset-paged in batches of 25 by tenant/channel. It returns only
  routing IDs from system scope; credentials are loaded inside the discovered
  tenant's RLS scope. Empty pages wrap the cursor. Shared coordination helpers
  provide startup spreading, bounded backoff, and jitter.

## Provider support matrix

| Provider                            | Inbound transport                                                                                        | Distributed listener status                                                                                                                                                        | Event identity / checkpoint                                                                                                                                                                         | Outbound and remaining at-least-once window                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack                               | Socket Mode                                                                                              | **Supported on PostgreSQL.** One lease owner opens the socket. Accepted events are transport-acknowledged after the durable callback; ignored events are acknowledged immediately. | Workspace + conversation + message timestamp, with Slack `event_id` only when those logical message coordinates are absent. This converges alternate envelopes for one message. No checkpoint.      | Normal message hooks execute on the daemon handling the durable Message and reload fresh tenant-scoped credentials; they do not depend on the listener owner. Slack may redeliver while a callback is pending/failed; the occurrence key and stable Task identity reconcile it. Slack's send API has no Agor idempotency key, so provider success followed by process death remains an outbound uncertainty window. |
| GitHub                              | Installation-authenticated API polling                                                                   | **Supported on PostgreSQL.** One lease owner polls each channel's configured repositories.                                                                                         | `github:issue_comment:{owner/repo}:{comment_id}`. Watermarks, ETags, and the bounded processed-ID ring are stored in the lease-fenced channel checkpoint. A first start uses a five-minute overlap. | Reaction and Processing-comment creation happen only after occurrence admission. GitHub offers no idempotency key for comment creation: a provider-success/process-crash gap can create a duplicate acknowledgement. Final response normally edits the known comment ID and is idempotent; fallback comment creation is at least once.                                                                              |
| Shortcut                            | API polling                                                                                              | **Supported on PostgreSQL.** One lease owner polls the workspace/search scope.                                                                                                     | `shortcut:comment:{story_id}:{comment_id}`. Watermark and processed-ID ring use the fenced checkpoint; first start overlaps five minutes.                                                           | The acknowledgement is created only after admission and normally edited into the final response. Shortcut comment creation has the same provider-success/database-crash at-least-once gap as GitHub.                                                                                                                                                                                                                |
| Microsoft Teams                     | Per-channel local Bot Framework HTTP server; proactive replies need an in-memory `ConversationReference` | **Unsupported/fail-closed for PostgreSQL distributed listener mode.** **Supported only by the historical standalone SQLite path.**                                                 | Activity IDs exist, but current ingress routing and reply capability are tied to one local port and process memory. An event table alone cannot make a load-balanced webhook safe.                  | Requires a product/deployment decision described below. The daemon logs `provider_unsupported` and does not claim/start Teams on PostgreSQL.                                                                                                                                                                                                                                                                        |
| Discord / WhatsApp / Telegram       | No connector is registered; these are reserved channel enum values.                                      | **Unsupported/fail-closed in both modes.** Discovery skips them because `hasConnector` is false.                                                                                   | None.                                                                                                                                                                                               | No outbound path is registered.                                                                                                                                                                                                                                                                                                                                                                                     |
| Runtime-registered custom connector | Extension-defined.                                                                                       | **Unsupported for automatic listener startup until explicitly audited.** `hasListeningConfig` admits only the built-ins above, so discovery fails closed.                          | If a future built-in wires it, PostgreSQL callbacks without a stable `providerEventId` fail before preparation/routing and the extension must own a recovery cursor.                                | Provider-specific idempotency and acknowledgement semantics require an explicit support-matrix update.                                                                                                                                                                                                                                                                                                              |

### Credential and token state

Slack and Shortcut credentials are static channel configuration; rotation is a
channel update and therefore revokes the owner and clears the old provider
checkpoint before a fresh connector loads the new secret/scope. GitHub App
installation access tokens are cached/refreshed by
Octokit inside one connector incarnation; a replacement owner creates its own
Octokit instance from the tenant-scoped App credentials and obtains a fresh
installation token. Teams Bot Framework authentication remains inside the
unsupported process-local connector path. No provider token or OAuth refresh
state is shared through Redis or a process-global listener registry.

The legacy generic `/gateway` channel-key inbound call has no provider event
identity contract. It remains available to standalone SQLite, but fails closed
on PostgreSQL instead of admitting an unfenceable, non-idempotent delivery.

## Inbound occurrence state machine

`gateway_inbound_events` has a tenant-aware unique key on channel + provider
event ID. Admission locks the channel, verifies enabled + unexpired listener
token, and inserts `processing` with a two-minute processing expiry. A duplicate
completed event is a no-op. An incomplete event can be reclaimed after that
expiry, but only by the then-current channel listener. A retry delivered to the
same still-current owner may immediately reconcile its own stable IDs; a
different owner must wait for expiry.

The event row deterministically derives the first Session and prompt Task IDs.
Prompt admission uses the existing internal Task idempotency contract and stamps
`Task.metadata.gateway_inbound_event_id`. A crash after Session creation or Task
admission is therefore reconciliation of the same identities, not a second
logical prompt. Event completion is conditional on both the event processing
token and the still-live listener token.

When GitHub or Shortcut creates an editable acknowledgement, its comment ID is
recorded on the occurrence behind the same token before routing continues. A
retry or replacement owner reuses that provider object. The unavoidable narrow
gap is provider success before that metadata write commits.

Provider payloads are not copied into PostgreSQL. Pollers recover payloads from
the provider by retaining the last fenced checkpoint; Slack leaves a failed
accepted callback unacknowledged so the provider can redeliver it. An occurrence
that was admitted but did not complete is held for two minutes before another
owner may reclaim it. This intentionally prefers duplicate suppression over
immediate retry.

## Kill-point audit

| Kill/pause point                                                               | Result and recovery                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before channel claim commits                                                   | No owner exists; any daemon may claim.                                                                                                                                                                                                                                                                                                                                                                                                          |
| After claim, before provider connect                                           | The token expires in 30 seconds; another scan takes over. Startup failure releases the token best-effort.                                                                                                                                                                                                                                                                                                                                       |
| Provider connects, then channel is disabled/deleted/rotated                    | The mutation revokes the token immediately. Renew/checkpoint/callback fences fail and the local transport is stopped on the next renewal pass or CRUD hook. Delete cascades occurrences.                                                                                                                                                                                                                                                        |
| Provider event before occurrence admission                                     | No accepted-event Agor/provider acknowledgement side effect is made. Ignored Slack envelopes are transport-acknowledged; accepted failures are left for provider retry. Poll overlap recovers GitHub/Shortcut.                                                                                                                                                                                                                                  |
| After occurrence admission, before acknowledgement                             | The event remains processing. A retry to the same current owner immediately reconciles its stable IDs; a different owner waits for the two-minute expiry.                                                                                                                                                                                                                                                                                       |
| Provider acknowledgement API succeeds, process dies before metadata is routed  | GitHub/Shortcut may create a second acknowledgement after reclaim because their create-comment APIs have no client idempotency key. This is the documented provider at-least-once gap.                                                                                                                                                                                                                                                          |
| Session commits, process dies before mapping/Task                              | The stable event-derived Session is reused only after branch, creator, and channel identity validation. Mapping uniqueness elects one thread mapping. The stable Task is retried.                                                                                                                                                                                                                                                               |
| Task commits/dispatches, process dies before occurrence completion             | Reclaim calls prompt with the same Task ID. Prompt reconciliation returns the already durable Task rather than launching a duplicate.                                                                                                                                                                                                                                                                                                           |
| Old owner pauses after a fence read, then lease is revoked                     | Durable occurrence admission/checkpoint/completion revalidate the opaque token in their mutation. Session/Task use stable event-derived IDs, so a final application check/commit race reconciles the same logical work rather than creating a second prompt. Provider APIs cannot consume Agor's token; acknowledgement/send calls retain the provider-specific uncertainty windows above.                                                      |
| Poll callbacks finish, owner loses token before checkpoint                     | Conditional checkpoint update fails, the poller restores its prior in-memory checkpoint and stops. The next owner re-polls the overlap; event keys deduplicate.                                                                                                                                                                                                                                                                                 |
| Final GitHub/Shortcut message created, producing daemon dies before idle flush | A post-turn hook on a recovering daemon reloads the latest assistant Message from PostgreSQL; the process-local buffer is only a cache. The editable acknowledgement makes replay idempotent. There is not yet a separate outbound scanner if death occurs after the only post-turn trigger commits but before its deferred hook starts; see decision 5. Without an acknowledgement ID, fallback create-comment delivery remains at least once. |
| Graceful shutdown during provider stop                                         | Successful stop precedes release. Timeout/error leaves the token to expire, preventing premature handoff.                                                                                                                                                                                                                                                                                                                                       |
| Hard death                                                                     | No cleanup is required. Database expiry plus bounded discovery elects a new owner. Redis state is irrelevant.                                                                                                                                                                                                                                                                                                                                   |

## Tenant/security proof

- System discovery can select only enabled channel/tenant routing references via
  the existing `gateway_listener_discovery` RLS capability.
- Claim, renewal, checkpoint, occurrence, channel reload, credential decrypt,
  mapping, Session, and Task operations all run under the captured tenant scope.
- The new occurrence table has forced RLS and tenant-stamped inserts. PostgreSQL
  integration coverage proves a tenant cannot read/claim another tenant's
  channel or event, while explicit system discovery can see only the narrow
  references.
- Connector configuration continues to be decrypted only after tenant reload.
  Tokens are never placed in system-scope discovery rows, lease diagnostics, or
  occurrence records.

## Validation coverage

- PostgreSQL: five simultaneous claims elect one winner; renewal, expiry
  takeover, stale renewal/checkpoint/release; duplicate event, expired event
  reclaim, stale completion; update/disable revocation; RLS cross-tenant
  negatives and bounded discovery.
- Fake daemon transports: duplicate provider delivery calls preparation and
  routing once; lost ownership performs neither; graceful drain stops transport
  and waits for admitted callbacks before releasing the token; PostgreSQL
  outbound routing ignores the process-local listener cache.
- Connector unit coverage: polling, checkpoint-safe awaitable callbacks, stable
  provider IDs, and standalone migration compatibility. PostgreSQL tests are
  environment-gated with `AGOR_TEST_POSTGRES_URL`.

## Focused Max decisions

1. **Teams HA ingress:** choose either (a) a shared externally hosted webhook
   endpoint that authenticates, deduplicates, and durably enqueues activities,
   or (b) load-balancer affinity plus durable ConversationReference storage and
   an explicit callback-owner routing contract. Until then, PostgreSQL Teams
   listeners remain fail-closed.
2. **Provider acknowledgement product semantics:** accept the narrow
   GitHub/Shortcut duplicate-ack window, remove immediate acknowledgement, or
   add a reconciliation job that searches for a branded/event-tagged existing
   comment before creating one. Provider APIs do not offer native idempotency.
3. **Recovery latency:** confirm the 30-second channel lease / 5-second scan /
   two-minute event-processing lease defaults. The first two bound hard-death
   takeover; the third bounds recovery of an event interrupted after admission.
4. **Generic inbound API:** if PostgreSQL customers need custom webhook
   producers, define a required caller/provider event-key contract before
   re-enabling `/gateway` delivery there.
5. **Durable response outbox:** listener ownership and inbound Task admission are
   HA-safe, and outbound routing is stateless across daemons, but ordinary Slack
   sends and the final post-turn trigger are not a transactional provider outbox.
   Decide whether gateway replies require a durable delivery/reconciliation
   state machine (with provider-specific at-least-once UX) or retain the current
   best-effort response semantics.
