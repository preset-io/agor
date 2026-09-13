# Agor on JuiceFS

This branch runs standard Agor repositories and worktrees directly on JuiceFS.
It is an alternative to the local-replicated workspace experiment, not an adapter
inside that transaction protocol. The base is standard Agor commit
`72bf01ff8e7b199434456bbedb0ecd93aeba6664`.

## Layout and semantics

| Data                                                                | Location                                        |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| Repositories, worktrees, Git metadata                               | JuiceFS                                         |
| Dependencies and build output inside worktrees                      | JuiceFS                                         |
| Agor SQLite database, configuration, credentials, agent home caches | Local application home                          |
| JuiceFS data blocks                                                 | S3                                              |
| JuiceFS filesystem metadata                                         | Dedicated PostgreSQL database                   |
| JuiceFS block cache                                                 | Local worker disk, 4 GiB configured cache limit |

The application uses ordinary filesystem operations. There is no Agor source
scan/upload at tool completion, no XFS reflink requirement, and no custom
transaction/conflict notification. Concurrent writes have JuiceFS/POSIX
semantics; this does **not** provide atomic commits of a tool's multi-file edits.
Normal Git branch/worktree behavior remains unchanged.

The profile is explicitly one static `default` tenant per deployment. A volume
identity marker prevents accidentally attaching another deployment's data. The
Agor container receives only its repositories and worktrees, never the JuiceFS
mount root, metadata password, local block cache, or host IAM credentials.
This is not a multi-tenant hosted execution substrate or an HA Agor deployment.
Do not put SQLite or credentials on the shared mount or start several independent
Agor databases against the same worktrees. Two mounts may be used for filesystem
validation without running multiple Agor daemons.

## Linux setup

Requires Docker, Python 3, `findmnt`, FUSE (`fuse3` on Amazon Linux 2023), and
network access to S3 and the metadata database. The installer pins JuiceFS 1.4.1
and verifies the official release SHA-256 before installing.

1. Build standard Agor from this branch:

   ```sh
   docker build --target production-source -t agor-juicefs:local -f docker/Dockerfile .
   ```

2. Provision storage with the Terraform module in this directory. Supply an
   isolated VPC, private subnets in two availability zones, the worker security
   group, and worker IAM role. The module creates a dedicated private S3 bucket,
   encrypted PostgreSQL instance, restricted access, and a managed database
   password. It does not create networking, compute, DNS, or a public endpoint.
   The default metadata instance is single-AZ for comparison; set `multi_az=true`
   for failover. Retain the Terraform state and metadata backups.

3. Install the host-side runtime:

   ```sh
   sudo bash infra/juicefs/install.sh
   sudo install -d -m 0700 /etc/agor-juicefs /opt/agor-juicefs
   sudo install -m 0755 infra/juicefs/manage.py /opt/agor-juicefs/manage.py
   sudo install -m 0600 infra/juicefs/config.example.json /etc/agor-juicefs/config.json
   ```

   Fill the config using Terraform's bucket and metadata URL outputs. Retrieve
   the managed database password into `/etc/agor-juicefs/metadata-password` with
   mode `0600`; never put it in the URL, command line, source, or shell history.
   On EC2 the host's IAM role supplies S3 credentials. Use TLS to RDS; for
   certificate verification install the RDS CA and use `sslmode=verify-full`
   with `sslrootcert` in the metadata URL. Do not pass IAM or metadata credentials
   into the application container.

4. Format a **new dedicated** database/volume once, then mount it:

   ```sh
   sudo python3 /opt/agor-juicefs/manage.py format /etc/agor-juicefs/config.json
   sudo install -m 0644 infra/juicefs/agor-juicefs.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now agor-juicefs
   sudo python3 /opt/agor-juicefs/manage.py prepare /etc/agor-juicefs/config.json
   sudo python3 /opt/agor-juicefs/manage.py start /etc/agor-juicefs/config.json
   ```

   Wait for the mount before `prepare`. The launcher fails if JuiceFS is absent,
   the volume identity differs, or an unrecognized application home already
   contains data. It never silently runs against an empty local directory.
   Existing deployments are not migrated by this script.

5. Agor listens on **127.0.0.1:3031** by default. Use an authenticated tunnel or
   your HTTPS reverse proxy. Fresh Agor performs its normal administrator
   bootstrap; there are no fixed default credentials. Configure agent tools and
   authentication normally in the fresh instance.

Mounts use normal close-to-open consistency, verified local cache contents, and
no writeback or relaxed open-cache options. Application container restarts retain
the bind mount; a failed FUSE mount produces errors rather than local fallback.
At host boot, ensure the mount is ready before starting the application.

## Validation and comparison

```sh
python3 -m unittest discover -s infra/juicefs -p 'test_*.py'
terraform -chdir=infra/juicefs init -backend=false
terraform -chdir=infra/juicefs validate
python3 infra/juicefs/mount-proof.py /first-client-mount /second-client-mount
```

The two-client proof checks file creation, visibility, and rename with separate
mounts and caches. It is not a performance comparison against the earlier
Superset tests. Use matching Superset commits, Node/npm versions, lockfiles,
instance sizes, and cold/warm states for that comparison. Measure branch creation,
first command, dependency installation, builds, and disk usage separately.

`proof/` contains narrowly scoped temporary S3 permissions for an isolated EC2
integration proof using an existing bucket. It grants access only to
`agor-juicefs-proof/*`. Use a separate Terraform state; destroy that policy after
stopping the proof instance and mounts. It is not needed for the dedicated
storage module above.

References: [JuiceFS architecture](https://juicefs.com/docs/community/architecture/),
[cache consistency](https://juicefs.com/docs/community/guide/cache/), and
[PostgreSQL setup](https://juicefs.com/docs/community/databases_for_metadata/).

## HTTPS on the existing comparison load balancer

`endpoint/` manages an additional certificate, target group on port 3031, and a
host-specific HTTPS listener rule. First apply with `enable_https=false`, publish
its `dns_records` output, then apply with `enable_https=true`. This attaches the
validated certificate and enables routing without changing the existing default
application route.

Set `bind_address` to the worker's specific private IPv4 address and
`public_origin` to the HTTPS origin in the runtime config, then recreate the
comparison app container. The shared load-balancer stack on
`codex/local-branch-workspaces` owns its security groups: set its
`juicefs_backend_enabled=true` to permit ALB-to-worker TCP 3031. Keeping those
rules in their original owning stack avoids conflicting Terraform ownership.
The metadata proof still uses local PostgreSQL; exposing HTTPS does not convert
it into the dedicated RDS deployment or enable agent tools automatically.
