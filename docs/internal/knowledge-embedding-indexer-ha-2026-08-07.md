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
claimed  -- final exact admission/renewal --> provider outside transaction
claimed  -- retryable provider failure --> error + database-time retry_at + jitter
claimed  -- permanent provider failure --> not_configured (operator reindex required)
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
Immediately before the provider side effect, a fresh tenant transaction locks
the semantic-policy aggregate, validates the policy/key snapshot, and renews
only the exact token+generation/content claims using database time. Partial
admission makes no call and releases the surviving exact claims.

Retryable provider failures durably release the exact live claim as `error`,
increment `embedding_failure_count`, and set capped exponential `retry_at` using
database time and database-side jitter. HTTP `Retry-After` is a lower bound even
when it exceeds the normal cap; absolute HTTP dates remain absolute and are
compared directly with PostgreSQL time rather than converted through daemon
wall-clock time. Permanent HTTP 4xx responses (except explicitly retryable
408/409/425/429) transition to `not_configured`; an operator must fix
configuration and reindex. Their durable error remains visible in indexing
status. A crash before a failure transition instead recovers through lease
expiry. Retry timing and ownership survive daemon restarts.

## Discovery, pacing, and fairness

- Every daemon scans; there is no fleet leader or central work controller.
- Distributed scans return at most 32 candidates and at most 8 for one tenant.
- Every routing page returns at most a fixed 4× overscan plus one sentinel. It uses
  `(created_at, tenant_id, unit_id)` keyset traversal backed by the partial work
  index; it never computes a window over the full backlog. PostgreSQL may still
  choose a sequential scan for a small table; the integration plan fixture
  verifies an index scan for a representative large backlog.
- The process-local cursor advances across live claims, future retries, paused
  tenants, and other skipped rows. Each traversal captures an inclusive maximum
  tuple cutoff. Normally ordered later-keyed appends are deferred and cannot
  prevent a finite wrap. This is not an MVCC membership snapshot: a backdated
  insert at or below the cutoff can join the active traversal. The
  cursor/high-water pair is a pacing/fairness optimization and carries no
  authority.
- Claiming remains authoritative because discovery results are hints and may be
  stale by the time a tenant transaction begins.
- Auth-resolved distributed replicas apply a randomized startup offset and the
  distributed caps above. Static standalone PostgreSQL starts immediately and
  preserves the public 1–128 `batch_size` contract (default scan cap 128).
- Distributed full pages use a short jittered saturated-drain delay.
- Distributed productive/error rounds use a jittered normal interval; empty
  rounds use bounded exponential idle backoff with jitter.
- Standalone keeps its fixed 30-second polling interval after immediate startup
  (with a fixed short delay only while draining a finite keyset traversal).
- Post-commit `wake()` calls are local latency hints only; durable polling is
  sufficient for recovery and correctness.

These timings use the shared `@agor/core/coordination` helpers. No correctness
state is kept in a timer, debounce map, retry map, or in-flight map.

## Startup and graceful shutdown

Startup constructs one scanner on every daemon. Static tenancy preserves the
configured tenant scope. Auth-resolved tenancy uses routing-only system
discovery and then explicitly enters each discovered tenant scope.

Shutdown first refuses new scans and clears local timers. A claim prepared but
not yet admitted/called is released with its exact token+generation. If a
provider HTTP request is in progress, its `AbortSignal` is triggered and the
durable claim is deliberately **not** released: aborting the local wait does not
prove that the provider did not already accept the cost-bearing request. Drain
wait is bounded (default 10 seconds); timeout is logged and shutdown continues,
leaving database lease expiry to recover the work.

## Kill-point audit

| Kill point                                           | Durable result                                                                       | Recovery / duplicate semantics                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Before discovery or claim                            | No state change                                                                      | Any daemon may discover later.                                                        |
| During claim transaction                             | Transaction commits completely or rolls back                                         | No provider call occurs before commit.                                                |
| After claim, before provider call (graceful stop)    | Exact claim is released and generation-fenced                                        | No provider cost; another daemon may claim immediately.                               |
| After claim, before provider call (crash)            | Live claim remains                                                                   | One recovery call after database-time expiry; no first-call cost.                     |
| During final provider admission                      | Transaction renews all exact claims or releases survivors and makes no call          | No partial provider batch.                                                            |
| During DB-only embedding reuse                       | Claim, vector copy, ready state, and reuse telemetry share one transaction           | Rollback leaves the claimable unit unchanged.                                         |
| After provider acceptance, before response           | Live claim remains                                                                   | Ambiguous at-least-once outcome; at most one replacement call in the next generation. |
| Transport failure after possible provider acceptance | Exact claim becomes durable `error` with backoff                                     | Ambiguous at-least-once outcome; one retry caller can win each later generation.      |
| After response, before/during completion transaction | Live claim or atomic ready+vector commit                                             | Expiry recovery may duplicate cost; stale completion loses its fence.                 |
| Before durable provider-failure update               | Live claim remains                                                                   | Lease-expiry recovery.                                                                |
| After durable provider-failure update                | `error`, failure count, database-time retry                                          | Exactly one claimant can win the retry generation.                                    |
| Content update while claimed                         | Old unit becomes non-work and generation increments in the document transaction      | Old provider result cannot commit; new version is separate work.                      |
| Document delete while claimed                        | Document archives and all its unit claims are fenced in one transaction              | Provider result cannot commit.                                                        |
| Namespace delete while claimed                       | Namespace/documents archive and descendant unit claims are fenced in one transaction | Provider result cannot commit and archived vectors cannot seed reuse.                 |
| Provider/model/key/chunking change                   | Current units are rematerialized/fenced under the semantic-policy aggregate lock     | Final admission and completion both reject the old snapshot.                          |
| Pause while claimed                                  | Current tokens clear and generations increment under the policy lock                 | The accepted call may cost money, but cannot publish.                                 |
| Daemon graceful stop during provider call            | HTTP wait aborts; claim stays live                                                   | Same safe ambiguous-outcome handling as a crash.                                      |

## Support and failure semantics

- **PostgreSQL + pgvector:** this is a locally validated multi-indexer HA
  foundation. PostgreSQL rows, RLS, database time, and transactions are the
  authority. Full independently deployed multi-daemon fault, outage, and soak
  testing remains pending.
- **SQLite standalone:** migrations retain schema portability, but vector
  semantic indexing remains an explicit no-op and text Knowledge search keeps
  working. No Redis or in-memory fallback pretends to provide durable claims.
- **Mixed schema/app versions:** migration 0074 is deliberately non-rolling.
  Existing PostgreSQL installations must stop every daemon, run
  `agor db migrate --offline-cutover`, then start only the new version. Normal
  startup refuses the pending migration; the explicit flag is an operator
  acknowledgement because one host cannot prove another host is stopped.
  Fresh installations and SQLite are unaffected.
- **Provider exactly-once:** not supported. Duplicate cost is bounded as above
  and cannot be eliminated without provider idempotency/reconciliation support.

## Validation matrix

The PostgreSQL integration suite covers a real non-default-tenant 0073→0074
upgrade under FORCE RLS/NOBYPASSRLS, concurrent claimant/indexer races, final
admission, database-time expiry/reclaim, stale-generation rejection, document
update/delete fencing, retry/permanent-failure transitions, bounded poison-row
traversal, routing-only projection, query-plan shape, and cross-tenant negative
claims. The daemon PostgreSQL test uses two real indexers plus a blocking
provider seam to prove successful vector commits, ambiguous abort/reclaim/stale
completion, and tenant A/B provider input and credential isolation. Unit
coverage adds response ID/vector validation, typed HTTP/Retry-After behavior,
policy/key/chunk snapshot fencing, pause fencing, post-commit wake behavior,
bounded shutdown, topology defaults, and the SQLite no-op regression.

The PostgreSQL suite is environment-gated by `AGOR_TEST_POSTGRES_URL` and
`AGOR_DB_DIALECT=postgresql`; a missing disposable database must be reported as
a skip rather than treated as a passing integration run.
