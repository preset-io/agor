# @agor/executor

Isolated execution environment for Agor - separates privileged daemon operations from untrusted execution contexts.

## Overview

The executor is a standalone Node.js process that:
- Runs as a separate Unix user (via sudo impersonation)
- Executes untrusted code (agent SDKs, terminals, MCP servers)
- Has NO access to database or API keys in environment
- Communicates with daemon via JSON-RPC over Unix sockets

## Architecture

```
Daemon (privileged)
  ↓ spawns via sudo
Executor (unprivileged)
  ↓ IPC (Unix socket)
Communication
```

## Security Properties

- **No database access** - Executor never receives DB connection string
- **Just-in-time API keys** - Executor requests keys per-call from daemon
- **Unix user isolation** - Runs as different UID/GID
- **Audit trail** - All IPC calls logged

## Usage

```bash
# Spawned by daemon (not run directly)
agor-executor --socket /tmp/executor-abc123.sock
```

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm dev

# Test
pnpm test
```

## IPC Protocol

See `context/explorations/ipc-message-catalog.md` for complete message type definitions.

### Example: Ping Request

```json
// Daemon → Executor
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "ping",
  "params": {}
}

// Executor → Daemon
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "pong": true,
    "timestamp": 1234567890
  }
}
```

## Related Documentation

- `context/explorations/executor-isolation.md` - Main architecture
- `context/explorations/executor-implementation-plan.md` - Implementation roadmap
- `context/explorations/ipc-message-catalog.md` - Message type definitions
