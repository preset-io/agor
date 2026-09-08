# PostgreSQL development profile

The `docker-compose.postgres.yml` overlay runs Agor against PostgreSQL with
the fail-closed per-user sandbox and Alice/Bob RBAC fixtures. It does
not create host Unix accounts or POSIX branch groups. The Compose `postgres`
profile by itself only activates the database service; RBAC is always enabled.

Because `agor init` is the SQLite bootstrap, source-mode PostgreSQL startup
creates only the missing deployment config on first boot. Its generated
`daemon.deployment_id`, JWT secret, and master secret persist in the
project-scoped `agor-home` volume; an existing config is validated and never
rewritten.

### One-time upgrade from the old `full` profile

The former `full` overlay injected fixed development JWT and master secrets
instead of relying on the project volume. An existing `full`/`rich` volume can
therefore contain different or incomplete persisted secrets. Do not preserve
that volume and simply restart it with this profile: doing so can invalidate
sessions or make credentials encrypted under the former master secret
unreadable.

These profiles contain disposable development fixtures, so the supported
upgrade is to use the branch environment's **Nuke** action (or the explicit
`down -v` command below) once, then start `rich` with a fresh volume. This
deletes the profile's PostgreSQL data and Agor home. If its data is not
disposable, preserve the currently effective identity and secrets in
`config.yaml` before upgrading rather than rotating them; see the operator
configuration guide linked below.

## Start

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  --profile postgres up --build postgres agor-dev
```

The checked-in `.agor.yml` variants provide the usual branch-specific ports and
project names. The `postgres` variant selects the smaller
`docker-compose.override.postgres.yml` overlay for database parity with RBAC and
Agor's sandbox off. The `rich` variant selects the overlay above; it requires
bubblewrap 0.12.0+/user-namespace support and fails closed if the sandbox cannot start.
The deprecated `full` variant is a compatibility alias for `rich`. Both
capability profiles are standalone source-mode development stacks; HA remains
a separate variant. The rich/full profile also defaults
`AGOR_SANDBOX_SDK_HOME_MODE=per_branch` so its multi-user fixtures exercise
branch-owned SDK state; set it to `inherit` to test legacy execution homes.

## Relevant environment overrides

```text
AGOR_DB_DIALECT=postgresql
DATABASE_URL=postgresql://...
AGOR_UNIX_USER_MODE=simple|sandbox|delegated
AGOR_SANDBOX_SDK_HOME_MODE=inherit|per_branch
CREATE_RBAC_TEST_USERS=true
SEED=true
```

`simple` is appropriate only for trusted development. `sandbox` applies the
local RBAC-derived filesystem policy. `delegated` requires an explicit external
launcher and an execution-home key for each user; Compose does not manufacture
an external isolation substrate.

## RBAC smoke test

With fixtures enabled:

1. Sign in as each seeded user.
2. Confirm private branches are hidden from non-owners.
3. Confirm shared branches follow `others_can`, direct grants, and board grants.
4. Confirm Owners & Permissions updates are reflected after reconnect.
5. In sandbox mode, launch an agent and verify its branch is mounted according
   to the effective user's read/write access while sibling homes and daemon
   state are absent.

## Database checks

```bash
docker compose --profile postgres exec postgres \
  psql -U agor_app -d agor -c 'select count(*) from users;'
```

Both SQLite and PostgreSQL schemas must retain parity. Historical
`branches.unix_group` and `repos.unix_group` columns are nullable compatibility
stamps and are ignored by runtime repositories.

## Cleanup

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  --profile postgres down
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  --profile postgres down -v
```

See
[`apps/agor-docs/content/guide/config-yaml.mdx`](../apps/agor-docs/content/guide/config-yaml.mdx),
[`apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx`](../apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx)
and
[`context/guides/rbac-and-unix-isolation.md`](../context/guides/rbac-and-unix-isolation.md).
