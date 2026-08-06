# Session Task queue HA audit

**Date:** 2026-08-06  
**Status:** stacked review requested by Max  
**Base dependency:** this branch is temporarily stacked on scheduler HA
[#2174](https://github.com/preset-io/agor/pull/2174), currently open. Max
explicitly requested the stacked PR on 2026-08-06; it must be rebased onto
`main` after #2174 lands before merge.

## Decision

PostgreSQL owns Session prompt order and dispatch admission. Every daemon may
discover and attempt durable queued work; no daemon is a permanent leader.
Correctness is one short Session-first database critical section, not the
process-local turn-lock map, retry timers, scan cadence, or daemon identity.

The scheduler base contributed two deliberately thin shared foundations reused
here:

- the `created|queued -> dispatching` Task fence and authenticated
  `dispatching -> running` executor claim;
- `@agor/core/coordination` diagnostic identity and bounded delay helpers.

This consumer generalizes the Task fence only as far as the concrete Session
queue requires: it locks Session before Task, checks the durable queue head and
other executing Tasks, and writes the Session projection atomically. It does
**not** introduce a central distributed-work controller or worker framework.

## Entry-point audit

| Producer/trigger                      | Path                                                       | Durable behavior after this change                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User/API prompt                       | `POST /sessions/:id/prompt`                                | Always inserts `queued` under the Session row lock, then immediately attempts the head claim. Returns actual `queued` or claimed state.                      |
| Explicit Task run                     | `POST /tasks/:id/run`                                      | Only `created`; durable claim refuses a queued head, busy Session, or different executing Task. A local lock is only a coalescer.                            |
| Generic Task creation                 | `POST /tasks` / `TasksService.create`                      | May create `created`, but cannot launch without the explicit run path and its claim.                                                                         |
| Queue selection/drain                 | `processNextQueuedTask`                                    | Reads stable `(queue_position, created_at, task_id)` order; the later Session+Task claim revalidates the head. Local retry state is not authority.           |
| Fleet recovery                        | `SessionQueueWorker`                                       | Every daemon performs bounded routing discovery, re-enters trusted tenant scope, and triggers the same drain path. Cursor/backoff/jitter are etiquette only. |
| Task completion                       | `TasksService.processCompletionSideEffects` and Task hooks | Post-commit trigger only. Duplicate daemon triggers converge at dispatch claim.                                                                              |
| User Stop                             | `/sessions/:id/stop`, `stopSessionPreserveQueue`           | Preserves queued rows and triggers draining after terminal settlement/release.                                                                               |
| Session patch hooks                   | `register-hooks.ts`                                        | Promptable Session transitions trigger the same drain path. No independent selection rule.                                                                   |
| Completion callback                   | `TasksService.queueCallbackToSession`                      | Direct durable queued admission with deterministic identity derived from source Task + target Session. The process-local Promise map is only coalescing.     |
| Widget submit/dismiss                 | `widgets/submissions.ts`                                   | Delegates to prompt admission with deterministic identity derived from the widget Message.                                                                   |
| Widget already-present                | `mcp/tools/widgets.ts`                                     | Same stable prompt admission; identity is distinct from the widget Message so transcript IDs cannot collide.                                                 |
| Scheduled initial prompt              | `services/scheduler.ts` from #2174                         | Delegates with the schedule occurrence's stable initial Task ID; no scheduler file is changed here.                                                          |
| Gateway prompt                        | `services/gateway.ts`                                      | Delegates to the prompt route with resolved tenant/user provenance.                                                                                          |
| MCP spawn/fork/subsession/btw prompts | `mcp/tools/sessions.ts`                                    | Delegate to the prompt route.                                                                                                                                |
| Spawn-prompt route                    | `/sessions/:id/spawn-prompt`                               | Renders only, then delegates to the prompt route.                                                                                                            |
| Upload notification                   | upload handler in `register-routes.ts`                     | Delegates to the prompt route with request tenant/user context.                                                                                              |
| Queue delete                          | `TaskRepository.delete`                                    | Deletes only while status remains `queued`; a concurrent dispatch claim and delete serialize on the Task row/status predicate.                               |

No other production caller writes `status='queued'` directly. The repository is
the single queue-position allocator.

## Durable invariants and proof points

### One executing turn per Session

`claimDispatchAndProjectSession` always locks the Session row before the Task
row. Under that lock it rejects:

- a queued Task that is not the stable queue head;
- a `created` Task while any queued head exists;
- any candidate while another Task is `dispatching`, `running`, `stopping`,
  `awaiting_permission`, or `awaiting_input`;
- any candidate whose Session projection is not promptable.

The winning transaction writes Task `dispatching`, clears its queue position,
appends the Task ID to the Session, and projects the Session to running/not
promptable. Claimants for two different Tasks therefore serialize at the same
row rather than at unrelated Task locks.

### One ordered admission decision

Queued admission locks the Session row before reading
`max(queue_position) + 1`. PostgreSQL `READ COMMITTED` transactions without
that lock can both read the same maximum; a uniqueness error would reject one
user rather than decide its order. The row lock creates one decision, while the
partial unique index remains corruption defense. SQLite uses an immediate
transaction plus bounded busy retry and preserves existing semantics.

### One claimant and no losing launch

The expected Task state, queue head, competing execution, and Session
projection are checked and written in one transaction. `spawnTaskExecutor`
returns before initial-message/session launch projection and before its
post-commit executor callback unless the result is `claimed`. Stable scheduled
occurrences are the narrow exception: a loser may idempotently repair their
deterministic transcript row, but it never launches.

### Durable recovery

Queued rows are never startup-orphaned or wiped. A bounded partial index
supports one routing ref per queued Session. In auth-resolved PostgreSQL mode a
SELECT-only RLS capability exposes queued Task routing to the scanner; content
is not returned by the repository, and every Session is reloaded/mutated under
the discovered tenant. Static PostgreSQL and standalone SQLite take the same
worker path without global discovery.

### Terminality

Existing row-locked Task mutation rejects terminal-to-nonterminal status
changes. Queue work does not add a second lifecycle state machine.

## Tenant boundary

`tasks` is tenant-owned. System queue discovery is a narrowly named
`task_queue_discovery` capability and projects only:

- `tenant_id` (PostgreSQL only),
- `session_id`,
- first queued timestamp.

The scanner exits system scope before calling Session services. It preserves
the discovered tenant in both async context and service params; repository
writes use short tenant units of work and the tenant write gate. A tenant-scoped
repository cannot find or claim another tenant's Task. PostgreSQL integration
coverage includes that negative proof and confirms nonqueued Sessions are not
discoverable.

## Kill points and runtime handoff

| Kill point                                   | Durable result                                                                             | Recovery owner                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Before queued insert commits                 | No Task admitted; request fails.                                                           | Caller may retry.                                                                                        |
| After queued insert, before claim            | `queued` Task with stable order.                                                           | Any daemon's queue worker.                                                                               |
| After claim, before executor launch          | `dispatching` Task + running Session projection, prompt text and launch timestamp durable. | Existing dispatch-startup/runtime supervision. Never blindly requeue: external launch may have occurred. |
| After local launch, before executor connects | Same `dispatching` evidence.                                                               | Dispatch connection deadline and termination coordinator.                                                |
| After executor connects                      | `running` with connection/heartbeat facts.                                                 | Existing heartbeat/watchdog/containment contract.                                                        |
| During terminal hook/queue trigger           | Terminal Task remains immutable; queued rows remain durable.                               | Natural triggers plus fleet queue scan.                                                                  |

The queue branch does not redesign heartbeat supervision, executor
containment, or startup orphan cleanup. A required runtime HA follow-up is to
make discovery/ownership of already-active `dispatching`/running work fully
fleet- and tenant-aware in auth-resolved deployments. Until that work lands,
the Task is durably diagnosed and current local/templated startup-timeout rules
apply, but queue code must not claim that it can prove external absence.

## Validation matrix

| Scenario                                                             | Coverage                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Two daemon request transactions race two prompts on one idle Session | `task-queue-ha.postgres.test.ts`                                               |
| Five drainers race one queued Task                                   | PostgreSQL integration; exactly one claim and one simulated launch side effect |
| Concurrent queue-position uniqueness/order                           | SQLite repository test and PostgreSQL integration                              |
| Different Tasks race one Session                                     | SQLite repository test; Session-first claim leaves one `dispatching`           |
| Non-head and explicit-run queue jumping                              | SQLite repository tests                                                        |
| Stable callback/widget production                                    | Durable-ID unit tests plus callback/widget service tests                       |
| Completion/Stop trigger convergence                                  | Existing completion/Stop tests plus durable claim race tests                   |
| Cross-tenant discovery/claim                                         | PostgreSQL negative integration and RLS migration contract test                |
| Queue survives startup                                               | `startup.test.ts`                                                              |
| Standalone queue order/recovery discovery                            | SQLite repository/worker tests                                                 |

PostgreSQL tests are gated by both `AGOR_TEST_POSTGRES_URL` and
`AGOR_DB_DIALECT=postgresql`; a skipped run is not evidence of a pass and must
be reported as skipped.
