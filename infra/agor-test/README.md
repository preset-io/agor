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
