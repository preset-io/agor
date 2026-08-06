# Session Task queue HA audit

**Date:** 2026-08-06  
**Status:** implementation review in progress
**Base dependency:** scheduler HA
[#2174](https://github.com/preset-io/agor/pull/2174) merged on 2026-08-06. This
branch was rebased onto its merge commit on `main`; the scheduler files remain
owned by that landed change.

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
| Widget submit/dismiss                 | `widgets/submissions.ts`                                   | Claims `pending -> resolving` durably before external work, then delegates to prompt admission with deterministic Task/message identity.                     |
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
does not write the transcript/session launch projection or schedule its
post-commit executor callback unless the result is `claimed`. Every idempotent
producer persists `Task.metadata.initial_message_id`. A loser repairs that row
only after it observes `dispatching|running`; a still-queued loser neither
writes a transcript row nor launches.

The prompt route uses the long-route tenant-identity pattern rather than a
route-wide PostgreSQL transaction. Direct Task repository calls are bound to
short tenant units of work, so queued admission commits before claim
preparation and queue events are emitted only after that admission boundary.

### Widget side-effect fence

Widget resolution has its own Message-row state machine because a deterministic
auto-resume Task cannot fence the earlier secret writes, connection probes, or
submit-vs-dismiss decision. `WidgetResolutionStore` performs short locked
metadata mutations:

1. `pending -> resolving` plus an opaque claim token;
2. registry/external work and durable auto-resume admission with no DB
   transaction held;
3. token-checked `resolving -> submitted|dismissed`.

The auto-resume Task uses the Session creator as its stable execution identity;
the actual resolver is retained on both the widget resolution and
`Task.metadata.widget_resolved_by_user_id`. This prevents a retry by a different
authorized collaborator from conflicting on the deterministic Task identity
after admission has already committed.

Only an `applySubmit` handler that explicitly reports failure before returning
releases the widget to `pending` with a secret-free diagnostic so the user can
explicitly retry; the current registry handlers write desired state
idempotently for that path. Once `applySubmit` returns, failures in prompt
admission or terminal completion leave the widget `resolving`: reopening it
would replay an effect that already succeeded. An abandoned `resolving` claim
is not automatically stolen: after daemon death the system cannot prove
whether the external operation happened, so replay would violate the
at-most-once side-effect policy. Requesting a fresh widget is the safe recovery
path for that indeterminate outcome.

The cooperating-writer token fence is backed by a service boundary:
transport callers cannot create widgets through generic Message single/bulk
CRUD, cannot replace or patch widget rows, and cannot remove a
`pending|resolving` widget. Public prompt callers likewise cannot supply Task
metadata; callback/widget provenance is accepted only from provider-less
daemon producers and is defensively stripped otherwise.

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

| Kill point                                            | Durable result                                                                             | Recovery owner                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Before queued insert commits                          | No Task admitted; request fails.                                                           | Caller may retry.                                                                                        |
| After queued insert, before claim                     | `queued` Task with stable order.                                                           | Any daemon's queue worker.                                                                               |
| After claim, before executor launch                   | `dispatching` Task + running Session projection, prompt text and launch timestamp durable. | Existing dispatch-startup/runtime supervision. Never blindly requeue: external launch may have occurred. |
| After local launch, before executor connects          | Same `dispatching` evidence.                                                               | Dispatch connection deadline and termination coordinator.                                                |
| After executor connects                               | `running` with connection/heartbeat facts.                                                 | Existing heartbeat/watchdog/containment contract.                                                        |
| During terminal hook/queue trigger                    | Terminal Task remains immutable; queued rows remain durable.                               | Natural triggers plus fleet queue scan.                                                                  |
| Widget daemon dies after resolution claim             | Widget remains `resolving` with claimant/action/time.                                      | Durable diagnosis; do not replay an external effect whose outcome is unknown.                            |
| Widget `applySubmit` explicitly reports failure       | Widget returns to `pending` with a secret-free code and no live claim.                     | User may explicitly retry; registry handlers must make this path idempotent.                             |
| Widget prompt admission/completion fails after submit | Widget remains `resolving`; a deterministic Task may already exist.                        | Do not replay the external effect; diagnose/reconcile manually.                                          |

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
| Busy widget queues then drains one ordered transcript row            | SQLite Task/Message regression plus stable-message decision unit test          |
| Widget submit-vs-dismiss / duplicate resolver race                   | SQLite repository/store tests; PostgreSQL integration when configured          |
| Cross-tenant widget claim                                            | PostgreSQL negative integration when configured                                |
| Prompt/widget short transaction boundaries                           | Route-boundary tests plus bound repository units                               |
| Public widget/provenance mutation bypasses                           | Feathers transport-hook negatives plus metadata sanitizer tests                |
| Completion/Stop trigger convergence                                  | Existing completion/Stop tests plus durable claim race tests                   |
| Cross-tenant discovery/claim                                         | PostgreSQL negative integration and RLS migration contract test                |
| Queue survives startup                                               | `startup.test.ts`                                                              |
| Standalone queue order/recovery discovery                            | SQLite repository/worker tests                                                 |

PostgreSQL tests are gated by both `AGOR_TEST_POSTGRES_URL` and
`AGOR_DB_DIALECT=postgresql`; a skipped run is not evidence of a pass and must
be reported as skipped.
