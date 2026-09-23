# Tenant restriction intent protocol

**Status: partial runtime enforcement, not a complete suspension feature.**
The only writer surface is the in-Cell operator command `agor tenant restriction
apply` (see [CLI](#cli)), which holds the runtime database credential and
authenticates nobody. No HTTP service, MCP tool, or daemon observer exposes the
writer, and no authenticated Cloud-to-runtime transport carries Team suspension
state into `tenant_restrictions` yet. Shared authenticated service admission, MCP requests,
bearer upload routes, and selected task automation boundaries consume
restriction state. Ordinary access is denied while exact termination reads and
scoped lifecycle acknowledgements remain possible. Prompt holds and event
cutoffs are implemented but still need integrated certification. These guards
do not establish full socket/process containment or controller freshness. Do
not advertise suspension support until transport and reactivation are
integrated and certified.

## Ownership and state

`packages/core/src/types/tenant-restriction.ts` defines the version-1 command and
pure transition policy. `packages/core/src/db/tenant-restriction.ts` persists it
in PostgreSQL under a short tenant-scoped transaction. The composite key is
`(tenant_id, controller_id)`; `placement_id` is immutable for that controller.
The controller identity must be bound by the authenticated internal caller,
not accepted as authority from a tenant request. RLS isolates tenants, not
operators within a tenant. The application database role is trusted code, not a
public control API.

```text
absent --restrict(r1)--> restricted
restricted --prepare_release(r2 > r1)--> release_prepared [still closed]
release_prepared --activate(exact r2 + operation)--> active [watermark retained]
any recorded phase --restrict(higher revision)--> restricted
absent --seed_active(r)--> active [re-home watermark restatement only]
```

Higher-revision prepare may supersede an incomplete restriction, but does not
open admission. Activation requires the exact prepared operation. Older
commands are rejected, including a delayed restrict after release. Same-command
retries are no-ops; a delayed prepare for an already-active operation is also a
no-op. Conflicting commands at the same revision are rejected. Advisory locking
serializes first writers even when no row exists, and rolls back with the
surrounding transaction. No network/process wait belongs inside this lock.

`seed_active` is the only action that writes an open record without a prepared
release, and it **writes only when the controller has no record at all**. It
exists because this table is deployment-bound and never portable: a tenant moved
to a fresh runtime arrives with an empty history that the launch-revision check
reads as a missing watermark (see Persistence and portability). The orchestrator
that moved the tenant restates the revision it already carries — it cannot
repair, override or reopen a runtime that recorded anything.

An exact replay of a seed this runtime already accepted — same placement,
operation and revision, still `active` — is a no-op returning `changed: false`,
like every other same-command retry. The transport is at-least-once, so a
delivery whose reply was lost has to be able to ask again; answering it with a
conflict made a correct runtime look like a failed one. It writes nothing, so
"empty history only" still holds. Every other recorded state — a different
operation or revision, a different placement, or any closed phase, including a
closed row at the seed's own revision — is rejected with `revision_conflict`.
The comparison is against this controller's own record: the composite key is
`(tenant_id, controller_id)`, so another controller's row is never what a seed is
compared with, and composition across controllers keeps its usual OR meaning.

A seeded row is an ordinary active record afterwards — a later restrict at a
higher revision closes it like any other.

Restriction composition is OR across controllers. Releasing one controller's
restriction cannot clear another's, and never modifies the separate portability
write gate. Stored data is strictly parsed; corrupt or unsupported values and
DB failures do not become an unrestricted result. SQLite operations explicitly
return unsupported rather than claiming a hosted tenant boundary exists.

## Persistence and portability

Migration `0115_tenant_restrictions` adds dialect-parity tables and PostgreSQL
FORCE RLS. On databases that ran the earlier feature's `0112_tenant_restrictions`,
the old ledger timestamp collides with main's `0112_kb_import_receipts`; the
idempotent `0115` also reconciles that skipped main table, indexes, and FORCE RLS
without replacing existing rows. No broad cross-tenant operator policy is added. The table is included
in the runtime-derived tenant erasure manifest but excluded from portable data
archives: placement/controller authority belongs to the deployment, not to
customer content. A destination must receive its own authoritative restriction
before serving imported data (for a tenant whose controller revision is already
positive, that is exactly what `seed_active` writes). A missing row alone is not
proof that a new or restored runtime is allowed to serve. Tenant identifiers must not be recycled;
an authenticated adapter must reject work for retired placements/tenants before
calling the persistence writer.

Do not delete active-phase rows to release a restriction: they retain the
revision watermark. Erasure is the separate irreversible tenant lifecycle.
Older binaries do not enforce this state; once serving adapters are installed,
rollback to an ignoring binary cannot be treated as safe.

## Required integration before activation

The persistence writer records intent; it does not accept/validate containment
proof or authenticate its caller. No authenticated application seam invokes it
yet: the CLI below is a trusted in-Cell process holding the database credential,
not an authenticated Cloud-to-runtime transport, which remains the open
integration. `activate` is a low-level state transition for that trusted caller,
not a customer-reachable endpoint; whoever runs it must establish the release
barrier first.
`assertTenantUnrestricted` is an uncached database admission primitive, not a
complete guard for already-admitted work, stale auth tokens, sockets, or agents.

Complete support requires implementation and integrated proof at every boundary below;
the partial enforcement already installed is described in the later sections:

- an authenticated Cloud-to-runtime transport that binds tenant, controller,
  operation and revision before calling the writer;
- admission fencing at HTTP, realtime, MCP, artifact/file, queue, scheduler,
  gateway and executor boundaries, including old credential epochs;
- trusted safety-operation paths for termination and acknowledgement that do
  not reopen ordinary tenant access;
- connection draining, task/process containment and current-replica evidence;
- queue/event cutoffs, prepared-release/activation coordination, and bootstrap
  synchronization before replacement replicas begin serving;
- restart/retry and offline-target reconciliation with honest incomplete states.

A database row or an intent write response proves none of those behaviors.

## CLI

`agor tenant restriction apply|inspect`
(`apps/agor-cli/src/commands/tenant/restriction/`) is the runtime side of the
protocol. The Data Plane Agent invokes it as a non-interactive in-Cell Job; it
needs only the runtime database configuration (`DATABASE_URL`), never contacts
the daemon, and follows the `agor tenant gate acquire|inspect|release`
conventions: one stable JSON line on stdout, human audit text on stderr.

```bash
agor tenant restriction apply \
  --tenant-id <workspaceId> --controller-id <controller> \
  --placement-id <cellId> --operation-id <operation> \
  --revision <n> --action restrict|prepare_release|activate|seed_active

agor tenant restriction inspect --tenant-id <workspaceId>
```

`apply` prints `{"record":…,"changed":…}`; `inspect` prints the records array
ordered by controller id. Flags are validated with
`TenantRestrictionCommandSchema` before a connection is opened, so the CLI
cannot accept an identity or revision the writer would reject. An exact replay of
an accepted `seed_active` exits `0` with `"changed":false`; any other recorded
state exits `2` with `revision_conflict`. An orchestrator must not force past
that, but it should first read `inspect`: a record for this controller at a
HIGHER revision means the destination has legitimately moved on and the seed's
work is already done, while anything else means the destination holds history
this seed cannot explain and a person has to look.

| Exit | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | Applied, or already in that state — `changed` says which. `inspect` read (any size) |
| `1`  | Invalid flags/tenant id, corrupt stored state, or any other failure                 |
| `2`  | Conflict with the recorded state                                                    |
| `3`  | `TenantRestrictionUnsupportedError` — the runtime is SQLite and holds no state      |

Failures print exactly one bounded `{"error":<code>}` line on stderr and nothing
on stdout — except on a SQLite runtime, where the shared client prints its
pragma banner to stdout before the exit-`3` refusal (as it does for every
`agor tenant …` command; set `AGOR_SILENT_PRAGMA_LOGS=true` to suppress it).
For exit `2` the code is the protocol
`TenantRestrictionConflictCode` (`identity_mismatch`, `stale_revision`,
`revision_conflict`, `release_not_prepared`) so an orchestrator can branch on
it; other failures collapse to `invalid_command`, `unsupported_runtime`,
`invalid_restriction_state` or `failed`. Error text never crosses the boundary.
Note that exit `2` means _conflict_ here, while the sibling `tenant delete` /
`tenant gate` commands use `2` for invalid input and `3` for their own
refusals.

The writer emits one bounded `[tenant.restriction]` line per accepted command,
after commit, carrying tenant, controller, operation, revision, action, phase
and `changed`. The CLI routes that line to stderr so stdout stays parseable.

A zero exit means a row was recorded. It is not evidence that the controller
was authenticated, that connections drained, that processes exited, or that the
tenant is suspended. An empty `inspect` result only means this database holds no
recorded intent — never that a new or restored runtime may serve the tenant.

## Tests

- `src/types/tenant-restriction.test.ts`: transition, binding, validation, and
  replay behavior; no database or runtime claim.
- `src/db/tenant-restriction.test.ts`: unsupported SQLite boundary.
- `src/db/tenant-restriction.postgres.test.ts`: real persistence/reconnect,
  concurrent first-writer and release races, rollback, tenant-negative RLS,
  corrupt-state rejection and independent restriction composition.
- Existing schema/deletion/portability tests cover migration classification.
- `apps/agor-cli/src/commands/tenant/restriction/apply.test.ts`: flag/schema
  validation and exit-code mapping, plus daemon-free argument refusals through
  the real command.
- `apps/agor-cli/src/commands/tenant/restriction/cli.postgres.test.ts`: the
  three-step happy path, retry no-ops, stale-revision and identity conflicts,
  and empty reads, spawned as a child process with only `DATABASE_URL` set. The
  PostgreSQL runner discovers `apps/agor-cli` alongside `packages/core` and
  `apps/agor-daemon`.

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

The 403 carries `data.code` = `TENANT_RESTRICTED_ERROR_CODE` (`tenant_restricted`,
`types/tenant-restriction.ts`), and the Socket.IO handshake rejects a restricted
tenant with the same code in its middleware-error `data` instead of the generic
401 credential rejection. That code is the entire client-facing disclosure: no
controller, placement, operation, revision or phase. The 503 and the deliberately
ambiguous per-packet `Forbidden` keep no code, because an unverifiable read is not
a statement that the tenant is closed. Socket.IO has no server-settable disconnect
reason, so a socket retired by the restriction monitor carries the code on its
next handshake. The same code also rides the earlier credential-generation
rejection (see Credential generations), which is what a browser actually
receives. agor-ui matches the code (never message text): `useAgorClient`
closes the socket, renders the full-page `WorkspaceSuspended` state, closes the
mutation gate, and re-probes with one handshake at 30s/1m/2m/4m/5m-cap until an
accepted handshake clears it. `useAuth` reports the same code from a
re-authentication, refresh or sign-in attempt, retains the stored credential and
re-probes on that schedule; `App` renders the suspended state from either half,
ahead of the sign-in gate. The browser state is a presentation of the last
answer the daemon gave, not evidence of containment.

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

A read that finds any record in a non-`active` phase rejects with
`NotAuthenticated` carrying `data` of exactly
`{ code: TENANT_RESTRICTED_ERROR_CODE }`; a failed, unavailable or corrupt read,
and a stale supplied generation against an open tenant, stay codeless. Nothing is
relaxed — the credential is refused on every path either way — but this check
runs ahead of tenant admission on each JWT path, so without the code a suspended
workspace was indistinguishable from an expired session in the browser and the
admission 403 was unreachable there. Disclosure is bounded by who can reach the
check: a holder of a signed runtime credential, or of valid primary credentials,
for that exact tenant — and the code is the whole of it. The refresh service
preserves that one code through its otherwise generic rejection for the same
reason; every other refresh failure stays "invalid or expired". After activation
the watermark moves, so a parked credential is rejected codelessly and the
browser correctly fails over to sign-in.

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
placement freshness, restore safety, or replica compatibility. Those remain
prerequisites for reactivation.
