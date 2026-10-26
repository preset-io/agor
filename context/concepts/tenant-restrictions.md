# Tenant restriction intent protocol

**Status: runtime enforcement of controller-owned restriction intent; not a complete suspension
feature by itself.** The only writer is the in-Cell operator command `agor tenant restriction apply`
(see [CLI](#cli)), which holds the runtime database credential and authenticates nobody; no HTTP
service, MCP tool, or daemon route exposes it. Ordinary access is denied while exact termination
reads and scoped lifecycle acknowledgements remain possible. These guards do not prove
socket/process containment or controller freshness.

## Ownership and state

`packages/core/src/types/tenant-restriction.ts` defines the version-1 command and pure transition
policy; `packages/core/src/db/tenant-restriction.ts` persists it in PostgreSQL under a short
tenant-scoped transaction. The key is `(tenant_id, controller_id)`; `placement_id` is immutable for
that controller. The authenticated internal caller binds the controller identity; a tenant request
never supplies it. RLS isolates tenants, not operators within a tenant; the application database
role is trusted code, not a public control API.

```text
absent --restrict(r1)--> restricted
restricted --prepare_release(r2 > r1)--> release_prepared [still closed]
release_prepared --activate(exact r2 + operation)--> active [watermark retained]
any recorded phase --restrict(higher revision)--> restricted
absent --seed_active(r)--> active [re-home watermark restatement only]
```

- Higher-revision prepare may supersede an incomplete restriction but never opens admission;
  activation requires the exact prepared operation. Older commands are rejected (including a delayed
  restrict after release), same-command retries and a delayed prepare for an already-active
  operation are no-ops, and conflicting commands at the same revision are rejected.
- Advisory locking serializes first writers even when no row exists and rolls back with the
  surrounding transaction. No network/process wait belongs inside it.
- `seed_active` writes only when this controller has **no record at all**: a tenant moved to a fresh
  runtime arrives with an empty history, and the orchestrator restates the revision it carries. It
  cannot repair, override or reopen a runtime that recorded anything. An exact replay (same
  placement, operation and revision, still `active`) returns `changed: false`; any other recorded
  state is `revision_conflict`.
- Any accepted change, a seed or first record included, moves the credential generation, so seeding
  or restricting a runtime already serving the tenant signs everyone out and stops running tasks.
  Seed before the destination serves (`apply` warns on stderr when a seed changed state).
- Composition is OR across controllers. Releasing one controller's restriction never clears
  another's and never touches the separate portability write gate.
- Stored data is strictly parsed; corrupt values and DB failures never become an unrestricted
  result. SQLite operations return unsupported rather than claiming a hosted tenant boundary.

## Persistence and portability

Migration `0120_tenant_restrictions` adds the PostgreSQL table with FORCE RLS and no broad
cross-tenant operator policy; SQLite has no table. The table is in the tenant erasure manifest but
excluded from portable archives: placement/controller authority belongs to the deployment. A
destination must receive its own authoritative restriction (for a positive revision, `seed_active`)
before serving imported data; a missing row never proves a new or restored runtime may serve. Tenant
identifiers are not recycled, and an authenticated adapter rejects retired placements/tenants before
calling the writer. Never delete active-phase rows to release: they retain the revision watermark.
Older binaries ignore this state, so rollback to one is unsafe once serving adapters are installed.

## Limits

- The writer records intent; it neither validates containment proof nor authenticates its caller,
  who must establish the release barrier before `activate`.
- `readTenantRestrictionState` is the single uncached read (records, closed, event cutoff) every
  admission check derives from; it does not guard already-admitted work, stale tokens, sockets, or
  agents. A row or write response does not prove draining, containment, or replica freshness.
- One handshake, socket packet or request shares one read across its strategy, packet and hook
  checks. The share never crosses requests (except executor streaming relay chunks) and never
  outlives one tick (1 s). Nested internal service calls read afresh: a nested call may be the write
  that must observe a new state.
- The socket monitor reads each tenant separately: the ids-only discovery capability of migration
  `0121` lacks the vector a generation check needs, and a batched full-state read would need a
  cross-tenant policy this table deliberately lacks.
- Slack card delivery and OAuth callbacks check admission on entry only; dispatched provider calls
  are not undone. The Slack repair sweep re-checks per page and never re-posts cards or notices
  older than 24 h after reactivation.
- Teams ingress stores nothing for a closed tenant; the Teams inbound worker consumes pre-cutoff
  events without prompts. Teams and Discord delivery workers hold a closed tenant's deliveries (no
  claim, no attempt spent), deferring each held row 30 s so it cannot starve other tenants.

Not contained: environments and dev servers keep running. Stop writes assert the portability write
gate, so restrict and let Stops settle before acquiring that gate. A branch-deletion `claim` needs
ordinary admission, so a deletion dispatched just before a restriction fails after 2 min and must be
retried after reactivation.

## CLI

`agor tenant restriction apply|inspect` (`apps/agor-cli/src/commands/tenant/restriction/`) runs as a
non-interactive in-Cell Job of the Data Plane Agent. It needs only `DATABASE_URL`, never contacts
the daemon, validates flags with `TenantRestrictionCommandSchema` before connecting, and prints one
stable JSON line on stdout (`apply`: `{"record":…,"changed":…}`) with human audit text on stderr.

| Exit | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | Applied, or already in that state — `changed` says which. `inspect` read (any size) |
| `1`  | Invalid flags/tenant id, corrupt stored state, or any other failure                 |
| `2`  | Conflict with the recorded state                                                    |
| `3`  | `TenantRestrictionUnsupportedError` — the runtime is SQLite and holds no state      |

Failures print one bounded `{"error":<code>}` line on stderr and nothing on stdout (on SQLite the
pragma banner still reaches stdout unless `AGOR_SILENT_PRAGMA_LOGS=true`). Exit `2` carries the
protocol `TenantRestrictionConflictCode`; error text never crosses the boundary. Unlike
`tenant gate`, exit `2` means _conflict_. Never force past a seed `revision_conflict`: a higher
revision for this controller means the destination moved on; anything else needs a person. A zero
exit or an empty `inspect` proves only what the row says, never suspension or permission to serve.

## Runtime admission and safety traffic

Production composes `createTenantRestrictedAuthHook` with the PostgreSQL 403/503 reader in
`auth/tenant-access.ts`. Direct MCP, bearer uploads and the MCP egress gateway (through its final
pre-dispatch check: `tenant_restricted`, or `egress_unavailable` on a failed read) check admission
independently. External launch projection takes the execution fence after the authorization fence.
Provider session teardown is not an exemption. SQLite keeps standalone behavior.

The 403 and the Socket.IO handshake rejection carry `data.code` = `TENANT_RESTRICTED_ERROR_CODE`
(`tenant_restricted`), the entire client-facing disclosure: no controller, placement, operation,
revision or phase. A 503 and the ambiguous per-packet `Forbidden` carry no code, because an
unverifiable read never says the tenant is closed. agor-ui matches the code (never message text)
from a handshake, re-authentication, refresh, sign-in, or a `GET /health` 403 from a proxy (the
daemon's own `/health` is always 200); it closes the socket and mutation gate, keeps the credential,
renders `WorkspaceSuspended` ahead of sign-in, and re-probes until a handshake is accepted.

A ready `GET /readyz` on PostgreSQL reports `tenant_restriction: { controller_id }` from
`external_launch.restriction_controller_id` (or `null`); Agor Cloud refuses to suspend a Team on a
Cell that did not report one. A launch refused between Cloud accepting a suspension and the runtime
applying it exits `76` (see `task-runtime-state.md`).

`auth/termination-read-authority.ts` issues single-call read grants bound to
tenant/path/method/resource; `tasks.getTerminationState` exposes only what Stop needs.
`auth/tenant-safety-settlement.ts` authenticates exact task or command capabilities before exempting
safety RPCs. Start/nuke and cleanup claims stay denied; ongoing authorized deletion cleanup may
settle. No role, provider-less call, report-path name or customer flag is a generic exemption.

### Sockets and publications

- Per-packet admission reads only for service-call and executor packets, sharing the read with the
  service hook. Executor safety RPCs never read; executor streaming relay chunks share one
  per-tenant read per tick, since they only re-emit through the publication gate.
- Raw terminal/presence/cursor packets never read. Packets dispatch in arrival order; a stuck read
  rejects its packet, timed-out reads per socket are capped, and an overflowing socket is
  disconnected rather than silently dropping packets.
- A bounded per-replica monitor (1 s tick) disconnects customer/service/terminal sockets only on a
  positive observation (closed tenant or stale generation), judging only sockets admitted before its
  read began. Unverifiable never disconnects; service calls still fail closed per call. Bounded
  partition freshness is deferred to v2 (D6).
- Publications and Redis relays recheck the generation through a per-tenant single-flight read
  reused for at most one tick; a failed or stuck read suppresses that tenant's delivery. Only the
  exact task termination signal keeps its scoped channel.
- Socket retirement does not prove process exit; terminal admission does not span process spawn, and
  Zellij sessions survive detach.

## Pending work and occurrence cutoffs

Transitions and task enqueue/dispatch take a tenant execution advisory lock before
branch/session/task locks: shared for admissions, exclusive for transitions. A closing transition
atomically sets a server-owned `tenant_restriction_hold` on pending prompts, which metadata edits
and activation preserve. Dispatch skips held prompts, inspection still shows them, they never block
a new prompt to the session, and resubmission creates a new task.

The retained row's update time is a conservative event cutoff: after activation only later
schedule/gateway occurrences run. Gateway times use the provider clock plus a 5-second skew grace,
so an early post-reactivation message can be dropped but a suspension-era one is never replayed.
Cron skips advance their cursor; gateway handling consumes event identities without prompts. Task
persistence rechecks schedule and gateway times under the execution fence. Environment command
non-Stop admission and claims take the fence too, so a pre-cutoff command never starts after
reactivation.

`services/tenant-restriction-reconciler.ts` lists closed tenant ids under the read-only
`tenant_restriction_discovery` capability (migration 0121; ids from `agor_restricted_tenant_ids()`
only, never rows), then pages those tenants' live tasks. Each tenant's scoped read decides before
the Stop coordinator runs, and the Stop claim re-reads closure under the fence. An empty discovery
is not proof a tenant is open. Coordinator recovery keeps running while a tenant is restricted.

Restricted telemetry claims `tenant_suspension` (settling Stopped) for a closed tenant or a codeless
stale generation, which a misused `seed_active` also produces. Only a durably recorded heartbeat
revocation claims `authorization_revoked`, decided under the Task row lock. The v1 cleanup context
(`EXECUTOR_CLEANUP_CAUSES`) sends `tenant_suspension` as `user_stop`, so existing helpers still
contain the executor.

A task completing as its tenant closes, or while admission is unverifiable (503), still returns its
session to idle; the rest of completion automation (callbacks, auto-title, result injection, the
after-patch gateway flush) is skipped and never replayed, so a parent can miss a child's callback
and a Slack status can stay `working`. The queue trigger is skipped only for a closed tenant. Each
skip logs `[tasks.completion] automation skipped reason=restricted|unverifiable`.

## Credential generations

`auth/tenant-credential-epoch.ts` hashes the sorted controller/placement/revision vector and tenant
identity; it is not a clock cutoff or maximum revision. Runtime access/refresh tokens, MCP session
tokens and egress capabilities keep the generation validated at issuance; refresh and JWT re-login
never replace it. Missing legacy claims work only without retained history. Fresh primary
authentication is not key revocation.

- A closed tenant rejects with `NotAuthenticated` whose `data` is exactly
  `{ code: TENANT_RESTRICTED_ERROR_CODE }`; a stale generation is a codeless 401; a failed or
  corrupt read is a codeless 503 (handshake: `{ code: 503, className: 'unavailable' }`), so an
  outage never signs anyone out. After activation a parked credential falls back to sign-in.
- MCP token issuance reuses the read that admitted the request and compares a JWT caller's
  generation: a closed tenant or moved generation mints nothing. If that read fails, a session get
  over a transport fails with 503, so an executor launch fails visibly instead of running without
  Agor MCP; internal, termination and authorization-only reads (Stop, permission decisions) return
  without a token. `/mcp` compares the generation on every request.
- Service admission, bearer authentication, socket packets/publications and egress dispatch compare
  the generation; session MCP projection does so only for signed runtime JWTs (API keys get the
  closed-tenant check).
- Old executor credentials keep only exact safety settlement, even after activation; telemetry
  cannot use it to restart callback automation. Only internal Stop and ongoing deletion renewal
  issue safety-only recovery credentials. An executor facing an older daemon falls back from
  `tasks.getTerminationState` to `tasks.get`.

`auth/tenant-launch-revision.ts` checks the signed handoff's
`tenant_restriction: { controllerId, revision }` against the provider's `restriction_controller_id`
(`AGOR_EXTERNAL_LAUNCH_RESTRICTION_CONTROLLER_ID`) under the execution fence before identity writes.
A positive revision needs a matching active controller row, any other closed owner denies launch,
and zero/missing is legacy baseline only with an empty history. The runtime token keeps the
generation captured in that transaction. This is anti-replay, not installation identity, placement
freshness or restore safety, which remain reactivation prerequisites.
