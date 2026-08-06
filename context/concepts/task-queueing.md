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

1. **Admit** — every prompt first creates a `queued` Task. While holding a
   short lock on the owning Session row, `TaskRepository.createPending`
   assigns `max(queue_position) + 1`. The Session row is the per-queue
   sequencer; an ordinary transaction without this lock is insufficient under
   PostgreSQL `READ COMMITTED`. A partial unique index is defense in depth.
2. **Attempt the head** — the prompt route immediately offers that Task to
   `spawnTaskExecutor`. If the Session is promptable and the Task is the
   durable queue head, it may leave the queue without waiting for a later scan.
   Otherwise the route returns the still-queued Task and its actual position.
3. **Claim** — `claimDispatchAndProjectSession` locks Session first, then Task,
   and atomically checks the queue head, absence of another executing Task,
   Session promptability, and the expected Task state. The winning transaction
   writes `queued|created -> dispatching` and the Session's running projection.
4. **Launch after commit** — only `outcome: 'claimed'` may schedule executor
   launch (a loser may only perform deterministic transcript repair for a
   stable internal occurrence). No transaction is held while spawning an
   executor or doing external work. The authenticated executor later claims
   `dispatching -> running`.

`created` remains supported for the explicit `POST /tasks/:id` then
`POST /tasks/:id/run` workflow. It cannot jump an existing queued prompt or a
different executing Task.

## Fleet-wide draining and recovery

Every daemon runs a bounded `SessionQueueWorker`. It discovers routing-only
queued Session refs and then reloads/processes each Session inside its trusted
tenant scope. There is no permanent leader and no worker lease: overlapping
scans are expected, while the Session+Task claim elects the only launcher.

The scan cursor, startup offset, bounded backoff, and jitter are contention
etiquette and fairness only. A process-local `SessionTurnLocks` map and
`queueRetryScheduled` set similarly coalesce work inside one daemon; process
death or duplicate triggers cannot affect correctness.

Queued rows survive daemon restart. Completion, Stop, callbacks, widgets,
scheduled initialization, and the recovery worker may all trigger draining;
duplicate triggers converge at the same durable claim. Callback and widget
occurrences use deterministic Task IDs so competing producers converge on one
queued row and one position.

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

## Key files

- Persistence: `packages/core/src/db/repositories/tasks.ts`
- Admission/launch/drain: `apps/agor-daemon/src/register-routes.ts`
- Fleet recovery: `apps/agor-daemon/src/services/session-queue-worker.ts`
- Local coalescer: `apps/agor-daemon/src/utils/session-turn-lock.ts`
- Producer identities: `apps/agor-daemon/src/utils/durable-task-id.ts`
- Reactive client: `packages/client/src/reactive-session.ts`

For post-claim executor lifecycle, heartbeat, SDK pulse/watchdog, and
termination ownership, see [task-runtime-state.md](task-runtime-state.md).
