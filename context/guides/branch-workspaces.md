# Managed branch workspace operations

Read `context/decisions/branch-workspaces.md` before enabling this backend.
This is a functioning managed-tool slice, not a drop-in native SDK deployment.

## Configuration

```yaml
execution:
  branch_workspace:
    enabled: false
    backend: local_replicated
    tool_boundary_sync: true
    local_root: /var/lib/agor
    clone: reflink
    checkpoint_idle_seconds: 300
    maximum_local_bytes: 21474836480
    maximum_local_inodes: 250000
    minimum_free_bytes: 10737418240
    minimum_free_inodes: 100000
    maximum_active_tools: 8
    maximum_receipts: 10000
    lease_seconds: 120
    tool_lease_seconds: 600
    conflict_policy: reject
    tenant_ids: []
    branch_ids: []
    exclude: []
```

Empty allowlists mean all within an enabled environment, not disabled rollout.
Start with one explicit tenant and branch. `copy` is the portable development
alternative when reflink fails. Linux roots must report local XFS, ext4, Btrfs
tmpfs or OverlayFS backed by local storage. Production tmpfs is unsuitable for capacity; use instance NVMe or
local encrypted EBS. `maximum_local_bytes/inodes` limit synchronized tree size;
free-space reserves provide admission protection. They are not aggregate disk
quotas across all replicas. Host capacity admission must reserve expected
executor demand through `selectWorkspaceHost`.

## Controller composition and rollout

1. Upgrade every daemon before adopting any branch. Apply both normal SQL migrations through the existing migration runner. The
   nullable column leaves unadopted branches unchanged. There is no flag day.
2. Instantiate `BranchWorkspaceRepository` with trusted tenant context and an
   already authorized BranchID. Do not grant SDK children raw database/S3
   credentials or access to base/metadata directories.
3. Supply tenant-scoped `S3WorkspaceBlobs` using the existing secret/STS chain.
   Supply a stable boot-unique worker host identity. `createBranchWorkspace`
   returns undefined when the environment/tenant/branch is outside rollout.
4. Stop legacy writers and development servers on the selected branch. Call
   `materialise(branch.path)` once to adopt the existing worktree/clone source.
   The snapshot source must be quiescent; the importer cannot freeze arbitrary
   external processes. Existing source remains untouched for rollback review.
5. Schedule managed tools on the selected host. `runWorkspaceTool` reserves,
   refreshes, invokes the awaited local callback and publishes. The callback
   must reap every descendant before resolving, including failed commands.
   Containment must use the existing sandbox/delegated substrate. Background
   servers and native SDKs are not supported by this adapter.
6. Renew placement before lease expiry. Invoke `maintainBranchWorkspace` from
   the controller's maintenance loop for inactivity checkpoints; on drain,
   stop admission first, await active tools, call it with `draining=true`, then
   acknowledge the existing external node lifecycle hook. The Terraform hook
   provides the grace period; the environment-specific hook consumer is not
   shipped in this checkout.

Do not enable the flag expecting existing Codex/Claude prompts to use this
backend. No production worker service, remote metadata RPC, native SDK hook
adapter or external scheduler routing has been enabled by this change. These
are explicit rollout blockers. The exported worker APIs and actual-process SQL
integration test are the executable integration contract.

## Recovery and rollback

- Tool process loss: abort its ticket when known; otherwise let its bounded
  reservation expire. Its uncommitted changes are discarded and logged as
  `abandoned_tool`. Preserve the replica for diagnosis until normal release.
- Lost commit acknowledgement: retry `completeTool(ticket)` or inspect the
  idempotency receipt. Never execute the tool again under the same key.
- Worker loss: wait for the SQL placement lease to expire. A replacement calls
  `restore`; the epoch advances and old workers cannot publish. Recovery uses
  latest SQL metadata and durable blobs, including commits after checkpoint.
- Corrupt/missing S3 object: admission fails; recover the exact immutable object
  from bucket versioning/backup. Do not advance revision or edit its checksum.
- Disk/inode pressure: stop admission, drain inactive branches, then `evict`.
  Eviction refuses a live/uncheckpointed placement. Local base/replica caches
  are disposable after a verified durable checkpoint.
- Rollback: stop managed tool admission, wait for tools, checkpoint/drain, and
  restore the latest synchronized tree into a reviewed **new** legacy source
  directory. Reconcile it with the branch's Git worktree using normal Git
  workflows. Only then clear workspace metadata in an operator-controlled
  migration and resume legacy writers. Toggling the flag alone is not rollback:
  the native startup guard deliberately continues to refuse adopted branches.

SQL backups/PITR and S3 objects must be retained together. Restoring SQL to an
older point may roll back acknowledged revisions; fence all workers before a
metadata disaster restore. The infrastructure module expects the deployment's
existing PostgreSQL HA/PITR setup and does not provision another database.

## Retention and observability

Never put a blanket age-expiry rule on live blob objects. S3 lifecycle cleans
abandoned multipart uploads and noncurrent versions only. `workspaceBlobRoots`
provides the offline mark set and refuses live placements. Actual sweeping and
receipt archival require the existing tenant write gate, enumeration of every
branch in that tenant, checkpoint ancestry traversal, and a privileged
maintenance adapter. Automatic S3 sweeping is **not enabled** in this slice.
Do not prune receipts casually: losing a key allows a retry to become a new
operation. Branch deletion currently removes SQL state; object reclamation
must remain an explicit tenant maintenance operation.

The coordinator's observer reports bounded metric names and numeric values:
materialisation, refresh, extraction, commit, checkpoint, restore, file/byte
counts, exclusions, free bytes/inodes, conflicts, fencing, abandonment and
eviction. Tenant/branch/host/tool identities are structured context only,
never metric label values. Wire this observer to the deployment's existing
metrics/tracing exporter. The Terraform alarm expects that exporter; there is
no claim that a callback alone emits CloudWatch metrics.

## Validation

```sh
pnpm --filter @agor/core exec vitest run src/workspaces src/db/repositories/branch-workspaces.test.ts src/config/branch-workspace.test.ts
pnpm --filter @agor/daemon exec vitest run src/branch-workspace-admission.test.ts src/services/executor-startup.test.ts src/branch-sdk-home.test.ts src/services/sessions.sdk-home-scope.test.ts src/utils/s3-workspace-blobs.test.ts
pnpm --filter @agor/core exec tsc --noEmit --customConditions source
terraform -chdir=infra/branch-workspaces init -backend=false
terraform -chdir=infra/branch-workspaces validate
terraform -chdir=infra/branch-workspaces test
```

PostgreSQL row-lock races, lease takeover and tenant RLS passed locally using
a non-superuser application role. Before production: exercise independent
worker services, S3/KMS tenant-tag denial, abrupt EC2/AZ failure, instance-store and EBS
bootstrap/reboot, lifecycle-hook consumption, controller sandbox mounts, native
SDK-state persistence, credential filtering, Linux reflink/OverlayFS, bounded
automatic cache eviction/GC, and the NVMe performance suite. Local SQLite and
mocked-provider tests cannot certify those guarantees.
