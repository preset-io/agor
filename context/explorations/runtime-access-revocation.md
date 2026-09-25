# Runtime access revocation — runtime and companion contract

**Status: Agor implementation; Cloud companion required before release. Not a deployed guarantee.** This is a
cross-repository security contract, not a refresh-token-family design. The
[implementation handoff](agor://kb/document/01a03599-b202-7778-93f2-0e6d3c9081a3)
revision 4 supersedes its historical refresh-family recommendation.

## Scope and release gate

Administrator disable must deny fresh authentication and existing user access.
Sign-out-all is a separate, tenant-local, per-user operation that permits fresh
primary authentication. Neither operation means single-device logout.

The first release covers Agor API access, browser subscriptions, MCP,
Task authority, and terminal **attachments**. It does not prove termination of
detached Zellij shells or independent provider work. Max accepted this access-only scope: revoke browser input/output/subscriptions
and reject reconnect/new joins/reattachment, but allow already executing commands
and detached shells to continue. No terminal heartbeat or independent executor
retirement is required. Socket disconnect is not process absence.

Cloud delivery is also a release dependency, not optional follow-up polish.
The runtime cannot observe a Cloud suspension until its fact arrives. The
60-second passive browser bound starts at the runtime authority commit, not at
the Cloud membership mutation. No finite delivery bound is promised through a
Cloud/Cell network partition.

## Authority and persistence

All user authority, source keys, external projections, and delivery state are
tenant-owned. A Task derives its tenant and principal through existing durable
relationships. Cell update authentication is a narrow system capability that
must resolve an authorized tenant before entering a short RLS transaction.

Runtime storage, in both SQLite and PostgreSQL:

- `users.access_disabled`, non-null, default false for local users. External
  users additionally require an initialized external-authority projection;
  migration defaults must not manufacture an active Cloud decision.
- Reuse `credential_generation` and its existing issuance watermark. An actual
  disable/re-enable transition and explicit revoke-logins increment generation
  atomically. Profile-only writes do not. Re-enable never revives old logins.
- A separate tenant-owned `external_user_authority` projection keyed uniquely
  by `(tenant_id, identity_key)` (SHA-256 of the existing NUL-delimited
  provider/issuer/subject tuple), with `revision`, `login_epoch`,
  `active`, and exact runtime `role`. Retain projections even when there is no
  local user. The existing `user_external_identities` relation requires a user
  FK and therefore cannot by itself retain a pre-JIT disable tombstone.
- Revisions and epochs are nonnegative signed-64-bit integers represented as
  canonical decimal strings on the wire, compared as integers, never JS floats.

Local disable/re-enable uses the current Users administration surface and the
existing tenant authorization fence. Validate current actor authority, role
hierarchy, self-disable, and last-active-admin protection under that fence.
Cloud-owned lifecycle, role, revision, epoch, and projection fields are not
ordinary user CRUD fields, including for runtime admins. Revoke-logins remains
a runtime credential operation; it must not mutate Cloud membership.

## Cloud → runtime protocol v1

Dedicated route: `POST /auth/external-authority` with a size-limited
JSON body `{ "assertion": "<signed update JWT>" }`. This route does not accept
ordinary browser, API-key, executor, service, or launch bearer authentication.
It has a dedicated verifier and no generic tenant selector in query/header.
A separate per-replica IP budget allows 600 requests/minute; Cloud must honor
429/RateLimit headers and back off. This is not a distributed quota.

Required verified claims:

| Claim                       | Meaning                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `iss`, `sub`, `provider`    | Configured authority issuer and stable external identity; never email-based binding |
| `aud`                       | Exact `agor-authority:<cell-id>` audience, distinct from launch audience            |
| `purpose`                   | Exact `external-authority-v1`                                                       |
| `tenant_id`, `workspace_id` | Equal workspace identity, covered by the Cell's authorized routing assignment       |
| `cell_id`                   | Exact receiving Cell identity                                                       |
| `revision`                  | Monotonic revision of this identity's complete desired state                        |
| `login_epoch`               | Monotonic credential invalidation floor, retained across disable/re-enable          |
| `active`, `role`            | Boolean and exact configured runtime role; unknown/disallowed roles reject          |
| `iat`, `exp`, `jti`         | Short transport validity (60 seconds) and nonsecret request correlation             |

Use a separately configured RSA public key and fixed RS256 verification; launch verification configuration alone must not enable
this endpoint. Key rotation is explicit. Never reuse the Cell's outbound
launch-exchange credential as an inbound administrative credential. Cloud owns
the signer; only its authority writer may request these assertions. Runtime
validates the Cell/workspace assignment from trusted provisioning, not from an
unverified body. Provisioning that cannot establish this assignment is a
fail-closed deployment blocker.

Provision this nonsecret runtime configuration (private signing key stays in Cloud):

```yaml
external_launch:
  authority:
    public_key: '<PEM RSA public key dedicated to administrative updates>'
    cell_id: '<stable receiving Cell ID>'
    tenant_ids: ['<workspace ID assigned to this Cell>']
```

The existing `external_launch.issuer`, `provider_id`, `allow_admin_roles`, and
`execution.allow_superadmin` also constrain accepted updates. Static tenancy
must match the configured static tenant. Assignment changes require coordinated
provisioning; signed claims alone cannot add a workspace to this allowlist.

Under the existing tenant authorization fence, apply these rules atomically:

1. Missing projection: insert, including disabled identities with no local user.
2. Lower revision: no mutation; return the current applied revision/epoch.
3. Equal revision, identical semantic state: idempotent success. Signing times
   and `jti` are not semantic state. Equal revision with different state: 409.
4. Higher revision: reject epoch regression. Any active transition or role
   change requires a strictly newer login epoch; epoch may also advance for an
   explicit Cloud sign-out. Apply the projection and any bound user's status,
   role, and generation in the same transaction.
5. Increment local generation whenever the Cloud login epoch advances. Keep
   runtime-local generation independent so later Cloud updates cannot undo a
   local revoke-logins operation. Publish existing invalidation after commit.

Response after commit: `{ "protocol": 1, "applied_revision": "…",
"applied_login_epoch": "…", "outcome": "applied|duplicate|superseded" }`.
Do not return successful enforcement on DB error or before commit. A lost
response is retried with the same semantic state; no per-JWT replay table is
needed for this idempotent operation. Conflicting equal revisions are alerts,
not automatically overwritten.

### Launch ordering

New Cloud launch assertions carry `authority_revision` and `login_epoch`.
Launch is an authentication credential, never an authority update. In external
mode the runtime requires an existing active projection, exact revision/epoch
match, and matching role and identity tuple before JIT or token issuance. A
newer launch cannot bypass missing synchronization; it receives an authentication failure (retry with a new code after synchronization). An older launch cannot re-enable or demote/promote
the user. After re-enable only a newly matching launch can authenticate.

Cloud must acknowledge initial projection before issuing an admissible launch.
Previously minted codes need exchange-time authority checking, not merely a new
claim at mint time: current `buildLaunchClaims` snapshots claims when minting.
The runtime's exact-match check remains necessary for updates racing exchange.

### Reliable Cloud companion work

Cloud must persist desired identity authority in the same transaction as every
membership/global-user lifecycle write, rather than append a best-effort HTTP
callback after the current write. A durable desired-state row can double as a
coalescing delivery queue; no general event bus is required.

- Membership removal affects that team's workspace identities only. Global
  user suspension affects every workspace identity for that user. If fanout
  cannot fit one transaction, persist a resumable fanout job in that transaction;
  do not report all workspaces enforced while expansion is incomplete.
- Workers lease pending rows, send newly signed envelopes, and retry with bounded
  backoff. Record acknowledged revision per destination; a late acknowledgment
  cannot mark a newer desired state delivered. Reconcile desired versus applied
  revisions periodically (proposed 30 seconds, subject to scale testing).
- API/UI distinguish **saved / enforcement pending / enforced / failed**. Set
  enforced only after all affected runtime destinations acknowledge. A timeout
  after commit is pending, not rolled back or reported as enforced.
- New workspaces must seed authority before admission. A moved workspace must
  fence old Cell routing/admission, initialize the destination from a consistent
  snapshot plus subsequent revisions, then enable routing. Persist destination
  assignment generation with delivery acknowledgments so an old Cell's reply
  cannot satisfy delivery to the new Cell. Keep disabled tombstones through moves.
- Proposed operational target: first delivery promptly after commit, repair
  scan every 30 seconds; alert on oldest pending age over 60 seconds. These are
  monitoring targets, not a partition-proof security bound. Stronger Cloud-time
  denial requires expiring external-authority leases, a separate availability
  decision not silently included here.

This requires Cloud migrations, transactional mutation coverage, worker/retry
ownership, assignment fencing, and acknowledgment observability. Existing
membership PATCH/DELETE and launch-only exchange are not this subsystem.

## Shared runtime enforcement

Use one indexed tenant-scoped authority projection: current user status, role,
generation, and optional source-key existence/ownership. No cross-request
success cache; request-local reuse must be server-owned and identity-bound.

- Local password auth, raw API-key auth, launch, JWT validation, and every token
  mint/renew path deny disabled users. Raw API keys retain their existing hash
  verification. Derived JWT verification uses key ID existence, not bcrypt.
- Access and refresh JWTs carry a server-issued format marker and optional
  `source_api_key_id`. Preserve lineage through refresh **and JWT
  reauthentication**. Key lookup must match tenant and user; deletion affects
  descendants only. API keys themselves are not invalidated by revoke-logins.
- REST/Feathers and protected socket methods consume current authority before
  role hooks. The immutable authenticated socket projection is identity, not
  permanently current authorization. Do not introduce per-tool checks.
- MCP keeps its current accepted families: raw API keys and internal session
  tokens. Apply disabled-user authority centrally without admitting browser
  JWTs or confusing audience/purpose boundaries.
- Add disabled state to the existing `branch-access.ts` principal projection
  consumed by Task admission/heartbeat, together with the same external projection
  predicate when lifecycle is externally managed. Keep the existing termination
  coordinator, DB-failure liveness behavior, and exact Task-token predicates.

### Passive/browser and terminal attachments

One replica-local one-second sweep begins renewal at approximately 30 seconds.
Each ordinary browser connection performs its own projection; checks are not
batched across connections. Each accepted
check grants at most 60 seconds from **check start**, never completion. Deadline
expiry retires publication/native subscription authority synchronously and
then disconnects. All send/admission paths also check deadline; timers alone
cannot enforce a bound during event-loop stalls. A hung query cannot extend the
lease. Late completions cannot resurrect an expired, disconnected, or replaced
connection. Preserve machine-token absolute expiry independently.

Browser terminal joins/reattachment perform a fresh authority check; input and
output use the browser lease. Targeted user invalidation disconnects only that
user’s browser sockets, not terminal executors. Existing Task heartbeats consume
the disabled principal predicate through their existing owner. There is no new
terminal attachment heartbeat, process retirement, or detached-shell termination.

Use `apps/agor-daemon/src/metrics/` for check count, duration, DB statement count,
renewal result and disconnection. Check spans use the existing Datadog tracer.
Labels are bounded result enums; never token/key/user/tenant IDs.
Measure actual SQL count and latency in disposable tests before claiming cost.

## Rollout and proof gates

Cutover requires explicit operational approval; this document does not
authorize deployment or forced logout. Additive schemas alone confer no safety.

1. Ship/runtime-test both schemas, shared enforcement, Cloud projection route,
   lease fencing, minimal local administration, and strict format verification.
2. Ship companion Cloud desired-state delivery, claims, and provisioning; seed
   existing identities and acknowledge projections before enabling external mode.
3. The access-authority migration (SQLite 0116 / PostgreSQL 0117) is additive only: a launch binding does not imply externally
   managed lifecycle. Existing locally managed launch users remain enabled;
   SQL must not infer configuration from `user_external_identities`.
   External-mode authentication and Task admission/heartbeat require an active
   synchronized projection for the configured issuer/provider, independently
   of `access_disabled`. Missing projection denies raw API keys, MCP and Task
   authority without manufacturing an enabled Cloud decision. Cloud's first
   synchronization advances a bound user's local generation. Ordinary access/refresh tokens must carry `auth_format: 1`;
   the server rejects unstamped legacy tokens, not just the UI.
4. Drain old replicas/connections and coordinate admission cutover. Reject legacy
   ordinary access/refresh tokens server-side, including unrecoverable old key
   descendants. Require fresh primary login; do not rotate shared machine keys.
5. Reject legacy Cloud launch claims in synchronized external mode. Mixed old/new
   replica admission is unsupported. Rollback requires fenced admission and
   preservation of authority rows; rolling back to readers that ignore disabled
   state is a security rollback, not a normal compatibility path.

Required tests before any guarantee: existing SQLite fixtures; real PostgreSQL
with NOSUPERUSER/NOBYPASSRLS and cross-tenant negatives; two replicas sharing PG
with deliberately missed healthy-Redis publication; failed/hung DB checks;
late lease results; restart; local disable/fresh-login/re-enable; per-user logout;
all key-derived renewal paths; role hierarchy/last-admin races; stale/conflicting
Cloud updates and wrong issuer/tenant/Cell/purpose; pre-JIT disable; workspace
move acknowledgments; legacy cutover; bounded metrics labels and query costs.
Do not substitute mocked Redis tests for shared-PG authority proof.

Independent service credentials, provider credentials already delivered to a
process, response capabilities already issued, detached shells, and operations
admitted before the revocation commit require their own lifecycle. Login
revocation is not a claim that these are canceled, recalled, or terminated.

## Implementation cost and validation boundaries

The shared checker performs one nonsecret authority SELECT (plus tenant-scope
transaction plumbing on PostgreSQL); normal JWT authentication still performs
its existing user lookup. Source-key descendants use indexed existence/ownership
checks, never bcrypt on each descendant use. `auth.authority.db_statements`
counts projection attempts, not transaction-control SQL. A disposable SQLite
fixture spies on the actual client and asserts one query per check, including
rejection after a status change. This is instrumentation,
not a throughput benchmark or a claim of one total SQL statement per request.

The final browser output fence wraps Socket.IO's pinned Engine.IO writer because
adapter broadcasts bypass per-socket emit hooks. Keep real broadcast/expiry tests
when upgrading Socket.IO. No positive authority cache survives DB uncertainty.
Leases begin at check start; rejected or hung renewal never extends authority.

Disposable PostgreSQL tests exercise non-superuser/NOBYPASSRLS connections,
cross-tenant negative cases, independent pools, and two real Socket.IO replicas
with healthy Redis while mutation publication is intentionally omitted. These
are runtime proofs, not Cloud delivery, workspace-move, deployment, or production
scale evidence. Cloud must independently test transactional outbox coverage,
retry/restart, destination fencing, and exchange-time stale-code rejection.
