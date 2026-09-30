# Tenant restriction intent protocol

**Status: runtime enforcement of controller-owned restriction intent; not a
complete suspension feature by itself.** The only writer is the in-Cell
operator command `agor tenant restriction apply` (see [CLI](#cli)), which holds
the runtime database credential and authenticates nobody. No HTTP service, MCP
tool, or daemon route exposes the writer. Ordinary access is denied while exact
termination reads and scoped lifecycle acknowledgements remain possible. These
guards do not prove socket/process containment or controller freshness.

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

An exact replay of an accepted seed (same placement, operation and revision,
still `active`) is a no-op returning `changed: false`, because the transport is
at-least-once. Every other recorded state, including a closed row at the seed's
own revision, is rejected with `revision_conflict`. The comparison is against
this controller's own `(tenant_id, controller_id)` record only.

A seeded row is an ordinary active record afterwards — a later restrict at a
higher revision closes it like any other.

Any accepted change, including a seed or any first record, changes the tenant
credential generation (see Credential generations). Seeding or restricting a
runtime that is already serving the tenant therefore signs everyone out and
turns running tasks' telemetry into Stop. `apply` warns on stderr when a seed
changed state; the orchestrator must seed before the destination serves.

Restriction composition is OR across controllers. Releasing one controller's
restriction cannot clear another's, and never modifies the separate portability
write gate. Stored data is strictly parsed; corrupt or unsupported values and
DB failures do not become an unrestricted result. SQLite operations explicitly
return unsupported rather than claiming a hosted tenant boundary exists.

## Persistence and portability

Migration `0117_tenant_restrictions` adds the PostgreSQL table with FORCE RLS;
SQLite has no table because restriction operations are PostgreSQL-only.
No broad cross-tenant operator policy is added. The table is included
in the runtime-derived tenant erasure manifest but excluded from portable data
archives: placement/controller authority belongs to the deployment, not to
customer content. A destination must receive its own authoritative restriction
before serving imported data (for a tenant whose controller revision is already
positive, that is exactly what `seed_active` writes). A missing row alone is not
proof that a new or restored runtime is allowed to serve. Tenant identifiers must not be recycled;
an authenticated adapter must reject work for retired placements/tenants before
calling the persistence writer.

Migration 0118 changed during this branch's development and the migrator never
re-runs an applied migration, so reset any development database that applied an
earlier build of it; no released database ran it.

Do not delete active-phase rows to release a restriction: they retain the
revision watermark. Erasure is the separate irreversible tenant lifecycle.
Older binaries do not enforce this state; once serving adapters are installed,
rollback to an ignoring binary cannot be treated as safe.

## Limits

The writer records intent; it does not validate containment proof or
authenticate its caller. `activate` is a low-level transition for that trusted
caller, not a customer-reachable endpoint; whoever runs it must establish the
release barrier first. `readTenantRestrictionState` is the single uncached
read (records, closed, event cutoff) every admission check derives from; it is
not a guard for already-admitted work, stale tokens, sockets, or agents. One
handshake, socket packet or request shares one read across its strategy, packet
and hook checks; the share never crosses requests (except executor streaming relay
chunks, below) and never outlives one tick (1 s).
Nested internal service calls read afresh on purpose: a nested call may be the
write that has to observe a new restriction, so no cross-call cache is added.
The socket monitor likewise reads each connected tenant separately: the only
cross-tenant read, the ids-only discovery capability of migration 0118, says which
tenants are closed but not the controller/revision vector a generation check needs,
and a batched full-state read would need a broader cross-tenant policy this table
deliberately lacks. A database row or an intent write response does not prove connection
draining, process containment, or current-replica freshness.
Slack card delivery and OAuth callbacks check admission on entry only; per-dispatch Slack/OAuth freshness fencing is deferred, and provider calls already dispatched are not undone.
The Slack repair sweep re-checks once per page, so a pass that began before a
restriction stops within one page. The sweep only repairs cards and notices
younger than 24 h: anything older at reactivation is never re-posted.

Not contained by suspension: environments and dev servers keep running (hard
containment is deferred). Stop writes assert the separate portability write
gate like every candidate write, so while an operator holds that gate a Stop
cannot be claimed or settled; restrict and let Stops settle before acquiring
it. A branch-deletion `claim` needs ordinary admission, so a deletion dispatched
just before a restriction is refused, marked failed after 2 min ("never
claimed") and must be retried after reactivation.

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
ordered by controller id, and the retained event cutoff (latest update) on
stderr only, so the stdout record shape stays fixed for strict parsers. Flags are validated with
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

## Runtime admission and safety traffic

Production composes `createTenantRestrictedAuthHook` with the neutral PostgreSQL
403/503 reader in `auth/tenant-access.ts`. Direct MCP and bearer upload routes
check admission independently. The raw MCP egress gateway also reads restriction
state in its existing current-authority check, including the final pre-dispatch
check (a closed tenant or stale generation is `tenant_restricted`; a failed read is
the transient `egress_unavailable`); already-dispatched provider effects are not undone. Provider session teardown
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

Per-packet socket admission reads only for Feathers service-call packets (and
every executor-socket packet), sharing that read with the service hook; it retains
executor safety RPC transport only, and service guards still authorize each
operation. Executor streaming relay chunks (`messages/streaming` and `tasks/streaming`
creates) instead share one per-tenant single-flight read for at most one tick from its
start, which also serves their service hook: for an executor they only re-emit through the
publication gate, which drops closed or stale deliveries itself. Every other executor RPC
still reads per call. Executor safety RPCs do no packet read at all, since they pass whatever
it says; they only keep their place in arrival order. Raw terminal/presence/cursor packets never read, and every packet on a
socket dispatches in arrival order (a raw packet waits only behind an earlier
pending admission). An admission read still pending after 2 s rejects its packet
with the same ambiguous `Forbidden`, so one stuck read never freezes the socket.
While four such timed-out reads of one socket are still running, its further
packets that need a read are refused at once without starting another, which
bounds the database load a socket can hold; the cap is per socket, so a replica can
hold up to four such reads for each connected socket. Executor raw frames (such as
terminal output) join the socket's raw-frame read already in flight; a settled or
timed-out read is never joined by a later frame. A
socket holding 1,000 queued packets is disconnected rather than dropping packets
silently, and nothing queued behind it dispatches. Raw traffic from a restricted tenant stops when the monitor
retires the socket, about one tick after a successful read shows the tenant closed. A bounded per-replica monitor (1 s tick) disconnects
ordinary customer/service/terminal sockets only on a positive observation: a
closed tenant or a stale credential generation. It reads each tenant separately
through a rolling pool of at most eight reads in flight, least recently read
tenants first. A failed, slow (>2 s) or saturated read skips that tenant until
the next tick with a rate-limited warning, and a sweep running far past its tick
is warned about the same way. A read still pending after 4 s is abandoned once so
a fresh read can start; while that abandoned read is outstanding no further read
replaces it, and abandoned reads count toward the eight-read bound.

When a replica cannot read the restriction (database outage or partition), its
already-connected sockets keep their raw terminal/presence/cursor traffic until a
read succeeds; being unverifiable never disconnects a socket. Service calls still
fail closed per call, because each reads admission itself. Bounded partition
freshness is deferred to v2 (D6): a strict stop during partitions would need
renewable serving leases.

Ordinary publications and Redis relays recheck the generation through a
per-replica, per-tenant single-flight read reused for at most one tick (a failed
read suppresses delivery for that tick; while a read stays pending past 2 s, that tenant's
publications are suppressed until it settles, and after 4 s a fresh read replaces it once; no further read starts while that abandoned read is outstanding), so suspension or reactivation reaches
publications within about one tick; the exact task termination signal retains its
narrowly scoped channel. Socket retirement does not prove process exit. Terminal creation also rechecks execution
admission before branch admission, but the transaction does not span process spawn.
Zellij sessions can survive detach; neither closing the attachment nor removing
its registry entry is containment evidence.

## Pending work and occurrence cutoffs

Restriction transitions and task enqueue/dispatch use a tenant execution advisory
lock before branch/session/task locks. Admissions take it shared, so they never
serialize on each other; only a transition takes it exclusively, waiting for
in-flight admissions to commit, and admissions after it read the new state. Any closing transition atomically places a
server-owned `tenant_restriction_hold` on pending prompts. Ordinary metadata edits
and activation preserve it. Queue inspection still shows held prompts, but runnable
selection/discovery/dispatch skip them. Explicit resubmission creates a new task.

The retained restriction row's database update time is a conservative event cutoff.
After activation only later schedule/gateway occurrences are eligible. Gateway
occurrence times come from the provider's clock, so they must also clear a 5 s
skew grace; a message in the first seconds after reactivation can be dropped,
never a suspension-era one replayed. Prompts held by a restriction never block
direct admission of a new prompt to the same session. Cron skips
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

`services/tenant-restriction-reconciler.ts` first lists closed tenant ids under the
read-only `tenant_restriction_discovery` capability (migration 0118: the capability
sees rows only inside `agor_restricted_tenant_ids()`, which returns the ids of tenants
with a non-active row and nothing else; a direct table read under it sees no row),
then pages live tasks of those tenants only, so
a runtime with nothing restricted pages nothing. Each tenant's own scoped read still
decides before the existing Stop coordinator is invoked; both reads are shared across
a saturated drain for at most one tick (1 s). Because that observation may be a tick
old, the Stop claim itself re-reads closure under the shared execution fence in the
claim transaction and does nothing for a tenant that has since reopened. An empty discovery is not proof that a
tenant is open: admission and restricted telemetry fail closed independently. It does
not infer process absence or complete suspension from a scan, a task status or an
empty page. Existing coordinator recovery still owns late connection,
acknowledgement, containment and unverified outcomes; the runtime reconciler reloads
candidates through termination reads, so dispatch-timeout, stale-heartbeat and
stranded-Stop recovery continue while a tenant is restricted.

Restricted telemetry claims `tenant_suspension` (settling Stopped) for a closed
tenant and for a codeless stale generation, which moves only with restriction
records, so a Stop keeps that cause across reactivation. Only a revocation the
heartbeat authority recorded durably claims `authorization_revoked`, and the
repository decides under the Task row lock whether it replaces a suspension cause.
A `seed_active` against a runtime already serving the tenant (documented misuse)
also moves the generation, and its running tasks are stopped as `tenant_suspension`
too: the read holds only current records and the task credential only the
generation hash, so a seeded record cannot be told from a reactivated one.

A task completing as the tenant closes (including a close between the admission
check and the session write), or while that check, the session read or the session
write cannot verify admission (503), still returns its session to idle through a
hook-free projection. Everything else
in completion is skipped and not replayed: origin alignment, auto-title, completion callbacks, BTW archive and result injection,
and the sessions after-patch hook, whose gateway outbound flush and
progress `done` do not run. A buffered final gateway reply is therefore never
posted, and a Slack thread status can stay `working` until that session's next
turn updates it; reactivation does not repair it. The queue trigger is skipped only
for a closed tenant; an unverifiable read still triggers it, because dispatch
re-checks the restriction under the execution fence. No durable path retries completion
callbacks, so a parent session whose child completed while its tenant was merely
unverifiable (never restricted) permanently misses that callback. Each skip logs
one `[tasks.completion] automation skipped reason=restricted|unverifiable` line
(`kept=queue` on the unverifiable one).

## Credential generations

`auth/tenant-credential-epoch.ts` hashes the complete sorted controller/placement/
revision vector and tenant identity. It is not a clock cutoff or maximum revision.
Runtime access/refresh tokens, MCP session tokens and MCP egress capabilities retain
the generation validated at issuance (a closed tenant is minted no MCP session token and its session read returns without one;
issuance reuses the read that admitted the request, within its tick; when issuance's own read fails, a session get over
a transport (the executor's or a browser's) fails with a 503, so an executor launch fails visibly rather than starting an agent
without Agor MCP, while internal daemon reads, termination reads and a committed create return without a token, and daemon routes that read the session under the caller's provider for authorization only (Stop, permission decisions) mint none at all; the `/mcp` route compares it on every request and answers a stale one 401); refresh and JWT re-login never replace an old generation
with the current one. Missing legacy claims work only without retained history.
Fresh primary authentication (including existing API keys) is not permanent key
revocation. Standalone SQLite remains outside hosted restriction support.

A read that finds any record in a non-`active` phase rejects with
`NotAuthenticated` carrying `data` of exactly
`{ code: TENANT_RESTRICTED_ERROR_CODE }`; a stale supplied generation against an
open tenant is a codeless 401, and a failed, unavailable or corrupt read is a codeless
503 (`Unavailable`), so an outage never reads as a rejected credential. The
credential is refused on every path either way; the code exists because this
check runs ahead of tenant admission on each JWT path, so the browser could
otherwise not tell a suspended workspace from an expired session. Only a holder
of a signed runtime credential or valid primary credentials for that tenant can
reach it. The refresh service preserves that one code and the codeless 503; every
other refresh failure stays "invalid or expired". The browser treats the 503 as
transient and keeps its stored credential. After activation the watermark moves, so a
parked credential is rejected codelessly and the browser falls back to sign-in.

Ordinary service admission, bearer authentication (executor-session upload and
Slack upload bearers included), socket packets/publications,
and egress dispatch compare the watermark. The bounded socket monitor also retires
stale nonexecutor connections after a rapid restriction/release cycle. Old executor
credentials retain only exact safety settlement, including after activation;
telemetry cannot use this exception to restart callback automation. Fresh command
issuance carries the current generation; only internal Stop and ongoing deletion
renewal issue safety-only recovery credentials. An executor facing an older daemon
without `tasks.getTerminationState` falls back to `tasks.get` for its Stop state. Initial cleanup/deletion claims
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
