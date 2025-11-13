# Logging in Agor

Agor uses an environment-aware logging system that respects log levels.

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

```typescript
import { createLogger } from '@agor/core/utils/logger';

const log = createLogger('my-module');

log.debug('Detailed debugging info');
log.info('General information');
log.warn('Warning message');
log.error('Error message');
```

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

## Namespaces

Each module creates its own namespaced logger:

```typescript
const log = createLogger('git');     // [git] prefix
const log = createLogger('repos');   // [repos] prefix
const log = createLogger('auth');    // [auth] prefix
```

This makes it easy to filter logs by module in production.
