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

- `console.log()` / `console.debug()` → debug (hidden in production)
- `console.info()` → info
- `console.warn()` → warn
- `console.error()` → error

## Implementation

Applied once at daemon startup:

```typescript
import { patchConsole } from '@agor/core/utils/logger';
patchConsole();
```
