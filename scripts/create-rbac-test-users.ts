#!/usr/bin/env tsx
/**
 * Create RBAC Test Users and Worktrees
 *
 * Creates alice and bob users with test worktrees for RBAC testing.
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
import { getConfigPath } from '@agor/core/config';
import {
  createDatabase,
  createUser,
  getUserByEmail,
  RepoRepository,
  WorktreeRepository,
} from '@agor/core/db';
import { autoAssignWorktreeUniqueId } from '@agor/core/environment/variable-resolver';
import { createWorktree } from '@agor/core/git';
import type { UUID } from '@agor/core/types';
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
  console.log(chalk.bold('👥 Creating RBAC Test Users and Worktrees\n'));

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
  const worktreeRepo = new WorktreeRepository(db);

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
  console.log('');

  // Create test worktrees
  console.log(chalk.bold('3. Creating test worktrees...\n'));

  interface TestWorktree {
    name: string;
    owner: string;
    additionalOwners?: Array<{ username: string; permission: 'view' | 'prompt' | 'all' }>;
  }

  const testWorktrees: TestWorktree[] = [
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
  const worktreesPath = path.join(os.homedir(), '.agor', 'worktrees');

  for (const testWorktree of testWorktrees) {
    try {
      // Check if worktree already exists
      const allWorktrees = await worktreeRepo.findAll({ repo_id: agorRepo.repo_id });
      const existing = allWorktrees.find((w) => w.name === testWorktree.name);

      if (existing) {
        console.log(chalk.gray(`  ✓ Worktree "${testWorktree.name}" already exists`));
        continue;
      }

      const ownerId = userIds[testWorktree.owner];
      if (!ownerId) {
        console.error(chalk.red(`  ✗ Owner "${testWorktree.owner}" not found`));
        continue;
      }

      // Auto-assign worktree unique ID using the same function as the repos service
      const worktreeUniqueId = autoAssignWorktreeUniqueId(allWorktrees);
      const worktreePathId = `wt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const worktreePath = path.join(worktreesPath, worktreePathId);

      // Create a branch name for this worktree (same as worktree name)
      const branchName = testWorktree.name;

      // Create worktree database entry
      const worktree = await worktreeRepo.create({
        repo_id: agorRepo.repo_id,
        name: testWorktree.name,
        ref: branchName,
        ref_type: 'branch',
        created_by: ownerId,
        worktree_unique_id: worktreeUniqueId,
        path: worktreePath,
        base_ref: 'main',
        new_branch: true,
      });

      // Create actual git worktree on disk with new branch
      await createWorktree(
        repoPath,
        worktreePath,
        branchName, // ref - new branch name
        true, // createBranch - create new branch from main
        false, // pullLatest (repo already cloned by seed script)
        'main', // sourceBranch - branch from main
        undefined, // env
        'branch' // refType
      );

      // Add owner
      await worktreeRepo.addOwner(worktree.worktree_id, ownerId);

      console.log(chalk.green(`  ✓ Created worktree "${testWorktree.name}"`));
      console.log(chalk.gray(`    ID:    ${worktree.worktree_id.substring(0, 8)}`));
      console.log(chalk.gray(`    Path:  ${worktreePath}`));
      console.log(chalk.gray(`    Owner: ${testWorktree.owner}`));

      // Add additional owners with permissions
      if (testWorktree.additionalOwners) {
        for (const additionalOwner of testWorktree.additionalOwners) {
          const additionalUserId = userIds[additionalOwner.username];
          if (!additionalUserId) {
            console.error(
              chalk.red(`    ✗ Additional owner "${additionalOwner.username}" not found`)
            );
            continue;
          }

          // For now, we only support adding as owner (full access)
          // The 'permission' field will be used when we implement
          // different permission levels in the worktree_owners table
          if (additionalOwner.permission === 'all') {
            await worktreeRepo.addOwner(worktree.worktree_id, additionalUserId);
            console.log(
              chalk.gray(
                `    + ${additionalOwner.username} (${additionalOwner.permission} permission)`
              )
            );
          } else {
            // For non-'all' permissions, we'll need to update the schema
            // to support permission levels in worktree_owners table
            console.log(
              chalk.yellow(
                `    ⚠️  ${additionalOwner.username} (${additionalOwner.permission} permission - not yet implemented)`
              )
            );
            console.log(
              chalk.gray('       Currently only "all" permission is supported via worktree_owners')
            );
          }
        }
      }
    } catch (error) {
      console.error(chalk.red(`  ✗ Failed to create worktree "${testWorktree.name}":`), error);
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
