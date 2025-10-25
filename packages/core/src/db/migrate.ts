/**
 * Database Migration Runner
 *
 * DEPRECATED: This file contains manual SQL schema creation and is kept for backwards compatibility.
 *
 * **New Approach (Recommended):**
 * Use `drizzle-kit push` to automatically sync schema.ts to database:
 *   - Run: `pnpm db:push` from packages/core
 *   - Drizzle Kit reads schema.ts and generates SQL automatically
 *   - No need to maintain manual CREATE TABLE statements
 *   - Single source of truth: packages/core/src/db/schema.ts
 *
 * **This file is still used by:**
 * - setup-db.ts for programmatic database initialization
 * - Legacy code that calls initializeDatabase() directly
 *
 * **Migration Path:**
 * For fresh databases: Use `pnpm db:push`
 * For existing databases: Use `pnpm db:push` (will detect and apply schema changes)
 * For seed data: Still use seedInitialData() from this file
 */

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from './client';

/**
 * Error thrown when migration fails
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Check if database tables exist
 */
async function tablesExist(db: Database): Promise<boolean> {
  try {
    const result = await db.run(sql`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('sessions', 'tasks', 'boards', 'repos', 'worktrees', 'messages', 'users', 'board_comments')
    `);
    return result.rows.length > 0;
  } catch (error) {
    throw new MigrationError(
      `Failed to check if tables exist: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Check if a specific table exists
 */
async function tableExists(db: Database, tableName: string): Promise<boolean> {
  try {
    const result = await db.run(sql`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name = ${tableName}
    `);
    return result.rows.length > 0;
  } catch (error) {
    throw new MigrationError(
      `Failed to check if table ${tableName} exists: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Create initial database schema
 *
 * Creates all tables with indexes. This is the "migration-free" approach:
 * we define the schema once and avoid constant migrations by using JSON columns.
 */
async function createInitialSchema(db: Database): Promise<void> {
  try {
    // Sessions table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        created_by TEXT NOT NULL DEFAULT 'anonymous',
        status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        agentic_tool TEXT NOT NULL CHECK(agentic_tool IN ('claude-code', 'cursor', 'codex', 'gemini')),
        board_id TEXT,
        parent_session_id TEXT,
        forked_from_session_id TEXT,
        worktree_id TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(worktree_id) ON DELETE CASCADE
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_agentic_tool_idx ON sessions(agentic_tool)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_board_idx ON sessions(board_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_worktree_idx ON sessions(worktree_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions(created_at)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(parent_session_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS sessions_forked_idx ON sessions(forked_from_session_id)
    `);

    // Tasks table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('created', 'running', 'stopping', 'awaiting_permission', 'completed', 'failed', 'stopped')),
        created_by TEXT NOT NULL DEFAULT 'anonymous',
        data TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS tasks_session_idx ON tasks(session_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at)
    `);

    // Boards table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS boards (
        board_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        created_by TEXT NOT NULL DEFAULT 'anonymous',
        name TEXT NOT NULL,
        slug TEXT UNIQUE,
        data TEXT NOT NULL
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS boards_name_idx ON boards(name)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS boards_slug_idx ON boards(slug)
    `);

    // Repos table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS repos (
        repo_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        slug TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS repos_slug_idx ON repos(slug)
    `);

    // Worktrees table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS worktrees (
        worktree_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        created_by TEXT NOT NULL DEFAULT 'anonymous',
        name TEXT NOT NULL,
        ref TEXT NOT NULL,
        worktree_unique_id INTEGER NOT NULL,
        board_id TEXT,
        data TEXT NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE,
        FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE SET NULL
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_repo_idx ON worktrees(repo_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_name_idx ON worktrees(name)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_ref_idx ON worktrees(ref)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_board_idx ON worktrees(board_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_created_idx ON worktrees(created_at)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_updated_idx ON worktrees(updated_at)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS worktrees_repo_name_unique ON worktrees(repo_id, name)
    `);

    // Messages table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('user', 'assistant', 'system', 'file-history-snapshot', 'permission_request')),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        "index" INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        content_preview TEXT,
        data TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS messages_task_id_idx ON messages(task_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS messages_session_index_idx ON messages(session_id, "index")
    `);

    // Users table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        emoji TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
        data TEXT NOT NULL
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)
    `);

    // MCP Servers table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        mcp_server_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'sse')),
        scope TEXT NOT NULL CHECK(scope IN ('global', 'team', 'repo', 'session')),
        enabled INTEGER NOT NULL DEFAULT 1,
        owner_user_id TEXT,
        team_id TEXT,
        repo_id TEXT,
        session_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('user', 'imported', 'agor')),
        data TEXT NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repos(repo_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_name_idx ON mcp_servers(name)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_scope_idx ON mcp_servers(scope)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_owner_idx ON mcp_servers(owner_user_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_team_idx ON mcp_servers(team_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_repo_idx ON mcp_servers(repo_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_session_idx ON mcp_servers(session_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS mcp_servers_enabled_idx ON mcp_servers(enabled)
    `);

    // Session-MCP Servers relationship table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS session_mcp_servers (
        session_id TEXT NOT NULL,
        mcp_server_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        added_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(mcp_server_id) ON DELETE CASCADE
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS session_mcp_servers_pk ON session_mcp_servers(session_id, mcp_server_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS session_mcp_servers_session_idx ON session_mcp_servers(session_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS session_mcp_servers_server_idx ON session_mcp_servers(mcp_server_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS session_mcp_servers_enabled_idx ON session_mcp_servers(session_id, enabled)
    `);

    // Board Objects table - Positioned worktrees on boards
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS board_objects (
        object_id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        worktree_id TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(worktree_id) ON DELETE CASCADE
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_objects_board_idx ON board_objects(board_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_objects_worktree_idx ON board_objects(worktree_id)
    `);

    // Board Comments table - Human-to-human conversations and collaboration
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS board_comments (
        comment_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        board_id TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'anonymous',
        session_id TEXT,
        task_id TEXT,
        message_id TEXT,
        worktree_id TEXT,
        content TEXT NOT NULL,
        content_preview TEXT NOT NULL,
        parent_comment_id TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        edited INTEGER NOT NULL DEFAULT 0,
        reactions TEXT NOT NULL DEFAULT '[]',
        data TEXT NOT NULL,
        FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE SET NULL,
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE SET NULL,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(worktree_id) ON DELETE SET NULL
      )
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_board_idx ON board_comments(board_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_session_idx ON board_comments(session_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_task_idx ON board_comments(task_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_message_idx ON board_comments(message_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_worktree_idx ON board_comments(worktree_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_created_by_idx ON board_comments(created_by)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_parent_idx ON board_comments(parent_comment_id)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_created_idx ON board_comments(created_at)
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS board_comments_resolved_idx ON board_comments(resolved)
    `);
  } catch (error) {
    throw new MigrationError(
      `Failed to create initial schema: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Run database migrations
 *
 * @param db Drizzle database instance
 * @param migrationsFolder Path to migrations folder (default: './migrations')
 *
 * @example
 * ```typescript
 * import { createDatabase } from './client';
 * import { runMigrations } from './migrate';
 *
 * const db = createDatabase({ url: 'file:~/.agor/sessions.db' });
 * await runMigrations(db);
 * ```
 */
export async function runMigrations(
  db: Database,
  migrationsFolder: string = './migrations'
): Promise<void> {
  try {
    // Check if tables exist
    const exists = await tablesExist(db);

    if (!exists) {
      // First run - create initial schema
      console.log('Creating initial database schema...');
      await createInitialSchema(db);
      console.log('Initial schema created successfully');
    } else {
      // Subsequent runs - apply migrations if any
      console.log('Running migrations...');
      await migrate(db, { migrationsFolder });
      console.log('Migrations applied successfully');
    }
  } catch (error) {
    throw new MigrationError(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Initialize database (create schema if needed)
 *
 * Simpler alternative to runMigrations when you don't have migration files.
 * Always safe to call - creates tables only if they don't exist.
 *
 * INCREMENTAL MIGRATION SUPPORT:
 * This function now checks for each table individually and adds missing ones.
 * Safe to call on existing databases - only adds what's missing.
 */
export async function initializeDatabase(db: Database): Promise<void> {
  try {
    const exists = await tablesExist(db);

    if (!exists) {
      // Fresh database - create everything
      console.log('Initializing database schema...');
      await createInitialSchema(db);
      console.log('Database initialized successfully');
    } else {
      // Existing database - check for missing tables and add them
      console.log('Checking for schema updates...');

      // Check for board_comments table (added in Phase 1 of comments feature)
      const hasBoardComments = await tableExists(db, 'board_comments');
      if (!hasBoardComments) {
        console.log('  Adding board_comments table...');
        await db.run(sql`
          CREATE TABLE board_comments (
            comment_id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER,
            board_id TEXT NOT NULL,
            created_by TEXT NOT NULL DEFAULT 'anonymous',
            session_id TEXT,
            task_id TEXT,
            message_id TEXT,
            worktree_id TEXT,
            content TEXT NOT NULL,
            content_preview TEXT NOT NULL,
            parent_comment_id TEXT,
            resolved INTEGER NOT NULL DEFAULT 0,
            edited INTEGER NOT NULL DEFAULT 0,
            reactions TEXT NOT NULL DEFAULT '[]',
            data TEXT NOT NULL,
            FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE SET NULL,
            FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE SET NULL,
            FOREIGN KEY (worktree_id) REFERENCES worktrees(worktree_id) ON DELETE SET NULL
          )
        `);

        // Create indexes
        await db.run(sql`CREATE INDEX board_comments_board_idx ON board_comments(board_id)`);
        await db.run(sql`CREATE INDEX board_comments_session_idx ON board_comments(session_id)`);
        await db.run(sql`CREATE INDEX board_comments_task_idx ON board_comments(task_id)`);
        await db.run(sql`CREATE INDEX board_comments_message_idx ON board_comments(message_id)`);
        await db.run(sql`CREATE INDEX board_comments_worktree_idx ON board_comments(worktree_id)`);
        await db.run(sql`CREATE INDEX board_comments_created_by_idx ON board_comments(created_by)`);
        await db.run(
          sql`CREATE INDEX board_comments_parent_idx ON board_comments(parent_comment_id)`
        );
        await db.run(sql`CREATE INDEX board_comments_created_idx ON board_comments(created_at)`);
        await db.run(sql`CREATE INDEX board_comments_resolved_idx ON board_comments(resolved)`);

        console.log('  ✅ board_comments table added');
      } else {
        // Table exists - check for reactions column (Phase 2: Threading + reactions)
        try {
          const tableInfo = await db.run(sql`PRAGMA table_info(board_comments)`);
          const hasReactionsColumn = tableInfo.rows.some(
            (row: { name: string }) => row.name === 'reactions'
          );

          if (!hasReactionsColumn) {
            console.log('  Adding reactions column to board_comments...');
            await db.run(sql`
              ALTER TABLE board_comments ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]'
            `);
            console.log('  ✅ reactions column added');
          }
        } catch (error) {
          console.error('  ⚠️ Failed to add reactions column:', error);
        }
      }

      // Future migrations: Add more table checks here
      // Example:
      // const hasNewTable = await tableExists(db, 'new_table');
      // if (!hasNewTable) { ... }

      console.log('Schema up to date');
    }
  } catch (error) {
    throw new MigrationError(
      `Database initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

/**
 * Seed initial data (default board)
 */
export async function seedInitialData(db: Database): Promise<void> {
  try {
    // Check if default board exists
    const result = await db.run(sql`
      SELECT board_id FROM boards WHERE name = 'Default'
    `);

    if (result.rows.length === 0) {
      // Create default board
      const { generateId } = await import('../lib/ids');
      const boardId = generateId();
      const now = Date.now();

      await db.run(sql`
        INSERT INTO boards (board_id, name, slug, created_at, updated_at, created_by, data)
        VALUES (
          ${boardId},
          ${'Default'},
          ${'default'},
          ${now},
          ${now},
          ${'anonymous'},
          ${JSON.stringify({
            description: 'Default board for all sessions',
            sessions: [],
            color: '#1677ff',
            icon: '⭐',
          })}
        )
      `);

      console.log('Default board created');
    }
  } catch (error) {
    throw new MigrationError(
      `Failed to seed initial data: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}
