# Logging in Agor

Console monkey-patch for log level filtering.

This document owns the exact mechanics of the current implementation. For rules governing what may
be logged, see the
[operational logging guidelines](../../../../context/guidelines/logging.md).

## Usage

```bash
# Set log level
LOG_LEVEL=debug pnpm dev   # Show all logs
LOG_LEVEL=info pnpm dev    # Hide debug logs (production default)
LOG_LEVEL=warn pnpm dev    # Warnings and errors only
LOG_LEVEL=error pnpm dev   # Errors only

# Or use DEBUG env var
DEBUG=agor:* pnpm dev
```

## Log Levels

- `console.debug()` → debug (hidden in production)
- `console.log()` → info
- `console.info()` → info
- `console.warn()` → warn
- `console.error()` → error

The `console.log()` → info mapping is a known deviation from the intended logging
contract and is tracked separately. It is documented here as the current behavior.

## systemd journal priorities

When `JOURNAL_STREAM` is present, `patchConsole()` adds sd-daemon severity prefixes
to every emitted line: `<7>` for debug, `<6>` for info/log, `<4>` for warnings, and
`<3>` for errors. With `StandardOutput=journal` and `SyslogLevelPrefix=yes`, systemd
uses these prefixes as journal priorities and removes them from the stored message.

Arguments are formatted together before prefixing, so every line of a multi-line
string, error stack, or object dump receives the same priority. Outside systemd,
arguments remain unmodified and output stays unprefixed.

## Process output destinations

The patch forwards permitted calls to the corresponding original console method. In foreground
development, stdout and stderr appear in the terminal. The installed CLI's detached daemon opens
the same `~/.agor/logs/daemon.log` file for both streams. Containers, systemd, and other process
managers may capture and route them differently.

## Codex runtime diagnostics

`packages/executor/src/sdk-handlers/codex/runtime-diagnostics.ts` owns the
`[codex.runtime]` operational events. Correlate using the authorized invocation's
`session_id` / `task_id` and the locally generated `reference=<run UUID>:<sequence>`.
These identifiers are operator correlation data, not authorization or provider
request IDs. They must stay in access-controlled operational logs, not public
analytics or another tenant's conversation. Terminal references are log-only;
generic user errors and the existing notice text are unchanged.

The collector shares a 20-detail budget across item notices, MCP failures, and
stream-error observations per invocation. It reserves one additional terminal
failure detail and emits one `diagnostics_limited` omission summary on completion
when needed. A stream error remains `outcome=awaiting_terminal_event`: it neither
ends the turn nor establishes retryability. No automatic replay is added.

**Source limits (pinned `@openai/codex-sdk` 0.156.1):** `dist/index.d.ts` declares
`ThreadError` / `ThreadErrorEvent` with only `message`, and item notices with
`id`, `type`, and `message`. `Thread.runStreamedInternal` parses CLI JSONL without
adding diagnostic fields. `CodexExec.run` forwards native spawn exceptions, but
flattens CLI exit code/signal and stderr into an ordinary Error message; JSONL
parse failures also become an Error containing raw input. We never parse, log,
hash, or persist that prose through this diagnostic channel. Consequently:

- Message-only 401, 429, context-limit, invalid-request, and runtime failures
  remain `category=unknown metadata=unavailable`. This is missing evidence,
  not proof that authentication, quota, context, or the runtime is healthy.
- Structured metadata, **if actually present**, retains the existing MCP
  sanitizer's closed HTTP status range and network-code allowlist. HTTP fields
  are defensive extension handling, not a promise that Codex emits them.
- A small additional allowlist of native runtime errno codes (for example
  `ENOENT`, `EACCES`) is logged as `runtime_failure` / `SystemError`. These are
  observations, not root-cause diagnoses; `ENOENT` does not identify which path
  was missing. No path, syscall, command, stderr, arbitrary provider code/type,
  URL, prompt, tool payload, stack, or cause is logged.
- `configuration_required` can also reflect Agor's existing local missing-auth
  check. Classification never changes lifecycle decisions or user-facing errors.

More precise provider classification requires an upstream structured exec/SDK
error contract and a reviewed mapping at that boundary. App-server error shapes
must not be assumed to exist on the exec JSONL path. Do not enable raw SDK dumps
or add freeform message matching to fill this gap.

## Operator runbook: systemd journal to Datadog

Agor owns the console stream and the detached CLI's file capture, **not** a
Datadog host Agent installation. This repository contains APM instrumentation
but no host `conf.d/agor.d/conf.yaml`, journald collector deployment, or systemd
unit provisioning. The infrastructure source of truth/owner must be identified
before rollout; an application release alone cannot correct a missing collector.

Use this procedure for a daemon whose stdout/stderr go to the journal while
Datadog is configured to tail an absent `~/.agor/logs/daemon.log`. Do not create
an empty file, redirect daemon output, or add an application file logger to make
that tailer appear healthy. An example `journald.d/conf.yaml.example` is not an
active configuration. APM traces and DogStatsD metrics do not prove log ingestion.

1. **Inventory without changing production.** An authorized operator should
   inspect only the required unit properties, for example:
   `systemctl show agor-daemon-with-full-apm.service -p FragmentPath -p StandardOutput -p StandardError -p SyslogLevelPrefix`.
   Substitute the actual deployment unit; its name is not a repository default.
   Compare a bounded journal time window of `[codex.runtime]` events with the
   Agent's active log sources. Inspect configuration locally without exporting
   credentials, environment dumps, or complete journal/Agent support bundles.
2. **Prepare an infrastructure change, not a live edit.** Confirm the installed
   Agent version, `logs_enabled: true` in its main configuration, and its existing
   authorized journal-read access. Review the unit's log content and disable
   legacy raw SDK/debug dumps before adding a retained destination. Require
   operator-only access and approved retention for session/task correlation.
   In the deployment owner's managed `journald.d/conf.yaml`, a unit-scoped
   source can be configured as follows (retain the deployment's service/env tags):

   ```yaml
   logs:
     - type: journald
       include_units:
         - agor-daemon-with-full-apm.service
       source: journald
       service: agor-daemon
   ```

   Do not omit `include_units`: that can collect the entire host journal. Do not
   add wildcard unit collection or broaden journal permissions without review.
   Check for overlapping journal/file sources to avoid duplicates. Remove only
   the stale Agor file-tail entry once its lack of a writer is confirmed; preserve
   unrelated sources. See the [Datadog journald integration](https://docs.datadoghq.com/integrations/journald/)
   for version-specific options, journal locations and access requirements.

3. **Deploy separately with operator approval.** Validate the managed Agent
   configuration with `datadog-agent configcheck` locally, then use the
   infrastructure owner's approved Agent rollout/restart procedure. No daemon
   restart or routing change is required for collection alone. Keep prior
   configuration for rollback; this runbook does not authorize production changes.
4. **Verify end to end, without replaying a user's prompt.** In
   `datadog-agent status`, verify the journald source is active with no read or
   forwarding errors. Compare an already occurring, post-rollout diagnostic's
   timestamp, session/task/reference and event between the unit journal and
   Datadog, checking tags, parsing, duplicates and restricted visibility. A
   healthy Agent alone is not proof. If there is no natural event, use only an
   independently approved staging synthetic diagnostic, not a customer session
   or live provider request. Confirm a configuration redeploy preserves the
   source. Historical journal backfill is not guaranteed; verify retention and
   cursor behavior before promising recovery of older incidents.
5. **Rollback if necessary.** Restore the prior managed collector configuration
   through the same approved process; verify unrelated sources remain healthy.
   Do not change application error redaction or daemon routing as a rollback.

Collection restoration and better diagnostics do not establish the cause of a
particular failed Codex turn. A message-only event can still remain unknown
after both changes are deployed.

## Legacy raw SDK-message diagnostic

The Claude SDK message processor currently checks `DEBUG_SDK_MESSAGES=true` and writes every full
SDK message with `console.log()`. This check is independent of `LOG_LEVEL`, and the output is
unredacted. Because `console.log()` maps to `info`, the dump is emitted whenever the configured
threshold permits info output.

This is a legacy unsafe diagnostic, not a pattern for operational logging. Under the
[operational logging policy](../../../../context/guidelines/logging.md), it must not be enabled where
process output is retained or shared, and new logging must not copy it.

## Implementation

The daemon and executor each apply the patch at process startup from
`apps/agor-daemon/src/index.ts` and `packages/executor/src/index.ts`, respectively:

```typescript
import { patchConsole } from '@agor/core/utils/logger';
patchConsole();
```
