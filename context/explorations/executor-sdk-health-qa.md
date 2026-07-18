# Executor SDK Health QA Receipt

**Date:** 2026-07-17

**Tested implementation:** `3e21525050bdfd9406f5fca41d9311de3217a47d`

**Base:** `b357aa73d48bf8d2f3f57fb354a79abc618b7014`

**Platform:** macOS Darwin 25.5.0 arm64, same-UID/simple mode, Node 22.22.2, pnpm 11.13.0

## Outcome

The scoped architecture is implemented. Deterministic tests, full core/daemon/UI/CLI suites,
source typechecks, formatting, boundary checks, migration coverage, real macOS process-tree
containment, and repeated lifecycle/watchdog race suites pass.

The watchdog deliberately remains `observe` by default. The seven-day/100-real-turn dogfood
window is an external rollout gate and cannot be manufactured during implementation. No default
enforcement claim is made before that receipt exists. PostgreSQL live repository coverage was
also unavailable because `AGOR_TEST_POSTGRES_URL` was not configured; dialect-neutral migration
and repository tests pass, while the PostgreSQL-specific suite remains skipped.

## Architecture receipt

- One Task remains the lifecycle aggregate; no attempt/runtime/effect tables were added.
- One protected `reportRuntimeTelemetry` path carries heartbeat plus the latest pulse fact.
- One shared adapter callback and mapping module normalizes SDK activity.
- One watchdog and one pure decision function implement observe/enforce policy.
- One daemon termination coordinator and one process-group helper own local containment.
- Existing terminal Task/session/queue/callback behavior remains downstream of verified absence
  or explicit owner/admin force-fail.
- Templated/remote and cross-UID execution remain diagnose-only without a verified stop contract.
- Daemon restart keeps main's orphan-recovery behavior and records unverified termination.
- Unknown-but-active SDK vocabulary fails open and records one bounded diagnosis.
- `claude-code-cli` remains on its existing JSONL/process watcher.

## LoC and mechanism ledger

Product source means non-test source under daemon/UI/CLI/core/executor. Generated migration
metadata, tests, docs, and the plan are counted separately.

| Bucket                                                         |     Added | Deleted |        Net |         Plan target |
| -------------------------------------------------------------- | --------: | ------: | ---------: | ------------------: |
| Reapplied PR #1888                                             |       369 |      61 |       +308 | reported separately |
| Phase 1: launch classification                                 |        88 |      21 |        +67 |             <= +150 |
| Phase 2: guarded telemetry, including tenant-safe finalization |       163 |      40 |       +123 |             <= +150 |
| Phase 3: semantic pulses                                       |       198 |      21 |       +177 |             <= +250 |
| Phase 4: containment/coordinator                               |       612 |     162 |       +450 |             <= +450 |
| Phase 5: watchdog before contraction                           |       467 |      49 |       +418 |             <= +200 |
| Watchdog contraction                                           |        49 |      74 |        -25 |  contraction credit |
| Final redundant-comment contraction                            |         0 |      10 |        -10 |        Phase 6 <= 0 |
| Review hardening and mutation-surface contraction              |       191 |      88 |       +103 |   correctness delta |
| **Beyond PR #1888 (per-commit gross)**                         | **1,768** | **465** | **+1,303** |       **<= +1,200** |
| **Total (per-commit gross)**                                   | **2,137** | **526** | **+1,611** |       **<= +2,500** |
| **Final product diff**                                         | **1,938** | **327** | **+1,611** |       **<= +2,500** |

Phase 5's original slice estimate was too low: the final watchdog mechanism is +393 after its
own contraction. Review hardening then removed external Task update authority, constrained the
documented create/run API to dormant tasks, made deletion atomic queued-work cancellation, and
added strict executor patch, identity, configuration, and adapter-session boundaries. That
correctness delta exceeds the reviewed post-#1888 target by 103 net lines while remaining below the
global ceiling, with three focused production modules, three Task custom methods, one column, and
no new tables. The variance is disclosed rather than hidden by reclassification.

Deletion happened with replacement, not as a compatibility tail:

- Generic `tasks.patch` heartbeat writes were removed with `reportRuntimeTelemetry`.
- External Task update was removed; create accepts only `session_id`, `full_prompt`, and `created`
  status, queued deletion is one conditional repository operation, and executor patches use one
  allowlist.
- Local/templated launcher exit classification replaced the unconditional exit assumption.
- Single-PID Stop, direct stale-heartbeat failure, and direct executor-exit terminalization were
  replaced by the shared coordinator/process-group path.
- Claude's loop-internal idle check was removed with the independent Claude watchdog policy.

## Automated validation

| Area                    | Command/result                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Core full suite         | `pnpm --filter @agor/core test` — 108 passed, 1 skipped files; 2,821 passed, 2 skipped tests               |
| Daemon full suite       | `pnpm --filter @agor/daemon test` — 141 passed, 1 skipped files; 1,788 passed, 31 skipped tests            |
| UI full suite           | `pnpm --filter @agor/ui test` — 147 files, 941 tests passed                                                |
| CLI full suite          | `pnpm --filter @agor/cli test` — 3 files, 19 tests passed                                                  |
| Source typechecks       | Core, daemon, and executor `typecheck` all passed                                                          |
| Changed formatting/lint | Original 75-file diff and the 15-file review delta passed                                                  |
| Tenant boundaries       | `node scripts/check-multitenancy-boundaries.mjs` — passed                                                  |
| Short-ID contract       | `node scripts/check-no-ad-hoc-shortid.mjs` — passed                                                        |
| Focused telemetry       | Connection/telemetry and coordinator suites — 10 tests passed                                              |
| Focused watchdog        | Watchdog/heartbeat suites — 13 tests passed                                                                |
| Watchdog handoff        | Unacknowledged enforced failure stops liveness and exits after the bounded abort grace — passed            |
| Review hardening        | Task authority/identity, strict config, adapter session ownership, and handoff — 180 focused tests passed  |
| Migrations              | Core migration suite passed for both schema histories; PostgreSQL live repository test skipped without URL |

The full executor suite reached 38 passing files and 508 passing tests, with three unrelated
existing/environment failures:

- Two Gemini suites cannot import the installed OpenTelemetry ESM package because its published
  extensionless directory import is rejected by this Node runtime.
- One OpenCode MCP test expects an Authorization header that the unchanged production path does
  not receive. This branch only added the common activity callback in that adapter.

Focused tests for every executor file changed by this architecture pass. The two import failures
occur before changed Gemini test code loads; the OpenCode failure is outside the activity mapping.

UI/CLI source typechecks resolve the repository's stale built `@agor/core` declarations when
builds are intentionally forbidden by repository instructions. Their full runtime test suites
pass. No build was run.

## Repeated race and containment receipt

Each group was run three consecutive times on the tested implementation:

| Group                            | Per-run result | Covered boundaries                                                                                                                            |
| -------------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Real process group + coordinator |      7/7 tests | SIGTERM-ignoring leader/descendant, SIGKILL, absence proof, cross-UID fail-closed, user Stop, force-fail, concurrent Stop/watchdog precedence |
| Stop/heartbeat/startup/launch    |    39/39 tests | queue barrier, stale heartbeat, restart diagnostics/recovery, launcher classification, local/template startup timeout                         |
| Watchdog/pulse mapping           |    32/32 tests | silent-after-context signature, permission pause, tool pause, Claude idle, unknown-active fail-open, mapping manifest, coalescing             |

The containment test spawns a detached real process group whose leader and descendant both ignore
SIGTERM. Automatic terminality is allowed only after SIGKILL and `kill(-pgid, 0)` reports absence.
Cross-UID execution is verified to remain nonterminal/diagnose-only.

## Security, queue, and failure-path evidence

- External patches to daemon-owned lifecycle/telemetry fields are rejected.
- Executor methods require a task-scoped executor credential for that exact connected Task.
- Direct repository mutations use `runDatabaseTransaction`; manual patched events use the
  tenant-aware `emitServiceEvent`. The multitenancy boundary checker passes.
- Repeated pulse sequence does not refresh daemon `observed_at`; a higher sequence does.
- Heartbeat cadence coalesces 100 concurrent executor doubles with 100 pulses each to one latest
  Task write per heartbeat interval.
- Observe mode uses the same decision function as enforce mode and produces no abort,
  containment, lifecycle, callback, or queue side effect.
- Unknown-only active streams diagnose once and do not enforce.
- User Stop overrides a concurrent watchdog request and shares the same single containment
  operation; terminal side effects run once.
- Unverified containment leaves Task/session `STOPPING`, keeps the session non-promptable, and
  exposes the authorized, short-ID-confirmed force-fail path.
- Restart recovery preserves main's STOPPED/idle behavior and retains unverified diagnostics.

## SDK mapping manifest

The CI freshness assertion pins the reviewed resolved versions:

- Claude Agent SDK 0.3.197
- Codex SDK 0.144.0
- Gemini CLI Core 0.31.0
- Copilot SDK 0.2.2
- OpenCode SDK 1.14.33

Any resolved version change fails the mapping-freshness test until fixtures and mappings are
reviewed again.

## External rollout gates

These are deliberately not claimed by this implementation receipt:

1. Seven consecutive days and at least 100 real post-change turns in observe mode across every
   adapter for which global enforcement is desired, with zero unjustified would-fire events.
2. A representative macOS telemetry/write measurement during that dogfood window.
3. A live PostgreSQL repository run with `AGOR_TEST_POSTGRES_URL` configured.
4. Provider CI and reviewer/product acknowledgement after publication.

Until gates 1–2 pass, `observe` remains the default and `enforce` is an explicit reduced-confidence
operator opt-in. Until a runtime mode can verify group absence, it remains diagnose-only. These are
the plan's intended safety boundaries, not deferred production mechanisms.
