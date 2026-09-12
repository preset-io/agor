# Isolated Agor AWS test deployment

This root deploys the Agor application and two local workspace workers in a
dedicated VPC. HTTPS uses the externally managed `agor.skellige.com.au` DNS
record and ACM certificate. The workers use encrypted local gp3/XFS storage;
workspace metadata lives in private Multi-AZ PostgreSQL and compressed immutable
content in a private KMS-encrypted, versioned S3 bucket. There is no network
filesystem or EBS Multi-Attach. Management uses SSM, with no inbound SSH.

The application retains its existing SQLite accounts/tasks/sessions. This test
proves workspace placement and recovery across workers, not whole-application
HA. Claude is the integrated provider; other providers are rejected on adopted
branches. Users configure Claude authentication through the existing Agor UI.

## Apply

Create an ignored `deployment.auto.tfvars.json` with `allowed_cidr` (client /32),
`source_archive` (absolute local tar.gz path), and `source_sha` (commit ID).
Archive only tracked source files; exclude Terraform artifacts and secrets.

```sh
terraform init
terraform validate
terraform plan -out=deploy.tfplan
terraform apply deploy.tfplan
terraform output
```

The initial build runs through cloud-init; infrastructure completion precedes
application readiness. Inspect `/var/log/agor-bootstrap.log` via SSM and wait
for the ALB target to become healthy. The UI is at `/ui/` and `/health` exposes
health status. HTTP is deliberately restricted to the configured client IP;
use a domain and ACM HTTPS before broader use.

Initial admin credentials are generated on the instance at
`/srv/agor/home/.agor/admin-credentials`, mode 0600. Retrieve them through SSM,
not EC2 user-data or Terraform variables/state. Authentication and persistent
SQLite/session state reside under `/srv/agor/home` on encrypted EBS.

Terraform state and variable/plan files are local and ignored. Preserve them
securely to update or remove this deployment. Changing user-data replaces the
instance; root EBS is deliberately retained on termination, so reattach/migrate
state explicitly before replacement. There is no automatic backup/restore.

## EC2 NAT egress

`nat.tf` provisions a dedicated Amazon Linux 2023 ARM `t4g.nano` NAT instance,
an Elastic IP, and an app-subnet route table. There is no NAT gateway. Forwarding
and masquerading persist through a systemd service; source/destination checking
is disabled. The instance accepts forwarded traffic only from the app subnet,
uses IMDSv2, and is managed through SSM without an inbound SSH rule.

For initial deployment, apply with `-var=nat_egress_enabled=false`, then verify
`cloud-init status --wait`, `systemctl is-active agor-nat`, and
`nft list table ip agor_nat` through SSM. Apply again with the default `true` to
switch only subnet `test[2]` to NAT egress. Verify the app container's external IP
matches `terraform output -raw nat_public_ip` and perform a GitHub clone/fetch.
Setting the flag false restores the previous direct internet route. Existing
app public-IP allocation is retained to avoid replacing its stateful EC2 host.

The second worker shares public subnet `test[1]` with the ALB and retains direct
internet egress. Do not point that subnet's default route at NAT: the ALB needs
its internet-gateway route. Moving that worker to a private subnet is a separate
host migration. This single NAT instance is a test-environment availability
tradeoff: its failure interrupts app internet egress until it is recovered.

NAT provides connectivity, not GitHub authentication or support for native Git
operations on branches already adopted by the replicated workspace backend.

## Teardown

Back up application data, then review `terraform plan -destroy` and apply the
reviewed plan. S3 must be emptied explicitly if it contains additional objects.
Retained root EBS volumes are not automatically removed by instance teardown;
inspect and delete them only after verifying backups. Ongoing charges include
EC2, EBS, ALB, public IPv4, storage and transfer until resources are removed.

## Packaged runtime smoke test

Copy `workspace-smoke.mjs` to the host and mount it read-only into a disposable
container from the deployed image. Run Node with the script path and the
bundled core workspace module URL as arguments, overriding the entrypoint:

```sh
docker run --rm --entrypoint node \
  -v /opt/agor/workspace-smoke.mjs:/tmp/workspace-smoke.mjs:ro \
  agor:COMMIT /tmp/workspace-smoke.mjs \
  file:///opt/agor-runtime/lib/node_modules/agor-live/node_modules/@agor/core/workspaces/index.js
```

This uses actual child processes and temporary local files, but an in-memory
metadata authority and local blobs. It validates packaging and the Linux tool
boundary path; it does not validate PostgreSQL, S3 or native SDK wiring.

## Custom-domain HTTPS

`https.tf` requests a DNS-validated ACM certificate for `agor.skellige.com.au`.
Keep `enable_https=false` while adding the two records from
`terraform output certificate_dns_records` and `application_dns_record` in
the external DNS provider. Retain the validation CNAME for automatic renewal.

After DNS resolves, set `enable_https=true`, plan and apply. Terraform waits
for certificate issuance, creates a TLS 1.2/1.3 listener and permits any IPv4
client on port 443. Port 80 remains restricted to `allowed_cidr` and redirects
to the custom HTTPS hostname. The app host remains reachable only from the ALB.

Before handing over the custom URL, recreate the existing Agor container with
`AGOR_BASE_URL=https://agor.skellige.com.au` and matching `CORS_ORIGIN`, preserving
its image, mounted `/srv/agor/home` directory and other environment settings.
Run `python3 /opt/agor/set-public-url.py https://agor.skellige.com.au` through SSM after copying `set-public-url.py` to that path. The script verifies the deployment shape, preserves existing environment and data mounts, retains the stopped previous container as `agor-url-backup`, and rolls back if health checks fail. Changing EC2 user-data would replace the instance. Verify
HTTPS, authentication, browser rendering and WebSocket connectivity. The
certificate-only phase does not make the HTTPS endpoint live.

## Replicated worker runtime

Set `workspace_release = { archive = "/absolute/source.tar.gz", sha = "<content-digest>" }`
when publishing a corrected runtime. Preserve the initial `source_sha` to avoid
replacing the application host. `build-workspace-runtime.sh <digest>` builds the
same source image on both hosts. `configure-workspace-worker.sh <digest>` installs
Claude through Agor, reads the control capability into a root-only controller config,
and starts the trusted worker service. Initialize `workspace-authority.sql` once
using the database owner and grant a NOSUPERUSER/NOBYPASSRLS worker role only
SELECT/INSERT/UPDATE plus `rds_iam`. Set its password to NULL. RDS connections obtain a fresh IAM authentication token for each connection and verify the AWS CA bundle and hostname. The EC2 role has `rds-db:connect` only for this database/user.

Copy `enable-workspace-runtime.mjs` to `/opt/agor/workspace/enable.mjs`, then run
`rollout-workspace.py <digest>` on the app host. It refuses active tasks, preserves
the user data bind and a rollback container/config, enables the existing executor
command template, and verifies application health. The dispatcher capability is
mounted only into the daemon. The AWS role and Docker socket are
available only to the trusted controller. Child SDK/tool containers receive
neither cloud authority nor another branch's filesystem.

Workspace preparation claims the scoped task before importing storage, emits
`preparing_workspace` telemetry, and listens for Stop. A cancelled preparation
acknowledges quiescence only after its pending storage work has settled and no
SDK can be launched. Imports and cold restores use at most eight concurrent
file transfers, and ownership is renewed while a cold base is rendered. Large
repositories can still take time on first use; task heartbeats distinguish this
phase from a disconnected executor.

`workspace-protocol-proof.mjs` and `workspace-proof-executor.mjs` exercise real
worker HTTP/Docker, PostgreSQL and S3 using an isolated tenant/branch and a mock
Agor authorization endpoint. They cover concurrent disjoint commits, same-base
conflicts, refresh, duplicate invocation, background-process cleanup, Stop,
excluded dependencies, checkpoint/drain, and recovery on a second worker. The
executor fixture is deterministic: passing it must not be described as a real
Claude model test. A final user-session test requires configured Claude auth.

The first supported user flow is Claude source editing, shell tests/installs,
and reading committed files in Agor. Persistent terminals/dev servers, additional
MCP servers, native Git-management operations on adopted branches, and other
providers remain unsupported. Old-checkout fallback is refused for adopted
branches. To roll back, export the newest durable tree to a reviewed fresh legacy
checkout before clearing its sticky adoption marker; changing the flag alone is
not a data migration. See `context/guides/branch-workspaces.md` for recovery and
retention limits.

### Local development state

A session reuses one isolated replica across successive prompts. `node_modules`,
virtual environments, nested build directories and private `.git` metadata stay
on that host across tool calls, including replica recovery after an aborted tool.
They are excluded from source revisions and checkpoints. Source changes from other
sessions appear as working-tree changes against the replica's own Git index.

Each fresh replica receives the branch's real initial Git history from a
credential-free, branch-scoped bundle stored separately through the workspace
persistence protocol. No source hooks, configuration or external worktree pointers
are copied. Local commits and refs survive while that replica is retained; they
are not shared Git refs or durable source revisions. Publish commits to the Git
remote before eviction or migration if their commit identity must survive.
Restoring elsewhere reconstructs the initial Git history plus the current source
revision as working-tree changes. Agor UI Git-management commands still require
separate integration; local Git commands inside the workspace now work.

The tool runtime includes Node, Python, pip, venv, a compiler toolchain and zstd.
Only `~/.cache`, `~/.npm`, `~/.local` and `~/.nvm` are retained from the tool home,
in replica-private local directories. npm user-global installs use `~/.local`.
Shell state is fresh each invocation: repeat directory changes and environment
activation. Commands support an explicit timeout up to 15 minutes, use `pipefail`,
and report container OOM failures. Tool memory/CPU reservations are configurable
through `toolMemoryGiB` and `toolCpus` (defaults 8 GiB and 2 CPUs); admission also
reserves 3 GiB/1 CPU for each SDK and 2 GiB for the host. A 16-GiB worker therefore
admits one such session; smaller tool budgets or larger workers permit concurrency.

Tracked `.npmrc`, `.env*` and repository `.claude` files are synchronized as
repository configuration. Untracked files with those names remain local; credential
stores such as `.aws`, `.netrc` and `.claude/auth.json` stay excluded even if tracked.
Configuration provenance travels in the source manifest, including during restore
before local Git metadata exists. Once admitted, configuration remains source content
until deleted; removing it from the Git index alone does not make it private again.

Use `upgrade-workspace-worker.sh <release>` after building to drain and replace an
idle worker while retaining the previous container. Do not roll a workspace containing
configuration provenance back to an older worker that does not understand it.
For branches imported by the old filter, `repair-workspace-config.mjs <config>
<tenant> <branch> <session> <paths...>` restores explicitly named missing tracked
configuration from the session's Git index, then commits it through the normal
workspace protocol and drains to durable storage. Run it in the new runtime image
on the owning host with the worker stopped after draining. It preserves existing
files; it is deliberately an operator action so normal tracked deletions never
get automatically resurrected.

Claude startup uses a read-only empty launcher; repository access is exclusively
through the managed workspace tool. A small branch launch lease pins placement
while Claude thinks, without importing or rendering the source tree. Source/Git
preparation waits until the first tool, remains cancellable, and holds the normal
branch lease before any command is admitted. Conversation-only prompts leave the
source authority untouched. Agor shows a system progress row for startup and file
preparation; Claude is instructed to explain its next action before calling a tool.
Immutable base caches are keyed by source content, independently of fencing epochs.
Warm replica and transcript admission refreshes metadata without an eager base
render or redundant initial source scan. Task and tool authority checks remain in
place; the launch lease is renewed alongside the conversation lease.

### Reflink branch creation

The deployment selects clone storage for new branches and enables a trusted
`branchReflinkRoot` in the dispatcher configuration. The Git command executor on
the app EC2 instance caches immutable source checkouts on its XFS/EBS filesystem,
scoped by repository, initiating user, remote, base ref and depth. It seeds a clean
fetch repository with reflinked Git objects, fetches the selected ref with scoped
credentials, and reflinks the matching cached checkout into the branch path.
Every branch has private files, index, refs and config; no hardlinks or Git
alternates connect it to its source. Relative symlinks retain their original targets.
New commits incur one cold checkout; a warm creation still contacts the remote
before reusing a tree. Cache directories remain outside all SDK/tool mounts.
The existing worker protocol adopts this branch on the first session tool call.

`branch-reflink-proof.mjs` exercises cold/warm Superset creation on EC2 with forced
reflinks and checks sibling isolation and Git status. The app must also be rolled
to the release image with `rollout-workspace.py` because the initial Git lifecycle
runs in its command executor. The rollout preserves its data, waits for health,
and retains a release-specific rollback container/config. Existing branches are
not converted. Both worker upgrades and app rollout require idle tasks.
