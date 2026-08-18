# PostgreSQL development profile

The PostgreSQL Compose profile runs Agor against PostgreSQL for schema parity,
multi-user RBAC, and tenant-boundary testing. It does not create host Unix
accounts or POSIX branch groups.

## Start

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  --profile postgres up --build postgres agor-dev
```

The checked-in `.agor.yml` variants provide the usual branch-specific ports and
project names. The `full` variant enables PostgreSQL, branch RBAC, and
`execution.unix_user_mode: sandbox`; it requires bubblewrap/user-namespace
support and fails closed if the sandbox cannot start.

## Relevant environment overrides

```text
AGOR_DB_DIALECT=postgresql
DATABASE_URL=postgresql://...
AGOR_RBAC_ENABLED=true
AGOR_UNIX_USER_MODE=simple|sandbox|delegated
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
docker compose --profile postgres down
docker compose --profile postgres down -v
```

See
[`apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx`](../apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx)
and
[`context/guides/rbac-and-unix-isolation.md`](../context/guides/rbac-and-unix-isolation.md).
