# Branch workspace benchmark procedure

These results are development measurements on the local Mac recorded in the
JSON environment fields. They do not certify Linux instance-store NVMe, XFS
reflink, production PostgreSQL/S3 latency, or native SDK integration. Targets
remain unchanged. Single command pairs are not percentile estimates.

## Reproduce

Install the locked workspace dependencies. On a dedicated Linux NVMe worker:

```sh
AGOR_WORKSPACE_BENCH_ROOT=/var/lib/agor/bench \
AGOR_WORKSPACE_BENCH_SOURCE=/path/to/agor \
AGOR_WORKSPACE_BENCH_OUTPUT=/tmp/workspace-results.json \
pnpm --filter @agor/core exec vitest run src/workspaces/benchmark.test.ts
```

The root must already exist on the storage under test. The benchmark creates
and removes only its own temporary child. It tests full-repository copy and
forced reflink, first creation and subsequent refresh, one/100-file publication,
64 MiB excluded output, concurrent 2/4/8 executor publication, checkpoint, warm
activation and cold restore. The four-branch test uses a small fixture and must
be repeated with representative large repositories for capacity planning.
Metadata is a serialized in-memory authority and blobs are local compressed
objects. SQL/S3 timings must be measured separately with deployed adapters.
Failed forced clones are recorded rather than silently downgraded to copies.

For command costs, prepare two identical **disposable** local directories on
the same device, install their required tools, and run:

```sh
node scripts/benchmark-workspace-commands.mjs /tmp/baseline /tmp/replica /tmp/commands.json
# Rerun selected commands after diagnosing a failure:
AGOR_WORKSPACE_BENCH_COMMANDS=typecheck,build node scripts/benchmark-workspace-commands.mjs /tmp/baseline /tmp/replica /tmp/commands-retry.json
```

Agor calls its typing command `pnpm typecheck`. The script runs install,
typecheck and build cold/warm in both directories. Cold removes root Turbo
cache and, for install, root node_modules; it does not clear every package
cache, global pnpm store, compiled output or OS page cache. Warm build/typecheck
can be Turbo cache hits. This is not an empty-store install measurement.
The checked-in command measurements used two plain local source copies, not
native SDK sessions or a deployed managed worker. Their comparison establishes
local-directory command costs only. For release qualification use a coordinator
replica, identical dependency state and at least 20 alternating-order runs on
an otherwise idle NVMe host. Record complete tool-boundary overhead separately.

## Local results

`macos-commands-initial.json` retains initial successes and failures. Install
passed (cold ratio 0.862, warm 0.977). Initial typing/build failures are retained;
`macos-commands-final.json` records the successful corrected rerun:

| Command        | Baseline | Replica directory | Ratio |
| -------------- | -------: | ----------------: | ----: |
| Typecheck cold | 39.165 s |          41.083 s | 1.049 |
| Typecheck warm |  1.494 s |           1.408 s | 0.942 |
| Build cold     | 55.121 s |          55.272 s | 1.003 |
| Build warm     |  1.392 s |           1.340 s | 0.963 |

Those pairs are within 10%, but cannot establish the NVMe requirement.
`macos-initial.json` is the initial full-refresh baseline.
`macos-incremental.json` records incremental-refresh improvement: first replica
3.043 s, subsequent unchanged refreshes 20.9–24.1 ms; one-file publication
1.273 s and 100-file publication 1.314 s. Source extraction took about 1.77 s
at median, while in-memory revision commit p95 was about 14.2 ms. These are
distinct operations. The initial/incremental concurrency batches reserved
replicas concurrently but published sequentially; the final harness publishes
concurrently and labels fresh creation separately from warm refresh.

## Acceptance and remaining bottlenecks

Fresh portable copy creation and small publication **miss** the 500 ms and
100 ms targets. Incremental unchanged refresh meets 100 ms in the local sample;
this is not a measured guarantee for applying changed revisions. Full-tree
scan/hash extraction dominates small publication. Next performance work is a
trusted local change journal with full-scan recovery, bounded parallel blob
staging, and measured Linux CoW clone/refresh. Never skip conflict validation
or acknowledge before durable blob storage to improve timings.

Node's forced reflink is unsupported on this Mac (ENOSYS); no Linux reflink or
OverlayFS comparison is claimed. OverlayFS is not implemented. Checkpoint and
restore are measured separately in raw results; local blob timings exclude
AWS transfer, KMS and PostgreSQL costs. Concurrent build activity can distort
these development samples. Certification still requires isolated NVMe runs,
large multi-branch workloads, fault injection under load, actual S3/SQL,
retained-cache growth and disk/inode-pressure tests.

The final run (`macos-final.json`) measured:

| Operation                             |         Observed duration |
| ------------------------------------- | ------------------------: |
| Initial repository materialisation    |                  12.498 s |
| First copy replica                    |                   3.112 s |
| Unchanged warm refresh, p95 of 4      |                 26.982 ms |
| One-file complete publication         |                   1.272 s |
| 100-file complete publication         |                   1.491 s |
| Excluded 64 MiB output publication    |                   1.394 s |
| Concurrent 2 / 4 / 8 executor batches | 6.755 / 12.830 / 16.256 s |
| Four branches, small fixture          |                 23.919 ms |
| Full-repository checkpoint            |                 25.478 ms |
| Warm branch activation                |                 15.492 ms |
| Cold restore to another root          |                   4.155 s |

Every concurrent publication was asserted committed. Observer aggregate groups
mix full-repository and small-fixture operations; use explicitly named samples
for comparisons, not pooled percentile groups. None of the single observations
above, except the explicitly labelled refresh sample, is a p95 estimate.
