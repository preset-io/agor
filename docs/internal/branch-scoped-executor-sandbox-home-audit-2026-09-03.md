# Branch-scoped executor sandbox-home audit (2026-09-03)

## Incident and exact error path

The Branch modal's **Files** tab calls `client.service('file').findAll` with a
client-supplied `branch_id`. The daemon's `/file` hooks authenticate the
request, load the tenant-scoped Branch, and enforce Branch view access.
`FileService.find` then enforces normalized filesystem `read` access and
launches the bounded `branch.files.browse` executor command through
`requestExecutor`.

On a local executor deployment, the call chain is:

1. `requestExecutor`
2. `requestExecutorLocal`
3. `sandboxLocalExecutorCommand`
4. `prepareLocalSandboxSources`
5. `buildSandboxWrap` / `resolveBwrapArgs`
6. bubblewrap, then the executor's `branch.files.browse` handler

`execution.unix_user_mode: sandbox` is resolved at startup to
`sandbox.enabled: true`, `sandbox.home_mode: per_user`, and
`sandbox.fail_if_unavailable: true`. Step 4 therefore requires the authoritative
per-execution-user home source in `payload.params.sandboxHomeStore`. It creates
and validates the home-side credential-authority layout and pins the actor's
persistent `tmp` directory before bubblewrap uses either path. This common
preflight applies to every local branch-scoped command with a `cwd`, even when
the bounded command itself does not consume a provider credential.

Before this fix, `/file` passed the Branch path and RBAC file-access projection
but did not pass `sandboxHomeStore`. `prepareLocalSandboxSources` deliberately
threw:

> sandbox home_mode=per_user requires an owner home store before credential authority preparation

`requestExecutorLocal` converted that into `EXECUTOR_SPAWN_ERROR` with the
prefix `Executor sandbox setup failed:`. `FileService.find` added `Failed to
browse files:`, and `FilesTab` rendered the resulting service error. The
executor and bubblewrap never started. This is a fail-closed programming error,
not evidence that an operator omitted a required home setting.

The Session file autocomplete path (`/files` -> `branch.files.list`) had the
same missing handoff. File preview/download uses `/file/:path` ->
`branch.files.read` and failed for the same reason.

## Root cause and ownership choice

The per-user home resolver existed, and prompt, terminal, environment, upload,
and artifact paths had acquired variants of the required handoff over several
changes. The two file services were older request-mode call sites and were not
updated when request-mode branch commands joined the common credential/tmp
preflight. Recent related fixes were PR #2637 (upload materialization) and PR
#2653 (artifact publish/validate/land); both intentionally called for a later
audit of sibling executor call sites.

File browse, read, and autocomplete are stateless actions by the authenticated
request actor. Their sandbox home must therefore be the **caller**'s home, not
the Branch primary owner's or the referenced Session owner's home. Selecting an
owner home would unnecessarily expose or mutate another principal's cache,
temporary files, and credential-authority leaves. The Branch and optional base
Repo are resolved in the same trusted tenant database scope, and RBAC still
controls whether the Branch mount is read-only or writable.

## Configuration conclusions

No new `config.yaml` key and no `users.filesystem_home` value is required for
this incident.

- `execution.unix_user_mode: sandbox` intentionally forces a fail-closed,
  per-user local sandbox. Operators cannot weaken it with `home_mode: shared`.
- When `users.filesystem_home` is empty, Agor derives the canonical store:
  - filesystem tenancy off:
    `<data_home>/tenants/<tenant-id>/homes/<user-id>`;
  - filesystem tenancy on:
    `<tenants_base_folder>/<tenant-id>/homes/<user-id>`.
- `users.filesystem_home` is an admin-only migration override for an existing
  absolute home outside every protected Agor data root. Setting it does not fix
  an omitted `sandboxHomeStore` payload.
- `paths.data_home` / `AGOR_DATA_HOME` and
  `multi_tenancy.tenants_base_folder` choose storage roots; they do not opt a
  user into the feature. The daemon account must be able to create the
  canonical home and its authority/tmp leaves.
- `execution.unix_user_mode: delegated` requires an external executor template
  and a per-user `unix_username` execution-home key. The external substrate,
  not local bubblewrap, resolves and enforces its homes.

Do not change a shared production deployment to `simple`, disable the sandbox,
or enable a shared home to hide this error. Those changes trade away the
filesystem boundary and may expose daemon or cross-user state. `simple` is a
reasonable development-only choice only for a trusted single-user machine.

## Supported-mode matrix

| Deployment shape                                            | Home authority for branch file reads                                               | Before this change                                 | After this change                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Local `simple`, no standalone sandbox                       | Daemon home; no OS file isolation                                                  | Worked                                             | Unchanged                                                                            |
| Local standalone sandbox with `home_mode: shared`           | Masked shared daemon home                                                          | Worked; not suitable as a multi-user home boundary | Unchanged; tenant worktree/base-Repo mounts are explicit                             |
| Local `sandbox` / per-user, SQLite                          | Authenticated caller; canonical store or `filesystem_home`                         | Failed before spawn                                | Supported, fail closed                                                               |
| Local `sandbox` / per-user, PostgreSQL shared-filesystem HA | Authenticated caller under RLS tenant scope; tenant filesystem root                | Failed before spawn                                | Supported when the HA storage/locking profile passes startup validation              |
| PostgreSQL HA with `execution_topology: external`           | External substrate binds trusted tenant/user identity to durable storage           | Did not enter local credential-authority preflight | Unchanged; requires request-response protocol/origin and reviewed launcher isolation |
| `delegated` external executor                               | `{tenant_id}`, `{user_id}`, `{branch_fs_access}`, and legacy `{unix_user}` handoff | Did not enter local preflight                      | Unchanged                                                                            |

The documented Cloud topology is PostgreSQL HA with an external/delegated
executor substrate. That explains why the local per-user error is not expected
there. The incident report did not include the live Cloud or production
configuration, so this is a configuration-path comparison, not a claim based
on inspecting either deployment.

## Branch-scoped executor inventory

All local executor payloads with a Branch `cwd` share the per-user sandbox
preflight. The owner semantics differ, so the spawn utility must not guess an
identity from a Branch ID or client payload.

| Operation family                            | Commands / entry points                                | Required identity and status at this audit                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch modal browse, preview, download      | `branch.files.browse`, `branch.files.read` via `/file` | **Fixed here:** authenticated caller, read projection, full tenant/home/base-Repo mounts                                                                                                                                                                 |
| Prompt file autocomplete                    | `branch.files.list` via `/files`                       | **Fixed here:** authenticated caller, read projection, full mounts                                                                                                                                                                                       |
| Agent/provider prompt launch                | `prompt` in `register-services`                        | Already supplies full mounts. Historical execution-home Sessions use their immutable owner; branch-home Sessions use the prompt actor                                                                                                                    |
| Web terminal                                | `terminals`                                            | Already supplies the caller's full mounts and process environment. Live authorization revalidation remains a documented gap                                                                                                                              |
| Managed environment lifecycle/logs          | `environment.lifecycle`, `environment.logs`            | Already supplies the resolved execution actor and full mounts                                                                                                                                                                                            |
| Artifact/runtime helpers                    | `branch.artifact.publish`, `.validate`, `.land`        | Already supplies the authenticated actor's full mounts (PR #2653)                                                                                                                                                                                        |
| Opaque upload materialization               | `branch.upload.materialize`                            | Supplies the canonical Session execution user and owner home (PR #2637). Tenant-root/base-Repo completeness should be aligned with the shared helper                                                                                                     |
| Branch Knowledge materialization/read       | `branch.knowledge.write`, `.read`                      | **Known residual:** has `cwd` but omits the owner-home mount; fails with the same preflight error in local per-user mode                                                                                                                                 |
| `.agor.yml` import/export                   | `branch.agor-yml.import`, `.export`                    | **Known residual:** has `cwd` but omits the owner-home mount; fails similarly                                                                                                                                                                            |
| Gateway branch-file upload to Slack         | `branch.gateway.slack-file-upload`                     | **Known residual:** has `cwd` but omits the owner-home mount; fails similarly. Opaque staged uploads that do not read a Branch are a different path                                                                                                      |
| Git clean during archive                    | `git.branch.clean`                                     | **Known residual:** has `cwd` but omits the owner-home mount; local per-user dispatch fails. Branch add/remove/status, Repo inspect/delete, and startup Git reconciliation have no Branch `cwd` and intentionally stay outside this sandbox prerequisite |
| Credential import/logout/inspection helpers | Claude/Codex auth-file commands                        | No Branch `cwd`; they use an explicit credential-home authority and have different HA routing/locking requirements                                                                                                                                       |

Static inventory found 9 affected command IDs across six branch-command
families. This change closes 3 IDs in the two user-facing file services; four
residual families account for the other 6 IDs. No
eligible production daemon logs or customer session records were available in
the investigation workspace, so there is no defensible runtime occurrence or
unique-user count. The exact text was present only in this investigation's own
prompt transcript and was excluded from incident quantification.

## Implementation and forward plan

### Implemented now (smallest safe incident fix)

`resolveBranchExecutorSandboxMounts` centralizes the mount family for bounded
file services. While the trusted tenant DB scope is active it:

1. resolves the tenant worktrees root;
2. resolves a linked worktree's base Repo path (clone storage omits it);
3. resolves the authenticated caller's user row and canonical/override home in
   per-user mode;
4. fails before executor dispatch if that tenant user no longer exists; and
5. returns no local mounts when the filesystem sandbox is disabled (including
   supported delegated execution).

The service leaves the database scope before waiting for the executor response.
The user lookup selects only the nonsecret user ID and filesystem-home fields;
no credential material is decrypted, logged, copied, or returned.

### Follow-up

1. Move Knowledge, `.agor.yml`, gateway Branch upload, Git clean, and upload
   mount completeness onto the same helper one family at a time. Each must first
   state whether its authority is the caller, Session execution user, or a
   narrowly scoped system identity, and add a cross-user negative test.
2. Replace the structurally optional `cwd` + mount fields with a typed
   server-only `BranchExecutorContext` so a local branch command cannot compile
   without an explicit execution user, tenant root, and file-access projection.
   Keep the final missing-home check in `prepareLocalSandboxSources` as defense
   in depth; never auto-derive identity in the spawn utility.
3. Add a low-cardinality metric for sandbox setup failures by command/error code
   (no paths, user IDs, or credential data) so operators can quantify affected
   families without searching transcripts.
4. Add live bubblewrap smoke coverage for browse/read/list in the managed
   sandbox-per-user profile and external request-response coverage for the same
   commands.

## Operator remediation, rollout, and rollback

1. Confirm the effective mode locally with `pnpm agor config --yaml` (do not
   share the full output; it may contain deployment details). If the effective
   mode is `sandbox`, retain it.
2. Run `pnpm agor doctor` on each local executor host and verify Linux,
   bubblewrap 0.12.0+ with functional `--bind-fd`, user namespaces, and access
   to the configured tenant/data volumes.
3. Upgrade to a release containing this fix and restart/drain daemons according
   to the deployment's normal rolling policy. No schema migration or data move
   is needed. In HA, keep all replicas on one version during the shortest
   practical rollout window.
4. Verify browse, preview/download, and `@` file autocomplete as two different
   users with read-only versus read/write Branch grants. A user with filesystem
   `none` must remain denied.
5. If home creation fails after the fix, check ownership and mount availability
   for the canonical tenant home root, or validate an intentionally migrated
   `users.filesystem_home`. Do not point an override into `data_home`, another
   tenant, `/`, or a sibling user's home.

Rollback is an application rollback only: stop/drain the new daemons and return
to the prior release. The change adds no migration and creates only the same
lazy per-user authority/tmp directories already created by normal prompts and
terminals. Those directories may be retained. Rolling back restores the Files
failure; it must not be paired with a sandbox downgrade as a production
workaround.
