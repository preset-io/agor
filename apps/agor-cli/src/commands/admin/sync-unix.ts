/**
 * Admin Command: Sync Unix Users and Groups
 *
 * PRIVILEGED OPERATION - Must be called via sudo:
 *   sudo agor admin sync-unix
 *
 * Verifies that all users with unix_username in the database have corresponding
 * Unix system users, and that they belong to the correct worktree groups.
 *
 * Operations (additive by default):
 * - Creates missing Unix users
 * - Ensures agor_users group exists and contains all managed users
 * - Adds users to worktree groups they own
 * - Reports discrepancies
 *
 * Cleanup operations (with --cleanup flags):
 * - --cleanup-groups: Deletes stale agor_wt_* groups not in database
 * - --cleanup-users: Deletes stale agor_* users not in database (keeps home dirs)
 * - --cleanup: Enables both cleanup operations
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  eq,
  inArray,
  select,
  users,
  worktreeOwners,
  worktrees,
} from '@agor/core/db';
import type { WorktreeID } from '@agor/core/types';
import {
  AGOR_USERS_GROUP,
  generateWorktreeGroupName,
  UnixGroupCommands,
  UnixUserCommands,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

interface UserWithUnix {
  user_id: string;
  email: string;
  name: string | null;
  unix_username: string;
}

interface WorktreeOwnership {
  worktree_id: string;
  name: string;
  unix_group: string | null;
}

interface SyncResult {
  user: UserWithUnix;
  unixUserExists: boolean;
  unixUserCreated: boolean;
  groups: {
    expected: string[];
    actual: string[];
    added: string[];
    missing: string[];
  };
  errors: string[];
}

export default class SyncUnix extends Command {
  static override description =
    'Sync Unix users and groups with database (admin only). Creates missing users and fixes group memberships.';

  static override examples = [
    'sudo <%= config.bin %> <%= command.id %>',
    'sudo <%= config.bin %> <%= command.id %> --dry-run',
    'sudo <%= config.bin %> <%= command.id %> --verbose',
    'sudo <%= config.bin %> <%= command.id %> --create-groups',
    'sudo <%= config.bin %> <%= command.id %> --cleanup --dry-run',
    'sudo <%= config.bin %> <%= command.id %> --cleanup-groups',
  ];

  static override flags = {
    'dry-run': Flags.boolean({
      char: 'n',
      description: 'Show what would be done without making changes',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed output',
      default: false,
    }),
    'create-users': Flags.boolean({
      description: 'Create missing Unix users',
      default: true,
      allowNo: true,
    }),
    'sync-groups': Flags.boolean({
      description: 'Sync group memberships',
      default: true,
      allowNo: true,
    }),
    'create-groups': Flags.boolean({
      description: 'Create missing worktree groups',
      default: false,
    }),
    // Cleanup flags
    cleanup: Flags.boolean({
      description: 'Enable all cleanup operations (stale users and groups)',
      default: false,
    }),
    'cleanup-groups': Flags.boolean({
      description: 'Delete stale agor_wt_* groups not in database',
      default: false,
    }),
    'cleanup-users': Flags.boolean({
      description: 'Delete stale agor_* users not in database (keeps home directories)',
      default: false,
    }),
  };

  /**
   * Check if a Unix user exists on the system
   */
  private userExists(username: string): boolean {
    try {
      execSync(UnixUserCommands.userExists(username), { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get groups a Unix user belongs to
   */
  private getUserGroups(username: string): string[] {
    try {
      const output = execSync(UnixUserCommands.getUserGroups(username), {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Check if a Unix group exists
   */
  private groupExists(groupName: string): boolean {
    try {
      execSync(UnixGroupCommands.groupExists(groupName), { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a Unix user (assumes running as root via sudo)
   */
  private createUser(username: string, dryRun: boolean): boolean {
    const cmd = UnixUserCommands.createUser(username);
    if (dryRun) {
      this.log(chalk.gray(`  [dry-run] Would run: ${cmd}`));
      return true;
    }
    try {
      execSync(cmd, { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add user to a group (assumes running as root via sudo)
   */
  private addUserToGroup(username: string, groupName: string, dryRun: boolean): boolean {
    const cmd = UnixGroupCommands.addUserToGroup(username, groupName);
    if (dryRun) {
      this.log(chalk.gray(`  [dry-run] Would run: ${cmd}`));
      return true;
    }
    try {
      execSync(cmd, { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a Unix group (assumes running as root via sudo)
   */
  private createGroup(groupName: string, dryRun: boolean): boolean {
    const cmd = UnixGroupCommands.createGroup(groupName);
    if (dryRun) {
      this.log(chalk.gray(`  [dry-run] Would run: ${cmd}`));
      return true;
    }
    try {
      execSync(cmd, { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a Unix user (keeps home directory)
   */
  private deleteUser(username: string, dryRun: boolean): boolean {
    const cmd = UnixUserCommands.deleteUser(username);
    if (dryRun) {
      this.log(chalk.gray(`  [dry-run] Would run: ${cmd}`));
      return true;
    }
    try {
      execSync(cmd, { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a Unix group
   */
  private deleteGroup(groupName: string, dryRun: boolean): boolean {
    const cmd = UnixGroupCommands.deleteGroup(groupName);
    if (dryRun) {
      this.log(chalk.gray(`  [dry-run] Would run: ${cmd}`));
      return true;
    }
    try {
      execSync(cmd, { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all agor_* users on the system (auto-generated format: agor_<8-hex>)
   */
  private listAgorUsers(): string[] {
    try {
      // Get all users from /etc/passwd matching agor_* pattern
      const output = execSync("getent passwd | grep '^agor_' | cut -d: -f1", {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output
        .trim()
        .split('\n')
        .filter((u) => u && /^agor_[0-9a-f]{8}$/.test(u));
    } catch {
      return [];
    }
  }

  /**
   * List all agor_wt_* groups on the system
   */
  private listWorktreeGroups(): string[] {
    try {
      // Get all groups from /etc/group matching agor_wt_* pattern
      const output = execSync("getent group | grep '^agor_wt_' | cut -d: -f1", {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output
        .trim()
        .split('\n')
        .filter((g) => g && /^agor_wt_[0-9a-f]{8}$/.test(g));
    } catch {
      return [];
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SyncUnix);
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;
    const createUsers = flags['create-users'];
    const syncGroups = flags['sync-groups'];
    const createGroups = flags['create-groups'];

    // Cleanup flags - --cleanup enables both
    const cleanupGroups = flags.cleanup || flags['cleanup-groups'];
    const cleanupUsers = flags.cleanup || flags['cleanup-users'];

    if (dryRun) {
      this.log(chalk.yellow('🔍 Dry run mode - no changes will be made\n'));
    }

    // Track stats
    let groupsCreated = 0;
    let groupsDeleted = 0;
    let usersDeleted = 0;
    let cleanupErrors = 0;

    try {
      // Connect to database
      // When running via sudo, os.homedir() returns /root, but we need the original user's DB.
      // Use SUDO_USER env var to resolve the correct home directory.
      let databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        const sudoUser = process.env.SUDO_USER;
        let agorHome: string;

        if (sudoUser) {
          // Running under sudo - use the invoking user's home directory
          // Try to get home directory from passwd entry
          try {
            const passwdEntry = execSync(`getent passwd ${sudoUser}`, {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'ignore'],
            }).trim();
            const homeDir = passwdEntry.split(':')[5]; // 6th field is home directory
            agorHome = join(homeDir, '.agor');
          } catch {
            // Fallback to /home/<user>/.agor if getent fails
            agorHome = join('/home', sudoUser, '.agor');
          }
        } else {
          // Not running under sudo - use current user's home
          agorHome = join(homedir(), '.agor');
        }

        const dbPath = join(agorHome, 'agor.db');

        // Verify the database exists
        if (!existsSync(dbPath)) {
          this.log(chalk.red(`Database not found: ${dbPath}`));
          if (sudoUser) {
            this.log(
              chalk.yellow(
                `\nHint: Running as root via sudo. Expected database at ~${sudoUser}/.agor/agor.db`
              )
            );
            this.log(
              chalk.yellow('If your database is elsewhere, set DATABASE_URL environment variable:')
            );
            this.log(chalk.gray('  sudo DATABASE_URL=file:/path/to/agor.db agor admin sync-unix'));
          }
          process.exit(1);
        }

        databaseUrl = `file:${dbPath}`;
      }

      const db = createDatabase({ url: databaseUrl });

      // Ensure agor_users group exists (global group for all managed users)
      this.log(chalk.cyan(`Checking ${AGOR_USERS_GROUP} group...\n`));
      if (!this.groupExists(AGOR_USERS_GROUP)) {
        this.log(chalk.yellow(`   → Creating ${AGOR_USERS_GROUP} group...`));
        if (this.createGroup(AGOR_USERS_GROUP, dryRun)) {
          groupsCreated++;
          this.log(chalk.green(`   ✓ Created ${AGOR_USERS_GROUP} group\n`));
        } else {
          this.log(chalk.red(`   ✗ Failed to create ${AGOR_USERS_GROUP} group\n`));
        }
      } else {
        this.log(chalk.green(`   ✓ ${AGOR_USERS_GROUP} group exists\n`));
      }

      // Get all users and filter for those with unix_username set
      const allUsers = (await select(db).from(users).all()) as UserWithUnix[];
      const validUsers = allUsers.filter((u) => u.unix_username);

      const results: SyncResult[] = [];

      if (validUsers.length === 0) {
        this.log(chalk.yellow('No users with unix_username found in database'));
        this.log(chalk.gray('\nTo set a unix_username for a user:'));
        this.log(chalk.gray('  agor user update <email> --unix-username <username>\n'));
        // Don't return early - still need to run cleanup if requested
      } else {
        this.log(chalk.cyan(`Found ${validUsers.length} user(s) with unix_username\n`));

        // Prefetch all worktree ownerships in a single query to avoid N+1
        const userIds = validUsers.map((u) => u.user_id);
        const allOwnerships = await select(db)
          .from(worktreeOwners)
          .innerJoin(worktrees, eq(worktreeOwners.worktree_id, worktrees.worktree_id))
          .where(inArray(worktreeOwners.user_id, userIds))
          .all();

        // Group ownerships by user_id for O(1) lookup
        const ownershipsByUser = new Map<string, WorktreeOwnership[]>();
        for (const row of allOwnerships) {
          const userId = (
            row as {
              worktree_owners: { user_id: string };
              worktrees: { worktree_id: string; name: string; unix_group: string | null };
            }
          ).worktree_owners.user_id;
          const ownership: WorktreeOwnership = {
            worktree_id: (row as { worktrees: { worktree_id: string } }).worktrees.worktree_id,
            name: (row as { worktrees: { name: string } }).worktrees.name,
            unix_group: (row as { worktrees: { unix_group: string | null } }).worktrees.unix_group,
          };
          const existing = ownershipsByUser.get(userId) || [];
          existing.push(ownership);
          ownershipsByUser.set(userId, existing);
        }

        for (const user of validUsers) {
          const result: SyncResult = {
            user,
            unixUserExists: false,
            unixUserCreated: false,
            groups: {
              expected: [],
              actual: [],
              added: [],
              missing: [],
            },
            errors: [],
          };

          this.log(chalk.bold(`📋 ${user.email}`));
          this.log(chalk.gray(`   unix_username: ${user.unix_username}`));
          this.log(chalk.gray(`   user_id: ${user.user_id.substring(0, 8)}`));

          // Check if Unix user exists
          result.unixUserExists = this.userExists(user.unix_username);

          if (result.unixUserExists) {
            this.log(chalk.green(`   ✓ Unix user exists`));
          } else {
            this.log(chalk.red(`   ✗ Unix user does not exist`));

            if (createUsers) {
              this.log(chalk.yellow(`   → Creating Unix user...`));
              if (this.createUser(user.unix_username, dryRun)) {
                result.unixUserCreated = true;
                result.unixUserExists = true;
                this.log(chalk.green(`   ✓ Unix user created`));
              } else {
                result.errors.push('Failed to create Unix user');
                this.log(chalk.red(`   ✗ Failed to create Unix user`));
              }
            }
          }

          // Get current groups (only if user exists)
          if (result.unixUserExists || dryRun) {
            result.groups.actual = result.unixUserExists
              ? this.getUserGroups(user.unix_username)
              : [];

            if (verbose && result.groups.actual.length > 0) {
              this.log(chalk.gray(`   Current groups: ${result.groups.actual.join(', ')}`));
            }

            // Ensure user is in agor_users group
            if (syncGroups && !result.groups.actual.includes(AGOR_USERS_GROUP)) {
              this.log(chalk.yellow(`   → Adding to ${AGOR_USERS_GROUP}...`));
              if (this.addUserToGroup(user.unix_username, AGOR_USERS_GROUP, dryRun)) {
                result.groups.added.push(AGOR_USERS_GROUP);
                this.log(chalk.green(`   ✓ Added to ${AGOR_USERS_GROUP}`));
              } else {
                result.errors.push(`Failed to add to ${AGOR_USERS_GROUP}`);
                this.log(chalk.red(`   ✗ Failed to add to ${AGOR_USERS_GROUP}`));
              }
            }

            // Get worktrees owned by this user (from prefetched data)
            const ownedWorktrees: WorktreeOwnership[] = ownershipsByUser.get(user.user_id) || [];

            if (verbose) {
              this.log(chalk.gray(`   Owns ${ownedWorktrees.length} worktree(s)`));
            }

            // Build expected groups from owned worktrees
            for (const wt of ownedWorktrees) {
              // Use existing unix_group or generate from worktree_id
              const expectedGroup =
                wt.unix_group || generateWorktreeGroupName(wt.worktree_id as WorktreeID);
              result.groups.expected.push(expectedGroup);

              const isInGroup = result.groups.actual.includes(expectedGroup);
              const groupExistsOnSystem = this.groupExists(expectedGroup);

              if (verbose) {
                this.log(
                  chalk.gray(
                    `   Worktree "${wt.name}" → group ${expectedGroup} ` +
                      `(exists: ${groupExistsOnSystem ? 'yes' : 'no'}, member: ${isInGroup ? 'yes' : 'no'})`
                  )
                );
              }

              if (!isInGroup && syncGroups) {
                let groupReady = groupExistsOnSystem;

                // Create group if it doesn't exist and --create-groups is set
                if (!groupExistsOnSystem) {
                  if (createGroups) {
                    this.log(chalk.yellow(`   → Creating group ${expectedGroup}...`));
                    if (this.createGroup(expectedGroup, dryRun)) {
                      groupsCreated++;
                      groupReady = true;
                      this.log(chalk.green(`   ✓ Created group ${expectedGroup}`));
                    } else {
                      result.errors.push(`Failed to create group ${expectedGroup}`);
                      this.log(chalk.red(`   ✗ Failed to create group ${expectedGroup}`));
                    }
                  } else {
                    result.groups.missing.push(expectedGroup);
                    if (verbose) {
                      this.log(
                        chalk.yellow(
                          `   ⚠ Group ${expectedGroup} does not exist (use --create-groups to create)`
                        )
                      );
                    }
                  }
                }

                // Add user to group if it exists/was created
                if (groupReady) {
                  this.log(chalk.yellow(`   → Adding to group ${expectedGroup}...`));
                  if (this.addUserToGroup(user.unix_username, expectedGroup, dryRun)) {
                    result.groups.added.push(expectedGroup);
                    this.log(chalk.green(`   ✓ Added to ${expectedGroup}`));
                  } else {
                    result.errors.push(`Failed to add to group ${expectedGroup}`);
                    this.log(chalk.red(`   ✗ Failed to add to ${expectedGroup}`));
                  }
                }
              }
            }
          }

          results.push(result);
          this.log('');
        }
      } // end if (validUsers.length > 0)

      // ========================================
      // Cleanup Phase
      // ========================================

      if (cleanupGroups || cleanupUsers) {
        this.log(chalk.cyan.bold('━━━ Cleanup ━━━\n'));
      }

      // Cleanup stale worktree groups
      if (cleanupGroups) {
        this.log(chalk.cyan('Checking for stale worktree groups...\n'));

        // Get all worktree groups that should exist (from DB)
        const allWorktrees = await select(db).from(worktrees).all();
        const expectedGroups = new Set(
          allWorktrees.map(
            (wt: { worktree_id: string; unix_group: string | null }) =>
              wt.unix_group || generateWorktreeGroupName(wt.worktree_id as WorktreeID)
          )
        );

        // Get all agor_wt_* groups on the system
        const systemGroups = this.listWorktreeGroups();

        if (verbose) {
          this.log(chalk.gray(`   Found ${systemGroups.length} agor_wt_* group(s) on system`));
          this.log(chalk.gray(`   Expected ${expectedGroups.size} group(s) from database`));
        }

        // Find stale groups (on system but not in DB)
        const staleGroups = systemGroups.filter((g) => !expectedGroups.has(g));

        if (staleGroups.length === 0) {
          this.log(chalk.green('   ✓ No stale worktree groups found\n'));
        } else {
          this.log(chalk.yellow(`   Found ${staleGroups.length} stale group(s) to remove:\n`));

          for (const groupName of staleGroups) {
            this.log(chalk.yellow(`   → Deleting group ${groupName}...`));
            if (this.deleteGroup(groupName, dryRun)) {
              groupsDeleted++;
              this.log(chalk.green(`   ✓ Deleted ${groupName}`));
            } else {
              cleanupErrors++;
              this.log(chalk.red(`   ✗ Failed to delete ${groupName}`));
            }
          }
          this.log('');
        }
      }

      // Cleanup stale users
      if (cleanupUsers) {
        this.log(chalk.cyan('Checking for stale Agor users...\n'));

        // Get all unix_usernames that should exist (from DB)
        // Only auto-generated ones (agor_<8-hex>) are candidates for cleanup
        const expectedUsers = new Set(
          validUsers.map((u) => u.unix_username).filter((u) => /^agor_[0-9a-f]{8}$/.test(u))
        );

        // Get all agor_* users on the system (only auto-generated format)
        const systemUsers = this.listAgorUsers();

        if (verbose) {
          this.log(chalk.gray(`   Found ${systemUsers.length} agor_* user(s) on system`));
          this.log(chalk.gray(`   Expected ${expectedUsers.size} user(s) from database`));
        }

        // Find stale users (on system but not in DB)
        const staleUsers = systemUsers.filter((u) => !expectedUsers.has(u));

        if (staleUsers.length === 0) {
          this.log(chalk.green('   ✓ No stale Agor users found\n'));
        } else {
          this.log(chalk.yellow(`   Found ${staleUsers.length} stale user(s) to remove:\n`));
          this.log(chalk.gray('   Note: Home directories will be kept\n'));

          for (const username of staleUsers) {
            this.log(chalk.yellow(`   → Deleting user ${username}...`));
            if (this.deleteUser(username, dryRun)) {
              usersDeleted++;
              this.log(chalk.green(`   ✓ Deleted ${username}`));
            } else {
              cleanupErrors++;
              this.log(chalk.red(`   ✗ Failed to delete ${username}`));
            }
          }
          this.log('');
        }
      }

      // Summary
      this.log(chalk.bold('━━━ Summary ━━━\n'));

      const usersCreated = results.filter((r) => r.unixUserCreated).length;
      const groupsAdded = results.reduce((acc, r) => acc + r.groups.added.length, 0);
      const groupsMissing = results.reduce((acc, r) => acc + r.groups.missing.length, 0);
      const syncErrors = results.reduce((acc, r) => acc + r.errors.length, 0);
      const totalErrors = syncErrors + cleanupErrors;

      const dryRunSuffix = dryRun ? ' (dry-run)' : '';

      // Sync stats
      this.log(chalk.bold('Sync:'));
      this.log(`  Users checked:     ${validUsers.length}`);
      this.log(`  Users created:     ${usersCreated}${dryRunSuffix}`);
      this.log(`  Groups created:    ${groupsCreated}${dryRunSuffix}`);
      this.log(`  Memberships added: ${groupsAdded}${dryRunSuffix}`);

      if (groupsMissing > 0) {
        this.log(
          chalk.yellow(`  Groups missing:    ${groupsMissing} (use --create-groups to create)`)
        );
      }

      // Cleanup stats (only if cleanup was requested)
      if (cleanupGroups || cleanupUsers) {
        this.log('');
        this.log(chalk.bold('Cleanup:'));
        if (cleanupUsers) {
          this.log(`  Users deleted:     ${usersDeleted}${dryRunSuffix}`);
        }
        if (cleanupGroups) {
          this.log(`  Groups deleted:    ${groupsDeleted}${dryRunSuffix}`);
        }
      }

      // Errors
      if (totalErrors > 0) {
        this.log('');
        this.log(chalk.red(`Errors:              ${totalErrors}`));
      }

      // Dry-run hint
      const hasChanges =
        usersCreated > 0 ||
        groupsAdded > 0 ||
        groupsCreated > 0 ||
        usersDeleted > 0 ||
        groupsDeleted > 0;
      if (dryRun && hasChanges) {
        this.log(chalk.yellow('\nRun without --dry-run to apply changes'));
      }

      process.exit(totalErrors > 0 ? 1 : 0);
    } catch (error) {
      this.log(chalk.red('\n✗ Sync failed'));
      if (error instanceof Error) {
        this.log(chalk.red(`  ${error.message}`));
      }
      process.exit(1);
    }
  }
}
