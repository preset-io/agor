# RBAC migration: unattributable owner quarantine

**Status:** accepted for the unreleased capability-policy migration  
**Applies to:** PostgreSQL `0095`, SQLite `0098`

## Problem

The first version of the offline RBAC cutover added nullable primary-owner
columns, filled them from legacy authority, and then aborted if any value was
still NULL. A real legacy database contained a Board created by the old
`anonymous` sentinel with no corresponding User or owner row. There was no
truthful owner to select, so the database-wide migration failed even though the
remaining resources were attributable.

Assigning an arbitrary administrator, manufacturing an `anonymous` User, or
copying ambient/group grants onto that Board would turn missing provenance into
new authority. Deleting the Board would discard user data. None is acceptable.

## Decision

The ownership backfill is best-effort and convergent:

1. Keep an already populated primary owner (important for safe data-step
   retries).
2. Otherwise select the oldest legacy owner row that references an existing
   same-tenant User, with the User ID as the deterministic tie-breaker.
3. Otherwise use `created_by` only when it references an existing same-tenant
   User.
4. Otherwise leave `primary_owner_user_id` NULL.

NULL is a reserved **legacy quarantine marker**, not a valid creation state.
Repository creation and insert triggers still require a real owner. Existing
non-NULL ownership remains immutable. An offline, audited repair may change
NULL to an existing same-tenant User exactly once; it cannot transfer an
already-attributed resource.

For an ownerless Board or Branch the migration creates a private normalized
policy with `Others: none`, no filesystem access, no named entries, and no
personal-session sharing. Invalid legacy user/group references are ignored
rather than allowed to abort the cutover. Valid resources retain the original
equal-or-less mapping. Legacy runtime authority is still tombstoned, and no
Board or Branch row is deleted.

Point and set-based normalized authorization independently require a non-NULL
owner. This defense prevents a damaged or manually widened policy row from
making a quarantined resource visible. Diagnostics expose only aggregate Board
and Branch counts; resource IDs, creators, principals, and tenant identifiers
do not enter shared migration logs.

## `branch_rbac=false`

The schema cutover is unconditional because a deployment may enable RBAC
later. `execution.branch_rbac=false` intentionally bypasses normalized
application authorization for trusted installations; it is not a second
legacy authority mode. The migration therefore still creates private
quarantine policies and tombstones the legacy fields, but the flag continues
to mean that those policies are not enforced until RBAC is enabled. Sandbox
mode enables RBAC automatically.

Operators who require the quarantine boundary at runtime must enable RBAC (or
use sandbox mode) before restarting. Repair remains an offline ownership and
policy-review operation; the migration never guesses merely because RBAC is
disabled.

## Multi-tenant and retry properties

PostgreSQL uses transaction-local, migration-specific RLS policies to process
all tenants, then drops those policies before commit. Every attribution join is
tenant-qualified. The migration emits aggregate cross-database counts, while
ordinary reads after cutover remain tenant-scoped by forced RLS.

Both dialect migrations are transactional. The backfill updates only NULL
owners, deterministic selection makes a repeated data step stable, and policy
copying filters out invalid principals. A failed transaction can therefore be
retried without changing an already-established owner.

## Verification

- SQLite executes the real migration against synthetic attributable,
  ownerless, and dangling-principal rows.
- PostgreSQL executes the real `0094 -> 0095` upgrade in a disposable database,
  including two non-default tenants and a cross-tenant negative assertion.
- Repository authorization tests corrupt a quarantined policy to permissive
  values and still require point, inventory, realtime, and prompt checks to
  deny access.
