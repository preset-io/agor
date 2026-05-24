#!/usr/bin/env tsx
/**
 * Create RBAC Test Users and Branches
 *
 * Creates alice and bob users with test branches for RBAC testing.
 * Used in PostgreSQL + RBAC development environment.
 *
 * Usage:
 *   tsx scripts/create-rbac-test-users.ts
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection URL
 *   AGOR_DB_DIALECT - Should be 'postgresql'
 */

import os from 'node:os';
import path from 'node:path';
import { getConfigPath, isBranchRbacEnabled, loadConfigSync } from '@agor/core/config';
import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  createDatabase,
  createUser,
  getUserByEmail,
  RepoRepository,
} from '@agor/core/db';
import { autoAssignBranchUniqueId } from '@agor/core/environment/variable-resolver';
import { createBranch } from '@agor/core/git';
import type { RepoID, UUID } from '@agor/core/types';
import { DirectExecutor, UnixIntegrationService } from '@agor/core/unix';
import chalk from 'chalk';

interface TestUser {
  email: string;
  password: string;
  name: string;
  username: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
}

const TEST_USERS: TestUser[] = [
  {
    email: 'alice@agor.live',
    password: 'admin',
    name: 'Alice',
    username: 'alice',
    role: 'admin', // Alice is admin for testing purposes
  },
  {
    email: 'bob@agor.live',
    password: 'admin',
    name: 'Bob',
    username: 'bob',
    role: 'member',
  },
];

async function main() {
  console.log(chalk.bold('👥 Creating RBAC Test Users and Branches\n'));

  // Get database connection
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Fall back to SQLite (though RBAC testing should use PostgreSQL)
    const configPath = getConfigPath();
    const agorHome = path.join(configPath, '..');
    const dbPath = path.join(agorHome, 'agor.db');
    databaseUrl = `file:${dbPath}`;
    console.log(
      chalk.yellow('⚠️  No DATABASE_URL set, using SQLite (PostgreSQL recommended for RBAC testing)')
    );
  }

  const db = createDatabase({ url: databaseUrl });
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const boardRepo = new BoardRepository(db);
  const boardObjectRepo = new BoardObjectRepository(db);

  // Setup Unix integration if RBAC is enabled
  let unixIntegrationService: UnixIntegrationService | null = null;
  const rbacEnabled = isBranchRbacEnabled();
  if (rbacEnabled) {
    const config = loadConfigSync();
    const daemonUser = config.daemon?.unix_user || os.userInfo().username;
    console.log(
      chalk.cyan(`🔐 RBAC enabled - Unix integration active (daemon user: ${daemonUser})\n`)
    );
    unixIntegrationService = new UnixIntegrationService(db, new DirectExecutor(), {
      enabled: true,
      daemonUser,
    });
  }

  // Create users
  console.log(chalk.bold('1. Creating users...\n'));

  const userIds: Record<string, UUID> = {};

  for (const testUser of TEST_USERS) {
    try {
      // Check if user already exists
      const existing = await getUserByEmail(db, testUser.email);

      if (existing) {
        console.log(chalk.gray(`  ✓ ${testUser.name} already exists (${testUser.email})`));
        userIds[testUser.username] = existing.user_id;
        continue;
      }

      // Create user with unix_username set
      const user = await createUser(db, {
        email: testUser.email,
        password: testUser.password,
        name: testUser.name,
        role: testUser.role || 'member',
        unix_username: testUser.username, // Link to Unix user account
      });

      userIds[testUser.username] = user.user_id;

      console.log(chalk.green(`  ✓ Created ${testUser.name} (${testUser.email})`));
      console.log(chalk.gray(`    Password:      ${testUser.password}`));
      console.log(chalk.gray(`    User ID:       ${user.user_id.substring(0, 8)}`));
      console.log(chalk.gray(`    Unix username: ${testUser.username}`));
    } catch (error) {
      console.error(chalk.red(`  ✗ Failed to create ${testUser.name}:`), error);
      process.exit(1);
    }
  }

  console.log('');

  // Find or create agor repo
  console.log(chalk.bold('2. Ensuring agor repo exists...\n'));

  const agorRepo = await repoRepo.findBySlug('agor');

  if (!agorRepo) {
    console.log(chalk.yellow('  ⚠️  Agor repo not found'));
    console.log(chalk.gray('     Run with SEED=true to create the repo first'));
    console.log('');
    process.exit(1);
  }

  console.log(chalk.green(`  ✓ Found agor repo (${agorRepo.repo_id.substring(0, 8)})`));

  // Ensure repo has Unix group (may have been created before RBAC was enabled)
  if (unixIntegrationService && !agorRepo.unix_group) {
    try {
      const groupName = await unixIntegrationService.createRepoGroup(agorRepo.repo_id as RepoID);
      console.log(chalk.gray(`    Created missing repo Unix group: ${groupName}`));
    } catch (error) {
      console.error(
        chalk.yellow(
          `    ⚠️  Failed to create repo group: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }
  console.log('');

  // Find default board
  console.log(chalk.bold('3. Finding default board...\n'));

  const defaultBoard = await boardRepo.findBySlug('default');

  if (!defaultBoard) {
    console.log(chalk.yellow('  ⚠️  Default board not found'));
    console.log(chalk.gray('     Run with SEED=true to create the default board first'));
    console.log('');
    process.exit(1);
  }

  console.log(chalk.green(`  ✓ Found default board (${defaultBoard.board_id.substring(0, 8)})`));
  console.log('');

  // Create test branches
  console.log(chalk.bold('4. Creating test branches...\n'));

  interface TestBranch {
    name: string;
    owner: string;
    additionalOwners?: Array<{ username: string; permission: 'view' | 'prompt' | 'all' }>;
  }

  const testBranches: TestBranch[] = [
    {
      name: 'alice-private',
      owner: 'alice',
    },
    {
      name: 'bob-private',
      owner: 'bob',
    },
    {
      name: 'team-shared',
      owner: 'alice',
      additionalOwners: [{ username: 'bob', permission: 'prompt' }],
    },
  ];

  const repoPath = path.join(os.homedir(), '.agor', 'repos', 'agor');
  const branchesPath = path.join(os.homedir(), '.agor', 'branches');

  for (const testBranch of testBranches) {
    try {
      // Check if branch already exists
      const allBranches = await branchRepo.findAll({ repo_id: agorRepo.repo_id });
      const existing = allBranches.find((w) => w.name === testBranch.name);

      if (existing) {
        console.log(chalk.gray(`  ✓ Branch "${testBranch.name}" already exists`));

        // Check if it needs board association
        if (!existing.board_id) {
          await branchRepo.update(existing.branch_id, { board_id: defaultBoard.board_id });
          console.log(chalk.gray(`    → Associated with board "${defaultBoard.name}"`));
        }

        // Check if board object exists
        const boardObject = await boardObjectRepo.findByBranchId(existing.branch_id);
        if (!boardObject) {
          const branchIndex = testBranches.findIndex((w) => w.name === testBranch.name);
          const baseX = 0;
          const baseY = 0;
          const spacing = 600;
          const jitter = 100;

          await boardObjectRepo.create({
            board_id: defaultBoard.board_id,
            branch_id: existing.branch_id,
            position: {
              x: baseX + branchIndex * spacing,
              y: baseY + (Math.random() - 0.5) * jitter,
            },
          });
          console.log(chalk.gray(`    → Created board object with position`));
        }

        continue;
      }

      const ownerId = userIds[testBranch.owner];
      if (!ownerId) {
        console.error(chalk.red(`  ✗ Owner "${testBranch.owner}" not found`));
        continue;
      }

      // Auto-assign branch unique ID — use getAllUsedUniqueIds to include archived branches
      const allUsedIds = await branchRepo.getAllUsedUniqueIds();
      const branchUniqueId = autoAssignBranchUniqueId(allUsedIds);
      const branchPathId = `wt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const branchPath = path.join(branchesPath, branchPathId);

      // Create a branch name for this branch (same as branch name)
      const branchName = testBranch.name;

      // Create branch database entry with board association
      const branch = await branchRepo.create({
        repo_id: agorRepo.repo_id,
        name: testBranch.name,
        ref: branchName,
        ref_type: 'branch',
        created_by: ownerId,
        branch_unique_id: branchUniqueId,
        path: branchPath,
        base_ref: 'main',
        new_branch: true,
        board_id: defaultBoard.board_id,
      });

      // Create actual git branch on disk with new branch
      await createBranch(
        repoPath,
        branchPath,
        branchName, // ref - new branch name
        true, // createBranch - create new branch from main
        false, // pullLatest (repo already cloned by seed script)
        'main', // sourceBranch - branch from main
        undefined, // env
        'branch' // refType
      );

      // Add owner
      await branchRepo.addOwner(branch.branch_id, ownerId);

      // Unix Integration: Create group and add owner (same as daemon hook does)
      if (unixIntegrationService) {
        try {
          // Add owner to repo group (for .git access)
          await unixIntegrationService.addUserToRepoGroup(agorRepo.repo_id as RepoID, ownerId);

          // Create branch group and add owner
          const groupName = await unixIntegrationService.createBranchGroup(branch.branch_id);
          await unixIntegrationService.addUserToBranchGroup(branch.branch_id, ownerId);

          // Fix permissions on .git/worktrees/<name>/ directory
          await unixIntegrationService.fixBranchGitDirPermissions(branch.branch_id);

          console.log(chalk.gray(`    Unix group: ${groupName}`));
        } catch (error) {
          console.error(
            chalk.yellow(
              `    ⚠️  Unix integration failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
          // Continue - app-layer RBAC is still functional
        }
      }

      // Create board object with position (spread branches horizontally with some jitter)
      const baseX = 0;
      const baseY = 0;
      const spacing = 600; // Space cards ~600px apart horizontally
      const jitter = 100; // Add some random vertical jitter
      const branchIndex = testBranches.findIndex((w) => w.name === testBranch.name);

      await boardObjectRepo.create({
        board_id: defaultBoard.board_id,
        branch_id: branch.branch_id,
        position: {
          x: baseX + branchIndex * spacing,
          y: baseY + (Math.random() - 0.5) * jitter,
        },
      });

      console.log(chalk.green(`  ✓ Created branch "${testBranch.name}"`));
      console.log(chalk.gray(`    ID:    ${branch.branch_id.substring(0, 8)}`));
      console.log(chalk.gray(`    Path:  ${branchPath}`));
      console.log(chalk.gray(`    Owner: ${testBranch.owner}`));
      console.log(chalk.gray(`    Board: ${defaultBoard.name}`));

      // Add additional owners with permissions
      if (testBranch.additionalOwners) {
        for (const additionalOwner of testBranch.additionalOwners) {
          const additionalUserId = userIds[additionalOwner.username];
          if (!additionalUserId) {
            console.error(
              chalk.red(`    ✗ Additional owner "${additionalOwner.username}" not found`)
            );
            continue;
          }

          // For now, we only support adding as owner (full access)
          // The 'permission' field will be used when we implement
          // different permission levels in the branch_owners table
          if (additionalOwner.permission === 'all') {
            await branchRepo.addOwner(branch.branch_id, additionalUserId);
            // Also add to Unix groups (repo + branch)
            if (unixIntegrationService) {
              try {
                // Add to repo group (for .git access)
                await unixIntegrationService.addUserToRepoGroup(
                  agorRepo.repo_id as RepoID,
                  additionalUserId
                );
                // Add to branch group
                await unixIntegrationService.addUserToBranchGroup(
                  branch.branch_id,
                  additionalUserId
                );
              } catch {
                console.error(
                  chalk.yellow(`    ⚠️  Failed to add ${additionalOwner.username} to Unix groups`)
                );
              }
            }
            console.log(
              chalk.gray(
                `    + ${additionalOwner.username} (${additionalOwner.permission} permission)`
              )
            );
          } else {
            // For non-'all' permissions, we'll need to update the schema
            // to support permission levels in branch_owners table
            console.log(
              chalk.yellow(
                `    ⚠️  ${additionalOwner.username} (${additionalOwner.permission} permission - not yet implemented)`
              )
            );
            console.log(
              chalk.gray('       Currently only "all" permission is supported via branch_owners')
            );
          }
        }
      }
    } catch (error) {
      console.error(chalk.red(`  ✗ Failed to create branch "${testBranch.name}":`), error);
    }
  }

  console.log('');
  console.log(chalk.bold.green('✅ RBAC test environment ready!\n'));

  console.log(chalk.bold('Test Users:'));
  console.log(chalk.gray(`  alice@agor.live (password: admin, unix: alice)`));
  console.log(chalk.gray(`    - Owns: alice-private, team-shared (full access)`));
  console.log(chalk.gray(`  bob@agor.live   (password: admin, unix: bob)`));
  console.log(chalk.gray(`    - Owns: bob-private`));
  console.log(
    chalk.yellow(`    - Note: bob's "prompt" permission on team-shared not yet fully implemented`)
  );
  console.log('');

  console.log(chalk.bold('SSH Access:'));
  console.log(chalk.gray('  ssh alice@localhost -p 2222  # password: admin'));
  console.log(chalk.gray('  ssh bob@localhost -p 2222    # password: admin'));
  console.log('');

  console.log(chalk.bold('Web Login:'));
  console.log(chalk.gray('  http://localhost:6091'));
  console.log(chalk.gray('  alice@agor.live / admin'));
  console.log(chalk.gray('  bob@agor.live / admin'));
  console.log('');
}

main().catch((error) => {
  console.error(chalk.red('\n✗ Fatal error:'), error);
  process.exit(1);
});
