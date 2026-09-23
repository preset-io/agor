# Task Queueing

**Tasks are the queueable unit. Sessions accept prompts. PostgreSQL is the
durable authority for admission, ordering, and dispatch across daemons.**

## Wire shape

`POST /sessions/:id/prompt` always returns the persisted `Task`. Callers inspect:

- `task.status === 'queued'` — the task has a durable position and is waiting;
- `task.status === 'dispatching'` — launch intent is durable and an executor is
  being started;
- `task.status === 'running'` — the authenticated executor claimed the task;
- `task.queue_position` — ordering within the Session queue (lowest first),
  populated only while `queued`.

There is no separate “queued vs ran” envelope and no `queue: true` request flag.
The response is the result of the admission attempt, not a decision based on a
client's earlier Session GET.

## Durable admission and dispatch

1. **Admit** — fresh ordinary prompts may insert a `dispatching` Task directly.
   Under the tenant authorization fence and Branch → Session locks, admission
   checks Session eligibility and the absence of _all_ nonterminal Tasks
   (including queued work and created handoffs). The Task insert and Session
   running projection commit together. Preflight Session reads only decide
   whether to prepare launch metadata; they never authorize dispatch.
   Stable-ID callback/widget/scheduled producers retain their queue and
   reconciliation protocol.
2. **Queue when needed** — when direct admission is not eligible,
   `TaskRepository.createPending` inserts a `queued` Task with
   `max(queue_position) + 1` under the same Session fence. There is no separate
   queue table. The route may attempt that head through `spawnTaskExecutor`;
   otherwise the existing durable worker will discover it.
3. **Claim queued work** — `claimDispatchAndProjectSession` takes the Branch
   admission lock, then Session and Task,
   and atomically checks the queue head, absence of another executing Task,
   Session promptability, and the expected Task state. The winning transaction
   writes `queued|created -> dispatching` and the Session's running projection.
4. **Launch after commit** — only `outcome: 'claimed'` may schedule executor
   launch (a loser may only perform deterministic transcript repair after the
   winner has crossed the fence). No transaction is held while spawning an
   executor or doing external work. The authenticated executor later claims
   `dispatching -> running`.

Prompt-route admission executes once inside its owned admission
transaction. No automatic replay is performed, including for `40P01` or
`40001`: the incident cause is not established. Tenant write gating, current
authority, Branch → Session admission locks and queue sequencing are unchanged.
The diagnostic wrapper preserves caller-owned transaction errors so the owner
can roll back. Launch preparation runs before admission without retaining its
locks. Title work, transcript writes and provider calls remain outside this unit. The direct
winner reuses prepared state and skips the second dispatch-claim transaction.
Its first Task event is `created` with `status: dispatching`, not an intermediate
queued event; only an actual queued admission is published as queued. See
`utils/prompt-admission-transaction.ts` in the daemon.

The outer prompt route sanitizes database failures even outside enqueue (and
when a wrapped query has no SQLSTATE). Users receive a reference and a warning
to inspect the session before resending: dispatch may already have committed.
`prompt.database` logs that reference, nested SQLSTATE/allowlisted driver code,
known row-lock table, numeric deadlock wait edges when available, and elapsed
time. Admission failures also record attempt, failure phase and acquisition/setup
time. Elapsed time is **not** a lock-hold measurement; acquisition/setup includes
pool wait and tenant setup. Raw SQL, parameters, driver detail and stacks are
never serialized; the original cause stays non-enumerable internally. Existing
PostgreSQL transaction tracing separates root acquisition/setup from body time.

BTW completion keeps the terminal Task, Session projection and archival in the
original transaction. Parent-result message insertion is scheduled only after
commit and opens its own tenant transaction, avoiding a Branch lock request
while retaining child Task/Session locks. Rollback discards the callback; there
is no automatic retry or new durable outbox. Existing best-effort delivery can
still be lost if the daemon exits after commit. Repository-origin maintenance
also runs after commit with tenant identity but without a transaction spanning
Git I/O. Completion callbacks/queue handoff retain their existing separate DB
scopes; these changes are not a general lock-order redesign.

`created` remains supported for the explicit `POST /tasks/:id` then
`POST /tasks/:id/run` workflow. It cannot jump an existing queued prompt or a
different executing Task.

## Agent queue management

Public `tasks.cancelQueued` and `tasks.reorderQueued` share
`TaskRepository.mutateQueued`: Session lock first, then queued Task locks,
validation and mutation in one transaction. Single-task `tasks.remove` uses the
same fence. Cancellation deletes only queued rows (no terminal transition or
completion callback). Reorder compares the full expected ordered ID snapshot
and requires an exact permutation, then compacts positions inside the lock so
subsequent max+1 admission stays after the reordered tail. Unique-index-safe
position clearing is transaction-private.

Both commands reuse Task deletion's Member + Branch Manager authorization.
MCP passes the acting user's external provider/tenant params to these public
methods, not to a repository bypass. Standard removed/patched events and a
promptable-only queue wakeup occur after commit. Session projections and
failure holds are unchanged. See [the MCP guide](../../apps/agor-docs/content/guide/internal-mcp.mdx#managing-a-sessions-pending-queue)
for conflicts, result shape and examples.

## Fleet-wide draining and recovery

Every daemon runs a bounded `SessionQueueWorker`. It discovers routing-only
queued Session refs and then reloads/processes each Session inside its trusted
tenant scope. There is no permanent leader and no worker lease: overlapping
scans are expected, while the Session+Task claim elects the only launcher.

Ordinary draining is event-driven by the committed terminal/Session projection.
The worker is a missed-event and restart recovery sweep, not a low-latency poller:
it pages quickly through at most 250 Session refs per sweep, preserves its
keyset cursor when saturated, then waits about one minute before continuing. A
known-busy queue head is therefore not fully hydrated every few seconds, while
a missed wakeup remains durably recoverable.

The scan cursor, startup offset, bounded backoff, and jitter are contention
etiquette and fairness only. A process-local `SessionTurnLocks` map and
`queueRetryScheduled` set similarly coalesce work inside one daemon; process
death or duplicate triggers cannot affect correctness.

Queued rows survive daemon restart. Completion, Stop, callbacks, widgets,
scheduled initialization, and the recovery worker may all trigger draining;
duplicate triggers converge at the same durable claim. Callback and widget
occurrences use deterministic Task IDs so competing producers converge on one
queued row and one position. Their stable initial-message identity is persisted
in `Task.metadata.initial_message_id`; a later drainer therefore writes exactly
the same transcript row. A losing admission that still observes `queued` writes
no transcript row.

Widget submit/dismiss uses a separate short Message-row claim before registry
or connector work. Only `pending -> resolving` may perform that work; the
opaque claim token alone may publish `submitted|dismissed`. An interrupted
attempt remains durably `resolving` and is not replayed automatically because
the prior side effect may already have happened. Only an `applySubmit` handler
that explicitly reports failure before returning releases the widget to
`pending` with a secret-free failure code for an explicit retry; handlers must
make that reported-error retry idempotent. Prompt-admission or completion
failures after `applySubmit` succeeds leave the claim `resolving` so the effect
cannot be replayed. Widget creation and lifecycle metadata are daemon-owned:
generic external Message create/update/patch cannot mint or alter a widget,
and pending/resolving widgets cannot be externally removed.

## Invariants

1. At most one Task is in an executing state for a Session.
2. Concurrent enqueue produces one durable order decision per Task.
3. Only the durable queue head may claim dispatch.
4. A Task claim has one winner; losing daemons do not launch.
5. Terminal Task state is immutable.
6. Queue state survives daemon/process loss.
7. System discovery exposes only routing refs; mutation always re-enters the
   discovered tenant scope.
8. SQLite preserves the same user-visible ordering and lifecycle without
   pretending to provide multi-daemon authority.

## Runtime supervision handoff

- Queued Tasks are durable user intent and survive daemon startup in both
  standalone and shared PostgreSQL modes. Replica startup is never a queue
  outcome.
- Shared PostgreSQL startup also leaves active Tasks and their Session
  projection untouched; bounded runtime reconciliation acts only on expired
  dispatch facts, stale executor heartbeats, or existing durable termination
  requests.
- Queue release follows authoritative Task settlement and the resulting
  Session projection. It is not keyed to daemon identity or restart notices.
- Verified containment may make the Session promptable and show a new-Task
  Resume action. Unverified containment remains `stopping` and guarded behind
  owner/admin force-fail.

## Key files

- Persistence: `packages/core/src/db/repositories/tasks.ts`
- Admission/launch/drain: `apps/agor-daemon/src/register-routes.ts`
- Fleet recovery: `apps/agor-daemon/src/services/session-queue-worker.ts`
- Local coalescer: `apps/agor-daemon/src/utils/session-turn-lock.ts`
- Producer identities: `apps/agor-daemon/src/utils/durable-task-id.ts`
- Widget resolution fence: `apps/agor-daemon/src/widgets/resolution-store.ts`
- Reactive client: `packages/client/src/reactive-session.ts`

For post-claim executor lifecycle, heartbeat, SDK pulse/watchdog, and
termination ownership, see [task-runtime-state.md](task-runtime-state.md).
