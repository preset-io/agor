# Always-on branch RBAC and pre-1.0 configuration audit

**Date:** 2026-09-04  
**Decision status:** staged deprecation recommended; do not remove the global
switch in one step  
**Implemented with this audit:** auth-resolved multi-tenant deployments now
fail startup unless the resolved effective configuration enables branch RBAC;
non-boolean `execution.branch_rbac` values are rejected

## Executive decision

Agor should converge on branch RBAC being always enabled before 1.0. The
disabled mode is not a simpler equivalent policy. It is an intra-workspace
authorization bypass spanning board/branch discovery, Sessions, Tasks,
messages, schedules, files, terminals, MCP, realtime delivery, and mutations.
It also exposes a stale UI that edits legacy permission fields which the
repositories now reject on update.

The global switch should **not** be deleted immediately. Existing databases
already contain normalized policies, but operators who have run with RBAC off
have not necessarily reviewed them. Enabling them can hide private resources,
remove board/branch mutation rights, prevent foreign-Session prompts, and
reduce filesystem access. Silently widening those policies to reproduce the
old open mode would defeat the security objective. The safe path is:

1. hard-require RBAC now for `multi_tenancy.mode: required_from_auth` (included
   in this change);
2. add an operator preflight and usage telemetry, then default static installs
   to RBAC on while retaining an explicit, loudly deprecated escape hatch;
3. reject explicit false after a documented migration window; and
4. remove the false-mode code and UI only after supported configurations can no
   longer select it.

This is an application-authorization decision, not an executor-containment
claim. Always-on RBAC does not make `unix_user_mode: simple` safe against an
agent or web terminal running as the daemon account.

## Evidence boundary and method

This audit followed the runtime value from raw YAML and environment projection
through daemon registration, repositories, SQL predicates, custom REST routes,
MCP, realtime publication, and UI feature discovery. It also inspected both
dialect schemas/migrations, checked-in environment variants, docs, and tests.
Search at this revision found:

- 95 non-test source references across 24 files;
- 46 test files mentioning the flag or derived mode;
- 88 explicit false-mode and 94 explicit true-mode test fixtures; and
- five development variants deliberately exercising false mode (`sqlite`,
  standalone `postgres`, `sandbox`, and both demo descendants), while `rich`,
  `sandbox-peruser`, and HA exercise true mode.

Counts are an inventory aid, not an API contract. The code and schema remain
the authority.

## Current implementation inventory

| Surface             | Current behavior                                                                                                                                                                                                                              | Consequence of removing the switch                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Config type/default | `AgorExecutionSettings.branch_rbac?: boolean`; absent means false in static/simple mode.                                                                                                                                                      | Change default, type, config display, and validation deliberately rather than relying on truthiness.           |
| Environment         | `AGOR_RBAC_ENABLED=true` can force true; no value can force false. Named `unix_user_mode: sandbox` also forces true after environment projection.                                                                                             | Retire the environment key after the YAML bridge; preserve rolling-deploy semantics meanwhile.                 |
| Derived mode        | `resolveExecutionSecurityMode().appRbacEnabled` and `isBranchRbacEnabled()` fan the switch into services. The latter catches config errors and returns false.                                                                                 | Remove the catch-and-disable behavior at the final hard-set stage.                                             |
| Startup/health      | Daemon registration receives the derived boolean. `/health` and About expose `features.branchRbac`.                                                                                                                                           | During transition expose a stable authorization mode/deprecation status; later remove the feature negotiation. |
| Policy persistence  | Board access policies and board branch templates are created transactionally for every Board. Branch overrides are also initialized transactionally; normal Branch service creation uses `inherit`. This happens even when the flag is false. | No new policy schema is needed, but policy completeness must be preflighted.                                   |
| Schema              | SQLite and PostgreSQL both have normalized board/branch policy and entry tables, fixed role/filesystem enums, one-user-or-group checks, unique principal entries, revisions, and target checks.                                               | Keep dialect parity tests and repository contract tests.                                                       |
| PostgreSQL tenancy  | Policy rows carry `tenant_id`, composite tenant FKs bind policies/resources/principals, and forced RLS covers all normalized policy tables.                                                                                                   | Always-on RBAC complements rather than replaces RLS.                                                           |
| List SQL            | Board, Branch, Session, Task/message references, schedules, artifacts, comments, and related list paths compose set-based normalized-policy `EXISTS` predicates.                                                                              | Query work becomes unconditional; benchmark the current normalized schema before the static default flip.      |
| Point authorization | Hooks/repositories resolve effective Board/Branch access and cache bounded request/realtime decisions.                                                                                                                                        | Simplify after the compatibility window, not before.                                                           |
| REST/service hooks  | Conditional hooks scope reads and authorize creates, patches, deletes, prompt-flow writes, board objects/cards/comments, files, and schedules.                                                                                                | Removing false mode closes many independent bypasses; it is not just a UI feature change.                      |
| Custom REST routes  | Prompt, upload/download, stop/permission, OpenCode configuration, and terminal routes contain conditional checks or projections.                                                                                                              | Audit by route inventory when deleting branches; service hooks alone are insufficient.                         |
| MCP                 | Most MCP tools inherit Feathers hooks. Direct message and teammate-discovery queries explicitly condition SQL scoping. MCP egress revalidation is conditional too.                                                                            | Remove direct-query exceptions and retain non-enumerating denials.                                             |
| Realtime            | Tenant channels exist in both modes. RBAC mode additionally resolves current Board/Branch/Session audiences, handles deletion tombstones, caches point decisions, invalidates on policy/group changes, and reauthorizes relayed HA events.    | Keep tenant scoping and current-policy reauthorization; only remove `allAuthenticated` false-mode audiences.   |
| UI                  | Health feature discovery controls policy fetches, permission tabs, Board/Branch/Card edit gates, board attachment checks, and legacy permission controls.                                                                                     | Delete legacy controls only when old daemons/false mode are unsupported.                                       |
| Seed/examples       | Board creation inputs still seed normalized defaults from legacy-looking fields. Demo fixtures can create low-level private overrides and explicit grants.                                                                                    | Validate fixture audiences under always-on behavior rather than assuming their false-mode visibility.          |
| Tests               | Large dual-mode matrix, especially realtime and update gating.                                                                                                                                                                                | Preserve security cases; delete only tests whose sole purpose is the unsupported open mode.                    |
| Deployments         | Default Compose/static variants are false; rich/sandbox/HA are true. PostgreSQL overlay defaults `AGOR_RBAC_ENABLED=true`; HA gets it from named sandbox mode.                                                                                | Flip examples in stages so a cheap SQLite path remains, but no longer an authorization-bypass path.            |

The conditional enforcement map is wider than the central Branch service:

- `register-hooks.ts` conditions Board, Branch, Session, Task, message,
  schedule, card, Board object/comment, artifact/reference, Session-MCP link,
  and file-service read/write hooks;
- `register-routes.ts` conditions prompt admission and settlement, task/stop
  authority, uploads and downloads, filesystem access, terminal/session token
  paths, and permission decisions;
- `register-services.ts` passes the mode into Branches, terminals, gateway,
  realtime, and other service constructors;
- direct MCP message search and teammate discovery add their own SQL scoping,
  while most other MCP operations inherit the Feathers hooks;
- MCP egress, OpenCode configuration scoping, permission delivery, runtime Task
  authority, primary-teammate candidates, branch removal publication, and
  realtime audience computation each branch independently.

Final removal therefore needs a fresh reference inventory plus route/service
security tests. Deleting the config type or the central hook spread alone would
leave inconsistent authorization.

### Migration history

SQLite migration `0098_board_branch_capability_policies.sql` and PostgreSQL
migration `0095_board_branch_capability_policies.sql` were explicitly designed
as an offline, big-bang remodel. They:

- assign immutable primary owners or fail closed when attribution is
  impossible;
- convert old shared Board visibility to Board `Others: Viewer`;
- convert old Board branch defaults, reducing legacy `prompt` to
  `Collaborator` rather than inferring foreign-Session authority;
- materialize overrides where Board inheritance would lose a directly
  representable owner/group grant;
- retain valid creators/managers as named entries;
- clear old owner/group-grant tables and tombstone legacy JSON/columns to
  private/none, so an old binary sees less authority rather than stale grants;
  and
- in PostgreSQL, restore forced RLS after the cross-tenant migration and add
  tenant-bound FKs and policies.

SQLite `0102_shared_session_prompting.sql` and PostgreSQL `0099` then place the
shared-prompt opt-in in the complete Branch permission configuration and remove
the older personal/rule model. There is no dual-read or dual-write bridge to
resurrect.

## False-mode versus true-mode behavior

Authentication, global roles, trusted service-account paths, and tenant
database scoping remain in both modes. The important difference is what an
ordinary authenticated member may do inside the tenant.

| Operation                    | RBAC false                                                                                             | RBAC true                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List/get Boards and Branches | Broad tenant-visible inventory.                                                                        | SQL-scoped to explicit Board and Branch policy. Board visibility is independent of Branch visibility.                                                       |
| Board/card/object mutation   | Any Member can generally mutate visible tenant resources.                                              | Requires Board Editor/Manager capability; policy management requires Manager.                                                                               |
| Branch metadata/environment  | General writes are broadly member-accessible; a few destructive paths retain older owner/admin checks. | Requires Branch Manager for management/environment operations.                                                                                              |
| Sessions                     | Any Member can create on a Branch and broadly access Sessions.                                         | Collaborator/Manager can create and prompt their own Sessions; Manager controls lifecycle, but does not automatically gain another user's prompt authority. |
| Foreign-Session prompt       | Broad member admission.                                                                                | Requires both workspace and Branch shared-prompt opt-ins, a shareable branch-home Session, and Collaborator/Manager access.                                 |
| Tasks/messages/schedules     | Tenant-wide list/read paths and much broader mutation/prompt-flow access.                              | Resolved through the Session's Branch policy; destructive foreign lifecycle actions require Manager.                                                        |
| Files/uploads                | Member role is the main boundary; another user's Branch/Session content can be reachable.              | Requires current Branch view/write and Session authority as appropriate.                                                                                    |
| Terminal/executor mount      | A Member admitted by the global terminal flag receives the legacy write projection.                    | Requires Collaborator/Manager plus non-`none` filesystem access; mount is `none`, read-only, or read-write.                                                 |
| MCP direct reads/egress      | Branch visibility/revocation checks are bypassed in several direct paths.                              | Direct SQL and egress are scoped/revalidated.                                                                                                               |
| Realtime                     | Resource events are broadly tenant-published (stream ownership still provides some narrowing).         | Current authorized audiences are calculated; revocations invalidate local and HA caches.                                                                    |
| UI editing                   | General Board/Branch/Card editing is presented as open. Permission package is hidden.                  | Controls reflect effective access and fail closed while policy/access cannot be loaded.                                                                     |

### The leftover false-mode UI is not a viable product mode

The Board modal submits `access_mode`, `default_others_can`, and
`default_others_fs_access` when RBAC is disabled. `BoardRepository.update()`
now rejects all three and directs callers to the permission policy service.
The corresponding stored legacy values were tombstoned by migration. As a
result, the disabled UI can show defaults that are not the authoritative
policy and can make an otherwise ordinary Board save fail. The Branch modal
likewise hides the real policy and falls back to inert `others_can` fields for
some affordances. This is compatibility residue, not a coherent alternative
authorization model.

Policy endpoints themselves are always registered and authorization-aware:
Board viewers can read the Board package, Branch viewers can read the Branch
package, and only policy Managers/admin exceptions can replace it. Hiding those
endpoints in the false-mode UI does not remove the stored policy.

## Visibility and policy sufficiency

The normalized model is sufficient for the launch requirements represented in
the repository:

- immutable primary owner;
- private or shared Board policy;
- separate Board Viewer/Editor/Manager roles;
- one complete Branch template per Board and `inherit | override` binding;
- Branch Viewer/Collaborator/Manager roles plus `none | read | write` filesystem
  access;
- direct user entries shadow groups; otherwise active group grants combine and
  filesystem access takes the maximum;
- `Others` is used only when no direct user or active-group entry matches; and
- shared Session prompting is explicit at workspace and Branch-package levels,
  remains unavailable to execution-home Sessions, and uses the actual caller's
  identity, credentials, MCP visibility, environment, and filesystem mount.

To emulate the old open mode exactly an operator would need broadly shared
Boards and `Others: Manager/write` Branch policies plus shared prompting. That
would recreate the unsafe behavior and must not be an automatic migration.
The normal post-remodel shared default (`Board Others: Viewer`, Branch Others:
`Collaborator/read`) intentionally preserves discovery and own-Session work,
not tenant-wide management or foreign-Session prompting.

Known policy-model follow-ups are not blockers for always-on authorization but
should be explicit: user lifecycle currently treats an existing tenant user as
an available principal, while group eligibility additionally excludes archived
groups. If suspended/deactivated users become a product state, that state must
participate in direct entries and `Others`, not just authentication issuance.

## Tenant isolation and Cloud posture

`required_from_auth`, PostgreSQL tenant columns/composite FKs, transaction-local
tenant context, forced RLS, path partitioning, and tenant-specific realtime
channels prevent cross-tenant access. They do **not** establish which member of
one tenant may access which resource. With branch RBAC false, tenant membership
effectively becomes authorization for many Boards, Branches, conversations,
files, and execution surfaces.

That distinction makes false mode unacceptable for Agor Cloud even though it
is not, by itself, a cross-tenant RLS escape. The bounded code change in this
audit validates the resolved effective configuration and fails startup when
`required_from_auth` does not have RBAC true. Validation is deliberately after
environment projection so `AGOR_RBAC_ENABLED=true` and named sandbox mode both
satisfy it. The checked-in HA profile already passes because named sandbox
forces RBAC.

Filesystem/process isolation remains separate:

- `simple` has no Agor filesystem containment and remains suitable only for a
  trusted local user/team;
- named `sandbox` is fail-closed, per-user, and uses RBAC-derived mounts; and
- `delegated` requires the external substrate to enforce the passed tenant,
  user, Branch filesystem access, credentials, storage, and cancellation.

Before Cloud launch, separately decide whether `required_from_auth` must also
require named sandbox or a reviewed delegated profile. The current
`filesystem_isolation_enabled: true` requirement only partitions Agor-managed
paths; it does not turn a daemon-user `simple` executor into an isolation
boundary.

## Query and realtime cost

The current normalized list predicates are set-based SQL, not application-level
per-row permission calls. They use indexed policy/config/entry rows and
`EXISTS` subqueries for owner, direct-user shadowing, active groups, and
unmatched `Others`. Session paging repeats the predicate in count and data
queries; reference resources use correlated visibility helpers. Point checks
have request/realtime caches and policy/group writes evict them, including
across the Redis HA relay.

There is a useful older performance investigation in
`branch-rbac-query-performance-2026-08-20.md`: it proved that a duplicated
Board predicate could cross PostgreSQL's JIT threshold and that factoring it
reduced a controlled median from 415.8 ms to 31.9 ms. It also showed that
multi-second Feathers timings occurred on non-RBAC services, so production
request duration cannot be attributed to RBAC alone. However, that document's
fixture/predicate inventory predates the current normalized capability tables;
its absolute timings are not a launch benchmark for this schema.

Required gates before the static default flip:

1. benchmark current normalized Board/Branch/Session/Task/message list and
   point shapes on PostgreSQL with forced RLS, representative direct/group/
   `Others` distributions, and JIT both on and off;
2. run SQLite functional and latency parity (SQLite has no RLS but shares the
   normalized authorization predicates);
3. measure Feathers p50/p95/p99, DB time, pool wait, result counts/bytes, and
   realtime authorization cache hit/miss rates; and
4. retain negative cross-tenant tests plus revocation-after-cache and HA relay
   reauthorization tests.

Do not add a second authorization cache or denormalized permission columns
without plans proving the indexed predicates are insufficient. Correctness and
immediate revocation outrank speculative optimization.

## Compatibility and rollout hazards

### What can change for an existing false-mode install

- Private Board/Branch packages may make resources owner-only.
- A direct `none` entry shadows a permissive group or `Others` rule.
- Group changes may narrow or expand access that false mode previously ignored.
- Board viewers cannot edit the canvas unless promoted to Editor/Manager.
- Collaborators cannot manage the Branch or other people's Session lifecycle.
- Foreign-Session prompting stops unless the complete sharing contract is
  deliberately enabled.
- Filesystem access may become read-only or hidden; terminals require both the
  role and filesystem dimensions.
- Low-level imports/fixtures that created unaligned Branches with the repository
  default may have private overrides.

The schema normally guarantees a policy row for each current resource, but the
preflight should still identify orphan/missing/inconsistent packages, missing
owners/principals, inherited Branches with no Board package, direct denies,
private resources, and policies whose effective audience differs from the
legacy open audience.

### Rolling deploy and rollback

Changing the default and deleting the key simultaneously is unsafe. An older
daemon reading a config with the key removed defaults to false, so a mixed or
rolled-back fleet could disagree on authorization and realtime audiences.
Conversely, a newer daemon must not silently treat explicit false as true
without a startup warning/error explaining the changed security model.

Use a cohort restart for the default flip. During the bridge, all replicas must
receive the same resolved authorization mode, and health/readiness should make
that mode observable. No database dual-write is needed, but a rollback must
restore the same explicit setting on every replica.

## Staged branch-RBAC plan

| Stage                      | Release action                                                                                                                                                                                                                         | Compatibility behavior                                                                                              | Exit criteria                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0 — now                    | Require true in `required_from_auth`; reject non-boolean YAML. Add this audit.                                                                                                                                                         | Static false mode remains unchanged. Named sandbox and `AGOR_RBAC_ENABLED=true` still imply true.                   | Cloud/HA startup tests pass; docs state the invariant.                                                                  |
| 1 — observe/preflight      | Add `agor local rbac audit` (read-only by default), low-cardinality mode telemetry, and startup warnings for false. Fix false UI to be read-only/deprecated rather than writing tombstoned fields.                                     | Explicit false still boots only in static standalone.                                                               | Inventory shows policy completeness; current-schema PG/SQLite performance gates pass; no unsupported audience patterns. |
| 2 — default on             | Set the static default to true; init/examples/demo/Compose use true. Accept explicit false only behind a named legacy escape hatch with a removal version and loud health warning. Forbid false in HA as well as `required_from_auth`. | Existing explicit false configs have one migration window; omission becomes secure.                                 | Release notes and policy migration workflow shipped; fleet-wide config convergence proven.                              |
| 3 — reject false           | Keep `branch_rbac: true` loadable as a no-op. Reject false and retire `AGOR_RBAC_ENABLED` with actionable startup guidance. Health advertises one authorization contract, not a feature.                                               | Old configs fail closed instead of silently changing behavior.                                                      | No supported deployment exercises false; rollback floor documented.                                                     |
| 4 — delete code before 1.0 | Remove conditional hooks/routes/queries, false realtime audiences, legacy UI/fields, derived boolean plumbing, and false-only tests. Keep normalized policies and negative coverage.                                                   | Option may remain in the retired-key allowlist for one final read-only compatibility period if upgrades require it. | Source inventory has no runtime false path; both dialects and HA pass security/performance suites.                      |

The preflight should support machine-readable output, tenant-by-tenant summaries,
and a non-mutating comparison. Any optional repair must require explicit
operator acknowledgement and update normalized policies through repository
transactions. It must never auto-grant Manager/write or shared prompting.

## Broader pre-1.0 configuration audit

Classification means:

- **Keep** — represents a real deployment/security/product choice.
- **Deprecate** — retain a documented bridge, then remove or reject.
- **Hard-set** — one behavior is already or should become invariant; a no-op
  key may remain briefly for compatibility.
- **Investigate** — plausible simplification, but evidence or migration safety
  is not yet sufficient.

### Recommended changes

| Option/family                                                                                                                                               | Classification                                         | Evidence and recommendation                                                                                                                                                                                                               | Blast radius / prerequisite                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execution.branch_rbac`                                                                                                                                     | **Deprecate**, then **hard-set true**                  | False is a broad intra-tenant authorization bypass and incoherent legacy UX. Hard-required immediately for auth-resolved tenancy; stage static installs.                                                                                  | Very high: 95 non-test references, 46 test files, API/MCP/realtime/UI/deploy behavior, existing policy audiences. Needs preflight, benchmark, and rolling-deploy bridge. |
| `AGOR_RBAC_ENABLED`                                                                                                                                         | **Deprecate** with the switch                          | True-only environment override becomes redundant. Do not remove before mixed-version rollback is unsupported.                                                                                                                             | Compose, entrypoint logging, docs, operators/IaC.                                                                                                                        |
| `identity.password_policy`                                                                                                                                  | **Hard-set**, then deprecate the key                   | The type accepts only `secure`, raw validation rejects every other value, and default/health always resolve secure. Keep `secure` as a no-op for one compatibility release, then retire it while retaining the versioned policy contract. | Low runtime risk; config/docs/init and clients reading health requirements. Do not remove password requirement metadata.                                                 |
| Retired `daemon.allowAnonymous/requireAuth`, `defaults.*`, `display.*`, `execution.managed_envs_minimum_role`, `branches.others_*`, onboarding pending keys | **Hard-set already; deprecate parser bridge**          | Runtime strips/ignores these and setup warns. Continue accepting only the known old spellings through the announced upgrade floor; then reject/remove.                                                                                    | Old hand-written YAML and automation. Unknown-key fail-closed policy means removal must be release-noted.                                                                |
| `mcp_catalog.*` retired section                                                                                                                             | **Hard-set already; deprecate parser bridge**          | Catalog is checked-in `curated.yaml`; all accepted keys are ignored. Retain loadability for upgrades, then remove at the compatibility boundary.                                                                                          | Any older config containing the block; no runtime catalog behavior.                                                                                                      |
| `daemon.cors_origins`, `daemon.cors_allow_sandpack`                                                                                                         | **Deprecate**                                          | `security.cors.*` is canonical; resolver already warns and defines precedence. Remove aliases after config telemetry/migration tooling.                                                                                                   | Public ingress and artifact origins; a mistaken removal can lock out the UI. Keep `CORS_ORIGIN` until container/IaC users migrate.                                       |
| `onboarding.frameworkRepoUrl`                                                                                                                               | **Deprecate**                                          | One resolver falls back to the renamed `teammates.framework_repo_url`.                                                                                                                                                                    | Low code cost, but old bootstrap configs. Warn before removal.                                                                                                           |
| `execution.daemon_writes_user_message`                                                                                                                      | **Investigate**, likely hard-set true                  | False is explicitly a racy emergency kill switch to the legacy executor writer; only one runtime branch remains. Remove after production soak proves daemon insertion/idempotency and the rollback window closes.                         | Prompt transcript integrity and executor compatibility.                                                                                                                  |
| `daemon.mcpToolSearch`                                                                                                                                      | **Investigate**                                        | Default true and false preserves clients that require a complete `tools/list`. Client capability/version telemetry is needed before hard-setting search.                                                                                  | MCP client compatibility and tool discovery; potentially high support blast radius.                                                                                      |
| `.agor.yml` `full` variant alias                                                                                                                            | **Deprecate; keep bridge**                             | Already documented as alias to `rich`. Existing Branch records can name it, and repo-authored files are not globally migratable.                                                                                                          | Branch environment re-render/start; remove only after references and repository templates migrate.                                                                       |
| `sandbox.include.branch`                                                                                                                                    | **Investigate**                                        | Documented “effectively always true,” but false can still alter read-only visibility in standalone/shared-home combinations. RBAC filesystem projection now supplies the real access dimension.                                           | Executor cwd, git behavior, and possible read-only legacy use. Prove no supported combination relies on false before hard-setting.                                       |
| Inline `external_launch.dev_shared_secret` and `service_credential`                                                                                         | **Deprecate for production profiles; keep dev bridge** | Environment/JWKS/public-key alternatives already exist and avoid secrets in checked-in YAML.                                                                                                                                              | External login availability and existing Compose/dev launcher. Add secret-source diagnostics before rejection in hardened modes.                                         |

### Keep: real choices or safety valves

| Option/family                                                                                                              | Why keep                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution.unix_user_mode` (`simple`, `sandbox`, or `delegated`)                                                           | Three materially different execution substrates. Keep `simple` for trusted local use; do not market it as multi-user containment.                                          |
| `execution.sandbox.enabled` plus named sandbox mode                                                                        | Standalone tunable sandbox and named fail-closed/per-user sandbox are not equivalent today. Investigate a clearer profile/policy split, but do not collapse them by alias. |
| `sandbox.protect_secrets`, `isolate_branches`, `home_mode`, `sdk_home_mode`, `fail_if_unavailable`, extra allow/deny paths | Affect filesystem visibility, SDK continuity, portability, and failure behavior. Named sandbox already hard-sets its critical subset.                                      |
| `allow_web_terminal`                                                                                                       | Necessary operator kill switch for a high-risk shell surface; HA topology also constrains it. Investigate a safer Cloud/simple default, not removal.                       |
| `allow_superadmin` and bootstrap list                                                                                      | Explicitly controls an exceptional recovery/admin bypass. Keep opt-in and continue excluding automatic foreign-Session prompt authority.                                   |
| Session/MCP token lifetimes and use counts                                                                                 | Security/operability trade-offs with real clients. Keep validation and bounded defaults.                                                                                   |
| Heartbeat, SDK watchdog, dispatch/response timeouts                                                                        | Runtime containment, reconciliation, remote-executor and operational tuning. These are rollback and incident controls, not cosmetic flags.                                 |
| `executor_command_template`, executor storage assertions, and nonzero-may-have-dispatched                                  | Define delegated execution and ambiguity/reconciliation guarantees.                                                                                                        |
| `managed_envs_execution_mode` (`hybrid` or `webhook-only`)                                                                 | Real trust boundary: repository-authored shell versus external webhooks. HA correctly requires webhook-only.                                                               |
| Branch storage mode/depth/borrowing controls                                                                               | Worktree and clone have different disk, portability, and security properties; auth-resolved tenancy requires clone-only.                                                   |
| `multi_tenancy.mode`, resolver, filesystem layout, static tenant                                                           | Separate local and hosted architectures. `filesystem_isolation_enabled` is not redundant with RLS.                                                                         |
| `deployment.mode`, HA support profile/topology/storage/affinity and Redis timeouts                                         | Explicit topology acknowledgement prevents partially supported HA from being inferred. The single-value support profile still has safety value.                            |
| `mcpEnabled`                                                                                                               | Operators may need to remove the MCP attack surface entirely.                                                                                                              |
| External identity authority/local-auth/admin-linking controls                                                              | Define who owns user lifecycle and roles and what assertions can do; high-value security boundaries.                                                                       |
| CSP/CORS canonical policy, Git config extras/override                                                                      | Required deployment escape hatches. Hardened modes should continue rejecting unsafe combinations rather than deleting the controls.                                        |
| Analytics, community telemetry, StatsD, APM                                                                                | Optional/privacy/cost-sensitive integrations; separate master switches are justified.                                                                                      |
| Database dialect, pool, SQLite WAL, uploads/storage/retention                                                              | Real topology and capacity decisions.                                                                                                                                      |
| `agentic_tools.claude_subscription_oauth`                                                                                  | Explicit provider/legal/release authorization; default-off has purpose.                                                                                                    |

### High-priority investigations before Cloud launch

1. **Execution containment admission:** decide whether
   `required_from_auth + simple` must fail startup, or define the exact reviewed
   delegated/sandbox profiles Cloud accepts. Branch RBAC alone is insufficient.
2. **Terminal default:** consider default-off for auth-resolved or `simple`
   deployments while keeping the kill switch.
3. **Tool-search compatibility:** measure old MCP clients before hard-setting
   `mcpToolSearch`.
4. **Prompt writer kill switch:** establish the executor compatibility floor
   and incident history before removing `daemon_writes_user_message=false`.
5. **Secret sources:** warn/reject inline external-launch secrets in hardened
   profiles after a redacted diagnostic/migration path exists.

## Focused implementation in this change

This audit intentionally does **not** flip the static default or remove false
UI/backend paths. It makes two bounded, fail-closed changes:

1. raw config rejects a non-boolean `execution.branch_rbac` instead of allowing
   a quoted/invalid scalar to act like disabled; and
2. resolved startup validation rejects `required_from_auth` unless branch RBAC
   is true, while accepting the named sandbox implication and environment
   override.

It also updates the multi-tenant guide with the complete RBAC and clone-only
requirements. No schema, data, API response, or policy mutation is introduced.
Static single-tenant behavior is unchanged. The HA checked-in configuration is
already compliant.

## Removal checklist

Do not merge the final switch-removal stage until all are true:

- [ ] Supported installs can run a non-mutating policy/audience preflight.
- [ ] Current normalized PostgreSQL/SQLite query benchmarks meet launch SLOs.
- [ ] Explicit-false configuration usage and required legacy audience patterns
      are understood.
- [ ] Static default-on and explicit-false deprecation shipped for at least one
      documented migration window.
- [ ] Mixed-version/rollback floor no longer permits a daemon that defaults to
      false when the key is absent.
- [ ] HA and auth-resolved deployment validation reject false.
- [ ] REST, MCP, direct SQL, realtime relay, deletion tombstones, file access,
      terminals, and permission decisions have negative security coverage.
- [ ] False-mode UI is removed together with, not ahead of, backend support.
- [ ] Legacy permission DTO fields are removed or explicitly retained only as
      inert read compatibility, with API versioning documented.
- [ ] Release notes state that the change can reduce access and never
      auto-widens policy.
