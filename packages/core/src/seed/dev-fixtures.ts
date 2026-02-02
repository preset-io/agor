/**
 * Dev Fixtures
 *
 * Seed script for populating development database with test data.
 * Uses Agor repositories to create realistic test data.
 *
 * Usage:
 *   import { seedDevFixtures } from '@agor/core/seed/dev-fixtures';
 *   await seedDevFixtures();
 */

import os from 'node:os';
import path from 'node:path';
import type { RepoID, UUID, WorktreeID } from '@agor/core/types';
import { isWorktreeRbacEnabled, loadConfigSync } from '../config/config-manager';
import {
  BoardObjectRepository,
  BoardRepository,
  RepoRepository,
  WorktreeRepository,
} from '../db/repositories';
import { cloneRepo, createWorktree, getWorktreePath } from '../git';
import { generateId } from '../lib/ids';
import { DirectExecutor, UnixIntegrationService } from '../unix';

export interface SeedOptions {
  /**
   * Base directory for cloning repos (defaults to ~/.agor/repos)
   */
  baseDir?: string;

  /**
   * User ID to attribute created entities to (defaults to 'anonymous')
   */
  userId?: UUID;

  /**
   * Skip if data already exists (idempotent)
   */
  skipIfExists?: boolean;
}

export interface SeedResult {
  repo_id: UUID;
  worktree_id: WorktreeID;
  skipped: boolean;
}

/**
 * Seed development fixtures
 */
export async function seedDevFixtures(options: SeedOptions = {}): Promise<SeedResult> {
  // Respect DATABASE_URL and AGOR_DB_DIALECT environment variables
  // Priority: DATABASE_URL env var > default SQLite file path
  let databaseUrl: string;
  const dialect = process.env.AGOR_DB_DIALECT;

  if (dialect === 'postgresql') {
    // Use DATABASE_URL for PostgreSQL
    databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/agor';
  } else {
    // Use SQLite file path (default)
    const configPath = path.join(os.homedir(), '.agor');
    const dbPath = path.join(configPath, 'agor.db');
    databaseUrl = process.env.DATABASE_URL || `file:${dbPath}`;
  }

  const { createDatabase } = await import('../db/client');
  const db = createDatabase({ url: databaseUrl });
  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
  const boardRepo = new BoardRepository(db);
  const boardObjectRepo = new BoardObjectRepository(db);

  // Setup Unix integration if RBAC is enabled
  let unixIntegrationService: UnixIntegrationService | null = null;
  const rbacEnabled = isWorktreeRbacEnabled();
  if (rbacEnabled) {
    const config = loadConfigSync();
    const daemonUser = config.daemon?.unix_user || os.userInfo().username;
    console.log(`🔐 RBAC enabled - Unix integration active (daemon user: ${daemonUser})`);
    unixIntegrationService = new UnixIntegrationService(db, new DirectExecutor(), {
      enabled: true,
      daemonUser,
    });
  }

  const baseDir = options.baseDir ?? path.join(os.homedir(), '.agor', 'repos');
  const userId = (options.userId ?? 'anonymous') as UUID;

  // Check if data already exists (always check for idempotency)
  const existing = await repoRepo.findBySlug('agor');
  if (existing && options.skipIfExists) {
    console.log('✓ Dev fixtures already exist, skipping...');

    // Find the test-worktree
    const worktrees = await worktreeRepo.findAll({ repo_id: existing.repo_id });
    const testWorktree = worktrees.find((w) => w.name === 'test-worktree');

    return {
      repo_id: existing.repo_id,
      worktree_id: testWorktree?.worktree_id ?? (generateId() as WorktreeID),
      skipped: true,
    };
  }

  // If repo exists but skipIfExists is false, delete and recreate
  if (existing && !options.skipIfExists) {
    console.log('⚠️  Repo already exists, deleting and recreating...');
    await repoRepo.delete(existing.repo_id);
  }

  console.log('📦 Seeding development fixtures...');

  // STEP 1: Create Agor repo
  console.log('1️⃣  Creating Agor repo...');

  const remoteUrl = 'https://github.com/preset-io/agor.git';
  const repoSlug = 'agor';
  const repoPath = path.join(baseDir, repoSlug);

  // Clone the repo (or use existing if already cloned)
  console.log(`   Cloning ${remoteUrl} to ${repoPath}...`);
  const { defaultBranch } = await cloneRepo({
    url: remoteUrl,
    targetDir: repoPath,
  });

  const repo = await repoRepo.create({
    slug: repoSlug,
    name: 'Agor',
    repo_type: 'remote',
    remote_url: remoteUrl,
    local_path: repoPath,
    default_branch: defaultBranch,
  });

  console.log(`   ✓ Created repo: ${repo.slug} (${repo.repo_id})`);

  // Unix Integration: Create repo group for .git access (same as daemon does)
  if (unixIntegrationService) {
    try {
      const groupName = await unixIntegrationService.createRepoGroup(repo.repo_id as RepoID);
      console.log(`   Unix group: ${groupName}`);
    } catch (error) {
      console.error(
        `   ⚠️  Unix integration failed: ${error instanceof Error ? error.message : String(error)}`
      );
      // Continue - app-layer RBAC is still functional
    }
  }

  // STEP 2: Get default board
  console.log('2️⃣  Getting default board...');
  const defaultBoard = await boardRepo.getDefault();
  console.log(`   ✓ Using default board: ${defaultBoard.name} (${defaultBoard.board_id})`);

  // STEP 3: Create test-worktree
  console.log('3️⃣  Creating test-worktree...');

  const worktreeName = 'test-worktree';
  const worktreePath = getWorktreePath(repoSlug, worktreeName);

  // Generate unique numeric ID for worktree (used for port allocation)
  const worktreeUniqueId = Math.floor(Math.random() * 1000) + 1;

  // Create worktree with its own branch (can't checkout main twice)
  const worktree = await worktreeRepo.create({
    repo_id: repo.repo_id,
    name: worktreeName,
    ref: worktreeName, // Use worktree name as branch name
    path: worktreePath,
    base_ref: defaultBranch,
    new_branch: true, // Create new branch from main
    worktree_unique_id: worktreeUniqueId,
    created_by: userId,
    board_id: defaultBoard.board_id,
    needs_attention: false,
  });

  // Create actual git worktree on disk
  await createWorktree(
    repoPath,
    worktreePath,
    worktreeName, // ref - new branch with same name as worktree
    true, // createBranch
    false, // pullLatest (just cloned)
    defaultBranch, // sourceBranch
    undefined, // env
    'branch' // refType
  );

  // Add user as owner of the worktree
  await worktreeRepo.addOwner(worktree.worktree_id, userId);

  // Unix Integration: Create worktree group and add owner (same as daemon hook does)
  if (unixIntegrationService) {
    try {
      const groupName = await unixIntegrationService.createWorktreeGroup(worktree.worktree_id);
      await unixIntegrationService.addUserToWorktreeGroup(worktree.worktree_id, userId);
      // Fix permissions on .git/worktrees/<name>/ directory
      await unixIntegrationService.fixWorktreeGitDirPermissions(worktree.worktree_id);
      console.log(`   Unix group: ${groupName}`);
    } catch (error) {
      console.error(
        `   ⚠️  Unix integration failed: ${error instanceof Error ? error.message : String(error)}`
      );
      // Continue - app-layer RBAC is still functional
    }
  }

  console.log(`   ✓ Created worktree: ${worktree.name} (${worktree.worktree_id})`);

  // STEP 4: Create board object to position worktree on board
  console.log('4️⃣  Creating board object for worktree...');

  // Position near viewport center (0,0) with random jitter
  // Jitter area = 2 * card width (card width ~500px, so jitter within ±1000px)
  const CARD_WIDTH = 500;
  const JITTER_AREA = 2 * CARD_WIDTH; // 1000px
  const viewportCenter = { x: 0, y: 0 }; // Default viewport center if not available

  const jitterX = (Math.random() - 0.5) * JITTER_AREA; // -500 to +500
  const jitterY = (Math.random() - 0.5) * JITTER_AREA; // -500 to +500

  const fallbackPosition = {
    x: Math.round(viewportCenter.x + jitterX),
    y: Math.round(viewportCenter.y + jitterY),
  };

  await boardObjectRepo.create({
    board_id: defaultBoard.board_id,
    worktree_id: worktree.worktree_id,
    position: fallbackPosition,
  });

  console.log(
    `   ✓ Created board object at position (${fallbackPosition.x}, ${fallbackPosition.y})`
  );

  console.log('✅ Dev fixtures seeded successfully!');
  console.log('');
  console.log(`   Repo:     ${repo.slug} (${repo.repo_id})`);
  console.log(`   Worktree: ${worktree.name} (${worktree.worktree_id})`);
  console.log('');

  return {
    repo_id: repo.repo_id,
    worktree_id: worktree.worktree_id,
    skipped: false,
  };
}

/**
 * Add custom seed data
 *
 * This function is intentionally minimal to make it easy to extend.
 * Add your own seed data here!
 *
 * Example:
 *   import { addCustomSeed } from '@agor/core/seed/dev-fixtures';
 *
 *   await addCustomSeed(async () => {
 *     const db = getDatabase();
 *     const repoRepo = new RepoRepository(db);
 *
 *     await repoRepo.create({
 *       slug: 'my-project',
 *       name: 'My Project',
 *       remote_url: 'https://github.com/me/my-project.git',
 *       local_path: '/path/to/my-project',
 *     });
 *   });
 */
export async function addCustomSeed(seedFn: () => Promise<void>): Promise<void> {
  console.log('🌱 Running custom seed...');
  await seedFn();
  console.log('✅ Custom seed complete!');
}
