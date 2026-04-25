# Task Queueing

**Tasks are the queueable unit. Sessions accept prompts. The Task entity itself
encodes whether the prompt ran or got queued.**

## Wire shape

`POST /sessions/:id/prompt` always returns a `Task`. Callers inspect:

- `task.status === 'queued'` → session was busy; the task is waiting and will
  drain automatically when the session goes idle.
- `task.status === 'running'` → ran immediately.
- `task.queue_position` → ordering within the session's queue (lowest drains
  first), populated only while QUEUED.

There is no separate "queued vs ran" envelope. The route does not take a
`queue: true` flag. Callers don't ask, the response answers.

## Lifecycle

1. **Materialize** — the route always creates a Task via
   `TaskRepository.createPending({ status })`. CREATED if the session is idle
   with no queue, QUEUED otherwise. Sentinel values (`message_range.start_index = -1`,
   `git_state.sha_at_start = ''`) are stamped here and stay until the
   QUEUED → RUNNING transition.
2. **Drain** — when a session reaches a terminal task state, the queue
   processor picks the lowest `queue_position` and hands it to
   `spawnTaskExecutor`, which is the *sole* place that pins
   `message_range`/`git_state`, writes the initial user-message row, and
   spawns the executor.
3. **Race safety** — `createPending` wraps the `max(queue_position) + 1`
   read-then-insert in a transaction so concurrent writers can't collide on
   identical positions.

## Key files

- Repo: `packages/core/src/db/repositories/tasks.ts` (`createPending`,
  `findQueued`, `getNextQueued`)
- Route: `apps/agor-daemon/src/register-routes.ts` (`/sessions/:id/prompt`,
  `spawnTaskExecutor`, `processNextQueuedTask`)
- Reactive client: `packages/client/src/reactive-session.ts` (handles
  `tasks:created`/`tasks:queued`/`tasks:patched` events)

## Rationale

The queue was originally implemented at the message layer (`messages.status='queued'`).
Tasks are the natural queueable unit: each prompt is exactly one task, the task
already carries the prompt + metadata + lifecycle, and the executor only needs
to know "give me the next task to run." Migration to task-level queueing
landed in `never-lose-prompt` (sqlite/0040, postgres/0030).
