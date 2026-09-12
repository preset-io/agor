# Branch revisions over local executor workspaces

Status: implemented managed-tool vertical slice; **not approved for native SDK or production rollout**.

## Existing control flow and insertion points

Inspection of revision `72bf01ff8` established these owners:

- `services/sessions.ts` / `prepareSessionForExecutorStart` funnel queued,
  scheduled, gateway and direct prompts into existing Task dispatch and executor
  startup. `services/scheduler.ts` owns scheduled occurrences, not an EC2 host
  scheduler. Task dispatch/heartbeat leases are distinct from branch placement.
- `utils/spawn-executor.ts` owns local process and delegated command-template
  transports. Executor commands own repository/branch filesystem access;
  `check-daemon-filesystem-boundaries.mjs` protects the daemon from becoming a
  filesystem worker. This change keeps filesystem code outside daemon services.
- Branch `storage_mode` selects a worktree or clone. The new backend sits above
  that source abstraction; it does not redefine worktree/clone identity.
- `BranchRepository`, dual Drizzle schemas, tenant database scopes, PostgreSQL
  RLS and the tenant write gate already own branch metadata. Workspace state is
  a nullable private column on that row, not a second branch database. Ordinary
  Branch DTOs do not expose it. Branch deletion and SQL portability include it.
- `branch-sdk-home.ts` and `getBranchHomePath` own sticky branch SDK-home intent
  and immutable Session scope. Claude uses **CLAUDE_CONFIG_DIR**, not the prompt's
  hypothetical CLAUDE_CONFIG_HOME. Codex uses CODEX_HOME and CODEX_SQLITE_HOME.
  Credential overlays and API key resolution remain actor-sensitive.
- Uploads have an existing S3 staging adapter; durable materialization and KB
  file commands run in executors. This change reuses the AWS SDK and managed
  tenant storage segments, and does not move uploads, KB roots or credentials.
- `execution.*` is strictly validated by config-manager. The additive
  `execution.branch_workspace` configuration defaults off.
- No `.tf` files or EC2 worker modules were present. `infra/branch-workspaces`
  is therefore a standalone module requiring existing network, IAM, AMI and
  KMS inputs, rather than an invented environment deployment.

The integration seam is `runWorkspaceTool`: an awaited controller callback
surrounding actual local process execution. Its integration test runs two Node
child processes through real migrated SQLite branch metadata. The executor
package re-exports this boundary for managed adapters. The factory
`createBranchWorkspace` implements scoped rollout. The host selector and
maintenance function are worker-controller APIs, not replacements for Agor's
Task scheduler or external substrate.

## Decision and consistency

Network POSIX filesystems amplify metadata latency for dependency and compiler
workloads. Source visibility occurs at a complete tool boundary instead: each
executor owns a local filesystem throughout the invocation. Network object
writes occur only on materialisation, publication and restore. Ordinary package
registry/API traffic is unaffected; “no network filesystem I/O” does not mean
“no network access.”

Each branch has one SQL-authoritative revision, placement epoch and host lease.
A tool reserves its executor slot and records its base revision in a short SQL
transaction. The replica is refreshed before its path is returned. There is no
revision notification dependency: every begin reads authoritative metadata.
An idle replica applies only changed entries. Removing its local validity
marker precedes application and execution; interrupted application or crashed
execution forces a complete reconstruction. Completed execution restores the
marker using an atomic rename. Running replicas are never refreshed.

Publication uploads compressed, content-addressed file bytes **before** taking
the SQL row lock. The transaction checks the host lease, epoch, invocation
identity and each changed path's base entry/version. It installs the whole
manifest and one new revision atomically. Tombstones prevent delete/recreate
ABA. Renames retain both source deletion and destination creation checks;
replacing a directory checks subsequent descendant mutations. Conflicts reject
all changes and retain base/current/proposed hashes in the receipt. Empty
mutation sets retain the current revision. Retries return the same receipt,
including after an acknowledgement is lost; they never re-run the tool.

PostgreSQL uses row locks and its clock; SQLite uses immediate transactions and
bounded retry of rolled-back SQLITE_BUSY contention. Worker clocks do not
allocate leases. A new owner increments the epoch after expiration. Live
ownership cannot be reassigned. Graceful draining requires an inactive current
checkpoint, then atomically clears ownership and increments the epoch.
Expired tools' uncommitted work is explicitly abandoned. Expired workers can
still consume CPU, but cannot publish authoritative changes.

## Filesystem and durability

Layout follows managed tenant paths:

```
<local_root>/tenants/<tenant>/branches/<branch>/
  base/<manifest-hash>/
  replicas/<executor>/workspace/
  replicas/<executor>/baseline.json
  replicas/<executor>/replica-tree.json
<local_root>/tenants/<tenant>/workspace-caches/<input-hash>/
```

Base directories are immutable local materialisations, produced privately and
renamed only when complete. SQL owns which revision is authoritative; cached
bases may lag and are reconstructed on demand. They must be inaccessible to
SDK children. The controller must mount only the selected replica and injected
resources using the existing sandbox/delegated isolation owner. Directory
separation alone is not a tenant security sandbox.

Default pruning excludes `.git`, dependency trees, build products and known
credential/machine-home paths. Additional exclusions are literal directory/file
basenames. This slice explicitly synchronises the remaining workspace tree;
it does not interpret `.gitignore`. Known auth files, `.env*` and `.npmrc` are
hard-excluded even if a repository tracks them. Inject runtime secrets through
the existing mechanism. Safe relative symlinks, executable modes, renames,
deletions and empty directories are preserved. Absolute/escaping links and
special files fail closed. Files over 128 MiB are rejected before publication.

Reflink is explicit and fails if unsupported; there is no silent hardlink or
shared writable fallback. Copy is an explicit development fallback. The
measured host returns ENOSYS for COPYFILE_FICLONE_FORCE. OverlayFS is not selected
without Linux whiteout/opaque-directory/mount-cleanup validation. The baseline
and incremental-refresh measurements are retained, including failed targets.

S3 objects are immutable and tenant-prefixed, gzip-compressed and SHA-256
verified. Acknowledged revisions already have durable blobs, so recovery does
not lose acknowledged post-checkpoint commits. Checkpoints are immutable
manifests with schema, branch/tenant, revision, epoch, parent, timestamp and
entry metadata; their hash is stored in SQL. Restore validates the checkpoint
and every required latest-revision blob before exposing a base. Interrupted
uploads leave no authoritative revision. A failed checkpoint upload does not
advance the checkpoint pointer. LocalWorkspaceBlobs is a local test adapter,
not an AZ-failure guarantee.

## SDK-home and compatibility boundary

SDK processes can mutate session state between tool invocations, and Codex
SQLite state cannot be safely copied live. Streaming tool-start events in
several integrations are **not blocking hooks**. Wiring synchronization to
those events would violate the protocol. This slice therefore supports managed
awaited tools only and does not snapshot native SDK homes. Native launch is
refused once the branch has workspace state; existing unadopted branches retain
all existing Codex/Claude home and session-sharing behavior. Regression tests
cover the unchanged SDK-home policy.

Full native adoption requires a separate serialized/versioned SDK-state commit
path at a quiescent SDK-process boundary, with reviewed per-provider state
allowlists and credential overlays, plus genuine before/after tool hooks for
all enabled providers. No claim is made that this work is implemented by the
managed-tool slice. A subscription home is never copied wholesale into S3.

## Alternatives and limits

EFS/FSx/CephFS do not eliminate per-operation network latency. EBS Multi-Attach
is not used. Per-tenant hosts would waste capacity and are not required: branch
placement permits many branches and tenants per host. Hardlinks are unsafe for
writable replicas. OverlayFS is promising for constant-time creation but needs
a privileged Linux lifecycle and correctness testing absent on this Mac.

The first metadata representation is a bounded branch-row JSON document.
This simplifies atomic multi-path updates, RLS and recovery, but full manifest
serialization and retained receipts limit scale. Per-path indexed tables and
journal-backed extraction are necessary before a high-throughput rollout.
Receipt limits fail closed rather than forgetting idempotency. Whole-tree
hashing remains a measured publication bottleneck. Performance targets remain
500 ms p95 creation and 100 ms publication/application; this implementation
does not yet meet all of them.
