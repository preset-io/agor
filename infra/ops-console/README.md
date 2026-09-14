# Agor operations console

Operator-only control plane for the custom EC2 workspace deployment. Served at
`https://agor.skellige.com.au/ops/`. This is a separate fleet-admin capability,
not a tenant-facing Agor API. It can inspect all registered tenants. Only Agor
super-admin users from the explicitly configured operator tenant can access it.
Worker control tokens, AWS credentials and object contents never reach the browser.

The Python service uses standard-library HTTP and the host AWS CLI. It polls
workers every 15 seconds and CloudWatch every minute. The browser reuses Agor's
same-origin access token and standard refresh endpoint. Each API request sends
that bearer to the configured Agor `/users/<subject>` endpoint, which verifies
its signature, expiry and credential revocation. The console requires the live
user role to be `superadmin`; it does not authorize from decoded JWT role claims.
Only ordinary access tokens for `operatorTenant` are accepted. Configure
`agorOrigin` as the trusted local daemon origin (here `http://127.0.0.1:3030`) and
`operatorTenant` as `default` in `/etc/agor-ops.json`. For a verified static-mode
daemon, set `agorStaticTenant` to its `static_tenant_id` so ordinary browser
tokens without a tenant claim work. Omit that fallback for dynamic tenancy;
explicit conflicting tenant claims are always rejected. Do not point this at an
untrusted endpoint. Other tenant administrators cannot gain fleet access.

There is no separate password or ops cookie. Mutations require both exact
same-origin Origin and a custom CSRF header, plus current Agor authorization.
Operation records carry the initiating Agor user ID and name. An accepted
background operation completes independently of subsequent browser logout.
Sign in at `/ui/`, then open `/ops/`; the account button returns to Agor.

## Operations

The first transfer workflow requires all registered workers to be idle and
briefly holds the whole fleet. This deliberately conservative operator path
rechecks residency on every held worker and rejects an older retained source.
It is not a zero-downtime migration service. Durable holds reject new
work and survive controller restarts. Checkpoints use the existing scoped
metadata, conflict checks and packed recovery format. The destination atomically claims the exact exported ownership generation
before restoring, renewing that lease during the transfer. Its newer inventory timestamp makes it preferable
for subsequent affinity placement; this is not a permanent scheduling pin.
Source copies remain. Previous destination replicas are moved to `ops-retained`
and require deliberate cleanup. No automatic deletion is performed by this UI.
A failed or interrupted transfer retains any acquired holds. Inspect its status
before explicitly releasing them. In-flight commands and SDK process memory
are never migrated. SDK transcript portability across hosts remains subject to
the existing executor's recovery support.

Add worker increments the desired capacity of the Terraform-owned
`agor-ops-workers` Auto Scaling group, bounded at four additional m7i.xlarge
workers. User data loads an immutable runtime image and starts the controller.
Dispatcher discovery merges healthy new workers with the original configured
hosts. No scale-down action is exposed: safe fleet contraction is separate work.
Scale-in protection and suspended unhealthy replacement/AZ rebalance prevent
ASG churn from silently discarding private workspaces. EBS survives termination.
This means failed hosts and orphan volumes require operator intervention.

## Metrics

Controller PUT/GET calls, successes, errors, compressed transfer bytes and cache
hits reset on controller restart. They count logical AWS SDK calls, not SDK retry
attempts, and exclude the daemon's separate blob client. PUT precondition
failures count as errors even when the following verification succeeds.
CloudWatch request metrics cover the whole configured bucket, are delayed and
best-effort, and are not billing records. Empty samples are unavailable, not zero.
Memory is total minus OS free, including reclaimable page cache. Disk statistics
cover the entire worker filesystem. Residency and session counts describe saved
inventory, not current distributed ownership or running sessions.

## Deployment

The parent `infra/agor-test` Terraform stack owns HTTPS routing, network rules,
S3 request metrics, IAM, the launch template and Auto Scaling group. Set
`ops_enabled=true` and `ops_worker_release` to the deployed immutable image tag.
Keep desired capacity operational; Terraform ignores changes to that field.
Publish the source archive and `ops-image-<release>.tar.gz` under the existing
private source bucket's `workspace-releases/` prefix before provisioning workers.
Run `install.sh` on the primary after securely supplying `/etc/agor-ops.json`.
Runtime state and journals stay outside Git. The app/worker rollout uses the
existing guarded deployment scripts; no active user task should be interrupted.

## Verification

- `python3 -m unittest discover -s infra/ops-console -p 'test_*.py'`
- `node --check infra/ops-console/app.js`
- Executor workspace hold, recovery, reclamation and S3 blob tests.
- Real AWS checks: authentication and CSRF rejection, live worker responses,
  isolated synthetic transfer with hashes/home/Git preserved, EC2 bootstrap and
  dispatcher discovery. Record actual rollout results outside the repository.
