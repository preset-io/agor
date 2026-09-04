# Session archive cascade plan

This document defines one explicit archive policy for Session lifecycle entry
points tracked by [issue #2661](https://github.com/preset-io/agor/issues/2661).
It is the contract the session archive engine implements; the code itself lives
in the daemon (see "Implementation notes").

**Status:** Implemented (revision 3); see "Implementation notes" for where the
code lives and the few places the implementation refines this text.
**Research baseline:** upstream `main` at
[`60e7a896`](https://github.com/preset-io/agor/commit/60e7a896d69ac14177c59f906da9e9e176253aa0).
The archive domain logic is unchanged from the issue audit at
[`cfc07997`](https://github.com/preset-io/agor/commit/cfc07997f366958fd90b6cc84208615cacc85c44),
but [`8d43790c`](https://github.com/preset-io/agor/commit/8d43790c36880140598b2cb6012e6b94c5eccb30)
materially changed the execution boundary by arming the tenant database-scope
guard in every mode. The engine and every migrated caller must satisfy that
newer boundary explicitly.

## Outcome

Session archive behavior must depend on an explicit descendant policy rather
than on which route, tool, or internal caller initiated it. Preview,
authorization, mutation, restoration, and realtime results must agree on the
same affected set.

Archive remains a reversible visibility/history operation. It does not stop a
Task, terminate an executor, suppress callbacks, or hard-delete history.

## Decisions

1. `SessionsService` owns the canonical Session archive engine. Repository
   methods perform scoped graph reads and atomic state writes; they do not own
   product policy.
2. The dedicated archive/unarchive operation includes branch-local spawned and
   forked descendants by default, preserving the existing `includeChildren:
false` opt-out introduced by
   [PR #1842](https://github.com/preset-io/agor/pull/1842).
3. The dedicated operation also follows outgoing `remote_create` relationships
   by default. `includeRemoteChildren: false` keeps remote work active.
4. The root branch-local tree is one all-or-nothing authorization and mutation
   unit. Each additional canonical remote branch is a separate unit: authorized
   units succeed; unauthorized units remain unchanged and are reported.
5. Bulk archive never traverses `remote_create`. It supports
   `descendantPolicy: 'none' | 'eligible' | 'all'`. For one compatibility
   release, omission executes the legacy `none` policy with a prominent
   deprecation warning; dry-run without a policy previews all three outcomes.
6. Provider-facing generic Session patch/update may not change `archived` or
   `archived_reason`. Archive-bearing multi-patch is also rejected. Callers use
   the dedicated archive operations instead.
7. BTW completion archives its root with `btw_completed`, includes local
   descendants, and excludes remote descendants.
8. Prompt auto-unarchive restores only the directly prompted Session when its
   canonical Branch is active. Prompting into an archived Branch fails with a
   conflict that directs the caller to restore the Branch first. It does not
   restore ancestors, siblings, local descendants, or remote descendants.
9. Branch archive affects every active Session canonically owned by that Branch
   and never crosses `remote_create`.
10. Board archive is a container-visibility operation. It does not archive its
    Branches or Sessions and is explicitly exempt from Session cascade policy.
11. This change does not repair historical archive inconsistencies
    automatically and does not add a schema migration.
12. Dedicated remote traversal is previewed and bounded. Exceeding any remote
    depth, Branch-unit, or Session-target limit fails closed before mutation.

## Current failure topology

| Entry point                            | Current behavior                                  | Failure                                                                    |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| Dedicated REST/MCP archive             | Cascades through branch-local genealogy           | Does not include visually nested remote-created Sessions                   |
| Generic `sessions.patch({ archived })` | Mutates one row                                   | Leaves active local descendants and provides no descendant option          |
| `agor_sessions_update({ archived })`   | Uses generic patch                                | Gives agents an easy non-cascading bypass                                  |
| Generic multi-patch                    | Single-row updates over a selection where enabled | Forms a second undocumented bulk archive path                              |
| MCP bulk archive                       | Filters and patches direct matches individually   | Preview omits descendants; tree behavior is implicit                       |
| BTW completion cleanup                 | Archives one Session                              | Can leave active local descendants                                         |
| Prompt auto-unarchive                  | Restores one Session                              | Re-roots the prompted Session while its parent remains archived            |
| Branch archive/unarchive               | Reads at most 1,000 Sessions and patches each     | Omits large-Branch rows and overwrites independent archive reasons         |
| Board archive                          | Archives only the Board                           | Intentional container-only behavior, currently undocumented in this policy |

The dedicated operation already provides the strongest starting point: it
walks branch-local genealogy, preflights its affected set, assigns causal
reasons, updates atomically, and emits affected Session events. The plan deepens
that owner rather than adding another archive service.

Primary code evidence:

- dedicated archive policy and RBAC preflight:
  [`apps/agor-daemon/src/services/sessions.ts`](https://github.com/preset-io/agor/blob/cfc07997f366958fd90b6cc84208615cacc85c44/apps/agor-daemon/src/services/sessions.ts#L1228-L1395);
- atomic archive-state repository update:
  [`packages/core/src/db/repositories/sessions.ts`](https://github.com/preset-io/agor/blob/cfc07997f366958fd90b6cc84208615cacc85c44/packages/core/src/db/repositories/sessions.ts#L921-L995);
- generic and bulk MCP paths:
  [`apps/agor-daemon/src/mcp/tools/sessions.ts`](https://github.com/preset-io/agor/blob/cfc07997f366958fd90b6cc84208615cacc85c44/apps/agor-daemon/src/mcp/tools/sessions.ts#L1365-L1634);
- Branch archive/unarchive:
  [`apps/agor-daemon/src/services/branches.ts`](https://github.com/preset-io/agor/blob/cfc07997f366958fd90b6cc84208615cacc85c44/apps/agor-daemon/src/services/branches.ts#L1766-L2084);
- remote relationship semantics:
  [`packages/core/src/types/session.ts`](https://github.com/preset-io/agor/blob/cfc07997f366958fd90b6cc84208615cacc85c44/packages/core/src/types/session.ts#L683-L701);
- documented root-only gateway cleanup:
  [`apps/agor-docs/content/guide/message-gateway.mdx`](https://github.com/preset-io/agor/blob/cfc07997f366958fd90b6cc84208615cacc85c44/apps/agor-docs/content/guide/message-gateway.mdx#L228-L238).

## Externally observable contract

### Dedicated archive and unarchive

Extend the existing options:

```ts
interface SessionArchiveOptions {
  includeChildren?: boolean; // default true
  includeRemoteChildren?: boolean; // default true
  dryRun?: boolean; // default false
}
```

The local unit contains the explicit root plus its active branch-local
descendants. The remote frontier begins with outgoing `remote_create` edges from
every Session included in that local unit. Every remote target starts a unit in
its canonical Branch; that unit contains the target and its branch-local
descendants. The frontier then follows outgoing remote edges from every Session
in each authorized remote unit. It never follows callback targets, inbound
relationship edges, excluded local descendants, or edges beyond an unauthorized
unit.

Dedicated preview and execution enforce these named bounds:

```text
MAX_ARCHIVE_REMOTE_DEPTH          = 8
MAX_ARCHIVE_REMOTE_BRANCH_UNITS   = 32
MAX_ARCHIVE_REMOTE_SESSION_TARGETS = 5_000
```

The limits apply to the remote expansion, not to the root's local closure or a
Branch-wide archive. Preview returns a bounded limit-exceeded result; execution
fails before changing the local or any remote unit. Both paths use a visited set
for duplicate and cycle defense.

If authorization for a remote unit fails, do not mutate or traverse through
that unit. Continue with independent authorized units and return a bounded
failure record. The local unit retains the existing all-or-nothing behavior.

Archive results must distinguish what happened:

```ts
type SessionArchiveUnitResult =
  | {
      rootSessionId: SessionID;
      kind: 'local' | 'remote';
      status: 'changed' | 'unchanged';
      changedCount: number;
      branchId: BranchID; // caller is authorized for this unit
    }
  | {
      rootSessionId: SessionID; // already visible through the relationship
      kind: 'remote';
      status: 'skipped';
      changedCount: 0;
      reason: 'insufficient_permission' | 'not_found' | 'conflict';
      // Deliberately no branchId or target metadata.
    };

interface SessionArchiveResult {
  session: Session;
  dryRun: boolean;
  wouldChangeCount: number;
  archivedCount: number;
  unarchivedCount: number;
  localCount: number;
  remoteCount: number;
  skippedCount: number;
  units: SessionArchiveUnitResult[];
  remainingArchived: Array<{
    sessionId: SessionID;
    reason: 'independent_reason' | 'archived_ancestor' | 'archived_branch';
  }>;
}
```

Keep response detail bounded. A skipped remote unit is identified by the
already-visible relationship target Session ID or an opaque count; it never
returns the inaccessible target's Branch ID or additional metadata. Existing
`count` may remain as a deprecated alias during the transport compatibility
window.

### Bulk archive

Add:

```ts
descendantPolicy?: 'none' | 'eligible' | 'all';
sampleLimit?: number; // default 20, maximum 100
```

Rules:

- Filters select the direct roots exactly as they do today.
- `none` archives only those roots.
- `eligible` adds branch-local descendants that have no nonterminal Task and
  are not newer than `olderThanDays` when an age cutoff is supplied. Session
  type, status, Board, and Branch filters select roots only; they are not
  reapplied to descendants. Without an age cutoff, Task terminality is the
  descendant eligibility gate.
- `all` adds every active branch-local spawned/forked descendant, even when it
  does not satisfy the original age, status, or Session-type filters.
- Neither policy follows remote relationships.
- For one compatibility release, `dryRun: false` without `descendantPolicy`
  executes `none` and returns `deprecatedDefaultApplied: true` plus an
  actionable warning. The next contract version requires the field.
- `dryRun: true` without a policy returns all three candidate outcomes.
- Dry-run and execution call the same planning code. Execution re-reads and
  reauthorizes current state; it may report intervening state/authority changes,
  but may not use different selection semantics through a separate code path.

The preview must report, for each policy:

- directly matched roots;
- unique implied descendants;
- descendants newer than an age cutoff;
- descendants included/excluded by age and nonterminal-Task eligibility;
- descendants with an active Session status;
- overlapping-tree deduplication;
- unauthorized cascade units;
- the exact total that execution would attempt.

Return complete counts, not complete Session arrays. Each category includes at
most `sampleLimit` representative rows plus `sampleTruncated: true` when more
exist. Counts remain exact for large Branches.

When `eligible` or `all` is selected, each direct root plus its selected local
closure is an all-or-nothing authorization unit. Independent authorized units
may succeed. Merge overlapping authorized closures before writing, with
direct-root intent taking precedence over implied-child intent.

### Generic patch and MCP update

After migrating all internal archive callers:

- reject `archived` or `archived_reason` in generic `patch`/`update` service
  payloads;
- reject those fields for `id === null` and array/multi-patch regardless of
  whether Branch RBAC is enabled;
- remove `archived` from `agor_sessions_update` input and description;
- return an actionable error naming the dedicated archive/unarchive operation.

The archive engine writes through repository archive-state methods, so it does
not need a hidden generic-patch bypass.

### Dedicated UI

The remote default must not be invisible in the UI:

- the UI first requests a dedicated dry-run and shows local, remote, Branch
  unit, nonterminal-work, and authorization counts before confirmation;
- the archive confirmation exposes an “also archive sessions created in other
  branches” choice, checked by default;
- the UI passes `includeChildren` and `includeRemoteChildren` explicitly instead
  of relying on transport defaults;
- success copy reports local and remote counts;
- a partial result produces a warning that identifies skipped Branch units
  without exposing inaccessible Session metadata;
- unarchive exposes the symmetric option and reports Sessions that remain
  archived because of an independent reason or archived ancestor.

If a session-tier caller owns the root but the local preview fails because a
shared-session descendant has another owner, preserve local all-or-nothing
semantics. Explain the denial and offer an explicit “Archive only my Session”
retry using `includeChildren: false`; never silently drop local descendants.

## State and restoration rules

### Required invariant

```text
archived = false  => archived_reason IS NULL
archived = true   => archived_reason is a trusted known reason
```

All unarchive writes pass `null`, never `undefined`. Repository archive-state
methods enforce the invariant. Generic repository update normalization also
clears a reason whenever it persists `archived: false`, so an internal caller
cannot create a stale active reason accidentally.

Until historical data is repaired separately, planning and restoration ignore
`archived_reason` on an active row.

### Trusted initiating reasons

The engine accepts an internal-only reason:

```ts
type ArchiveInitiator = 'manual' | 'btw_completed' | 'branch_archived';
```

- Explicit roots receive the initiating reason.
- Newly archived implied descendants receive `parent_archived`.
- A Session already archived for another reason keeps its existing state and
  reason.
- Public inputs cannot assign `parent_archived`, `branch_archived`, or
  `btw_completed` directly.

### Cause-aware unarchive

Use one post-transition activation predicate for local and remote restoration:

```text
mayActivate(session, role) =
  canonical Branch is active
  AND (
    role is explicit root
    OR no direct incoming parent source remains archived
  )
```

Incoming parent sources include `parent_session_id`,
`forked_from_session_id`, and the source of every incoming `remote_create`
relationship. Evaluate their state after applying the planned transition, not
from the pre-operation snapshot alone.

An explicit Session restore overrides archived local or remote parent edges and
therefore deliberately re-roots that Session. It never overrides an archived
canonical Branch: dedicated unarchive and prompt auto-unarchive return
`409 Conflict` with guidance to restore the Branch first. An implied descendant
remains archived whenever any incoming parent source remains archived. Return
it in `remainingArchived` with the applicable blocker.

Only rows carrying a parent-caused reason are candidates for implied
restoration. Independently archived targets always remain archived. If a remote
unit is unauthorized, leave it unchanged and report the already-visible target
Session ID or an opaque count without its Branch metadata.

The production fork and spawn paths currently create one incoming genealogy
edge per Session, so the ordinary local case is a chain. A Session may also have
incoming remote provenance, so the activation predicate must consider both
edge classes from the first remote-cascade release. Traversal remains cycle-safe
because the persistence schema does not enforce an acyclic shape for legacy,
imported, or direct repository data.

## Architecture

### Policy owner

Evolve `SessionsService.setArchiveStateForTree` into two private phases:

1. `planArchiveTransition(...)`
   - open a bounded tenant database read scope owned by the engine;
   - resolve and validate explicit roots;
   - load branch-local graphs once per involved Branch;
   - traverse outgoing remote relationships only when enabled;
   - classify direct/implied targets and warnings;
   - compute cause-aware final state;
   - partition targets into authorization/mutation units.
2. `applyArchiveTransitionPlan(...)`
   - open one fresh tenant write scope/transaction per unit;
   - revalidate that unit inside the same scope;
   - apply its final target states atomically;
   - enqueue exactly one post-commit event per changed Session;
   - return changed, skipped, and still-archived results.

Dry-run stops after planning and authorization. Both dry-run and execution use
the same immutable plan representation within one request. A later execution
request creates a fresh plan and revalidates authority; previews are
point-in-time evidence, not a lock on future state.

### Repository work

Add or generalize repository operations that:

- load all Sessions for a specified Branch without service pagination;
- batch-load outgoing `remote_create` relationships for a bounded frontier;
- batch-identify candidate Sessions with nonterminal Tasks for Bulk eligibility
  and preview warnings;
- update distinct archive state/reason targets atomically;
- return only rows whose persisted state actually changed;
- accept a transaction-scoped repository/database supplied by the service.

For multiple roots in one Branch, build adjacency once and use an indexed queue
plus visited set. Do not call the current whole-Branch scan once per root.

No new archive coordinator, table, relationship type, background worker, or
repair job is introduced.

### Change map

| Area                                                    | Expected owner/files                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Archive policy, planner, authorization, results         | `apps/agor-daemon/src/services/sessions.ts`, `apps/agor-daemon/src/declarations.ts`          |
| Complete Branch reads and archive-state writes          | `packages/core/src/db/repositories/sessions.ts`                                              |
| Batched outgoing remote traversal                       | `packages/core/src/db/repositories/session-relationships.ts`                                 |
| REST request/response options and prompt auto-unarchive | `apps/agor-daemon/src/register-routes.ts`                                                    |
| Dedicated, update, and bulk MCP contracts               | `apps/agor-daemon/src/mcp/tools/sessions.ts`                                                 |
| BTW completion caller                                   | `apps/agor-daemon/src/services/tasks.ts`                                                     |
| Branch archive/unarchive caller                         | `apps/agor-daemon/src/services/branches.ts`                                                  |
| UI options and result messaging                         | `apps/agor-ui/src/hooks/useSessionActions.ts` and archive callers in Session/Branch surfaces |
| Internal MCP contract note                              | `context/concepts/mcp-session-tools.md`                                                      |
| Public behavior and generated API material              | gateway/session guide content and OpenAPI output                                             |

### Events

The engine, not Feathers automatic patch emission, owns archive transition
events. Enqueue them after a successful unit commit. Emit one `sessions.patched`
event for each changed row and none for unchanged, skipped, dry-run, or rolled
back rows.

## Entry-point migration

| Caller                       | Engine request                                                               |
| ---------------------------- | ---------------------------------------------------------------------------- |
| REST/MCP dedicated archive   | `manual`, local `true` by default, remote `true` by default                  |
| REST/MCP dedicated unarchive | Cause-aware inverse using the same requested edge policy                     |
| MCP bulk `none`              | Each selected row is an explicit `manual` root; no descendants               |
| MCP bulk `eligible`          | `manual` roots plus age/task-eligible local descendants; no remote traversal |
| MCP bulk `all`               | `manual` roots plus local descendants; no remote traversal                   |
| BTW natural completion       | `btw_completed`, local descendants on, remote off                            |
| Prompt auto-unarchive        | Reject archived Branch; otherwise direct root only                           |
| Branch archive               | Every active canonical Branch Session is an explicit `branch_archived` root  |
| Branch unarchive             | Restore only canonical rows archived for `branch_archived`                   |

Only after these callers have migrated should generic archive patching be
rejected.

## Branch archive delivery split

### First: contained correctness fix

In `BranchesService.archive/unarchive`:

1. Replace the `$limit: 1000` service read with a complete tenant-scoped
   repository read or explicit full pagination.
2. Archive only `archived: false` Sessions.
3. Unarchive only `archived: true AND archived_reason = 'branch_archived'`
   Sessions.
4. Clear the reason with `null` on restoration.
5. Batch the Session state update and emit only changed rows.

This prevents omissions and preserves independent manual, parent, and BTW
archive intent.

### Deferred branch-lifecycle hardening

Coupling Branch metadata, terminal retirement, environment/filesystem work, and
Session state into one recoverable workflow is distinct from Session cascade
policy. Filesystem effects cannot join a database transaction. Keep that
redesign outside #2661 unless implementing the contained fix exposes a new
failure that cannot be made retry-safe locally.

## Permission model

Authorization never substitutes for tenant isolation.

| Context                                        | Required behavior                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Internal call with no provider                 | Supplies trusted tenant identity; engine opens its own scope/unit; no user Branch RBAC preflight                             |
| Provider call, Branch RBAC disabled            | Authenticated tenant boundary and write gate apply; Branch permission preflight is intentionally skipped                     |
| Provider call, RBAC enabled, `prompt` or `all` | May archive any Session in each authorized unit                                                                              |
| Provider call, RBAC enabled, `session`         | May archive only Sessions created by that user; a shared-session child owned by another user rejects the complete local unit |
| Service account                                | Preserve the existing deliberate service-account bypass inside the tenant boundary                                           |
| Remote unit                                    | Resolve current access against that unit's canonical Branch; source-Branch access does not confer target-Branch access       |

`includeChildren: false` remains the explicit way for a session-tier caller to
archive only an owned root when a complete local cascade is unauthorized.

An unauthorized remote unit is skipped and reported; it does not roll back the
already authorized local unit. Do not continue relationship traversal through
an unauthorized unit or reveal its additional Session metadata.

## Tenant classification

Multi-tenancy is implicated because this work changes persisted lifecycle data,
HTTP/MCP service boundaries, relationship traversal, authorization, and
realtime side effects.

| Resource or effect             | Classification                   | Owner and enforcement                                                                           |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Sessions and archive state     | Tenant-owned                     | Trusted tenant context plus scoped `SessionRepository`; PostgreSQL RLS remains defense in depth |
| Branches and permission policy | Tenant-owned                     | Scoped `BranchRepository`; current Branch access resolved per mutation unit                     |
| Session relationships          | Tenant-owned                     | Scoped `SessionRelationshipRepository`; both endpoints must resolve inside the same tenant      |
| Tasks used for bulk warnings   | Derived through Session          | Scoped Task query using the selected tenant-owned Session IDs                                   |
| Realtime archive events        | Derived through Session          | Existing tenant-aware realtime publisher after commit                                           |
| Board archive exemption        | Tenant-owned container lifecycle | Existing Board authorization; no Session mutation side effect                                   |

Trusted tenant identity comes from authenticated request/MCP context or the
ambient internal operation context, never IDs in the archive payload. The
default-on database proxy now raises `MissingTenantDatabaseScopeError` in every
deployment mode when code touches `this.db` outside a scope.

The archive engine, rather than each caller, owns its database scopes:

1. Planning opens one bounded tenant read scope.
2. Applying opens one fresh tenant write unit/transaction per local or remote
   mutation unit.
3. Each unit constructs `SessionRepository`, `BranchRepository`, Task, and
   relationship repositories from that scoped database.
4. Transport and internal callers supply trusted tenant identity and pass the
   write gate, but do not hold an open database transaction across the engine
   call.

Adjust the current MCP wrapper accordingly. BTW completion runs after Task
commit and must open a new engine-owned unit. Branch archive must pass trusted
tenant identity rather than call the Session service with missing parameters.
Add a guarded-SQLite regression for each migrated REST, MCP, BTW, prompt, Bulk,
and Branch caller so missing scope fails in the same mode used by local
development, not only under PostgreSQL/RLS.

Required negative proof: tenant B cannot discover, count, archive, unarchive, or
receive events for tenant A's Session by reusing a Session, Branch, or
relationship ID. A cross-tenant/malformed relationship must fail closed rather
than expanding the traversal.

## Acceptance scenarios

1. **Local dedicated archive:** a nested spawn/fork chain is archived by
   default; `includeChildren: false` changes only the root.
2. **Remote default and opt-out:** dedicated archive includes outgoing remote
   units by default; `includeRemoteChildren: false` leaves them active and
   reports no attempted remote units.
3. **Remote preview and bounds:** dry-run reports bounded local/remote counts;
   execution uses the same frontier semantics; depth, Branch-unit, or target
   overflow fails before any mutation.
4. **Remote authorization and disclosure:** the local unit commits, an
   authorized remote Branch commits, and an unauthorized remote unit remains
   unchanged, exposes no Branch metadata, and is not traversed further.
5. **Unified restoration:** a local or remote implied child remains archived
   when any direct incoming local/fork/remote parent source remains archived
   after the transition.
6. **Explicit root and Branch rule:** an explicit root may re-root beneath an
   archived parent, but no Session is restored inside an archived canonical
   Branch; prompt and dedicated unarchive return `409 Conflict` there.
7. **Bulk compatibility:** omission executes legacy `none` with a deprecation
   warning during the compatibility release; dry-run without a policy previews
   exact `none`, `eligible`, and `all` counts with bounded samples.
8. **Bulk eligibility:** `eligible` includes old-enough local descendants with
   no nonterminal Task even when they do not match root-only type/status filters;
   `all` also identifies newer and active/nonterminal descendants.
9. **Generic bypass closure:** provider archive patch, update-tool archive, and
   archive-bearing multi-patch are rejected with dedicated-operation guidance.
10. **Trusted reasons:** manual, BTW, and Branch roots receive their initiating
    reasons; implied children receive `parent_archived`; independent reasons are
    preserved.
11. **Chain restoration:** for `R -> A -> B`, where `A` remains manually
    archived, unarchiving `R` does not revive `B` and reports the archived
    ancestor blocker.
12. **Prompt restoration:** in an active Branch, prompting an archived child
    restores only that child and it remains re-rooted until its parent is
    restored; prompting inside an archived Branch is rejected.
13. **Session-tier fallback:** a shared-session descendant can reject the local
    unit; the UI explains why and offers an explicit root-only retry.
14. **Branch completeness:** archive/unarchive handles more than 1,000 Sessions
    and never revives a previously manual or BTW archive.
15. **Reason invariant:** every path persists `archived_reason = NULL` for an
    active row; a stale legacy reason cannot block or cause restoration.
16. **Events:** each changed Session emits once after commit; skipped, unchanged,
    dry-run, and rolled-back rows emit nothing.
17. **Scope guard:** every migrated caller passes a guarded-SQLite test proving
    that the engine, not the caller, opens the required database scope.
18. **Tenant isolation:** same-tenant behavior succeeds and a cross-tenant ID or
    relationship attempt fails without observable target information.
19. **Board exemption:** Board archive does not mutate Branch or Session archive
    state.

## Implementation sequence

### Slice 1 — Branch correctness and invariant

- Add complete Branch Session selection.
- Add active/reason predicates.
- Persist `null` on restoration and normalize the active-row invariant.
- Add greater-than-1,000 and reason-preservation regression tests.

This slice is independently shippable and reduces existing data-integrity risk.

### Slice 2 — Canonical local planner

- Extract the current dedicated local cascade into plan/apply phases.
- Add multi-root deduplication, trusted root reasons, cause-aware unarchive, and
  actual-change event emission.
- Migrate dedicated local archive, BTW cleanup, prompt restoration, and Branch
  Session transitions.

### Slice 3 — Bulk policy

- Add `none | eligible | all` and the one-release legacy-default warning.
- Make dry-run preview all three policies when omitted using exact counts and
  bounded samples.
- Reuse the canonical planner for preview and execution.
- Add warning classifications, authorization-unit results, and count parity.

### Slice 4 — Close generic paths and document exemptions

- Remove archive from `agor_sessions_update`.
- Reject archive-bearing generic and multi-patch.
- Update gateway/archive documentation and generated API material.
- Update `context/concepts/mcp-session-tools.md` so agent guidance no longer
  presents generic Session update as an archive path.
- Document prompt and Board exemptions.

Do not close the generic paths before all trusted internal callers have moved.

### Slice 5 — Dedicated remote units (separate PR)

- Add the dedicated dry-run, exact frontier, named bounds, and cycle defense.
- Add `includeRemoteChildren` to REST/MCP/UI contracts and documentation.
- Add independent per-Branch authorization, opaque skipped-unit reporting, and
  unified local/remote restoration coverage.
- Include only sanitized aggregate orphan evidence in the PR rationale; never
  include Session titles, prompts, IDs, Branch names, or other local data.

Remote lifecycle semantics intentionally ship in their own PR. Debate over
reversing the historical provenance-only contract must not block Slices 1–4.

## Verification

Add or extend focused tests in:

- `apps/agor-daemon/src/services/sessions.archive.test.ts`
- `apps/agor-daemon/src/mcp/tools/sessions.test.ts`
- `apps/agor-daemon/src/services/branches.test.ts`
- `apps/agor-daemon/src/services/boards.test.ts`
- `apps/agor-daemon/src/register-hooks.test.ts`
- `apps/agor-ui/src/hooks/useSessionActions.test.tsx`
- the Session/Branch archive confirmation component tests covering preview,
  explicit opt-outs, partial remote results, and session-tier root-only retry
- PostgreSQL/RLS repository or service integration coverage at the changed
  tenant boundary

Run focused checks first:

```bash
pnpm --filter @agor/daemon test -- \
  src/services/sessions.archive.test.ts \
  src/mcp/tools/sessions.test.ts \
  src/services/branches.test.ts \
  src/services/boards.test.ts \
  src/register-hooks.test.ts

pnpm --filter @agor/daemon typecheck
pnpm check:multitenancy-boundaries
pnpm exec biome check <touched-files>
git diff --check
```

Run the new repository/service cases against both SQLite and PostgreSQL/RLS.
Then perform real-boundary QA in an isolated Agor environment:

1. Build a nested local tree and remote-created targets across two Branches.
2. Exercise dedicated defaults, both opt-outs, and a denied remote Branch.
3. Compare bulk dry-run `none`/`eligible`/`all` previews with actual execution.
4. Verify age/nonterminal eligibility and bounded preview samples.
5. Verify session-tier local denial offers and executes the root-only retry.
6. Verify prompt auto-unarchive restores only the prompted Session in an active
   Branch and rejects an archived Branch.
7. Verify Branch archive completeness and independent-reason preservation.
8. Confirm API, MCP, UI active listings, and realtime updates converge.
9. Confirm archived running work remains running, preserving archive-versus-Stop
   semantics.

## Rollout and compatibility

- This is an API behavior change. Update MCP descriptions, REST/OpenAPI output,
  and the gateway guide in the same delivery.
- For one compatibility release, Bulk omission retains root-only behavior but
  returns a prominent deprecation warning. Documentation and examples pass
  `descendantPolicy` explicitly. The next contract version rejects omission.
- Removing archive from generic update is intentionally breaking. Error text
  must name the dedicated replacement.
- Dedicated archive expands to remote children by default. Surface the opt-out
  in both UI and MCP before enabling the new default.
- No historical repair runs automatically. If production inventory shows a
  material need, design a separate dry-run-first reconciliation tool.
- Retry is safe: already-correct rows remain unchanged and emit no duplicate
  transition events.

## Deferred hardening

- A coordinated Branch metadata/filesystem/terminal recovery workflow.
- Create-time inheritance or stronger serialization for a child created after
  archive discovery but before commit. The engine guarantees its discovered
  transaction snapshot; closing the creation race changes Session creation and
  needs separate acceptance criteria.
- A durable multi-cause archive table. Recompute from current ancestry and
  Branch state first; add schema only if relationship removal or production
  overlap proves the scalar reason insufficient.
- A historical orphan-repair operation.
- Realtime coalescing or a bounded Branch-level invalidation event for very
  large transitions. This plan preserves the current one-event-per-changed-row
  contract and records fanout as a scalability concern rather than changing the
  client protocol inside #2661.

## Delivery map

```text
Plan review
  -> Slice 1: Branch completeness + reason invariant
  -> Slice 2: canonical local archive planner
  -> Slice 3: explicit bulk policy
  -> Slice 4: reject generic bypasses + docs
  -> focused SQLite/PostgreSQL proof
  -> fresh review and remediation
  -> real-boundary QA
  -> Slice 5 (separate PR): bounded dedicated remote units
  -> remote-policy review + focused proof + QA
  -> final issue evidence
```

## Implementation notes

The engine lives in `apps/agor-daemon/src/services/sessions.ts`
(`planArchiveTransition`, `expandRemoteArchiveUnits`, `planArchiveTargets`,
`planRestoreTargets`, `applyArchiveTransitionPlan`, `buildArchiveResult`) with
the public entry points `archive`, `unarchive`, `archiveBtwSession`,
`restorePromptedSession`, `archiveBranchSessions`, `unarchiveBranchSessions`,
`previewBulkArchive`, and `bulkArchive`. Repository support is
`SessionRepository.findByIds` / `updateArchiveStateForTargets` (no-op aware,
invariant-enforcing), `SessionRelationshipRepository.findRemoteChildrenForSources`
/ `findRemoteParentsForTargets`, and
`TaskRepository.findSessionIdsWithNonterminalTasks`. Proof is in
`apps/agor-daemon/src/services/sessions.archive.test.ts`.

Where the code refines the text above:

- **Scopes.** The engine opens one tenant read scope for planning and applies
  each unit through the repository's native transaction. When a transport hook
  already holds a tenant transaction (PostgreSQL), that write nests as a
  savepoint instead of opening a second unit; the invariant kept is "one
  atomic write per unit, revalidated against current row state".
- **Skipped units.** A skipped remote unit is reported once per relationship
  target (`rootSessionId`), never with the denied branch's ID. A skipped bulk
  unit is reported once per selected root.
- **Dry-run overflow.** A remote bound overflow on a dry-run drops the remote
  units from the reported plan and sets `limitExceeded`; execution fails with
  `400 Bad Request` before any mutation.
- **Prompt restore.** `restorePromptedSession` reuses the explicit-root rule,
  so prompting into an archived branch surfaces the same `409 Conflict` as
  dedicated unarchive.
- **UI.** Both archive confirmations request a dry-run first and render the
  local/remote/running/skipped counts with the remote checkbox
  (`SessionArchiveConfirmContent`). A session-tier denial offers the explicit
  root-only retry. There is no UI unarchive surface today; REST and MCP expose
  the symmetric option.
- **Bulk preview payload.** Every category returns an exact `count` plus at
  most `sampleLimit` rows; the legacy omission path returns
  `deprecatedDefaultApplied: true` and a warning.
- **Delivery shape.** Slices 1–5 shipped in one pull request at the
  requester's instruction rather than the two PRs sketched above. The remote
  policy is isolated in `expandRemoteArchiveUnits`, `planRestoreTargets`'
  incoming-remote-source check, and the `includeRemoteChildren` option, so it
  can be reviewed, split, or defaulted off independently of the local engine.
- **Not in this delivery.** PostgreSQL/RLS integration coverage at the changed
  boundary, the OpenAPI snapshot refresh (the archive routes' request bodies are
  not modeled in the checked-in document), and the one-time maintenance script
  `scripts/archive-old-gateway-sessions.ts`, which still writes through the
  repository and bypasses the engine.
