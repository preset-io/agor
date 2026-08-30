# Durable transitive completion propagation

## Root cause

Direct completion routing is attached to one Task or Session and is dispatched
after that Task becomes terminal. It has no durable representation of the
requested unit of work after an intermediary delegates to another Task. As a
result, A -> B -> C could notify A when B finished delegating, while C's later
result returned only to B. The direct path also has an unavoidable crash gap
between terminal Task commit and callback Task creation.

## Decision

Transitive propagation is an explicit, opt-in completion subscription. It
reuses Task admission, Task terminal state, the session queue, branch
authorization, and tenant database scopes rather than adding another execution
system.

- `callbackPropagation: "root"` creates one `completion_subscriptions` row in
  the same metadata transaction as the first downstream Task.
- `continueCompletion: true` atomically designates the new Task as the sole
  continuation of that requested unit of work.
- The subscription has `join_policy: "designated_child"`. Parallel helpers do
  not affect aggregate completion unless one is explicitly designated.
- Each hop can designate at most one continuation. The default maximum path is
  eight Tasks and callers may select 1-32 when creating the root request.
- A deterministic callback Task ID derived from subscription and recipient is
  the delivery/idempotency key.
- `agor_completion_subscriptions_get` is the authoritative aggregate status;
  the requester never needs to discover descendant IDs.

This is deliberately not "notify the root about every descendant." Aggregate
joins such as `all`, `any`, and quorum are separate future policies and are not
inferred from genealogy.

## State and outcome model

Subscription delivery state is separate from Task runtime state:

```text
pending -> delegated -> running_downstream
   |           |                |
   +-----------+----------------+
                    |
                    v
             terminal_pending -> delivered
                    |
                    v
             delivery_failed --(retry)--> delivered
```

The terminal outcome is one of `completed`, `failed`, `cancelled`, or
`timed_out`. A handoff is represented by `delegated`; it is never rendered as a
terminal outcome. Task status remains the only execution lifecycle.

## Semantics

- **One child:** designation moves the active Task pointer to that child. The
  intermediary's later completion does not complete the subscription.
- **Multiple children:** helpers may run in parallel, but only one child may be
  the designated continuation. A competing designation is rejected and its
  Task admission rolls back.
- **Nested delegation:** the active child may designate one child of its own,
  up to `max_depth`. Reusing a Task already in the path is rejected as a cycle.
- **Parent ends first:** safe. Once the continuation transaction commits, the
  subscription points at the child and ignores the parent's terminal event.
- **No designation:** the initially requested Task remains the requested unit
  and its terminal outcome completes the subscription.
- **Failure, Stop, timeout:** map to `failed`, `cancelled`, and `timed_out`
  respectively and follow the same durable delivery path.
- **Retry:** transient delivery failures use bounded exponential backoff for
  eight attempts. The durable terminal snapshot and `delivery_failed` state
  remain queryable after exhaustion; restarting the daemon does not reset or
  duplicate attempts.
- **Archived recipient:** the callback is admitted to the normal durable
  Session queue; archive state is not silently rewritten by this subsystem.
- **Deleted recipient:** the callback FK becomes null and delivery records
  `callback_target_missing`; immutable origin IDs remain for audit.
- **Deleted active work:** FK cleanup is reconciled to a failed terminal
  snapshot instead of leaving the subscription pending forever.
- **New input in the requester:** the callback is a normal queued Task. It
  follows existing ordering and cannot overwrite or interrupt the steered turn.

## Delivery, restart, and idempotency

Task transitions wake the worker for low latency. A bounded recovery scan joins
subscriptions to Tasks and selects only terminal or missing active Tasks; it
does not poll running agents. A second scan consumes committed delivery intents.
This closes the terminal-commit crash gap while keeping downstream execution
event-driven.

Multiple daemon workers may observe the same intent. They all derive the same
delivery Task ID. Creation is idempotent, ownership is verified on conflict,
and the subscription records that one Task. A crash after Task creation but
before outbox acknowledgement is repaired by re-reading the deterministic Task.
If the queue trigger is interrupted, the ordinary durable queue worker finds
the already-created Task.

## Authorization, tenancy, and privacy

`completion_subscriptions` is tenant-owned. PostgreSQL RLS enforces ordinary
tenant isolation. Cross-tenant recovery can read only routing IDs through the
narrow `completion_callback_discovery` system capability; every reconciliation
and delivery re-enters the owning tenant before reading or writing details.

Creation uses authenticated MCP session context for the origin and preserves
the requesting user. Delivery revalidates that user can still prompt the
callback Session and can still read the terminal Session/Task. If downstream
access was lost, only the aggregate outcome is delivered; the failure reason,
final message, path, descendant IDs, branch, issue, and pull-request links are
redacted. Logs contain IDs, state, attempt count, and bounded error codes,
never prompts, results, tokens, or credentials.

Browser links come from enriched Session/Branch URLs and the configured Agor
UI origin fallback. No deployment hostname or localhost value is hardcoded.

## Backward compatibility and rollback

The default remains direct behavior. Existing `callback: true`, session
callbacks, persistent callbacks, and `btw` callbacks do not create a
subscription and retain their current semantics. Root propagation is rejected
for `btw` because that mode already owns a separate ephemeral callback flow.

The migration is additive. Operational rollback is to stop issuing
`callbackPropagation: "root"` / `continueCompletion`; older daemons ignore the
new table. Rows should be retained for audit and pending-delivery recovery
rather than dropped during a code rollback.

## Code map

- Types: `packages/core/src/types/completion-subscription.ts`
- Schema/migrations: `packages/core/src/db/schema.{sqlite,postgres}.ts`,
  `packages/core/drizzle/{sqlite,postgres}/`
- Repository/CAS: `packages/core/src/db/repositories/completion-subscriptions.ts`
- Atomic prompt admission: `apps/agor-daemon/src/register-routes.ts`
- MCP contract/query: `apps/agor-daemon/src/mcp/tools/sessions.ts`
- Reconciliation/delivery: `apps/agor-daemon/src/services/completion-subscription-worker.ts`
- Legacy callback suppression: `apps/agor-daemon/src/services/tasks.ts`
