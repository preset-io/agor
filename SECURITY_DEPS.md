# Dependency Security Notes

This file tracks advisories that cannot currently be resolved through
`pnpm.overrides` pins, the reason why, and the compensating mitigation.

Run `pnpm audit --audit-level=high --prod` to see the current state. Most
transitive advisories are addressed via the `pnpm.overrides` block in the
root `package.json`.

## Unresolved advisories

### `next` (docs site only) — requires major bump

- **Package:** `next`
- **Current:** `^14.2.35` (in `apps/agor-docs/package.json`)
- **Advisories:** multiple; all patched versions are in the `15.x` series
  (e.g. `>=15.0.8`, `>=15.5.10`, `>=15.5.13`, `>=15.5.14`, `>=15.5.15`).
- **Severity:** 2 high, 3 moderate.
- **Why not fixed:** Upgrading to `next@15` is a breaking change and
  requires coordinated migration of `apps/agor-docs` (`next.config`,
  router, image handling). Out of scope for a security-only patch bump.
- **Mitigation:**
  - `apps/agor-docs` is the static documentation site only; it does not
    process untrusted user input or handle authenticated traffic for the
    daemon or UI.
  - The docs site is excluded from the primary CI workflow
    (`.github/workflows/ci.yml` has `paths-ignore: apps/agor-docs/**`).
  - Tracked for a standalone upgrade PR.

### `@tootallnate/once` — deprecated transitive (low)

- **Package:** `@tootallnate/once`
- **Advisory:** low severity, patched `>=3.0.1`.
- **Why not fixed:** The package is deprecated upstream; consumers pin
  `1.x` / `2.x` via `agent-base` / `http-proxy-agent` chains that have no
  patched release on those majors. An override to `>=3.0.1` is rejected
  by peer ranges.
- **Mitigation:** Low-severity, transitive, used in local development
  network clients only. Will be removed once upstream consumers drop the
  dependency (most have already migrated to `agent-base@7`).

## Process

- Critical advisories must be pinned in root `pnpm.overrides` or
  documented here with a mitigation. High advisories should be pinned
  whenever feasible.
- `.github/workflows/ci.yml` `audit` job:
  - **Blocking:** `pnpm audit --audit-level=critical --prod`
  - **Advisory (non-blocking):** `pnpm audit --audit-level=high --prod`
    and `pnpm audit --audit-level=high` (full tree)
  - Runs on pushes to `main` and PRs targeting `main`, excluding
    `apps/agor-docs/**`, `context/**`, and `*.md` paths (docs-only
    changes skip the audit job).
- `.github/dependabot.yml` runs weekly grouped npm and
  github-actions updates.
