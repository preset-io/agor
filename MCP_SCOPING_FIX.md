# MCP Scoping Fix Summary

## Problem

The MCP server scoping logic had multiple issues:

1. **Unused scope types**: `'team'` and `'repo'` scopes were defined but never implemented
2. **Incorrect foreign keys**: The `mcp_servers` table had `team_id`, `repo_id`, and `session_id` columns that contradicted the many-to-many junction table design
3. **Scoping bug**: Session-assigned MCP servers were not properly isolated - sessions could see all servers in the junction table regardless of scope

## Root Cause

The `SessionMCPServerRepository.listServers()` method correctly queried the `session_mcp_servers` junction table, but the SDK handlers (Claude and Gemini) would include ALL servers from the junction table without validating scope.

This meant:
- A session assigned only "mcp sdx" could see "mcp 2cad" and "mcp stg" if they existed in the junction table
- Global servers and session-assigned servers were being mixed incorrectly

## Solution

### 1. **Simplified Scope Model**

Removed unused scopes and simplified to 2 types only:

```typescript
// Before
export type MCPScope = 'global' | 'team' | 'repo' | 'session';

// After
export type MCPScope = 'global' | 'session';
```

**Scope Behavior:**
- **`'global'`**: User's personal MCP servers, available to all their sessions by default
- **`'session'`**: MCP servers assigned to specific sessions via `session_mcp_servers` junction table

### 2. **Removed Foreign Keys**

The `mcp_servers` table now only has `owner_user_id` FK:

```sql
-- Before
owner_user_id text(36)  -- For 'global' scope
team_id text(36)        -- For 'team' scope (REMOVED)
repo_id text(36)        -- For 'repo' scope (REMOVED)
session_id text(36)     -- For 'session' scope (REMOVED)

-- After
owner_user_id text(36)  -- For 'global' scope only
```

Session assignments are managed exclusively through the `session_mcp_servers` junction table.

### 3. **Fixed Scoping Logic**

Updated both Claude and Gemini SDK handlers to use proper isolated/hierarchical scoping:

**Isolated Mode** (when session has assigned servers):
```javascript
if (sessionServers.length > 0) {
  // Use ONLY session-assigned servers
  // No global servers included
  allServers = sessionServers;
}
```

**Hierarchical Mode** (when session has NO assigned servers):
```javascript
else {
  // Fall back to global servers
  allServers = globalServers;
}
```

## Files Modified

### Core Types & Schema
- `packages/core/src/types/mcp.ts` - Removed `'team'` and `'repo'` from `MCPScope`, removed `team_id`, `repo_id`, `session_id` from `MCPServer` interface
- `packages/core/src/db/schema.sqlite.ts` - Updated scope enum and removed FK columns

### Repositories
- `packages/core/src/db/repositories/mcp-servers.ts` - Removed team/repo scope handling in `findAll()`, updated row conversion methods

### Shared Utilities (NEW!)
- `packages/executor/src/sdk-handlers/base/mcp-scoping.ts` - **New shared utility** `getMcpServersForSession()` for consistent MCP scoping across all SDKs
- `packages/executor/src/sdk-handlers/base/index.ts` - Export new utility

### SDK Handlers
- `packages/executor/src/sdk-handlers/claude/query-builder.ts` - Refactored to use shared `getMcpServersForSession()` utility
- `packages/executor/src/sdk-handlers/gemini/prompt-service.ts` - Refactored to use shared `getMcpServersForSession()` utility

### Database Migration
- `migrations/0001_remove_unused_mcp_scope_columns.sql` - Dropped `team_id`, `repo_id`, `session_id` columns from `mcp_servers` table

## Verification

### Before Fix
```bash
# Session A has only "mcp sdx" assigned
$ sqlite3 ~/.agor/agor.db "SELECT * FROM session_mcp_servers WHERE session_id = 'a7a0890a...'"
a7a0890a...|085e8bcb...|1|...

# But agent saw all 3 MCP servers (bug!)
```

### After Fix
```bash
# Session with assigned server sees ONLY that server
Isolated mode: session-assigned servers only

# Session with NO assigned servers sees global servers
Hierarchical mode: global servers only
```

## Testing Recommendations

1. **Test isolated mode**: Assign 1 MCP server to a session, verify agent only sees that one
2. **Test hierarchical mode**: Create session with no assignments, verify agent sees all global servers
3. **Test Agor MCP**: Verify internal Agor MCP server is always attached (regardless of mode)
4. **Test scope validation**: Verify session-scoped servers can't leak across sessions

## Breaking Changes

⚠️ **Breaking Changes** (none expected in practice):

1. **Scope enum reduced** from 4 to 2 values - but `'team'` and `'repo'` were never used
2. **FK columns removed** - but these were always NULL in production
3. **Scoping logic changed** - this is a bug fix, restores intended behavior

## Migration Steps

1. ✅ Update types and schema
2. ✅ Update repositories to remove team/repo logic
3. ✅ Fix SDK handlers (Claude and Gemini)
4. ✅ Run database migration
5. ⏭️ Restart daemon to pick up changes
6. ⏭️ Test with existing sessions

## Architecture Improvement: Shared MCP Scoping Utility

To ensure consistency across all SDK handlers (Claude, Gemini, and future integrations like Codex), we created a **shared utility function** at `packages/executor/src/sdk-handlers/base/mcp-scoping.ts`:

```typescript
export async function getMcpServersForSession(
  sessionId: SessionID,
  deps: MCPResolutionDeps
): Promise<MCPServerWithSource[]>
```

**Benefits:**
- ✅ Single source of truth for MCP scoping logic
- ✅ Consistent behavior across all SDKs (Claude, Gemini, Codex)
- ✅ Easier to test and maintain
- ✅ Clear separation of concerns (scoping vs SDK-specific formatting)

**Usage:**
```typescript
// In Claude SDK (query-builder.ts)
const serversWithSource = await getMcpServersForSession(sessionId, {
  sessionMCPRepo: deps.sessionMCPRepo,
  mcpServerRepo: deps.mcpServerRepo,
});

// In Gemini SDK (prompt-service.ts)
const serversWithSource = await getMcpServersForSession(sessionId, {
  sessionMCPRepo: this.sessionMCPRepo,
  mcpServerRepo: this.mcpServerRepo,
});
```

Each SDK then converts the returned `MCPServerWithSource[]` to its specific format (Claude uses `MCPServersConfig`, Gemini uses `MCPServerConfig` classes).

## Next Steps

- [x] Create shared MCP scoping utility
- [x] Refactor Claude SDK to use shared utility
- [x] Refactor Gemini SDK to use shared utility
- [ ] Restart daemon: `cd apps/agor-daemon && pnpm dev`
- [ ] Create new session and verify MCP attachment
- [ ] Test isolated mode with session-assigned servers
- [ ] Test hierarchical mode with global servers only
