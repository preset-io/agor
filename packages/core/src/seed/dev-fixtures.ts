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
import type { BranchID, RepoID, UUID } from '@agor/core/types';
import { loadConfigSync, resolveExecutionSecurityMode } from '../config/config-manager';
import { resolveMultiTenancyConfig } from '../config/multitenancy';
import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  RepoRepository,
} from '../db/repositories';
import { cloneRepo, createBranch, getBranchPath } from '../git/exec';
import { generateId } from '../lib/ids';
import { DirectExecutor, UnixIntegrationService } from '../unix';

export interface SeedOptions {
  /**
   * Base directory for cloning repos (defaults to ~/.agor/repos)
   */
  baseDir?: string;

  /**
   * User ID to attribute created entities to. Required — every row must be
   * attributed to a real user. Pass the user_id of an existing admin (e.g.
   * the one auto-created by `ensureFirstRunAdmin` on first daemon start).
   */
  userId: UUID;

  /**
   * Skip if data already exists (idempotent)
   */
  skipIfExists?: boolean;
}

export interface SeedResult {
  repo_id: UUID;
  branch_id: BranchID;
  skipped: boolean;
}

/**
 * Seed development fixtures
 */
export async function seedDevFixtures(options: SeedOptions): Promise<SeedResult> {
  if (!options?.userId) {
    throw new Error(
      'seedDevFixtures: options.userId is required — pass the user_id of an existing admin'
    );
  }
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
  const { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } = await import(
    '../db/tenant-scope'
  );
  const db = createTenantScopedDatabaseProxy(createDatabase({ url: databaseUrl }));
  const config = loadConfigSync();
  const multiTenancy = resolveMultiTenancyConfig(config);
  const tenantId = multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined;

  return runWithTenantDatabaseScope(db, tenantId, async () => {
    const repoRepo = new RepoRepository(db);
    const branchRepo = new BranchRepository(db);
    const boardRepo = new BoardRepository(db);
    const boardObjectRepo = new BoardObjectRepository(db);

    // Setup Unix integration only when filesystem isolation is enabled.
    let unixIntegrationService: UnixIntegrationService | null = null;
    const unixSecurityMode = resolveExecutionSecurityMode();
    if (unixSecurityMode.unixFsIsolationEnabled) {
      const config = loadConfigSync();
      const daemonUser = config.daemon?.unix_user || os.userInfo().username;
      console.log(`🔐 Unix integration active (daemon user: ${daemonUser})`);
      unixIntegrationService = new UnixIntegrationService(db, new DirectExecutor(), {
        enabled: true,
        daemonUser,
      });
    }

    const baseDir = options.baseDir ?? path.join(os.homedir(), '.agor', 'repos');
    const userId = options.userId;

    // Check if data already exists (always check for idempotency)
    const existing = await repoRepo.findBySlug('agor');
    if (existing && options.skipIfExists) {
      console.log('✓ Dev fixtures already exist, skipping...');

      // Find the test-branch
      const branches = await branchRepo.findAll({ repo_id: existing.repo_id });
      const tenantBranchSuffix =
        tenantId && tenantId !== 'default'
          ? `-${tenantId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40)}`
          : '';
      const testBranchName = `test-branch${tenantBranchSuffix}`;
      const testBranch = branches.find((w) => w.name === testBranchName);

      return {
        repo_id: existing.repo_id,
        branch_id: testBranch?.branch_id ?? (generateId() as BranchID),
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

    // STEP 3: Create test-branch
    console.log('3️⃣  Creating test-branch...');

    const tenantBranchSuffix =
      tenantId && tenantId !== 'default'
        ? `-${tenantId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40)}`
        : '';
    const branchName = `test-branch${tenantBranchSuffix}`;
    const branchPath = getBranchPath(repoSlug, branchName);

    // Generate unique numeric ID for branch (used for port allocation)
    const branchUniqueId = Math.floor(Math.random() * 1000) + 1;

    // Create branch with its own branch (can't checkout main twice)
    const branch = await branchRepo.create({
      repo_id: repo.repo_id,
      name: branchName,
      ref: branchName, // Use branch name as branch name
      path: branchPath,
      base_ref: defaultBranch,
      new_branch: true, // Create new branch from main
      branch_unique_id: branchUniqueId,
      created_by: userId,
      board_id: defaultBoard.board_id,
      needs_attention: false,
    });

    // Create actual git branch on disk
    await createBranch(
      repoPath,
      branchPath,
      branchName, // ref - new branch with same name as branch
      true, // createBranch
      false, // pullLatest (just cloned)
      defaultBranch, // sourceBranch
      undefined, // env
      'branch' // refType
    );

    // Add user as owner of the branch
    await branchRepo.addOwner(branch.branch_id, userId);

    // Unix Integration: Create branch group and add owner (same as daemon hook does)
    if (unixIntegrationService) {
      try {
        const groupName = await unixIntegrationService.createBranchGroup(branch.branch_id);
        await unixIntegrationService.addUserToBranchGroup(branch.branch_id, userId);
        // Fix permissions on .git/worktrees/<name>/ directory
        await unixIntegrationService.fixBranchGitDirPermissions(branch.branch_id);
        console.log(`   Unix group: ${groupName}`);
      } catch (error) {
        console.error(
          `   ⚠️  Unix integration failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // Continue - app-layer RBAC is still functional
      }
    }

    console.log(`   ✓ Created branch: ${branch.name} (${branch.branch_id})`);

    // STEP 4: Create board object to position branch on board
    console.log('4️⃣  Creating board object for branch...');

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
      branch_id: branch.branch_id,
      position: fallbackPosition,
    });

    console.log(
      `   ✓ Created board object at position (${fallbackPosition.x}, ${fallbackPosition.y})`
    );

    console.log('✅ Dev fixtures seeded successfully!');
    console.log('');
    console.log(`   Repo:     ${repo.slug} (${repo.repo_id})`);
    console.log(`   Branch: ${branch.name} (${branch.branch_id})`);
    console.log('');

    return {
      repo_id: repo.repo_id,
      branch_id: branch.branch_id,
      skipped: false,
    };
  });
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
