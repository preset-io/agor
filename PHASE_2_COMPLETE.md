# Phase 2: Daemon Integration - COMPLETE ✅

## Summary

Phase 2 of the Executor Isolation feature is complete! The daemon can now spawn and communicate with executor subprocesses via IPC.

## What Was Built

### 1. ExecutorClient (`apps/agor-daemon/src/services/executor-client.ts`)

Daemon-side IPC client for communicating with executors:
- Connects to executor's Unix socket
- Sends JSON-RPC requests and receives responses
- Handles notifications from executor (fire-and-forget)
- Pending requests map for concurrent request handling
- Automatic cleanup on disconnect

### 2. ExecutorPool (`apps/agor-daemon/src/services/executor-pool.ts`)

Manages executor subprocess lifecycle:
- Spawns executor processes with optional Unix user impersonation
- Detects impersonation mode (sudo or disabled)
- Tracks active executors in a Map
- Waits for socket readiness before connecting
- Graceful termination with fallback to force kill

### 3. Configuration Types (`packages/core/src/config/types.ts`)

Added `AgorExecutionSettings` with:
- `run_as_unix_user` - Enable/disable Unix user impersonation
- `executor_unix_user` - Default Unix user for executors
- `max_executors` - Maximum concurrent executors
- `idle_timeout_ms` - Idle timeout
- `socket_path_template` - Socket path pattern
- `connection_timeout_ms` - Connection timeout
- `session_token_expiration_ms` - Token expiration
- `session_token_max_uses` - Max token uses

### 4. Integration Tests

Created comprehensive test suite (`apps/agor-daemon/test/executor-simple-test.mjs`):
- ✅ Spawn executor and connect
- ✅ Send ping and receive pong
- ✅ Multiple sequential requests
- ✅ Concurrent requests (5 simultaneous)
- ✅ Multiple executors (3 concurrent)
- ✅ Error handling for unknown methods
- ✅ Graceful termination
- ✅ Pool tracking

## Test Results

```
=== Executor Pool Integration Test ===

1. Creating ExecutorPool...
   ✓ ExecutorPool created

2. Spawning executor...
   ✓ Executor spawned (id=5a78a2d3)
   ✓ Socket: /tmp/agor-executor-5291a027-4a50-4faa-9443-50a0be3c9f69.sock
   ✓ Connected: true

3. Sending ping request...
   ✓ Response: { "pong": true, "timestamp": 1763686550866 }
   ✓ Ping successful

4. Testing multiple sequential requests...
   ✓ All sequential pings successful

5. Testing concurrent requests...
   ✓ All concurrent requests successful

6. Testing multiple executors...
   ✓ Spawned 2 more executors
   ✓ All executors responding

7. Testing error handling...
   ✓ Error handling works correctly

8. Testing graceful shutdown...
   ✓ Terminated 2 executors

9. Testing pool tracking...
   ✓ Active executors: 1
   ✓ Pool tracking correct

10. Cleaning up...
   ✓ All executors terminated

✅ All tests passed!
```

## Architecture

### How It Works

```
Daemon Process (ExecutorPool)
  │
  ├─ spawn('npx', ['tsx', 'executor/src/cli.ts', '--socket', '/tmp/...'])
  │
  └─> Executor Subprocess
        │
        ├─ Creates Unix socket server
        ├─ Waits for daemon to connect
        └─ Processes JSON-RPC requests

Daemon (ExecutorClient)
  │
  ├─ Connect to Unix socket
  ├─ Send request('ping', {})
  └─ Receive response { pong: true }
```

### Key Features

1. **Subprocess Management**
   - Spawns executor as separate Node.js process
   - Captures stdout/stderr for logging
   - Monitors exit events
   - Automatic cleanup on disconnect

2. **IPC Communication**
   - JSON-RPC 2.0 over Unix sockets
   - Newline-delimited JSON framing
   - Concurrent request handling with pending requests map
   - Notification support for streaming events

3. **Impersonation Mode Detection**
   - Checks `execution.run_as_unix_user` config flag
   - Tests sudo availability at startup
   - Falls back to running as daemon user if sudo unavailable
   - Logs detected mode for transparency

4. **Connection Management**
   - Waits for socket to exist (5 second timeout)
   - Validates connection before returning
   - Tracks connection state
   - Graceful disconnect with cleanup

## Files Created/Modified

**Created:**
- `apps/agor-daemon/src/services/executor-client.ts` - Daemon-side IPC client
- `apps/agor-daemon/src/services/executor-pool.ts` - Executor lifecycle management
- `apps/agor-daemon/test/executor-simple-test.mjs` - Integration tests
- `apps/agor-daemon/test/executor-integration.test.ts` - Vitest tests (framework)

**Modified:**
- `packages/core/src/config/types.ts` - Added `AgorExecutionSettings`
- `packages/executor/src/ipc-server.ts` - Fixed concurrent request handling
- `packages/executor/test/simple-test.mjs` - Fixed hardcoded path

## Phase 1 Fixes

Also completed all Phase 1 code review fixes:

1. ✅ Fixed concurrent request handling in `ExecutorIPCServer`
   - Added pending requests Map
   - Proper response routing based on request ID
   - Cleanup on disconnect

2. ✅ Fixed hardcoded path in test
   - Used `import.meta.url` for relative path resolution

## Configuration Example

```yaml
# ~/.agor/config.yaml

execution:
  # Enable Unix user impersonation (requires sudo setup)
  run_as_unix_user: false

  # Default Unix user for executors (if user not linked)
  executor_unix_user: agor_executor

  # Pool settings
  max_executors: 10
  idle_timeout_ms: 60000
```

## Success Criteria

- [x] Daemon can spawn executor process
- [x] Daemon can connect via Unix socket
- [x] Daemon can send ping, receive pong
- [x] Integration test passes
- [x] Works with and without sudo configured
- [x] Concurrent requests work correctly
- [x] Multiple executors can run simultaneously
- [x] Graceful termination works
- [x] Pool tracking is accurate

**Phase 2: COMPLETE** ✅

## Next Steps (Phase 3)

Phase 3 will implement SDK execution via executor:

1. **execute_prompt Handler**
   - Implement in `packages/executor/src/handlers/execute-prompt.ts`
   - Call Claude SDK from executor process
   - Stream events back to daemon via notifications

2. **API Key Requests**
   - Implement `get_api_key` request (executor → daemon)
   - Just-in-time key delivery (not in environment)

3. **Permission Requests**
   - Implement `request_permission` for tool approval
   - Interactive permission prompts

4. **Daemon Service Integration**
   - Modify `/sessions/:id/prompt` endpoint to use ExecutorPool
   - Route SDK execution through executor
   - Handle streaming notifications

5. **Feature Flag**
   - Make it opt-in via `execution.run_as_unix_user`
   - Maintain backward compatibility

## Resources

- Design docs: `context/explorations/executor-isolation.md`
- IPC protocol: `context/explorations/ipc-message-catalog.md`
- Phase 1 implementation: `packages/executor/IMPLEMENTATION.md`

---

**Last Updated:** 2025-01-21
**Status:** Phase 2 Complete, Ready for Phase 3
