# OpenCode in Agor Cloud — acceptance scenarios

Canonical design: [`context/explorations/opencode-cloud.md`](../../../context/explorations/opencode-cloud.md).

This directory holds the executable acceptance scenarios for the hosted OpenCode
first release, the retained local proof scripts, and the proof log. Scenario
files use stable IDs (`OC-xx`) so implementation slices, review findings, and
QA evidence can reference them. Evidence from a QA run belongs in the task or
pull request, not in this directory.

| File                           | Purpose                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| [`scenarios.md`](scenarios.md) | Acceptance scenarios with preconditions, steps, and passing observations                 |
| [`proof-log.md`](proof-log.md) | Local developer proof already performed (pinned executable, no credentials)              |
| `local-spike-storage.mjs`      | Replayable spike: `OPENCODE_DB` placement, SIGKILL recovery, main-file-only copy failure |
| `local-spike-concurrency.mjs`  | Replayable spike: two writers on one DB, checkpoint-publish, resume from a single file   |

Replay a spike (no provider credentials, no network beyond loopback):

```bash
node qa/specs/opencode-cloud/local-spike-storage.mjs \
  "$(pnpm --silent exec which opencode || echo node_modules/.pnpm/opencode-darwin-arm64@1.14.33/node_modules/opencode-darwin-arm64/bin/opencode)" \
  "${TMPDIR:-/tmp}/opencode-spike-run1"
```

Formal QA status: **not run**. Section 11 of the design lists the environment
prerequisites; the scenarios below mark which boundary each one needs.
