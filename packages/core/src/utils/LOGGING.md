# Logging in Agor

Console monkey-patch for log level filtering.

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

## Implementation

Applied once at daemon startup:

```typescript
import { patchConsole } from '@agor/core/utils/logger';
patchConsole();
```
