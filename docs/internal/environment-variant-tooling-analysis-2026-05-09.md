# MCP environment-variant tooling: shape analysis (2026-05-09)

Status: archival. Captures the design analysis behind splitting variant
configuration off the `start` verb into a dedicated `agor_environment_set`
tool, instead of overloading `agor_environment_start({ variant })` as proposed
in PR #1122.

## Context

`Worktree.environment_variant` is already a persistent column
(`packages/core/src/db/schema.{sqlite,postgres}.ts`,
`packages/core/src/types/worktree.ts`). The daemon already exposes:

- A service method `WorktreesService.renderEnvironment(id, { variant? })` that
  validates admin permission for variant changes, persists the new variant,
  and re-renders all materialized command strings (start/stop/nuke/logs/
  health/app) from the repo's Handlebars templates
  (`apps/agor-daemon/src/services/worktrees.ts`).
- A REST endpoint that wraps the same method
  (`POST /worktrees/:id/render-environment`).
- UI that calls the REST endpoint from the variant picker
  (`apps/agor-ui/src/components/WorktreeModal/tabs/EnvironmentTab.tsx`).

What was missing on `main`: any MCP-tool surface to drive the variant.

## Three candidate shapes

### Shape A — `agor_environment_start({ variant })` (PR #1122)

Variant is an optional param on `start`. When present and different from the
persisted variant, the handler calls `renderEnvironment({ variant })` first,
then `startEnvironment()`. Refuses to switch when env is `running`/`starting`.

### Shape B — `agor_environment_set({ variant, andStart? })` (this PR)

Variant lives on a dedicated configuration verb. `agor_environment_start` stays
a pure execution verb that always uses the persisted variant. A convenience
`andStart=true` covers the one-shot configure-and-run case.

### Shape C — `agor_worktrees_update({ environment_variant })`

Just expose the field on the existing `update` tool.

## Comparison

| Criterion | Shape A | Shape B | Shape C |
|---|---|---|---|
| State visibility — agent/UI can see what's configured | Yes (variant persists), but mutation is hidden behind `start` | Yes, mutation is the explicit purpose of the verb | Yes, but doesn't re-materialize commands |
| Idempotency of `start` | `start({ variant: X })` mutates DB then runs; `start()` only runs | `start()` always does the same thing | n/a |
| Multi-agent safety | Agent A's `start({ variant: 'sqlite' })` silently overwrites agent B's prior config | Variant change is its own visible event | Same as B for the field, but commands go stale |
| API surface added | 0 new tools (overloads existing) | 1 new tool | 0 new tools, but breaks the invariant that env commands match the variant |
| Mental-model fit | "configure" is a side effect of "execute" | "configure, then execute" — matches `docker-compose`, `kubectl apply + rollout`, etc. | "set a string" understates the operation (it actually re-renders 6 fields) |
| Mirrors existing service surface | No — bundles two service calls behind one verb | Yes — 1:1 with `WorktreesService.renderEnvironment` and the REST endpoint | No — would skip `renderEnvironment` entirely |
| Render-without-start (current REST capability) | Not exposed | Default behavior (`andStart` defaults to `false`) | Not addressed |
| One-shot configure-and-run | Default behavior | Opt in via `andStart=true` | Requires two tool calls |

## Decision

**Shape B**, implemented as `agor_environment_set({ worktreeId, variant?, andStart? })`.

Rationale:

1. **Variant is already first-class persistent state.** The data model says so;
   the UI already reads it. The remaining question is just how MCP mutates it.
2. **`renderEnvironment` is already the canonical operation** — service
   method, REST endpoint, UI integration. The MCP tool should mirror that, not
   bury the call inside `start`.
3. **Hidden mutation behind a verb is a multi-agent surprise.** Shape A's
   `start({ variant: X })` silently changes which command strings the worktree
   is configured to run, then runs them. With explicit `set`, configure and
   execute are separable, observable events.
4. **The convenience case is preserved.** `agor_environment_set({ variant,
   andStart: true })` matches PR #1122's one-shot ergonomics with no
   additional round-trips.

Shape C was rejected because variant change semantically requires
re-rendering: just setting `environment_variant` would leave `start_command`,
`stop_command`, `health_check_url`, etc. stale, which is worse than Shape A.

## What this PR keeps from #1122

- `agor_worktrees_create({ variant })` — clean addition. At create time there
  is no existing state to silently overwrite, so passing the variant as a
  create-time argument is honest about what it does.
- `ReposService.createWorktree` accepting `environment_variant` in its data
  shape — same rationale.

## What this PR drops vs #1122

- The `variant` param on `agor_environment_start`. Variant changes go through
  `agor_environment_set` instead.

## Naming choice: `set` vs `render`

Considered `agor_environment_render` (mirrors the internal service method
name). Rejected: MCP family naming uses intent verbs (`start`, `stop`,
`health`, `logs`, `nuke`, `open_app`) rather than service-method names. "Set"
fits the family and reads naturally with the `variant` arg. The tool
description spells out the blast radius (re-renders six fields, admin gate on
variant change) so the friendly name doesn't understate the operation.

## Behavior summary

| Call | Effect |
|---|---|
| `agor_environment_set({ worktreeId, variant: 'X' })` (env stopped) | Validates `X` against repo config; calls `renderEnvironment({ variant: 'X' })` (admin-only on change); persists `environment_variant=X` and re-materialized commands |
| `agor_environment_set({ worktreeId, variant: 'X', andStart: true })` | As above, then `startEnvironment()` |
| `agor_environment_set({ worktreeId, variant: 'X' })` (env running with variant ≠ X) | Refuses with `Stop it first` error; no DB mutation |
| `agor_environment_set({ worktreeId })` (no variant) | Re-renders the worktree with its current variant (or repo default if unset). Useful for picking up `template_overrides` changes |
| `agor_environment_start({ worktreeId })` | Unchanged. Runs the persisted commands. No `variant` param |
| `agor_worktrees_create({ ..., variant: 'X' })` | Validates `X`; persists initial `environment_variant=X` on the new worktree |
