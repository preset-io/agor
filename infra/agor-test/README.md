# Isolated Agor AWS test deployment

This root deploys Agor from the source archive built from the committed branch.
It creates a dedicated VPC, three subnets, routing, an IP-restricted HTTP ALB,
one EC2 application host, encrypted gp3 disk, private source bucket and scoped
instance role. There are no inbound SSH rules. EC2 management uses SSM.
The instance has outbound internet access for source builds and agent tools.

This is a single-host test deployment using the existing SQLite backend. The
experimental replicated workspace backend remains disabled for native SDKs.
It is not an HA/AZ-recovery demonstration. No shared filesystem or EBS
Multi-Attach is required. No provider subscription credentials are uploaded.
Install and authenticate agent tools through the existing Agor workflow.

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

## Teardown

Back up application data, then review `terraform plan -destroy` and apply the
reviewed plan. S3 must be emptied explicitly if it contains additional objects.
Retained root EBS volumes are not automatically removed by instance teardown;
inspect and delete them only after verifying backups. Ongoing charges include
EC2, EBS, ALB, public IPv4, storage and transfer until resources are removed.
