# Provider subscription sign-in in HA

Status: **current-state record and remaining Claude design**, reviewed against
`main` at `390e9216` on 2026-08-24.

This document originally proposed one future design for Codex device sign-in and
Claude subscription OAuth. That is no longer an accurate shape:

- [PR #2521](https://github.com/preset-io/agor/pull/2521) has implemented the
  Codex half on `main`, with materially stronger credential-mutation fencing than
  the original proposal.
- Claude subscription OAuth is not on `main`. Its standalone foundation remains
  in [PR #2317](https://github.com/preset-io/agor/pull/2317), and the first durable
  attempt implementation remains in the stacked
  [PR #2462](https://github.com/preset-io/agor/pull/2462).

The current Codex contract lives in
[`codex-device-auth-ha.md`](./codex-device-auth-ha.md) and the operator contract
lives in
[`daemon-ha.mdx`](../../apps/agor-docs/content/guide/daemon-ha.mdx). Do not use
the deleted revisions of this document as an implementation specification.

## Scope

This document does two things:

1. records the PR lineage and the currently shipped Codex behavior; and
2. defines the smallest sound design still required before Claude subscription
   OAuth may be enabled in `deployment.mode: ha`.

MCP OAuth, OpenCode auth, and API-key-only flows are out of scope. The reusable
MCP security primitives remain relevant; its state machine is not a generic
provider-auth state machine.

## PR lineage and review snapshot

The branches are siblings plus one stack, not one four-PR stack:

```text
main
├── oauth-signin-ha-enablement-design      # PR #2449, this document
├── claude-code-oauth-signin               # PR #2317
│   └── oauth-signin-ha-durable-attempts   # PR #2462, exactly five commits
└── #2521                                  # merged to main as a44bba08
```

At the review snapshot:

- #2462's GitHub base was `claude-code-oauth-signin` at
  `019095cc1187bc9e6ea8da40606519aa018a31c1`, exactly the #2317 head. It is not
  based on #2449.
- #2317 conflicted with current `main`. Consequently, #2462 being clean against
  its named base did not make it current-main mergeable.
- #2462's migration names had already collided with `main`:
  PostgreSQL `0088_claude_oauth_attempts` versus
  `0088_session_recent_index`, and SQLite `0091_claude_oauth_attempts` versus
  `0091_session_recent_index`.
- #2462 also predates the credential-home, envelope, authority, realtime, and HA
  admission primitives merged by #2521 and later main changes. It must be
  rebased and reshaped, not merged as an isolated add-on to its stale base.

## Current state on `main`

### Codex device sign-in is implemented, conditionally

PostgreSQL HA uses `codex_device_auth_attempts`; standalone SQLite deliberately
keeps the process-local flow. The durable implementation is in:

- `apps/agor-daemon/src/services/codex-device-auth-durable.ts`
- `apps/agor-daemon/src/services/codex-device-auth-attempt-authority.ts`
- `packages/core/src/db/repositories/codex-device-auth-attempts.ts`
- `packages/core/src/codex/credential-file.ts`

The flow reserves a short-lived `starting` row before requesting a provider user
code, attaches the grant with a compare-and-set transition, leases polling on the
database clock, claims exchange once, and serializes final credential mutation
against start/cancel/import/logout. Provider network waits do not hold a database
transaction.

The approved poll result and exchanged tokens stay in the winning daemon's heap.
They are not added to PostgreSQL. Death before the one-shot exchange claim can be
recovered by polling the still-current device grant again; uncertainty after the
claim becomes `ambiguous` and is never replayed automatically.

`codexDeviceAuth` is now a `boolean` capability and
`isHaFeatureUnavailable()` reads it. Admission is deliberately narrower than
replica-visible storage:

- exact tenant/user routing through local `sandbox` execution;
- `executor_storage.user_home: persistent-per-user`; and
- an operator-verified
  `executor_storage.user_home_locking: cross-replica-flock` contract.

Shared identities, `simple`, delegated writers, local-only locks, and user home
overrides remain gated. A persistent path alone does not prove that two replicas
cannot race or that a timed-out remote writer has stopped.

### Claude subscription OAuth is not implemented on `main`

The `claude-auth/oauth` and `claude-auth/logout` services, their UI, and the
`claudeOAuth`/`claudeAuth` HA feature keys exist only on #2317/#2462. Any Claude
HA plan therefore depends first on reconciling #2317 with current `main`.

The useful foundation from #2317 remains the provider protocol and standalone
UX: authorization code plus PKCE, a manual `CODE#STATE` paste, and a managed
`~/.claude/.credentials.json`. The useful foundation from #2462 remains a
tenant/user/attempt-bound PostgreSQL claim. Its filesystem and activation model
must not be carried forward unchanged.

### `processAffineAuth` is not an enablement switch

`processAffineAuth` still has only a resolved-config declaration, assignment to
`false`, and a test fixture. No runtime code reads it. Provider-specific
capabilities must express provider-specific evidence. Removing this unused field
is valid cleanup, but it is not part of the Claude safety mechanism.

## Corrections to the original proposal

### 1. Storage visibility is not credential mutation authority

The old proposal treated a replica-visible executor home plus atomic rename as
leaving only the attempt `Map` to solve. That was incomplete.

Database revalidation immediately before and after a file write does not close
the race. A worker can pass its first check, lose ownership, and write after a
new login or logout. Deleting "the file it wrote" after a failed second check is
also unsafe: the path may already contain a newer winner's credential. A delayed
cleanup pass has the same flaw.

#2521 added the missing authority:

- one tenant/user database advisory lock for every competing mutation;
- a monotonically increasing mutation generation;
- a per-home generation tombstone;
- a non-age-stealable cross-replica kernel `flock`;
- file and directory fsync;
- no-follow, opened-directory filesystem operations; and
- a contained local writer whose lifetime cannot exceed the authority-owning
  daemon unnoticed.

Claude must reuse or generalize that mechanism. It must not add a second
precheck/write/postcheck protocol.

The old EFS-specific supporting claims are also not admission evidence. The
[AWS EFS CSI driver](https://github.com/kubernetes-sigs/aws-efs-csi-driver)
documents PVC capacity as a Kubernetes placeholder for elastic EFS, so a
reported 20 GiB claim is not by itself a 20 GiB quota. AWS documents Regional
EFS writes as durable after either file close or a synchronous write such as
`fsync` in its
[data-consistency contract](https://docs.aws.amazon.com/efs/latest/ug/features.html).
The current fsync behavior is useful general hardening; neither fact proves
exact-user routing, cross-client locking, or stale-writer containment.

### 2. An exchange claim does not make a provider retry safe

The original proposal preserved `exchangeWithOneRetry` when both calls were made
by one claim holder. That is unsafe. A claim prevents a second owner; it cannot
tell whether a timed-out, reset, 5xx, or unusable-success request consumed the
one-time authorization code.

Make exactly one exchange request. A validated provider rejection is `failed`.
Any outcome for which consumption cannot be disproved is `ambiguous`. The user
starts a fresh attempt; no owner replays the old code.

### 3. The approved Codex result does not need another durable secret state

The repeatable-poll observation recorded on #2449 supports one narrow behavior:
a new lease owner may re-poll before exchange. It does not justify persisting an
`approval_observed` authorization code/verifier or transient tokens.

The smaller shipped state machine is the model: keep the poll result in heap,
atomically claim exchange, and make every post-claim uncertainty terminal. The
initial provider user-code request also needs its shipped `starting` reservation;
the old proposal omitted that nontransactional call.

The 2026-08-18 probe used one egress IP and proprietary OpenAI endpoints. It did
not establish RFC 8628 compliance or cross-egress-IP behavior. The implementation
therefore retains safe restart behavior rather than inferring a broader provider
contract.

### 4. Browser-visible protocol material must be named honestly

Codex's user code is intentionally returned to the owning browser. Claude's
authorization URL includes raw `state`, and the authorization code and state
return through the user's `CODE#STATE` paste. These values must be scoped,
short-lived, excluded from logs/Redis/other users, and treated as capabilities;
they cannot be described as never reaching the client.

Server-only material includes the Codex `device_auth_id`, PKCE verifiers, Codex's
polled authorization code, and access/refresh tokens. Claude's pasted
authorization code necessarily touches its owning browser before the daemon.

### 5. Master-secret rotation is deployment-wide

Provider-attempt rows are short-lived, so draining them can simplify their part
of a rotation. It is not a complete `AGOR_MASTER_SECRET` rotation plan. The same
secret protects long-lived MCP OAuth grant material and other bound envelopes.
A safe rotation must account for every encrypted-at-rest consumer and either
re-encrypt or deliberately invalidate/reconnect it; never imply that waiting
10-15 minutes makes the whole fleet safe to re-key.

## Smallest sound remaining Claude design

### Resource classification

| Resource                           | Classification                       | Authority                                                             |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Claude OAuth attempt               | tenant-owned, user-scoped, transient | PostgreSQL in HA; in-memory in standalone                             |
| Raw OAuth `state`                  | short-lived browser capability       | browser/request; PostgreSQL stores SHA-256 only in the minimal design |
| PKCE verifier and credential route | secret/derived attempt material      | purpose-separated bound envelope                                      |
| Authorization code and tokens      | single-use/credential material       | request-handler heap only, then exact-user credential file            |
| `.credentials.json`                | tenant-owned, user-derived file      | generation-fenced exact-user home                                     |
| Fleet maintenance                  | narrow system/global operation       | explicit maintenance capability plus forced RLS                       |

Transient attempts are deleted with their tenant but are not portable. Exporting
or restoring an in-flight provider capability is not a supported operation.

### Attempt record and start

Use a Claude-specific table and state machine. Reuse current generic primitives,
not the MCP compatibility names:

- `sealBoundSecret` / `openBoundSecret` with a new Claude-specific purpose;
- `lockTenantAuthoritySubject` for concurrent generation allocation;
- `runWithTenantDatabaseScope` for ordinary access; and
- `runWithSystemDatabaseScope` with a narrow Claude maintenance capability for
  expiry and pruning across tenants.

The row needs trusted `tenant_id`, authenticated `user_id`, public-safe
`attempt_id`, a monotonic generation, `is_current`, DB-clock expiry, status,
`state_hash`, a one-shot exchange claim, a purpose/AAD-bound envelope, and
lifecycle timestamps. Bind the envelope to tenant, user, attempt, and generation.
Clear it on every terminal transition.

The minimal envelope contains the PKCE verifier and exact credential route, not
raw state. Start returns the authorization URL once. A page that loses the URL
may continue with an already-open provider tab and its `attempt_id`, or start
over. If product explicitly requires reconstructing the URL after a full reload,
sealing raw state is an intentional additional exposure and must be documented;
the implementation and security claim cannot say both "hash-only" and "sealed
raw state".

Starting a new attempt takes the tenant/user/provider authority lock, allocates a
new generation, supersedes the prior live attempt, inserts the new row, and only
then returns `{attemptId, verificationUrl, expiresAt}`. The UI must echo the exact
`attemptId` on status, submit, and cancel; it is not optional fallback state.

### Claim and exchange

On submit:

1. parse `CODE#STATE` without mutating the attempt;
2. hash the pasted state;
3. atomically transition the exact current, unexpired
   `(tenant,user,attempt,state_hash)` row from `pending` to `exchanging` with a
   random claim ID;
4. commit before provider I/O;
5. open and validate the bound verifier/route; and
6. perform one token exchange outside the transaction.

A malformed paste or wrong state does not consume the attempt. Two replicas
racing the same submit produce one claimant and one provider call. A definite
provider rejection becomes `failed`; uncertain provider/transport/response
outcomes become `ambiguous`. No authorization code or token is persisted in the
attempt table.

### Credential and auth-method finalization

Finalization is the hard boundary. It must generalize the authority shipped for
Codex rather than relying on two reads around an executor call:

1. take the tenant/user/provider credential-mutation authority;
2. revalidate exact attempt generation, current status, and claim;
3. mark `persisting`;
4. write `~/.claude/.credentials.json` with the same per-home lock, generation
   tombstone, no-follow directory capability, atomic write, and durability
   semantics used for Codex;
5. update the user's Claude auth method and clear a shadowing pasted token under
   the same logical authority; and
6. terminalize with the exact claim/generation.

Provider I/O must never occur while this authority is held. A file/DB crash gap
may still yield an `ambiguous` user-visible result, but a stale writer must not be
able to overtake the next higher generation. Do not add loser-delete or delayed
path-delete cleanup.

The authority must cover **all** Claude credential-source and method mutations,
not only OAuth start and logout. On #2317, ordinary `users.patch` calls can save
or clear `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` and change
`agentic_auth_methods`. If those paths do not participate in the authority (or a
durable compare-and-set generation), an older OAuth completion can erase a newer
token choice and flip the method back. This is a server boundary; UI sequencing
is not a correctness mechanism.

### HA capability and external execution

Add narrow `claudeOAuth` and `claudeAuth` capabilities. For the first safe HA
version, compute them from the same evidence as the local exact-user Codex route:

- `sandbox` exact-user home;
- `persistent-per-user`; and
- verified `cross-replica-flock`.

Do not key interactive Claude sign-in only from the broader
`codexCredentialFiles` capability. A tenant-safe shared identity can be valid for
an operator-managed import yet still be unsafe for one browser user replacing
credentials on behalf of another.

Keep delegated/external Claude sign-in gated until the external credential
writer owns a reviewed protocol that provides all of the following:

- exact trusted tenant/user routing;
- a persistent per-home mutation generation and atomic stale-generation reject;
- cross-client mutual exclusion;
- idempotent operation identity and queryable completion state; and
- a proof that timeout/authority loss cannot let an older writer commit after a
  newer mutation (by containment, termination acknowledgement, or substrate-owned
  generation CAS).

`persistent-per-user` by itself proves none of those. Widen the capability only
from an explicit, validated substrate contract.

### Tenant, realtime, and secret boundaries

- Register Claude auth services as tenant-identity-only request paths. Open short
  tenant database units at each DB access; never hold an HTTP-long transaction
  across provider I/O.
- Force RLS on the attempt table and cover cross-tenant and cross-user reads,
  claims, completion, cleanup, and ciphertext rebinding negatively.
- Give fleet maintenance its own narrow system capability; normal tenant policy
  must exclude it.
- Add `claude-auth/oauth` and `claude-auth/logout` to
  `REALTIME_PUBLISH_POLICY` with `audience: 'none'` and to
  `REDIS_FEATHERS_DENIED_PATHS`. Current publication is default-deny, but the
  explicit credential-control-plane barrier remains defense in depth.
- Never log provider bodies, codes, state, verifiers, credential routes, or
  tokens. Stable failure categories and aggregate counters are safe.
- A missing or mismatched fleet master secret fails closed. Never fall back to
  plaintext.

## Required validation before activation

### Database and service

- two independent PostgreSQL pools complete one attempt across replicas;
- simultaneous starts allocate ordered generations and leave one current row;
- simultaneous submits result in exactly one provider exchange;
- wrong state and malformed paste do not consume the attempt;
- abandoned/uncertain exchange becomes `ambiguous` and is never replayed;
- expiry and system-capability maintenance use the database clock;
- cross-tenant, cross-user, and ciphertext-rebinding attempts fail; and
- tenant deletion removes attempts while portability omits them.

### Credential authority

- logout, replacement OAuth, API-key save, pasted-token save/clear, and OAuth
  completion are raced at each write/method boundary;
- a lower filesystem generation cannot overwrite or delete a higher one;
- lock contention and database-authority loss cannot release a still-live writer
  into a later mutation;
- symlink/path replacement cannot redirect a write to another home; and
- file write success is not reported when durability/read-back fails.

### HA and UI

- start on replica A and submit/status/cancel on B;
- kill the claimant before exchange versus after exchange and verify the distinct
  retry contracts;
- stale tabs cannot submit or cancel a replacement attempt;
- auth results never enter Redis or a second user's connection;
- supported sandbox topology reports the capabilities true; shared/simple,
  missing-lock, home-override, and delegated cases remain false; and
- a full page reload follows the chosen raw-state contract: reconstruct only if
  raw state was deliberately sealed, otherwise offer a clean Start over path.

After code changes, run the focused daemon/core/executor/UI suites, PostgreSQL
non-superuser RLS tests, `pnpm check:multitenancy-boundaries`, typecheck/lint, and
the managed two-daemon HA harness. External support additionally requires an
environment test against the real writer protocol; Compose cannot certify it.

## Rebase plan for #2317 / #2462

1. Rebase #2317 onto current `main` and resolve its existing conflicts first.
2. Rebase #2462 on that new #2317 head; regenerate migration IDs and journals
   from the then-current schema.
3. Replace duplicated pre-#2521 helpers with the current bound-envelope,
   authority-lock, credential-home, and credential-file primitives.
4. Make `attemptId` required end-to-end in the UI and service.
5. Choose and document the raw-state/reload contract. Do not use MCP's
   `pending-exchange` purpose for Claude material.
6. Add the provider-wide credential/method mutation authority before HA
   capability enablement.
7. Add current realtime `audience: 'none'` declarations as well as the Redis hard
   deny entries.
8. Keep delegated/external capability false until its writer contract is proved.
9. Preserve #2317's unresolved ToS/AUP review as a pre-GA product/legal
   prerequisite; HA correctness does not answer that question.

## Decision

Codex is implemented and its existing focused document is authoritative. For
Claude, durable PostgreSQL attempt state is necessary but not sufficient. The
smallest sound first release is a request-driven, one-shot claim plus the existing
generation-fenced **local exact-user sandbox** credential authority. External
writer support is a separate protocol project, not a capability flip based on
shared storage.
