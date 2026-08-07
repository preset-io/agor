# Knowledge embedding indexer HA semantics

Status: implementation note for review. PostgreSQL is the durable authority.
Redis is not used by this state machine.

## Resource and tenant boundary

Knowledge namespaces, documents, versions, units, semantic settings, provider
credentials, embedding spaces, and vectors are tenant-owned. The only global
operation is bounded discovery of routing references:

```text
{ tenant_id, unit_id, eligible_at }
```

PostgreSQL RLS grants the narrow `knowledge_embedding_discovery` system
capability SELECT access to candidate unit rows. The discovery implementation
projects routing metadata only. It does not load document content, settings,
credentials, or embeddings. Claiming and every later read/write re-enter a
trusted tenant database scope and RLS is the final cross-tenant fence.

## Durable state machine

Each current, non-archived document unit is an independent indexing unit.

```text
pending/stale ----------------------------+
error with retry_at null/<= database now -+--> eligible
expired claim ----------------------------+

eligible -- atomic claim --> token + generation + database-time expiry
claimed  -- reusable vector --> ready (same transaction)
claimed  -- provider outside transaction --> fenced completion --> ready
claimed  -- provider failure --> error + failure_count + database-time retry_at
claimed  -- crash/ambiguous provider outcome --> lease expiry --> eligible

old document version / archived document or namespace --> not_configured
document, settings, or pause invalidation --> token cleared + generation incremented
```

Claims are short PostgreSQL transactions using `FOR UPDATE ... SKIP LOCKED`.
An opaque per-batch token is the ownership key. The monotonically increasing
unit generation fences reuse of a token and makes invalidation explicit.
Daemon instance and boot IDs are diagnostics, not correctness inputs.

Completion and failure transitions require all of:

- the exact token and generation;
- an unexpired lease according to database time;
- the same content snapshot (for completion);
- the unit still belonging to the current version of a non-archived document
  in a non-archived namespace.

Completion updates the unit and upserts its vector in the same caller-owned
tenant transaction. A stale worker therefore cannot publish a vector or change
the unit state after expiry, reclaim, content update, deletion, settings
replacement, or pause.

## Provider delivery and duplicate-cost bound

OpenAI embedding calls have no provider-side idempotency key in this path.
Delivery is **at least once**, not exactly once. The unavoidable ambiguous kill
point is after the provider accepts a request but before the daemon durably
commits its result. The claim remains unavailable until lease expiry, then one
new generation may issue one replacement call. A transport error after provider
acceptance is ambiguous too and enters the durable retry path. Atomic claims
ensure at most one provider call per live claim generation; each expiry or
retry generation can add at most one duplicate batch.

That is a per-generation concurrency/cost bound, not a finite lifetime retry
budget. Repeated provider failures continue at the capped retry cadence while
indexing remains enabled. Operators can pause indexing to stop calls. A finite
dead-letter budget would be a separate product policy and is not implied by
this coordination layer.

The default provider timeout is 90 seconds and the claim lease is five minutes.
Bounded batches leave ample transaction/commit margin, so the initial version
does not renew claims. If a future provider legitimately needs calls near the
lease duration, renewal must be an exact token+generation database-time
transition rather than a process-local heartbeat.

Normal provider failures durably release the exact live claim as `error`,
increment `embedding_failure_count`, and set capped exponential `retry_at` using
database time. A crash before that failure transition instead recovers through
lease expiry. Retry timing and ownership survive daemon restarts.

## Discovery, pacing, and fairness

- Every daemon scans; there is no fleet leader or central work controller.
- A scan is globally bounded (default 32) and per-tenant bounded (default 8).
- PostgreSQL ranks one candidate per tenant before offering a second candidate,
  preventing one large backlog from monopolizing a page.
- Claiming remains authoritative because discovery results are hints and may be
  stale by the time a tenant transaction begins.
- Replicas apply a randomized startup offset.
- Full pages use a short jittered saturated-drain delay.
- Productive/error rounds use a jittered normal interval.
- Empty rounds use bounded exponential idle backoff with jitter.
- Post-commit `wake()` calls are local latency hints only; durable polling is
  sufficient for recovery and correctness.

These timings use the shared `@agor/core/coordination` helpers. No correctness
state is kept in a timer, debounce map, retry map, or in-flight map.

## Startup and graceful shutdown

Startup constructs one scanner on every daemon. Static tenancy preserves the
configured tenant scope. Auth-resolved tenancy uses routing-only system
discovery and then explicitly enters each discovered tenant scope.

Shutdown first refuses new scans and clears local timers. If a provider HTTP
request is in progress, its `AbortSignal` is triggered and the current loop is
awaited. Its durable claim is deliberately **not** released: aborting the local
wait does not prove that the provider did not already accept the cost-bearing
request. Database lease expiry safely hands it to another daemon.

## Kill-point audit

| Kill point                                           | Durable result                                                                       | Recovery / duplicate semantics                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Before discovery or claim                            | No state change                                                                      | Any daemon may discover later.                                                        |
| During claim transaction                             | Transaction commits completely or rolls back                                         | No provider call occurs before commit.                                                |
| After claim, before provider call                    | Live claim remains                                                                   | One recovery call after database-time expiry; no first-call cost.                     |
| During DB-only embedding reuse                       | Claim, vector copy, ready state, and reuse telemetry share one transaction           | Rollback leaves the claimable unit unchanged.                                         |
| After provider acceptance, before response           | Live claim remains                                                                   | Ambiguous at-least-once outcome; at most one replacement call in the next generation. |
| Transport failure after possible provider acceptance | Exact claim becomes durable `error` with backoff                                     | Ambiguous at-least-once outcome; one retry caller can win each later generation.      |
| After response, before/during completion transaction | Live claim or atomic ready+vector commit                                             | Expiry recovery may duplicate cost; stale completion loses its fence.                 |
| Before durable provider-failure update               | Live claim remains                                                                   | Lease-expiry recovery.                                                                |
| After durable provider-failure update                | `error`, failure count, database-time retry                                          | Exactly one claimant can win the retry generation.                                    |
| Content update while claimed                         | Old unit becomes non-work and generation increments in the document transaction      | Old provider result cannot commit; new version is separate work.                      |
| Document delete while claimed                        | Document archives and all its unit claims are fenced in one transaction              | Provider result cannot commit.                                                        |
| Namespace delete while claimed                       | Namespace/documents archive and descendant unit claims are fenced in one transaction | Provider result cannot commit and archived vectors cannot seed reuse.                 |
| Provider/model/key/chunking change                   | Current units are rematerialized/fenced under the semantic-policy aggregate lock     | Results from the old policy snapshot cannot commit.                                   |
| Pause while claimed                                  | Current tokens clear and generations increment under the policy lock                 | The accepted call may cost money, but cannot publish.                                 |
| Daemon graceful stop during provider call            | HTTP wait aborts; claim stays live                                                   | Same safe ambiguous-outcome handling as a crash.                                      |

## Support and failure semantics

- **PostgreSQL + pgvector:** semantic materialization and multi-daemon HA are
  supported. PostgreSQL rows, RLS, database time, and transactions are the
  authority.
- **SQLite standalone:** migrations retain schema portability, but vector
  semantic indexing remains an explicit no-op and text Knowledge search keeps
  working. No Redis or in-memory fallback pretends to provide durable claims.
- **Mixed schema/app versions:** the additive migration must be applied before
  daemons using claim columns start. This does not change user-visible Knowledge
  document/settings models.
- **Provider exactly-once:** not supported. Duplicate cost is bounded as above
  and cannot be eliminated without provider idempotency/reconciliation support.

## Validation matrix

The PostgreSQL integration suite covers multi-daemon claim races, database-time
expiry/reclaim, stale-generation rejection, document update/delete fencing,
durable failure/retry races, tenant-fair discovery, routing-only projection,
and a cross-tenant negative claim. Service/unit coverage adds policy/key/chunk
snapshot fencing, pause fencing, provider `AbortSignal` propagation,
post-commit wake behavior, saturated rerun behavior, and the SQLite no-op
regression.

The PostgreSQL suite is environment-gated by `AGOR_TEST_POSTGRES_URL` and
`AGOR_DB_DIALECT=postgresql`; a missing disposable database must be reported as
a skip rather than treated as a passing integration run.
