# MCP spawn: misleading session-sharing authority failure

## Finding

**A genuine MCP database-scope bug, not a missing sharing grant.** The tenant
database guard correctly fails closed, but a permitted operation reaches it
without a database scope. The child-identity catch replaces the guard error
with `Cannot resolve session-sharing authority for this branch.`

Confirmed against the current investigation session on 2026-09-07. The original
report did not identify its failing session/task, so these observations prove
the reproduced instance, not the provenance of every occurrence of this message.

- Investigated checkout/base: `fe48ecfd516384ee008df6787efac90cb243b0ed`.
- Final main check: `64e17cfa5a29206a4130e6ee68fc991c39860840`; its only
  additional commit was unrelated MCP catalog PR #2638, with no spawn-path changes.
- Live `/health`: version `0.26.1`, build `95e5c26d4`, built
  `2026-09-05T23:14:04.484Z`; database healthy, `branchRbac: true`, realtime
  `required: false, ready: true`. This is not evidence of an HA outage.
- Main is newer, but has the same failing MCP calls and child-authority code.
  Merely updating to the main SHA above does **not** fix this error.

## Exact origin and failure chain

`apps/agor-daemon/src/services/sessions.ts`,
`SessionsService.resolveChildIdentity()`, line 822 at the investigated SHA:

```ts
} catch (error) {
  if (error instanceof Forbidden) throw error;
  throw new Forbidden('Cannot resolve session-sharing authority for this branch.');
}
```

The outer phrase “Agor blocked the spawn with:” is not a repository error
literal. The inner error is a Feathers `Forbidden` (403).

1. MCP authenticates a user/session token or user API key, resolves trusted
   tenant identity, and builds `baseServiceParams` with `provider: 'mcp'`, user,
   authentication state, and tenant (`mcp/server.ts`). The session-aware token
   path validates its session rather than accepting an arbitrary client actor.
2. `tenantScopedToolProxy` enters **tenant identity**, deliberately not a
   request-long database transaction (`mcp/tenant-scope.ts`).
3. `agor_sessions_spawn` directly calls the registered service's custom
   `.spawn()`. The same omission exists in `agor_sessions_prompt` modes
   `subsession`, `fork`, and `btw`. These custom methods are not Feathers
   transport methods and do not acquire the standard request scope.
4. The standard `sessions.get` and nested `branches.get` have their own scoped
   hooks. Returning from either restores the caller's identity-only context.
5. `resolveChildIdentity` calls its **unbound** `branchRepo`'s
   `resolveSessionPromptAuthority`. Its first normalized branch-policy read
   touches the guarded daemon database outside a database unit.
6. `MissingTenantDatabaseScopeError('daemon database')` is thrown, with message
   `Missing tenant database scope for daemon database access`. The catch above
   hides it. No child or initial task is written at this point.

The real-service SQLite regression captures the rejected policy-repository
promise and checks the underlying exception type as well as the outer message.
It does not merely mock the expected text. Registered Feathers reads succeed;
the direct authority read fails exactly as in the live reproduction.

The same catch could also mask an unavailable database, a branch deleted during
admission, missing board template/override policy, an invalid inherited branch
without a board, or a runtime/core API mismatch. Ordinary policy denials are
already `Forbidden` and retain their specific, actionable messages. This generic
message alone is not evidence that session sharing should be enabled.

## Scoped live records and reproduction

Only the investigation session, its task, branch, board policy, and workspace
sharing preference were inspected through authenticated services. No database
dump, secret values, other tenants, or broad transcript search was used.

| Record                                         | Observed state                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Session `01a07934-0ed7-7335-b680-b8e0196a2d02` | `sdk_home_scope: branch`; creator is the authenticated caller                                                                              |
| Task `01a07934-1376-7338-9a52-3452c078f552`    | Running; `created_by` is that same caller                                                                                                  |
| Branch `01a07933-5cf0-7178-8bcb-864180bc7899`  | Ready, unarchived, `sdk_home: per_branch`; caller is immutable primary owner; `permission_binding: inherit`                                |
| Board `9833703b-b9e6-4b7b-b0eb-70f783fba715`   | Caller is primary owner; branch-template and board-access revisions both 5                                                                 |
| Effective branch template                      | Shared; `allow_shared_session_prompts: true`; unmatched Others = Collaborator/write; named group = Viewer/read; named user = Manager/write |
| Board access                                   | Others = Viewer; named group and user = Manager; independent of branch roles                                                               |
| Workspace preference                           | `session_sharing_enabled: true`                                                                                                            |

The legacy branch `others_can: none` and `others_fs_access: none` are inert
compatibility fields, **not** the effective Others grant. No fallback repair is
needed. Primary ownership wins for this caller even if a group grants less.

Live transport comparison, same parent and caller:

1. `agor_sessions_spawn` with a harmless acknowledgment prompt, callbacks off,
   and `mcpServerIds: []` returned the exact reported error.
2. Authenticated `POST /sessions/<same-parent>/spawn` with a harmless prompt,
   callbacks off, and `mcpServerIds: []` returned **201** and an **idle** child,
   `01a07936-e5aa-72f5-9ab9-9ce38d24c8ce`. Its branch, caller attribution, and
   branch-home scope were correct. No prompt was submitted to that child.
3. That exact idle smoke child was archived afterward. No live permissions,
   user records, configuration, runtime stamp, or credentials were changed.

## Expected authorization semantics

- `spawn` and `fork` always keep the selected parent's branch and immutable
  SDK-home scope. A `branchId` is not a spawn destination override.
- Same-user children still require `sessions.prompt_own` in the branch. They
  do **not** require either sharing switch. Ownership of a _session_ does not
  override loss of access to its branch.
- A foreign caller needs Collaborator/Manager branch capability, a branch-home
  parent, the tenant sharing preference, and the effective package opt-in.
  Execution-home parents are never shareable. Superadmin status, board
  management, or branch management alone is not foreign-session prompt authority.
- Branch access uses primary owner, then a direct-user entry (shadowing groups),
  otherwise additive active groups, otherwise unmatched same-tenant Others.
  A matched Viewer or No-access entry does not fall through to a stronger Others
  grant. The current repository checks user existence and non-archived groups;
  it does not introduce a new persisted user-active-state mechanism.
- `inherit` resolves the board's complete branch template, including sharing.
  `override` uses the complete branch-owned package, not a merge. Board access
  governs the canvas, not standalone branch prompting. A caller can have branch
  work rights without board visibility. Turning off the workspace sharing gate
  also clears that tenant's narrower opt-ins; re-enabling is not restoration.
- The child is attributed to the actual authorized caller and receives that
  caller's **current** execution-home key. Selected environment names and MCP
  IDs may carry forward, but execution resolves credentials/visibility for the
  caller. It must not borrow the parent creator's private home. Delegated mode
  additionally requires the caller's execution-home key; failures there have
  different messages. Internal provider-less calls preserve parent attribution
  and rely on their trusted producer's authorization; the fix does not convert
  MCP calls into such internal calls.

### Cross-branch orchestration

`agor_sessions_prompt(mode: 'subsession')` can select a parent in another branch.
Authority is checked against **that target parent and branch**; owning the
orchestrator's branch supplies no additional grant. The child stays in the target
branch. The regression covers an allowed cross-branch call and denial after the
target sharing gate is revoked.

`agor_sessions_create(branchId: ...)` is a different path: standard scoped
`sessions.create`, target-branch `sessions.create` capability, caller-owned fresh
session, and target branch's new-session SDK-home admission. Same-branch creates
can add genealogy metadata; cross-branch creates use a separate `remote_create`
relationship. An explicit genealogy parent in another branch is rejected.
Provenance does not share native conversation state or confer prompt rights.
Explicit/enabled callback targets require their own prompt-authority check.
This independent-create path does not execute the failing `resolveChildIdentity`.

### UI, task launch, realtime, and HA

The UI uses `/sessions/:id/spawn` or `/fork`, then prompts the returned child
(`useSessionActions.ts`). The custom route registrar supplies a tenant database
unit and write gate around admission. That is why the REST smoke succeeds.

MCP submits the initial prompt **after** child admission. Prompt admission,
task execution identity, and launch/heartbeat branch authorization remain
separate checks. PostgreSQL runtime checks revalidate current policy and the
original filesystem access floor; Redis is not required to enforce those checks.
Realtime audiences use tenant-qualified normalized visibility, with HA cache
invalidation for policy changes. They are not used by this direct authority
read and cannot explain the reproduced failure. This change adds no raw socket
broadcast or ambient prompt authority and does not change callback routing.

## History and patch

- [#2555](https://github.com/preset-io/agor/pull/2555) introduced the current
  normalized sharing resolver and this catch-all.
- [#2612](https://github.com/preset-io/agor/pull/2612) fixed the same missing-scope
  class for other MCP custom methods. Its audit recognized `*Service.method()`
  locals; these inline cast-and-call spawn/fork expressions escaped that scan.
- [#2662](https://github.com/preset-io/agor/pull/2662), `8d43790c36`, armed the
  database-scope guard in **every** mode, exposing this latent omission in
  static/SQLite too. Required-from-auth guarded deployments were already at risk.
- [#2587](https://github.com/preset-io/agor/pull/2587) added branch SDK-home
  plumbing; [#2589](https://github.com/preset-io/agor/pull/2589) added runtime
  authority revalidation. Neither supplies the missing MCP admission scope.
- [#2669](https://github.com/preset-io/agor/pull/2669) made RBAC always on after
  the inspected deployment. It does not repair these MCP calls.

The production change is three `runWithMcpTenantDatabaseWrite` wrappers in
`mcp/tools/sessions.ts`: spawn, fork/btw, and subsession. They retain the original
external caller params, use the existing trusted tenant and write gate, and end
before prompt/executor orchestration. The audit now tracks spawn/fork mutations
and also recognizes inline service casts. No policy, schema, token, home,
credential, or execution-mode semantics are relaxed.

## Operator remedy (separate from the code fix)

**This reproduced instance needs no config/data repair.** Keep both the tenant
guard and existing policies intact. Until a reviewed fixed release is available,
use the authenticated UI/REST fork/spawn path for permitted operations. Do not
relabel the MCP request as internal, grant broad Manager access, mutate
`sdk_home_scope`, populate legacy grants, or disable scope enforcement.

After normal review/release, update the daemon to a build containing this patch.
Verify `/health.buildSha`, not just `version: 0.26.1`; on HA, drain/replace all
serving replicas and verify each so old replicas cannot intermittently reject
MCP admission. No migration or permission reset accompanies this patch. A UI
refresh alone cannot replace the server's custom-method implementation.

For a different instance with genuine policy corruption, first identify the
tenant-scoped branch binding, referenced board template/override, and immutable
primary owner. Restore only the intended complete package using the authorized
revision-checked permission service or a reviewed offline recovery. Do not guess
an owner or reconstruct authority from the tombstoned legacy fields. If a
historical normalized-policy migration is involved, follow its offline cutover
runbook rather than running old and new daemons against the same schema.

## Validation and rollback

- Live MCP failure versus successful idle REST admission, as above.
- Guarded real-service regression: exact underlying error, owner spawn/fork/btw/
  subsession without sharing, caller-attributed inherited Others sharing without
  board visibility, cross-branch target policy, denied workspace/override/Viewer/
  superadmin/execution-home/error cases, and missing/conflicting tenant identity.
- Focused daemon suite: **153 passed**; focused core capability/tenant suite:
  **45 passed**.
- Disposable PostgreSQL (application role verified `NOSUPERUSER`, `NOBYPASSRLS`):
  **2 passed**, proving permitted shared spawn, foreign-tenant parent-ID replay
  rejection, write-freeze rejection for spawn/fork, and success after release.
  The test container was removed; no live tenant database was used.
- Source-condition daemon no-emit typecheck and explicit regression-test
  typecheck; full Biome/frontend-plugin lint; multitenancy, realtime, daemon
  filesystem, and short-ID boundary checks. No managed dev environment was
  started: the transport comparison and isolated SQLite/PostgreSQL tests exercise
  the affected boundary without launching an agent or changing a deployment.
  The root `pnpm typecheck` command unexpectedly scheduled upstream builds through
  Turbo; it was stopped and replaced with the direct no-emit checks.

Rollback is a **code-only revert** of this patch; it restores the MCP failure
without changing stored policy or tenant isolation. Keep the guarded database
and current migrations. This is not a reason to roll back #2662 or the normalized
policy migration; rolling back those older schema cutovers requires their full
pre-migration database backup. No merge or deployment was performed here.
