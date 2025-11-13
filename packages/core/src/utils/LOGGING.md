# Logging in Agor

Agor uses a **console monkey-patch** for environment-aware logging. This means all existing `console.log()` and `console.debug()` calls throughout the codebase automatically respect log levels.

## How it works

At daemon startup, we patch the global console methods to check `LOG_LEVEL` before outputting. This gives you zero-config log level filtering without changing any code.

## Configuration

Set log level via environment variables:

```bash
# Show all logs (debug, info, warn, error)
LOG_LEVEL=debug pnpm dev

# Show info and above (default in production)
LOG_LEVEL=info pnpm dev

# Show warnings and errors only
LOG_LEVEL=warn pnpm dev

# Show only errors
LOG_LEVEL=error pnpm dev

# Alternative: Use DEBUG env var (common convention)
DEBUG=agor:* pnpm dev
DEBUG=* pnpm dev
```

## Usage

Just use normal console methods - they're automatically filtered:

```typescript
console.debug('Detailed debugging info');  // Hidden in production
console.log('Also treated as debug');      // Hidden in production
console.info('General information');       // Shown in production
console.warn('Warning message');           // Shown in production
console.error('Error message');            // Always shown
```

## Log Level Mapping

- `console.log()` → **debug** level (hidden in production)
- `console.debug()` → **debug** level (hidden in production)
- `console.info()` → **info** level (shown in production)
- `console.warn()` → **warn** level (shown in production)
- `console.error()` → **error** level (always shown)

## Default Behavior

- **Development** (`NODE_ENV=development`): Shows debug and above
- **Production** (`NODE_ENV=production`): Shows info and above (hides debug logs)

## Examples

### Development (local)
```bash
# See all debug logs
pnpm dev
```

### Production (Codespaces)
```bash
# Default: hide debug logs, show info/warn/error
pnpm start

# Enable debug logs in production for troubleshooting
LOG_LEVEL=debug pnpm start

# Or use DEBUG convention
DEBUG=agor:* pnpm start
```

## Implementation

The monkey-patch is applied once at daemon startup in `apps/agor-daemon/src/index.ts`:

```typescript
import { patchConsole } from '@agor/core/utils/logger';
patchConsole();
```

This works across the entire codebase without requiring any imports or code changes.
