# Pull-request CI performance

## Baseline (27 August 2026)

The baseline was measured from 30 successful `CI` pull-request runs returned by
the Actions API (runs 8021--8110; the workflow was already on the current
single-job shape). Job and step timestamps came from
`GET /repos/preset-io/agor/actions/runs/{run_id}/jobs` and the run logs were
sampled for Turbo/Vitest summaries. The repository is public and all sampled
runs used the standard `ubuntu-latest` hosted runner.

| stage                                   |                p50 |                p90 | notes                                                          |
| --------------------------------------- | -----------------: | -----------------: | -------------------------------------------------------------- |
| queue (run created → job start)         |                3 s |                4 s | one burst had a 2,274 s queue outlier                          |
| checkout                                |                6 s |               41 s | occasional GitHub service variance                             |
| setup-node (pnpm store cache)           |               17 s |               26 s | one 107 s restore; cold restores are ~1 s                      |
| `pnpm install` (1,927 packages)         |               24 s |               38 s | cold download samples 36–42 s                                  |
| lint + policy checks                    |               33 s |               34 s | policy checks add ~10 s                                        |
| Turbo build + typecheck (30 tasks)      |              116 s |              122 s | `Cached: 0/30` across jobs; local cache is ephemeral           |
| Redis HA focused test                   |                5 s |                5 s | service startup is included in job setup                       |
| Turbo unit tests (5 packages, 11 tasks) |          **915 s** |          **986 s** | 15–16 min in the slow runs; 6/11 tasks are build-cache replays |
| browser install + browser tests         |        24 s + 12 s |        35 s + 16 s | six files/tests across three viewports                         |
| CLI tests (28 files)                    |               65 s |               67 s | intentionally serialized after Turbo                           |
| complete job                            | 1,238 s (20.6 min) | 1,339 s (22.3 min) | test stage is ~74% of the critical path                        |

The test log explains the bottleneck: five Vitest projects were launched by
Turbo on one runner, each with its own default worker pool. For example, run
8110 reported 276 UI files with a 981 s Vitest duration and aggregate test time
of 2,093 s. The pools compete for the hosted runner's CPU, so the slowest
package determines the serial job's wall time. No Turbo remote cache is
configured; the only cache is setup-node's pnpm store cache. A cold sample
(run 8096) downloaded the store in 36 s and saved the cache; warm samples still
spent 15–107 s restoring it plus 20–40 s linking packages.

## Critical-path model and options considered

The old path is approximately `install + lint + build + unit fanout + browser
install/browser + CLI` (about 20 minutes at p50). The new path runs independent
lint, build, six unit groups (UI is two deterministic Vitest shards), a
dedicated Redis HA lane, and the browser lane concurrently. The aggregate gate
waits for all of them, so a failed shard cannot produce a green required check.
Expected warm critical path is the slower UI shard or build lane (roughly 3–5
minutes), plus a short gate queue.

- **Parallel jobs/matrix (chosen):** removes worker-pool oversubscription and
  preserves focused logs. `fail-fast: false` keeps all shards diagnosable. The
  Redis-backed tenant-isolation test is isolated in its own service job rather
  than provisioning Redis on every unit shard.
- **Duplicated setup/install:** accepted. Most unit jobs use filtered pnpm
  installs (no docs/release tree); daemon uses a full install because its
  integration tests import executor source through an undeclared test edge.
  Daemon/CLI lanes additionally build their workspace dependency closure
  because those tests import published `dist` entrypoints. Hosted-runner
  minutes increase, but wall time drops materially.
- **Artifacts/build sharing:** not needed for source-resolving Vitest suites.
  The build lane owns the compiled executor unit/runtime checks. No untrusted
  build artifact crosses jobs.
- **Turbo remote/GitHub cache:** not enabled. A remote token would be a secret
  unavailable to fork PRs, and broad `.turbo` caches create trust and save
  contention questions. Local Turbo reuse still deduplicates build/typecheck in
  the build lane. The pnpm store cache remains the standard setup-node cache;
  it contains public dependency bytes only and fork saves cannot write the base
  branch cache.
- **Vitest workers/sharding:** each runner hosts one package pool. UI uses
  Vitest's built-in `--shard=1/2` and `2/2`, which partitions the exact included
  file set; no test is selected by a path heuristic. Other packages keep their
  tested configs and default worker policy.
- **Larger runners:** an 8-core runner could reduce contention but requires an
  organization plan and increases per-minute cost. The public standard runner
  is the portable default; this can be revisited after measuring the PR.
- **Path-aware skipping:** unchanged. Existing conservative docs/context PR
  filters and separate PostgreSQL, docs, audit, Docker, and packaged-install
  workflows remain intact.
- **Cancellation:** PR runs now use a workflow concurrency group, cancelling a
  superseded commit and avoiding stale queue/minute spend. Main pushes remain
  uncancelled.

## Coverage and failure UX

`scripts/ci-test-matrix.mjs` is the package-group manifest and validates the
workflow's YAML matrix against its runnable groups. The lint lane runs
`check:ci-test-coverage` before expensive work; it fails if any workspace with
a `test` script is missing, duplicated (except the two intentional UI shards),
or stale, and it verifies build-owned executor checks. The ten test-bearing
workspaces are covered exactly once (UI's two entries are file shards), and the
two `.browser.test.tsx` files are intentionally owned by the browser lane. The
compiled executor tests/runtime smoke run once in the build lane. The stable
job name remains `Lint, typecheck, build, test`, so the existing required
context `CI / Lint, typecheck, build, test (pull_request)` needs no branch
protection migration.

If the matrix is reverted, restore the previous `ci.yml` and remove the two
manifest scripts; no database or package format migration is involved.

## Observed PR run

Run `33047235362` for PR #2572 (commit `561cbf6d`) completed successfully in
**346 s (5 m 46 s wall-clock)** from the first runner start to the aggregate
gate. This is a 72% reduction from the 1,238 s baseline p50. Lane durations
from the Actions job API were: build/typecheck 210 s, UI shard 1 275 s, UI
shard 2 340 s (critical path), daemon unit 253 s, core 196 s, CLI 155 s,
support 87 s, browser 80 s, Redis HA 93 s, and lint 88 s. The gate itself took
3 s. The run used warm setup-node pnpm caches (15–31 s setup; 15–46 s install
or filtered install), while the build lane still had no reusable Turbo remote
cache. An earlier exploratory run exposed a flaky UI popover assertion; the
final observed runs require a clean pass with no CI retry policy, so a
recurrence remains visible and fails the required gate.
