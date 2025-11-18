#!/usr/bin/env node

/**
 * Integration Test Script
 *
 * Tests the complete database layer:
 * - ID generation and resolution
 * - Repository CRUD operations
 * - JSON serialization
 * - Genealogy queries
 *
 * Usage:
 *   npm run test:integration
 */

import { formatShortId, generateId } from '../../lib/ids';
import type { Session, TaskID, UserID, WorktreeID } from '../../types';
import { SessionStatus, TaskStatus } from '../../types';
import { createDatabase } from '../client';
import { initializeDatabase, seedInitialData } from '../migrate';
import {
  BoardRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
} from '../repositories';

// Test database path
const TEST_DB_PATH = 'file:/tmp/agor-test.db';

async function cleanup() {
  const db = createDatabase({ url: TEST_DB_PATH });
  const { sql } = await import('drizzle-orm');
  const { isSQLiteDatabase } = await import('../database-wrapper');

  if (isSQLiteDatabase(db)) {
    await db.run(sql`DROP TABLE IF EXISTS tasks`);
    await db.run(sql`DROP TABLE IF EXISTS sessions`);
    await db.run(sql`DROP TABLE IF EXISTS boards`);
    await db.run(sql`DROP TABLE IF EXISTS repos`);
  } else {
    await db.execute(sql`DROP TABLE IF EXISTS tasks`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions`);
    await db.execute(sql`DROP TABLE IF EXISTS boards`);
    await db.execute(sql`DROP TABLE IF EXISTS repos`);
  }
}

async function testIdGeneration() {
  console.log('\n📋 Testing ID Generation...');

  // Generate 5 IDs
  const ids = Array.from({ length: 5 }, () => generateId());

  // Verify format
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error(`Invalid UUID format: ${id}`);
    }
  }

  // Verify time ordering (first 48 bits should be increasing)
  for (let i = 1; i < ids.length; i++) {
    const prev = ids[i - 1].replace(/-/g, '').slice(0, 12);
    const curr = ids[i].replace(/-/g, '').slice(0, 12);
    if (prev > curr) {
      throw new Error('IDs not time-ordered');
    }
  }

  console.log('  ✅ Generated 5 UUIDv7s');
  console.log(`  ✅ Sample ID: ${ids[0]}`);
  console.log(`  ✅ Short form: ${formatShortId(ids[0])}`);
  console.log('  ✅ Time-ordered');
}

async function testSessionRepository(db: ReturnType<typeof createDatabase>) {
  console.log('\n📦 Testing Session Repository...');

  const repo = new SessionRepository(db);

  // Create session
  const session = await repo.create({
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UserID,
    worktree_id: 'test-worktree-id' as WorktreeID,
    git_state: {
      ref: 'main',
      base_sha: 'abc123',
      current_sha: 'abc123',
    },
    genealogy: {
      children: [],
    },
    contextFiles: [],
    tasks: [],
    message_count: 0,
  });

  console.log(`  ✅ Created session: ${formatShortId(session.session_id)}`);

  // Test short ID resolution
  const shortId = formatShortId(session.session_id);
  const found = await repo.findById(shortId);

  if (!found || found.session_id !== session.session_id) {
    throw new Error('Short ID resolution failed');
  }

  console.log(`  ✅ Resolved short ID: ${shortId} → ${session.session_id}`);

  // Test JSON data integrity
  if (found.agentic_tool !== 'claude-code') {
    throw new Error('JSON data not preserved');
  }

  console.log('  ✅ JSON data preserved correctly');

  // Test update
  const updated = await repo.update(session.session_id, { status: TaskStatus.RUNNING });
  if (updated.status !== TaskStatus.RUNNING) {
    throw new Error('Update failed');
  }

  console.log('  ✅ Update successful');

  // Test findByStatus
  const running = await repo.findByStatus(TaskStatus.RUNNING);
  if (running.length !== 1) {
    throw new Error('findByStatus failed');
  }

  console.log('  ✅ findByStatus works');

  return session;
}

async function testTaskRepository(db: ReturnType<typeof createDatabase>, session: Session) {
  console.log('\n📝 Testing Task Repository...');

  const repo = new TaskRepository(db);

  // Create task
  const task = await repo.create({
    session_id: session.session_id,
    description: 'Test task',
    full_prompt: 'This is a test task',
    status: TaskStatus.CREATED,
    message_range: {
      start_index: 0,
      end_index: 1,
      start_timestamp: new Date().toISOString(),
    },
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    model: 'claude-sonnet-4-5',
    tool_use_count: 5,
  });

  console.log(`  ✅ Created task: ${formatShortId(task.task_id)}`);

  // Test findBySession
  const tasks = await repo.findBySession(session.session_id);
  if (tasks.length !== 1) {
    throw new Error('findBySession failed');
  }

  console.log('  ✅ findBySession works');

  // Test update
  const updated = await repo.update(task.task_id, {
    status: TaskStatus.COMPLETED,
    completed_at: new Date().toISOString(),
  });

  if (updated.status !== TaskStatus.COMPLETED || !updated.completed_at) {
    throw new Error('Task update failed');
  }

  console.log('  ✅ Update successful');

  return task;
}

async function testBoardRepository(db: ReturnType<typeof createDatabase>, session: Session) {
  console.log('\n🗂️  Testing Board Repository...');

  const repo = new BoardRepository(db);

  // Get default board (created by seedInitialData)
  const defaultBoard = await repo.getDefault();
  console.log(`  ✅ Default board exists: ${defaultBoard.name}`);

  // Create custom board
  const board = await repo.create({
    name: 'Test Board',
    slug: 'test-board',
    description: 'A test board',
    color: '#ff0000',
    icon: 'rocket',
  });

  console.log(`  ✅ Created board: ${formatShortId(board.board_id)}`);

  // TODO: Update board tests for worktree-centric model
  // Old session-based board API is deprecated
  /*
  // Add session to board
  const updated = await repo.addSession(board.board_id, session.session_id);
  if (!updated.sessions.includes(session.session_id)) {
    throw new Error('addSession failed');
  }
  */

  console.log('  ✅ Board test skipped (TODO: update for worktree-centric model)');

  // Test findBySlug
  const foundBySlug = await repo.findBySlug('test-board');
  if (!foundBySlug || foundBySlug.board_id !== board.board_id) {
    throw new Error('findBySlug failed');
  }

  console.log('  ✅ findBySlug works');

  return board;
}

async function testRepoRepository(db: ReturnType<typeof createDatabase>) {
  console.log('\n📚 Testing Repo Repository...');

  const repo = new RepoRepository(db);

  // Create repo
  const repoData = await repo.create({
    slug: 'test-repo',
    name: 'Test Repository',
    remote_url: 'https://github.com/test/test-repo.git',
    local_path: '/Users/test/.agor/repos/test-repo',
    default_branch: 'main',
  });

  console.log(`  ✅ Created repo: ${formatShortId(repoData.repo_id)}`);

  // Note: Worktrees are now managed separately in the worktrees table
  console.log('  ✅ Repo created successfully');

  // Test findBySlug
  const foundBySlug = await repo.findBySlug('test-repo');
  if (!foundBySlug || foundBySlug.repo_id !== repoData.repo_id) {
    throw new Error('findBySlug failed');
  }

  console.log('  ✅ findBySlug works');

  return repoData;
}

async function testGenealogy(db: ReturnType<typeof createDatabase>) {
  console.log('\n🌳 Testing Session Genealogy...');

  const repo = new SessionRepository(db);

  // Create parent session
  const parent = await repo.create({
    agentic_tool: 'claude-code',
    status: TaskStatus.COMPLETED,
    created_by: 'test-user' as UserID,
    worktree_id: 'test-worktree-id' as WorktreeID,
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    genealogy: { children: [] },
    contextFiles: [],
    tasks: [],
    message_count: 0,
  });

  console.log(`  ✅ Created parent: ${formatShortId(parent.session_id)}`);

  // Create forked child
  const fork = await repo.create({
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UserID,
    worktree_id: 'test-worktree-id' as WorktreeID,
    git_state: { ref: 'main', base_sha: 'def', current_sha: 'def' },
    genealogy: {
      forked_from_session_id: parent.session_id,
      fork_point_task_id: 'task-123' as TaskID,
      children: [],
    },
    contextFiles: [],
    tasks: [],
    message_count: 0,
  });

  console.log(`  ✅ Created fork: ${formatShortId(fork.session_id)}`);

  // Create spawned child
  const spawn = await repo.create({
    agentic_tool: 'codex',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UserID,
    worktree_id: 'test-worktree-id' as WorktreeID,
    git_state: { ref: 'main', base_sha: 'def', current_sha: 'def' },
    genealogy: {
      parent_session_id: parent.session_id,
      spawn_point_task_id: 'task-456' as TaskID,
      children: [],
    },
    contextFiles: [],
    tasks: [],
    message_count: 0,
  });

  console.log(`  ✅ Created spawn: ${formatShortId(spawn.session_id)}`);

  // Test findChildren
  const children = await repo.findChildren(parent.session_id);
  if (children.length !== 2) {
    throw new Error(`Expected 2 children, got ${children.length}`);
  }

  const childIds = children.map((c: Session) => c.session_id).sort();
  const expectedIds = [fork.session_id, spawn.session_id].sort();

  if (JSON.stringify(childIds) !== JSON.stringify(expectedIds)) {
    throw new Error('findChildren returned wrong sessions');
  }

  console.log('  ✅ findChildren works');

  // Test findAncestors
  const ancestors = await repo.findAncestors(fork.session_id);
  if (ancestors.length !== 1 || ancestors[0].session_id !== parent.session_id) {
    throw new Error('findAncestors failed');
  }

  console.log('  ✅ findAncestors works');
}

async function main() {
  console.log('🌧️  Agor Drizzle Integration Tests');
  console.log('=====================================');

  try {
    // Cleanup old test data
    console.log('\n🧹 Cleaning up old test data...');
    await cleanup();

    // Initialize database
    console.log('🏗️  Initializing database...');
    const db = createDatabase({ url: TEST_DB_PATH });
    await initializeDatabase(db);
    await seedInitialData(db);
    console.log('  ✅ Database initialized');

    // Run tests
    await testIdGeneration();

    const session = await testSessionRepository(db);
    const task = await testTaskRepository(db, session);
    const board = await testBoardRepository(db, session);
    const repo = await testRepoRepository(db);

    await testGenealogy(db);

    // Summary
    console.log('\n=====================================');
    console.log('✅ All tests passed!');
    console.log('');
    console.log('📊 Test Summary:');
    console.log(`  - Session: ${formatShortId(session.session_id)}`);
    console.log(`  - Task: ${formatShortId(task.task_id)}`);
    console.log(`  - Board: ${formatShortId(board.board_id)}`);
    console.log(`  - Repo: ${formatShortId(repo.repo_id)}`);
    console.log('');
    console.log('✨ Sprint 1 Complete - Ready for Sprint 2!');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
