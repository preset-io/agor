# Tenant restriction intent protocol

**Status: partial runtime enforcement, not a complete suspension feature.**
No public command, HTTP service, MCP tool, or daemon observer exposes the intent
writer. An unregistered internal consumer seam exists, but it requires an
explicit authoritative tenant/Workspace binding resolver and has no production
caller.
Shared authenticated service admission, MCP requests, bearer upload routes, and
selected task automation boundaries consume restriction state. Ordinary access
is denied while exact termination reads and scoped lifecycle acknowledgements
remain possible. Prompt holds and event cutoffs are implemented but still need integrated
certification. These guards do not establish full socket/process containment,
controller freshness, or the Cloud orchestration contract. Do not
advertise suspension support until the remaining integration is certified.

## Managed runtime bootstrap barrier

`auth/tenant-runtime-bootstrap.ts` defines the v1 verification-only bootstrap
contract for a managed placement. The Cloud/deployment controller signs a
document containing the deployment identity, database incarnation, team and
placement revision/origin, and the complete replica inventory. Startup can be
put into the managed barrier with `AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED=true`;
the daemon then requires an absolute bootstrap document path, an Ed25519 public
key, an independently supplied expected deployment/database identity, and an
explicit replica/incarnation pair. The copied config/database and `HOSTNAME`
are never used as fallback identities. A missing, malformed, mismatched, or
signature-invalid document prevents startup before database, Redis, socket, or
HTTP initialization. The default standalone path remains unchanged until a
managed deployment explicitly supplies the barrier variables.

The signed document carries `restore_policy: "closed"`. Static config's tenant
identity is bound to the signed team. After database initialization, managed
startup performs a read/lock-only check through
`auth/tenant-runtime-current-authority.ts` against the singleton
`runtime_installation_identity` row (migration `0112_runtime_installation_identity`)
and compares the connected row's deployment, database incarnation, database
name, logical database ID, team, placement, origin, and revision to the signed
document. The PostgreSQL adapter also compares `current_database()` with the
stored `database_name`; `logical_database_id` remains an opaque control-plane
identifier and is never treated as a PostgreSQL catalog OID. Managed SQLite is
explicitly unsupported by this authority adapter rather than using an unstable
file-path identity. Missing, corrupt, or mismatched identity fails closed; there
is no auto-registration or repair path. The row is deployment-owned and a
separate privileged installer must seed or replace it under an
expected-incarnation fence. A same-database replica replacement may pass only
when the deployment independently supplies the same database incarnation and
the signed inventory names the replacement incarnation. Physical OID/clone
detection, freshness, and process containment remain future proofs;
independently managed incarnation issuance and stronger logical-database binding
are still required.
v1 is single-team scoped and refuses to act as authority for an auth-resolved/shared
runtime. Placement revision/origin and replica inventory are attestation inputs,
not freshness, process-containment, or Suspend/Reactivate activation proof.

## Signed coordinator command groundwork

`auth/tenant-runtime-restriction-command.ts` defines a verification-only Ed25519
envelope for the future Cloud-to-runtime coordinator. It authenticates the
signed target `tenant_id` and binds the controller/operation/revision/action,
placement revision/origin, deployment and database identities to the already
verified bootstrap and connected `runtime_installation_identity`. The tenant ID
is not thereby proven to belong to this installation or a live Workspace. The
Cloud adapter foundation now re-locks the durable Team operation and the
database-derived Workspace/Cell/placement fence inside its persistence
transaction before asking an injected server-side resolver for the exact
installation binding. Missing or mismatched binding data fails closed; the
current Cloud schema still cannot supply deployment, database-incarnation,
placement-origin/ID, or replica-inventory authority, so there is no production
resolver or transport wiring yet. The key ID is covered by the canonical signed
bytes, and malformed, stale-identity, wrong-controller, and invalid-signature
commands fail closed.

`auth/tenant-runtime-restriction-consumer.ts` is the narrow, unregistered
runtime application seam. It runs the existing verifier first, then requires an
injected full tenant/Workspace binding whose team, deployment, database,
logical-database, placement, origin, and placement revision exactly match the
signed command. It accepts only `restrict` and `prepare_release`; `activate`
returns a typed unsupported error. The existing PostgreSQL writer then owns the
tenant execution/controller advisory fences, operation/revision/action replay
checks, and transaction rollback. There is no default resolver: missing,
moved, or unresolved tenant authority fails closed.

Cloud-side durable revision/operation checks now reject stale, moved, deleted,
mismatched, and completed operation targets. The consumer's successful intent
write is not transport, completion, release readiness, process containment, or
suspension proof; durable operation-bound evidence remains mandatory, and
signature verification alone can never authorize activation.

The Cloud side now has a separate private lease-claim projection seam that can
pass one already-signed batch through an injected authenticated Runtime
consumer callback and release the ledger lease for retry. Its claimed/repeated
outcomes are callback-invocation bookkeeping only, not evidence that this
consumer ran, mutated a Runtime database, contained a replica, or made a Team
safe to reactivate. The Runtime consumer still requires its authoritative
database handle and installation binding from its caller; there is no Cloud
transport, production caller, completion observer, or activation path.

The Runtime result/receipt boundary remains fail-closed. The existing consumer
returns one command's signed identity, restriction record, and `changed` bit,
but it does not return the authoritative binding resolved before the writer or
the explicit current replica identity verified by the managed bootstrap. The
Cloud projection has the operation/team/revision/action, command-batch digest,
lease, and actor context, but its callback return is intentionally untyped and
ignored; no batch result can bind every command to that lease. A result must not
derive a replica from a Cell, URL, namespace, hostname, or inventory position.

`auth/tenant-runtime-restriction-receipt.ts` therefore exposes only the
immutable `runtime_receipt_unavailable` boundary, naming the missing Runtime
binding, current-replica, and typed batch/lease bridge. It is not a receipt and
does not report applied, already-applied, rejected, delivery, completion,
containment, or release readiness. A future approved contract must provide
those exact authorities before any `record`/`changed` value can cross back to
Cloud.

An identical checked-in golden envelope is exercised by the runtime verifier and
the Cloud contracts package. It proves canonicalization/signature compatibility
only; it is test material, not a production key or transport.

## Ownership and state

`packages/core/src/types/tenant-restriction.ts` defines the version-1 command and
pure transition policy. `packages/core/src/db/tenant-restriction.ts` persists it
in PostgreSQL under a short tenant-scoped transaction. The composite key is
`(tenant_id, controller_id)`; `placement_id` is immutable for that controller.
The controller identity must be bound by the authenticated internal consumer,
not accepted as authority from a tenant request. RLS isolates tenants, not
operators within a tenant. The application database role is trusted code, not a
public control API.

```text
absent --restrict(r1)--> restricted
restricted --prepare_release(r2 > r1)--> release_prepared [still closed]
release_prepared --activate(exact r2 + operation)--> active [watermark retained]
any recorded phase --restrict(higher revision)--> restricted
```

Higher-revision prepare may supersede an incomplete restriction, but does not
open admission. Activation requires the exact prepared operation. Older
commands are rejected, including a delayed restrict after release. Same-command
retries are no-ops; a delayed prepare for an already-active operation is also a
no-op. Conflicting commands at the same revision are rejected. Advisory locking
serializes first writers even when no row exists, and rolls back with the
surrounding transaction. No network/process wait belongs inside this lock.

Restriction composition is OR across controllers. Releasing one controller's
restriction cannot clear another's, and never modifies the separate portability
write gate. Stored data is strictly parsed; corrupt or unsupported values and
DB failures do not become an unrestricted result. SQLite operations explicitly
return unsupported rather than claiming a hosted tenant boundary exists.

## Persistence and portability

Migration `0111_tenant_restrictions` adds dialect-parity tables and PostgreSQL
FORCE RLS. No broad cross-tenant operator policy is added. The table is included
in the runtime-derived tenant erasure manifest but excluded from portable data
archives: placement/controller authority belongs to the deployment, not to
customer content. A destination must receive its own authoritative restriction
before serving imported data. A missing row alone is not proof that a new or
restored runtime is allowed to serve. Tenant identifiers must not be recycled;
an authenticated adapter must reject work for retired placements/tenants before
calling the persistence writer.

Do not delete active-phase rows to release a restriction: they retain the
revision watermark. Erasure is the separate irreversible tenant lifecycle.
Older binaries do not enforce this state; once serving adapters are installed,
rollback to an ignoring binary cannot be treated as safe.

## Required integration before activation

The persistence writer records intent; it does not accept/validate containment
proof or authenticate its caller. The internal consumer is the only current
authenticated application seam: it requires the signed installation checks plus
an injected authoritative tenant/Workspace record and rejects `activate`.
There is still no production caller or resolver. In particular, `activate` is a
low-level state transition for a future privileged coordinator, not an operator
endpoint; that coordinator must establish the full release barrier before
invoking it.
`assertTenantUnrestricted` is an uncached database admission primitive, not a
complete guard for already-admitted work, stale auth tokens, sockets, or agents.

Complete support requires implementation and integrated proof at every boundary below;
the partial enforcement already installed is described in the later sections:

- production authenticated tenant/controller/placement binding and current
  operation checks (the unregistered consumer is only a fail-closed seam until
  its authoritative resolver and caller exist);
- admission fencing at HTTP, realtime, MCP, artifact/file, queue, scheduler,
  gateway and executor boundaries, including old credential epochs;
- trusted safety-operation paths for termination and acknowledgement that do
  not reopen ordinary tenant access;
- connection draining, task/process containment and current-replica evidence;
- queue/event cutoffs, prepared-release/activation coordination, and bootstrap
  synchronization before replacement replicas begin serving;
- restart/retry and offline-target reconciliation with honest incomplete states.

A database row or an intent write response proves none of those behaviors.

## Tests

- `src/types/tenant-restriction.test.ts`: transition, binding, validation, and
  replay behavior; no database or runtime claim.
- `src/db/tenant-restriction.test.ts`: unsupported SQLite boundary.
- `src/db/tenant-restriction.postgres.test.ts`: real persistence/reconnect,
  concurrent first-writer and release races, rollback, tenant-negative RLS,
  corrupt-state rejection and independent restriction composition.
- `apps/agor-daemon/src/auth/tenant-runtime-restriction-consumer.test.ts`:
  verifier, binding, unsupported-action, and unregistered-surface checks.
- `apps/agor-daemon/src/auth/tenant-runtime-restriction-consumer.postgres.test.ts`:
  valid restrict/prepare, replay/conflict, binding rejection, and transaction
  rollback; skipped when the PostgreSQL test URL/dialect is unavailable.
- `apps/agor-daemon/src/auth/tenant-runtime-restriction-receipt.test.ts`:
  immutable fail-closed receipt shape and canonical missing-blocker ordering;
  no result or completion claim.
- Existing schema/deletion/portability tests cover migration classification.

## Runtime admission and safety traffic

Production composes `createTenantRestrictedAuthHook` with the neutral PostgreSQL
403/503 reader in `auth/tenant-access.ts`. Direct MCP and bearer upload routes
check admission independently. The raw MCP egress gateway also reads restriction
state in its existing current-authority check, including the final pre-dispatch
check; already-dispatched provider effects are not undone. Provider session teardown
is not a generic exemption, so unverified remote cleanup remains unverified.
External launch projection takes the execution fence after the authorization fence
and refuses restricted identity/default-board writes. The credential-generation
checks below also reject stale grants; end-to-end controller/placement integration
and certification remain unfinished. SQLite retains standalone behavior.

`auth/termination-read-authority.ts` issues single-call, server-owned read grants
bound to tenant/path/method/resource for coordinator reads. The minimal executor
`tasks.getTerminationState` projection exposes only task status and the fields
needed to acknowledge Stop. `auth/tenant-safety-settlement.ts` authenticates exact
task or command capabilities before exempting safety RPCs. Start/nuke and cleanup
claims remain denied; ongoing authorized deletion cleanup may settle. No role,
provider-less call, report-path name or customer flag is a generic exemption.

Socket admission retains executor safety RPC transport only; service guards still
authorize each operation. A bounded per-replica monitor disconnects ordinary
customer/service/terminal sockets when restriction cannot be ruled out. Ordinary
publications and Redis relays recheck admission; the exact task termination signal
retains its narrowly scoped channel. Socket retirement does not prove process exit. Terminal creation also rechecks execution
admission before branch admission, but the transaction does not span process spawn.
Zellij sessions can survive detach; neither closing the attachment nor removing
its registry entry is containment evidence.

## Pending work and occurrence cutoffs

Restriction transitions and task enqueue/dispatch use a tenant execution advisory
lock before branch/session/task locks. Any closing transition atomically places a
server-owned `tenant_restriction_hold` on pending prompts. Ordinary metadata edits
and activation preserve it. Queue inspection still shows held prompts, but runnable
selection/discovery/dispatch skip them. Explicit resubmission creates a new task.

The retained restriction row's database update time is a conservative event cutoff.
After activation only later schedule/gateway occurrences are eligible. Cron skips
advance their cursor without changing enabled configuration. Gateway handling
consumes durable event identities without provider preparation or prompt creation.
Task persistence rechecks initial schedule identity/time and gateway receipt time
under the execution fence to close in-flight initialization races. Manual scheduled
runs use their creation time, not the minute-rounded cron occurrence identifier.

Environment command non-Stop admission and claims acquire the execution fence
before the branch lock. An unclaimed command requested before the retained cutoff
cannot start after reactivation. Stop, output and result settlement preserve the
existing attempt/authority/deadline checks. Successful Stop commands and stopped
environment metadata do not prove that services or background descendants exited.

`services/tenant-restriction-reconciler.ts` uses existing routing-only task discovery,
then re-enters each tenant scope before reading restrictions and initiating the
existing Stop coordinator. It does not infer process absence or complete suspension
from a scan, a task status or an empty page. Existing coordinator recovery still owns
late connection, acknowledgement, containment and unverified outcomes.

Use the repository PostgreSQL integration runner and its disposable non-superuser
application role. Module integration proof is not end-to-end suspension QA.

## Credential generations

`auth/tenant-credential-epoch.ts` hashes the complete sorted controller/placement/
revision vector and tenant identity. It is not a clock cutoff or maximum revision.
Runtime access/refresh tokens and MCP egress capabilities retain the generation
validated at issuance; refresh and JWT re-login never replace an old generation
with the current one. Missing legacy claims work only without retained history.
Fresh primary authentication (including existing API keys) is not permanent key
revocation. Standalone SQLite remains outside hosted restriction support.

Ordinary service admission, bearer authentication, socket packets/publications,
and egress dispatch compare the watermark. The bounded socket monitor also retires
stale nonexecutor connections after a rapid restriction/release cycle. Old executor
credentials retain only exact safety settlement, including after activation;
telemetry cannot use this exception to restart callback automation. Fresh command
issuance carries the current generation; only internal Stop and ongoing deletion
renewal issue safety-only recovery credentials. Initial cleanup/deletion claims
still require ordinary admission.

`auth/tenant-launch-revision.ts` additionally checks the signed handoff's
`tenant_restriction: { controllerId, revision }` against the trusted external
provider's `restriction_controller_id` configuration (environment override:
`AGOR_EXTERNAL_LAUNCH_RESTRICTION_CONTROLLER_ID`). Comparison occurs under the
execution fence before identity/default-board writes. Positive revisions need an
existing matching active controller row; any other closed owner denies launch.
Zero/missing is legacy baseline only when the entire restriction history is empty.
The resulting runtime token keeps the generation captured in that transaction.

This handoff check is assertion-generation anti-replay, not installation identity,
placement freshness, restore safety, replica compatibility, or bootstrap proof.
Those remain prerequisites for the authenticated controller adapter and activation.
