# Managed branch workspace operations

Read `context/decisions/branch-workspaces.md` before enabling this backend.
The Claude worker adapter integrates this protocol with ordinary Agor prompt dispatch. Other providers remain gated on adopted branches.

## Configuration

```yaml
execution:
  branch_workspace:
    enabled: false
    native_adapter: claude_workspace
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
   Containment must use the existing sandbox/delegated substrate. Background servers are not supported. The Claude adapter described below supplies the native SDK boundary.
6. Renew placement before lease expiry. Invoke `maintainBranchWorkspace` from
   the controller's maintenance loop for inactivity checkpoints; on drain,
   stop admission first, await active tools, call it with `draining=true`, then
   acknowledge the existing external node lifecycle hook. The Terraform hook
   provides the grace period; the environment-specific hook consumer is not
   shipped in this checkout.

### Claude worker deployment

`packages/executor/src/workspaces/worker-cli.ts` runs a trusted worker controller.
`dispatch-cli.ts` plugs into `execution.executor_command_template`; it follows
SQL branch affinity and never retries an uncertain prompt dispatch. The daemon
stores a sticky `authority: worker-sql` admission marker, while the worker's
PostgreSQL row is authoritative for revisions, placement and receipts. Existing
application accounts and task/session rows keep using the existing database.
The test environment provisions a separate Multi-AZ PostgreSQL authority to
preserve its existing SQLite application data. This does not make the application
daemon itself highly available.

The SDK container receives a read-only code mount and an ephemeral provider
home. Claude's native tools, project hooks and alternate MCP transports are
disabled. Its `agor_workspace.execute` MCP tool calls the trusted controller,
which refreshes a private replica, starts a separate local Docker tool container,
removes the entire container before publication, and returns the structured
commit/conflict result. A repeated HTTP invocation returns its first result and
does not execute the command again. IAM database/S3 authority and the Docker socket are
never mounted into either child container. The worker verifies the task token
through Agor and rechecks task authority before publication.

SDK transcript JSONL files have a separate serialized SQL slot per Agor Session,
within the branch and tenant. The SDK subprocess must be gone before snapshots
are committed. A task cannot report normal completion before that publication.
Stop also contains outstanding tool containers before acknowledging quiescence.
Forks copy the parent's last committed transcript; resumes use the stable
`/workspace` cwd across workers. Legacy imports select only the authorized
provider session, never credentials or settings. Cross-branch transcript imports
require an explicit migration.

Sessions reuse their local replica across prompts. Private Git metadata, nested
dependency directories and build outputs survive tool boundaries; a crash rebuild
retains excluded descendants beneath surviving source directories. Only package
caches and user tools (`~/.cache`, `~/.npm`, `~/.local`, `~/.nvm`) are retained from
the tool home. Shell activation and working-directory changes must be repeated.

Fresh replicas import the real initial Git history, branch ref and reachable tags
without overwriting source files. A separately stored, credential-free Git bundle
uses verified 64-MiB chunks so large histories fit the source blob size limit.
Each worker prepares an immutable local Git template once; new sessions clone
private metadata using reflinks instead of repeatedly unpacking history.
Local Git refs, index and commits are private to each session and persist while
its replica is retained. They are not synchronized source revisions: publish
commits to the remote before migration/eviction if their identity must survive.
Recovery reconstructs initial Git history plus current source as working-tree
changes. Package caches and build outputs are disposable and rebuilt after loss.

File browse/read/autocomplete operations read a stable committed replica.
Unsupported commands on an adopted branch fail explicitly instead of running
against its old checkout. This slice does not support persistent dev servers,
interactive terminals, Agor UI Git-management operations on replicated code,
additional MCP servers, Codex or Gemini. Source edits, searches, installs and
tests run through the managed Claude tool. Admission reserves memory and CPU for both SDK and tool containers; the configured
session ceiling is further constrained by those reservations and host capacity.

See `infra/agor-test/README.md` for the reproducible AWS runtime deployment and
its protocol proof. The proof uses real Docker workers, PostgreSQL and S3 with a
deterministic executor and authorization fixture; it is not a real-model test.

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
metadata disaster restore. The generic infrastructure module expects an existing PostgreSQL HA/PITR setup; the isolated AWS test root provisions its own Multi-AZ metadata database.

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

### Worker affinity and automatic local reclamation

The custom worker supports an explicit `cachePolicy` in both worker and dispatcher
JSON. Omission retains the old placement behaviour. Apply
`infra/agor-test/workspace-inventory.sql` as the metadata owner first, then grant
`SELECT, INSERT, UPDATE` on `agor_workspace_inventory` to the existing restricted
worker role. The table enforces the same tenant session setting and forced RLS
as workspace authority. SDK containers receive neither inventory access nor
recovery credentials.

On each worker, persist the policy in
`/opt/agor/workspace/cache-policy.json`; `configure-workspace-worker.sh` reads it
on immutable upgrades and also configures the dispatcher on the application
host. Use the same values on all workers:

```json
{
  "mode": "observe",
  "highWatermark": 0.8,
  "lowWatermark": 0.65,
  "minimumFreeBytes": 10737418240,
  "minimumFreeInodes": 100000,
  "idleMs": 300000,
  "heartbeatMs": 10000,
  "affinityWaitMs": 15000
}
```

Promote through `observe`, `affinity`, `caches`, then `workspaces`. Observation
reports reclamation candidates without deleting them. Affinity enables placement;
`caches` additionally reclaims the dedicated S3 disk cache; `workspaces` additionally
archives and removes idle code replicas under pressure. A worker advertises
capacity and tenant-local residency using SQL server timestamps. Dispatch rejects
expired advertisements, requires a responding worker, honours a live owner even
when unavailable, then prefers a warm session, warm branch, warm repository, and
stable tenant/repository rendezvous placement. Warm capacity can queue for up to
15 seconds; an uncertain prompt submission is never retried. A branch's first
import must use a worker with the original authorized checkout locally available.
Initial repository preparation still uses existing branch/Git seed paths; sharing
a repository is a placement preference, not a guarantee of a dependency cache hit.

Local inventory persists outside SDK mounts in `controller-cache/residency.json`.
Workers only automatically reclaim tracked branches. Pre-existing replicas with durable branch authority are registered lazily on
placement lookup, preserving session locality across upgrades. Unknown directories
without authority are never adopted or deleted by a filesystem crawl. Inventory is a hint, not proof of ownership or
permission to delete. One preferred worker is selected per branch; no background
replication to other nodes occurs. Idle ownership can be released independently
of retaining a warm replica.

Maintenance briefly closes worker admission to verify no untracked SDK/tool
containers survive. It then uses tenant-and-branch admission locks for capture
and final detachment; other branches can run while a checkpoint uploads.
Requests arriving during capture wait for that branch lock (up to two minutes,
cancelled on disconnect), then recheck execution capacity before admission.
Prompt waits run inside the existing preparation supervisor, with heartbeat,
progress and Stop active before any SDK or execution slot is reserved. Worker
heartbeats continue during uploads. Every accepted dispatch or file reader changes
a local generation counter, including commands that modify only private files.
An intervening admission, source revision, ownership epoch change, or conflict
invalidates eviction. A lock is acquired again before publishing the manifest.

In `workspaces` mode, idle replicas are checkpointed before pressure occurs.
An unchanged, precheckpointed local generation can be evicted without copying or
transferring it again; the durable pointer, source revision, ownership epoch and
local admission generation must still match. Reclamation starts at 80% byte or inode usage and stops below 65%, checking actual
free space between candidates. The minimum free reserve also gates admission.
The disposable S3 read cache is reclaimed first, then older idle replicas.
Capacity exhaustion with no safe victim rejects new work rather than killing tasks.

New private checkpoints use schema 2: a reflink copy captures the idle replica,
then up to eight concurrent workers pack its files into checksummed 32 MiB S3
objects. A deterministic 64-way path shard limits how far an edit changes pack
boundaries. The manifest indexes file slices within packs and preserves Git,
private homes, dependencies, build output, permissions and symlinks. Schema 1
manifests remain readable. Restore verifies packs and writes file slices with
bounded concurrency into a temporary directory before publishing the session.
Compression runs asynchronously outside the controller event loop.

Controller-owned `recovery-receipts/<bucket-hash>/<tenant>/<branch>` directories
record acknowledged immutable objects. Retries and later checkpoints reuse those
objects, including uploads completed before an interrupted checkpoint. Receipts
are never created before S3 acknowledgment and are not mounted into SDKs. This
assumes immutable recovery objects remain retained; offline GC still fails closed
while recovery roots exist. No payload copies are added to the local S3 read cache.
The worker allows 15 minutes per checkpoint attempt, then defers without deleting
the original. Reflink capture requires spare inodes and can itself fail safely
under pressure. Special files and unresolved conflicts also prevent eviction.

After durability is acknowledged, eviction drains ownership and atomically moves
the local directory to a unique trash path. Cleanup only deletes that captured
path, never the replacement branch directory. The admission gate protects local
recreation. On return, a missing session restores from retained manifests before
source refresh. Existing sessions are never overwritten by restoration. Recovery
checks tenant/branch identity, content hashes, path traversal and symlink ancestors.
Old manifests remain referenced so evicting a newer, partial set of local sessions
does not discard an earlier session's Git/home snapshot. Offline source blob GC
fails closed when recovery roots are present until recursive recovery marking is
implemented. Idle and eviction checkpoints are not continuous backups of running or abruptly lost workers.

Operational events include `workspace_placement`, `workspace_cache_reclamation`,
`workspace_eviction_candidate`, and `workspace_eviction_deferred`, alongside
existing preparation timings. Compare warm-hit reasons, queued milliseconds,
preparation time and physical disk/inode recovery before promoting each mode.
Rollback by restoring the previous policy or removing it from worker and dispatcher
configuration and performing the normal idle worker upgrade; retain recovery
manifests and S3 objects. Do not roll back to a binary that ignores recovery pointers
after replica eviction without first restoring affected sessions.

Schema 2 checkpoints require a schema-2-capable worker for restoration. Roll out
read support to every worker before allowing new packed evictions; an older
schema-1-only binary is not a safe rollback once packed checkpoints are published.
