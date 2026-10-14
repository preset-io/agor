# Demo-video pipeline backlog

Ideas parked while building the syllabus — not blocking, revisit between
lesson batches.

## ✅ SHIPPED: Per-lesson state checkpoints ("migrations as cache") — Evan, 2026-08-30

Each lesson, when it runs for real, could persist the workspace-state delta
it produces, so any later lesson can start from blank/baseline plus the
chain of prior lessons' state — like alembic migrations acting as a cache.
Run lesson N solo without replaying lessons 0..N-1 through the UI.

Implementation note: the workspace is one SQLite file + one git data-home
directory at stable paths, so a full **scratch-dir snapshot per green
lesson boundary** (copy `~/.agor-e2e/runtime` → `.checkpoints/NN-id/`)
gives the same ladder with less machinery than logical migration files —
restore checkpoint N-1, then `AGOR_E2E_KEEP_SCRATCH=1` run lesson N.
Snapshots also capture worktree/filesystem state that no DB migration
could. Cassette chunking (AGOR_E2E_CASSETTE_APPEND=1) already lets the
recorded API traffic accumulate the same way.

Shipped 2026-08-31: `openLesson` snapshots `pre-<lessonId>` to
`~/.agor-e2e/checkpoints/` via APFS clone (`cp -Rc`, near-instant);
restore with `AGOR_E2E_FROM_CHECKPOINT=pre-<lessonId>`. Paid for itself
the first night — lesson 09's final take restored from checkpoint instead
of re-burning the whole ladder. Still open: checkpoint invalidation when
an earlier lesson's script changes (hash the spec files into the name?).

## Native-4K capture

Blocked on host load: 4K screencast + VP8 encode starved the executor
heartbeat during live turns (see ONBOARDING_FINDINGS.md #10). Revisit with
encoder speed 8 at 4K, or capture 4K only for replay runs (no live agent
in the process mix). The reel already upscales 1080p → 4K30 via lanczos.

## Heartbeat-tolerance product fix (PR)

`heartbeat_lost` termination kills healthy turns under transient stalls;
Evan approved a focused PR + cherry-pick when we're ready. Needs
`context/concepts/task-runtime-state.md` care and reconciler tests. The
harness workaround (`execution.executor_heartbeat.stale_after_ms: 900000`)
unblocks recording meanwhile.

## Contiguous multi-lesson recordings

Some lessons could record as one continuous take with title pauses
(e.g. 01→02, 04→08). Deferred by Evan until the syllabus is fuller.
