-- Migration: Remove unused MCP scope columns
-- Date: 2025-11-26
-- Description: Remove team_id, repo_id, and session_id columns from mcp_servers table
--              These were never implemented. MCP scoping now uses only:
--              - 'global' scope with owner_user_id FK
--              - 'session' scope with session_mcp_servers junction table (many-to-many)

-- SQLite doesn't support DROP COLUMN directly, so we need to:
-- 1. Create new table without unused columns
-- 2. Copy data
-- 3. Drop old table
-- 4. Rename new table

BEGIN TRANSACTION;

-- Create new table without team_id, repo_id, session_id
CREATE TABLE mcp_servers_new (
  mcp_server_id text(36) PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,

  -- Materialized columns
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'sse')),
  scope TEXT NOT NULL CHECK(scope IN ('global', 'session')),
  enabled INTEGER NOT NULL DEFAULT 1,

  -- Scope foreign key (only for global scope)
  owner_user_id text(36),

  -- Source tracking
  source TEXT NOT NULL CHECK(source IN ('user', 'imported', 'agor')),

  -- JSON blob
  data TEXT NOT NULL
);

-- Copy data from old table
INSERT INTO mcp_servers_new (
  mcp_server_id,
  created_at,
  updated_at,
  name,
  transport,
  scope,
  enabled,
  owner_user_id,
  source,
  data
)
SELECT
  mcp_server_id,
  created_at,
  updated_at,
  name,
  transport,
  scope,
  enabled,
  owner_user_id,
  source,
  data
FROM mcp_servers;

-- Drop old table
DROP TABLE mcp_servers;

-- Rename new table
ALTER TABLE mcp_servers_new RENAME TO mcp_servers;

-- Recreate indexes
CREATE INDEX mcp_servers_name_idx ON mcp_servers(name);
CREATE INDEX mcp_servers_scope_idx ON mcp_servers(scope);
CREATE INDEX mcp_servers_owner_idx ON mcp_servers(owner_user_id);
CREATE INDEX mcp_servers_enabled_idx ON mcp_servers(enabled);

COMMIT;
