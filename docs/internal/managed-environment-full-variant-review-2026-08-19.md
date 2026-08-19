# Managed environment `full` variant review

**Status:** Renamed with compatibility alias
**Scope:** Agor repository's checked-in `.agor.yml` and Docker development profiles

## Finding

The capability historically named `full` is not redundant with `postgres`:

- `postgres` selects `docker-compose.override.postgres.yml`. It changes the database to
  PostgreSQL but leaves branch RBAC off and local execution in trusted `simple` mode.
- `rich` selects `docker-compose.postgres.yml`. It enables PostgreSQL, branch RBAC,
  `execution.unix_user_mode: sandbox` (therefore fail-closed per-user bubblewrap isolation), and
  Alice/Bob RBAC fixtures.

Both use the source-mode development image, bind-mounted checkout, Vite UI, development seed, and
standalone daemon topology. Neither is a production deployment profile. The separate `ha` variant
is the constrained active-active smoke topology; it currently uses a static tenant, shared storage,
PostgreSQL, ephemeral Redis, two daemon processes, and nginx affinity, with branch RBAC off.

All source-mode PostgreSQL variants (`postgres`, `postgres-demo`, `rich`, and the `full` alias) skip
`agor init` so that they do not create an unrelated SQLite database. They therefore need a separate
config-only bootstrap for the required deployment identity and secrets. The source entrypoint now
creates a random `daemon.deployment_id`, JWT secret, and master secret only when `config.yaml` is
absent, persists them in the project-scoped `agor-home` volume, and validates rather than rewriting
an existing config. SQLite variants continue to get these values from `agor init`. The HA smoke
stack already supplies one checked-in identity shared by its two replicas; the docs-only variant has
no daemon.

`full` was introduced by PR #1042 as PostgreSQL + RBAC + `strict` Unix-user impersonation. PR #1665
moved it onto the richer PostgreSQL/RBAC overlay, PR #2260 repaired its strict-mode bootstrap, and
PRs #2362/#2375 replaced and then removed host impersonation. The capability remains useful, but
`full` incorrectly implied that it also included the separate HA topology.

## Recommendation

Rename the capability to `rich`, while retaining `full` as a deprecated compatibility alias. Do
**not** merge it into `postgres`: database parity is faster and intentionally does not exercise
RBAC or fail-closed executor containment. `rich` denotes the broader standalone development
profile, not every Agor capability; HA deliberately remains separate.

The current single-level inheritance model provides compatibility without a schema change:

```yaml
environment:
  default: sqlite
  variants:
    rich:
      # existing full commands, including explicit health/app fields
    full:
      description: Deprecated compatibility alias for `rich`
      extends: rich
```

- Rendering `full` continues to resolve the same commands and retains `full` as the branch's
  provenance key.
- UI pickers show both names, with the `full` description identifying it as deprecated. New branches
  should select `rich`.
- Existing rendered start/stop/nuke/log commands remain snapshots and are not rewritten implicitly.

## Compatibility constraint

`branches.environment_variant` persists an arbitrary **repo-defined** string, while rendered
commands are also persisted on each branch. Removing `full` from this repo would not immediately
erase an existing branch's commands, but it would make explicit re-rendering and new selection fail
after the repository configuration is re-imported. Editing `.agor.yml` also does not retroactively
update the repository row or branch snapshots.

A global database migration from `full` to `rich` would be unsafe because another
repository can legitimately define a different variant named `full`. Migration must be scoped to a
specific repo/config identity, or performed by re-rendering known Agor-repo branches after the alias
ships. Checked-out or running branches must not be silently changed.

## Naming rule going forward

Treat `rich` as a documented convenience profile rather than an exhaustive capability claim. Keep
topology-specific profiles such as `ha` separate, and keep each variant's concise description as the
user-facing capability contract in `.agor.yml` and the picker.
