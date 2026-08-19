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
