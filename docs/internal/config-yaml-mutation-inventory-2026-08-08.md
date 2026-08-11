# `config.yaml` mutation inventory (2026-08-08)

`~/.agor/config.yaml` is deployment-owned input. After initial creation, ordinary Agor
runtime, API, MCP, UI, daemon, upgrade, container-entrypoint, and CLI operations must treat it
as read-only.

## Inventory and disposition

| Path                              | Actor / trigger                 | Previously written                                    | Unattended / write behavior                                                                           | Ownership and replacement                                                                                                                                        |
| --------------------------------- | ------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core save/set/unset helpers       | Any in-process caller           | Entire parsed YAML document                           | Non-atomic truncate/write; inherited umask; concurrent lost updates; destroyed comments/order/anchors | General persistence APIs removed. Exclusive `createInitialConfig` is init-only; atomic replacement remains test-only for regression coverage.                    |
| `agor config set/get/unset`       | Operator CLI                    | Set/unset rewrote the document; get read one key      | Set/unset could run unattended without warning                                                        | Removed. `agor config` is read-only and can display/materialize the effective configuration as YAML.                                                             |
| JWT bootstrap                     | Daemon startup when missing     | Generated `daemon.jwtSecret`                          | Unattended runtime rewrite; daemon race                                                               | Removed. `AGOR_JWT_SECRET` wins over YAML; otherwise fail closed. Init creates a stable secret.                                                                  |
| Master-secret bootstrap           | Daemon startup when missing     | Generated `daemon.masterSecret`                       | Unattended rewrite/race could invalidate encrypted values                                             | Removed. `AGOR_MASTER_SECRET` wins over YAML; otherwise fail closed. Init creates a stable secret.                                                               |
| Telemetry env materialization     | Startup with `AGOR_TELEMETRY=1` | Enabled flag and instance ID                          | Unattended rewrite                                                                                    | Removed; override remains in memory.                                                                                                                             |
| Telemetry heartbeat/version/usage | Startup/hourly timer            | Report timestamps/version                             | Unattended rewrite and multi-daemon lost updates                                                      | Removed from YAML. Process-local suppression prevents hourly duplication. Durable global state is a possible follow-up and must not live in an arbitrary tenant. |
| Telemetry CLI                     | Operator                        | Opt-in or generated ID                                | Silent rewrite                                                                                        | On/off direct operators to env or YAML/IaC. Test IDs may be ephemeral.                                                                                           |
| `agor init`                       | Initial install                 | Defaults, telemetry choice, stable secrets            | Interactive/headless creation                                                                         | Allowed only during initialization. Uses exclusive create, mode 0600; existing-install `--set-config` is rejected.                                               |
| Docker entrypoint                 | Every container start           | Host/port, executor, RBAC and Unix mode via CLI/`sed` | Unattended, non-atomic                                                                                | Removed. Deployment variables are resolved in memory; read-only ConfigMaps work.                                                                                 |
| Config Feathers service           | Executor secret resolution      | Historical general service                            | Current implementation has no YAML CRUD                                                               | Keep narrowly authenticated `config/resolve-api-key`; it reads user/tenant DB credentials only. No UI/MCP YAML mutation caller exists.                           |
| Upgrade/migrations                | Installer/container lifecycle   | Indirect init/entrypoint writes                       | Previously every Docker start                                                                         | Entry-point mutation removed; migrations have no YAML persistence helper.                                                                                        |
| Tests                             | Fixture setup                   | Fixture YAML                                          | Test only                                                                                             | Direct writes remain acceptable. `saveConfigForTests` rejects non-test runtimes.                                                                                 |

Search covered direct writes/renames, YAML serialization, shell `sed`, service routes, UI callers,
MCP tools, installers, setup/repair helpers, and tests. `.agor.yml`, git config, Codex config, and
`.env-config.yaml` are separate files and out of scope.

## Read precedence and scope

| Concern                                                         | Effective precedence                                                | Scope                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| daemon port/host                                                | `PORT` / `DAEMON_HOST` → YAML → default                             | deployment-global         |
| daemon URL                                                      | explicit `DAEMON_URL` where supported → port/YAML → default         | deployment-global/process |
| JWT/master secrets                                              | matching environment secret → YAML → fail closed                    | deployment-global secret  |
| telemetry                                                       | `DO_NOT_TRACK` and `AGOR_TELEMETRY*` → YAML → disabled/unconfigured | deployment-global         |
| database/bootstrap, static tenant, filesystem/executor/security | supported field-specific env → YAML → typed default                 | deployment-global         |
| agentic credentials/config                                      | user DB → tenant DB under explicit policy; no YAML fallback         | user/tenant               |
| Knowledge settings                                              | tenant DB                                                           | tenant-owned              |
| UI/session preferences                                          | user/tenant DB                                                      | user/tenant-owned         |

Deployment-global values are never copied into tenant-scoped `app_variables`. In
`required_from_auth` mode no arbitrary tenant may own daemon boot authority. Pre-database values
remain environment/YAML owned.

## History and compatibility

The checkout is grafted at `d0220d2`, so earlier ancestry cannot be inspected locally. Available
history shows later tenant scoping, uploads, Unix modes, analytics hardening, and executor credential
work, but no external dependency requiring runtime YAML rewrites. Changelog/docs advertised
`agor config set`, config loading, and Docker materialization, so automation using set/get/unset
must migrate to explicit source-file management or read-only `agor config --yaml` inspection.
