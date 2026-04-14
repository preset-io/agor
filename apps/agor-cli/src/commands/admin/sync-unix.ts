/**
 * Admin Command: Sync Unix Users and Groups
 *
 * Full sync of Unix users and groups with the Agor database. This command
 * ensures all users, groups, and permissions are correctly configured.
 *
 * Default behavior (no flags needed):
 * - Creates missing Unix users for users with unix_username set
 * - Creates missing worktree groups (agor_wt_*) and repo groups (agor_rp_*)
 * - Backfills unix_group on worktrees that don't have one
 * - Sets filesystem permissions on worktrees and .git directories
 * - Creates missing worktree directories for non-archived worktrees
 * - Adds users to their worktree and repo groups
 * - Prunes stale group memberships (users no longer owning a worktree)
 * - Ensures agor_users group exists and contains all managed users
 * - Applies daemon user ACLs on worktree directories
 * - Syncs user symlinks (creates missing, removes broken)
 *
 * Cleanup (opt-in, destructive):
 * - --cleanup: Deletes stale users and groups not in database
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@agor/core/config';
import {
  createDatabase,
  eq,
  inArray,
  repos,
  select,
  update,
  users,
  worktreeOwners,
  worktrees,
} from '@agor/core/db';
import {
  AGOR_USERS_GROUP,
  generateRepoGroupName,
  generateWorktreeGroupName,
  getUserWorktreesDir,
  getWorktreePermissionMode,
  getWorktreeSymlinkPath,
  REPO_GIT_PERMISSION_MODE,
  SymlinkCommands,
  UnixGroupCommands,
  UnixUserCommands,
} from '@agor/core/unix';
import type { RepoID, WorktreeID } from '@agor-live/client';
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
  repo_id: string;
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
    'Sync Unix users and groups with database (admin only). Creates missing users and fixes group memberships. NOTE: This command does NOT sync passwords - password hashes are one-way and cannot be converted to Unix passwords. Passwords are only synced in real-time during user creation or password updates via the web API.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>                # Full sync (creates users, groups, sets permissions)',
    '<%= config.bin %> <%= command.id %> --dry-run      # Preview what would be done',
    '<%= config.bin %> <%= command.id %> --cleanup      # Full sync + remove stale users/groups',
    '<%= config.bin %> <%= command.id %> --verbose      # Show detailed output',
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
    // Cleanup flags (opt-in, destructive)
    cleanup: Flags.boolean({
      description: 'Delete stale users and groups not in database (destructive)',
      default: false,
    }),
    'cleanup-groups': Flags.boolean({
      description: 'Delete stale agor_wt_* and agor_rp_* groups not in database',
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
   * Check if a Unix user is in a group
   */
  private isUserInGroup(username: string, groupName: string): boolean {
    try {
      execSync(UnixGroupCommands.isUserInGroup(username, groupName), { stdio: 'ignore' });
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

  /**
   * List all agor_rp_* (repo) groups on the system
   */
  private listRepoGroups(): string[] {
    try {
      // Get all groups from /etc/group matching agor_rp_* pattern
      const output = execSync("getent group | grep '^agor_rp_' | cut -d: -f1", {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output
        .trim()
        .split('\n')
        .filter((g) => g && /^agor_rp_[0-9a-f]{8}$/.test(g));
    } catch {
      return [];
    }
  }

  /**
   * Get members of a Unix group from the system
   */
  private getGroupMembers(groupName: string): string[] {
    try {
      const output = execSync(UnixGroupCommands.listGroupMembers(groupName), {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output.trim().split(',').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Remove user from a group
   */
  private removeUserFromGroup(username: string, groupName: string, dryRun: boolean): boolean {
    const cmd = UnixGroupCommands.removeUserFromGroup(username, groupName);
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
   * Check if a worktree directory should be created/synced based on archive state.
   *
   * Returns:
   * - 'sync': Directory exists, apply permissions
   * - 'create': Directory missing, non-archived — create it
   * - 'skip': Skip this worktree (archived+deleted, creating, failed, etc.)
   */
  private getWorktreeDirectoryAction(
    dirExists: boolean,
    archived: boolean,
    filesystemStatus: string | null | undefined
  ): 'sync' | 'create' | 'skip' {
    // Creating or failed worktrees — not ready, skip
    if (filesystemStatus === 'creating' || filesystemStatus === 'failed') {
      return 'skip';
    }

    // Archived + deleted — directory was intentionally removed
    if (archived && filesystemStatus === 'deleted') {
      return 'skip';
    }

    // Directory exists — always sync permissions regardless of archive state
    if (dirExists) {
      return 'sync';
    }

    // Directory missing + not archived — create it
    if (!archived) {
      return 'create';
    }

    // Directory missing + archived (preserved or cleaned) — skip
    // The directory was expected to exist but doesn't — log info but don't create
    return 'skip';
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SyncUnix);
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;

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
    let worktreesSynced = 0;
    let worktreesBackfilled = 0; // Worktrees that needed unix_group set in DB
    let worktreeDirsCreated = 0; // Worktree directories created on disk
    let worktreesSkipped = 0; // Worktrees skipped (archived/deleted, missing path, etc.)
    let reposBackfilled = 0; // Repos that needed unix_group set in DB
    let reposPermSynced = 0; // Repos that had .git permissions synced
    let membershipsRemoved = 0; // Stale group memberships pruned
    let daemonAclsApplied = 0; // Daemon user ACLs applied
    let symlinksCreated = 0; // User symlinks created
    let symlinksCleaned = 0; // Broken symlinks removed
    let syncErrors = 0;

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

      // Load config and get daemon user
      // The daemon user must be added to all Unix groups so it can access files
      // Since this command runs under sudo, we MUST require explicit config
      // (process.env.USER would return 'root' which is wrong)
      const config = await loadConfig();
      const daemonUser = config.daemon?.unix_user;

      if (!daemonUser) {
        this.error(
          'daemon.unix_user is not configured.\n' +
            'This command requires explicit configuration because it runs with elevated privileges.\n' +
            'Please set daemon.unix_user in ~/.agor/config.yaml.\n' +
            'Example:\n' +
            '  daemon:\n' +
            '    unix_user: agor'
        );
      }

      this.log(chalk.cyan(`Daemon user: ${daemonUser}\n`));
      if (verbose) {
        this.log(
          chalk.gray(
            `   (from config.daemon.unix_user, will be added to all repo and worktree groups)\n`
          )
        );
      }

      // Track daemon memberships added
      let daemonMembershipsAdded = 0;

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
        // biome-ignore lint/suspicious/noExplicitAny: Join query requires type assertion
        const allOwnerships = await (db as any)
          .select()
          .from(worktreeOwners)
          .innerJoin(worktrees, eq(worktreeOwners.worktree_id, worktrees.worktree_id))
          .where(inArray(worktreeOwners.user_id, userIds));

        // Group ownerships by user_id for O(1) lookup
        const ownershipsByUser = new Map<string, WorktreeOwnership[]>();
        for (const row of allOwnerships) {
          const userId = (
            row as {
              worktree_owners: { user_id: string };
              worktrees: {
                worktree_id: string;
                name: string;
                unix_group: string | null;
                repo_id: string;
              };
            }
          ).worktree_owners.user_id;
          const ownership: WorktreeOwnership = {
            worktree_id: (row as { worktrees: { worktree_id: string } }).worktrees.worktree_id,
            name: (row as { worktrees: { name: string } }).worktrees.name,
            unix_group: (row as { worktrees: { unix_group: string | null } }).worktrees.unix_group,
            repo_id: (row as { worktrees: { repo_id: string } }).worktrees.repo_id,
          };
          const existing = ownershipsByUser.get(userId) || [];
          existing.push(ownership);
          ownershipsByUser.set(userId, existing);
        }

        // ========================================
        // Sync Repos Phase
        // Ensures all repos have unix_group set in the database
        // and creates the corresponding Unix group if needed.
        // This runs BEFORE the per-user loop so that the repoGroupMap
        // will have the correct unix_group values when processing users.
        // ========================================

        // Get all repos first
        let allRepos = await select(db).from(repos).all();

        this.log(chalk.cyan.bold('\n━━━ Sync Repos ━━━\n'));

        const reposWithoutGroup = allRepos.filter(
          (r: { unix_group: string | null }) => r.unix_group === null
        );

        if (reposWithoutGroup.length === 0) {
          this.log(chalk.green('   ✓ All repos have unix_group set\n'));
        } else {
          this.log(
            chalk.cyan(
              `Found ${reposWithoutGroup.length} repo(s) without unix_group (of ${allRepos.length} total)\n`
            )
          );

          for (const repo of reposWithoutGroup) {
            const rawRepo = repo as {
              repo_id: string;
              slug: string;
              data: { local_path?: string } | null;
            };

            const repoGroup = generateRepoGroupName(rawRepo.repo_id as RepoID);

            this.log(chalk.bold(`📁 ${rawRepo.slug}`));
            this.log(chalk.gray(`   repo_id: ${rawRepo.repo_id.substring(0, 8)}`));
            this.log(chalk.gray(`   generated group: ${repoGroup}`));

            // Create the Unix group if it doesn't exist
            const groupExistsOnSystem = this.groupExists(repoGroup);

            if (groupExistsOnSystem) {
              this.log(chalk.green(`   ✓ Unix group already exists`));
            } else {
              this.log(chalk.yellow(`   → Creating Unix group ${repoGroup}...`));
              if (this.createGroup(repoGroup, dryRun)) {
                groupsCreated++;
                this.log(chalk.green(`   ✓ Created Unix group ${repoGroup}`));
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to create Unix group ${repoGroup}`));
                this.log('');
                continue; // Skip DB update if group creation failed
              }
            }

            // Add daemon user to repo group
            if (daemonUser) {
              const daemonInGroup = dryRun ? false : this.isUserInGroup(daemonUser, repoGroup);
              if (!daemonInGroup) {
                this.log(chalk.yellow(`   → Adding daemon user ${daemonUser} to ${repoGroup}...`));
                if (this.addUserToGroup(daemonUser, repoGroup, dryRun)) {
                  daemonMembershipsAdded++;
                  this.log(chalk.green(`   ✓ Added daemon user to ${repoGroup}`));
                } else {
                  this.log(chalk.red(`   ✗ Failed to add daemon user to ${repoGroup}`));
                }
              } else if (verbose) {
                this.log(chalk.gray(`   ✓ Daemon user already in ${repoGroup}`));
              }
            }

            // Update the database to set unix_group
            if (dryRun) {
              this.log(
                chalk.gray(
                  `   [dry-run] Would update database: SET unix_group = '${repoGroup}' WHERE repo_id = '${rawRepo.repo_id}'`
                )
              );
            } else {
              try {
                await update(db, repos)
                  .set({ unix_group: repoGroup })
                  .where(eq(repos.repo_id, rawRepo.repo_id))
                  .run();
                this.log(chalk.green(`   ✓ Updated database with unix_group`));
              } catch (error) {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to update database: ${error}`));
                this.log('');
                continue;
              }
            }

            // Set .git permissions if the repo has a local_path and .git exists
            const repoPath = rawRepo.data?.local_path;
            if (repoPath) {
              const gitPath = `${repoPath}/.git`;

              if (!existsSync(gitPath)) {
                if (verbose) {
                  this.log(chalk.gray(`   ⊘ .git path missing (${gitPath}), skipping permissions`));
                }
              } else if (dryRun) {
                this.log(chalk.gray(`   [dry-run] Would run: chgrp -R ${repoGroup} "${gitPath}"`));
                this.log(
                  chalk.gray(
                    `   [dry-run] Would run: chmod -R ${REPO_GIT_PERMISSION_MODE} "${gitPath}"`
                  )
                );
              } else {
                try {
                  for (const cmd of UnixGroupCommands.setDirectoryGroup(
                    gitPath,
                    repoGroup,
                    REPO_GIT_PERMISSION_MODE
                  )) {
                    execSync(cmd, { stdio: 'pipe' });
                  }
                  this.log(
                    chalk.green(`   ✓ Applied .git permissions (${REPO_GIT_PERMISSION_MODE})`)
                  );
                } catch (error) {
                  syncErrors++;
                  this.log(chalk.red(`   ✗ Failed to set .git permissions: ${error}`));
                }
              }
            } else {
              this.log(chalk.yellow(`   ⚠ No local_path found, skipping .git permissions`));
            }

            reposBackfilled++;
            this.log('');
          }

          // Summary for repo backfill
          this.log(chalk.bold('Repo Backfill Summary:'));
          this.log(`  Repos backfilled: ${reposBackfilled}${dryRun ? ' (dry-run)' : ''}`);
          if (syncErrors > 0) {
            this.log(chalk.red(`  Errors: ${syncErrors}`));
          }
          this.log('');

          // Refresh allRepos after updates so the repoGroupMap will have correct values
          allRepos = await select(db).from(repos).all();
        }

        // Build a map of repo_id -> unix_group for quick lookup
        // This happens AFTER the sync repos phase so newly created groups are included
        const repoGroupMap = new Map<string, string | null>();
        for (const repo of allRepos) {
          const r = repo as { repo_id: string; unix_group: string | null };
          repoGroupMap.set(r.repo_id, r.unix_group);
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

          // Get current groups (only if user exists)
          if (result.unixUserExists || dryRun) {
            result.groups.actual = result.unixUserExists
              ? this.getUserGroups(user.unix_username)
              : [];

            if (verbose && result.groups.actual.length > 0) {
              this.log(chalk.gray(`   Current groups: ${result.groups.actual.join(', ')}`));
            }

            // Ensure user is in agor_users group
            if (!result.groups.actual.includes(AGOR_USERS_GROUP)) {
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

              let groupReady = groupExistsOnSystem;

              // Create group if it doesn't exist
              if (!groupExistsOnSystem) {
                this.log(chalk.yellow(`   → Creating group ${expectedGroup}...`));
                if (this.createGroup(expectedGroup, dryRun)) {
                  groupsCreated++;
                  groupReady = true;
                  this.log(chalk.green(`   ✓ Created group ${expectedGroup}`));
                } else {
                  result.errors.push(`Failed to create group ${expectedGroup}`);
                  this.log(chalk.red(`   ✗ Failed to create group ${expectedGroup}`));
                }
              }

              // Add user to group if it exists/was created and user is not already in it
              if (groupReady && !isInGroup) {
                this.log(chalk.yellow(`   → Adding to group ${expectedGroup}...`));
                if (this.addUserToGroup(user.unix_username, expectedGroup, dryRun)) {
                  result.groups.added.push(expectedGroup);
                  this.log(chalk.green(`   ✓ Added to ${expectedGroup}`));
                } else {
                  result.errors.push(`Failed to add to group ${expectedGroup}`);
                  this.log(chalk.red(`   ✗ Failed to add to ${expectedGroup}`));
                }
              }

              // Add daemon user to worktree group
              if (groupReady && daemonUser) {
                const daemonInWtGroup = dryRun
                  ? false
                  : this.isUserInGroup(daemonUser, expectedGroup);
                if (!daemonInWtGroup) {
                  this.log(
                    chalk.yellow(`   → Adding daemon user ${daemonUser} to ${expectedGroup}...`)
                  );
                  if (this.addUserToGroup(daemonUser, expectedGroup, dryRun)) {
                    daemonMembershipsAdded++;
                    this.log(chalk.green(`   ✓ Added daemon user to ${expectedGroup}`));
                  } else {
                    this.log(chalk.red(`   ✗ Failed to add daemon user to ${expectedGroup}`));
                  }
                } else if (verbose) {
                  this.log(chalk.gray(`   ✓ Daemon user already in ${expectedGroup}`));
                }
              }
            }

            // Sync repo groups - user should be in repo group for each unique repo they own worktrees in
            const repoIdsSeen = new Set<string>();
            for (const wt of ownedWorktrees) {
              if (repoIdsSeen.has(wt.repo_id)) continue;
              repoIdsSeen.add(wt.repo_id);

              // Get repo group (from prefetched map or generate)
              const repoGroup =
                repoGroupMap.get(wt.repo_id) || generateRepoGroupName(wt.repo_id as RepoID);
              result.groups.expected.push(repoGroup);

              const isInRepoGroup = result.groups.actual.includes(repoGroup);
              const repoGroupExistsOnSystem = this.groupExists(repoGroup);

              if (verbose) {
                this.log(
                  chalk.gray(
                    `   Repo ${wt.repo_id.substring(0, 8)} → group ${repoGroup} ` +
                      `(exists: ${repoGroupExistsOnSystem ? 'yes' : 'no'}, member: ${isInRepoGroup ? 'yes' : 'no'})`
                  )
                );
              }

              let repoGroupReady = repoGroupExistsOnSystem;

              // Create repo group if it doesn't exist
              if (!repoGroupExistsOnSystem) {
                this.log(chalk.yellow(`   → Creating repo group ${repoGroup}...`));
                if (this.createGroup(repoGroup, dryRun)) {
                  groupsCreated++;
                  repoGroupReady = true;
                  this.log(chalk.green(`   ✓ Created repo group ${repoGroup}`));
                } else {
                  result.errors.push(`Failed to create repo group ${repoGroup}`);
                  this.log(chalk.red(`   ✗ Failed to create repo group ${repoGroup}`));
                }
              }

              // Add user to repo group if it exists/was created and user is not already in it
              if (repoGroupReady && !isInRepoGroup) {
                this.log(chalk.yellow(`   → Adding to repo group ${repoGroup}...`));
                if (this.addUserToGroup(user.unix_username, repoGroup, dryRun)) {
                  result.groups.added.push(repoGroup);
                  this.log(chalk.green(`   ✓ Added to ${repoGroup}`));
                } else {
                  result.errors.push(`Failed to add to repo group ${repoGroup}`);
                  this.log(chalk.red(`   ✗ Failed to add to repo group ${repoGroup}`));
                }
              }

              // Add daemon user to repo group
              if (repoGroupReady && daemonUser) {
                const daemonInRpGroup = dryRun ? false : this.isUserInGroup(daemonUser, repoGroup);
                if (!daemonInRpGroup) {
                  this.log(
                    chalk.yellow(`   → Adding daemon user ${daemonUser} to ${repoGroup}...`)
                  );
                  if (this.addUserToGroup(daemonUser, repoGroup, dryRun)) {
                    daemonMembershipsAdded++;
                    this.log(chalk.green(`   ✓ Added daemon user to ${repoGroup}`));
                  } else {
                    this.log(chalk.red(`   ✗ Failed to add daemon user to ${repoGroup}`));
                  }
                } else if (verbose) {
                  this.log(chalk.gray(`   ✓ Daemon user already in ${repoGroup}`));
                }
              }
            }
          }

          results.push(result);
          this.log('');
        }
      } // end if (validUsers.length > 0)

      // ========================================
      // Worktree Group Backfill Phase
      // Ensures all worktrees have unix_group set in the database
      // ========================================

      this.log(chalk.cyan.bold('\n━━━ Sync Worktree Groups ━━━\n'));

      let allWorktreesForBackfill = await select(db).from(worktrees).all();
      const worktreesWithoutGroup = allWorktreesForBackfill.filter(
        (wt: { unix_group: string | null; archived: boolean; filesystem_status: string | null }) =>
          wt.unix_group === null && !(wt.archived && wt.filesystem_status === 'deleted')
      );

      if (worktreesWithoutGroup.length === 0) {
        this.log(chalk.green('   ✓ All worktrees have unix_group set\n'));
      } else {
        this.log(
          chalk.cyan(
            `Found ${worktreesWithoutGroup.length} worktree(s) without unix_group (of ${allWorktreesForBackfill.length} total)\n`
          )
        );

        for (const wt of worktreesWithoutGroup) {
          const rawWt = wt as {
            worktree_id: string;
            name: string;
            repo_id: string;
            data: { path?: string } | null;
          };

          const wtGroup = generateWorktreeGroupName(rawWt.worktree_id as WorktreeID);

          this.log(chalk.bold(`📁 ${rawWt.name}`));
          this.log(chalk.gray(`   worktree_id: ${rawWt.worktree_id.substring(0, 8)}`));
          this.log(chalk.gray(`   generated group: ${wtGroup}`));

          // Create the Unix group if it doesn't exist
          const groupExistsOnSystem = this.groupExists(wtGroup);

          if (groupExistsOnSystem) {
            this.log(chalk.green(`   ✓ Unix group already exists`));
          } else {
            this.log(chalk.yellow(`   → Creating Unix group ${wtGroup}...`));
            if (this.createGroup(wtGroup, dryRun)) {
              groupsCreated++;
              this.log(chalk.green(`   ✓ Created Unix group ${wtGroup}`));
            } else {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed to create Unix group ${wtGroup}`));
              this.log('');
              continue;
            }
          }

          // Add daemon user to worktree group
          if (daemonUser) {
            const daemonInGroup = dryRun ? false : this.isUserInGroup(daemonUser, wtGroup);
            if (!daemonInGroup) {
              this.log(chalk.yellow(`   → Adding daemon user ${daemonUser} to ${wtGroup}...`));
              if (this.addUserToGroup(daemonUser, wtGroup, dryRun)) {
                daemonMembershipsAdded++;
                this.log(chalk.green(`   ✓ Added daemon user to ${wtGroup}`));
              } else {
                this.log(chalk.red(`   ✗ Failed to add daemon user to ${wtGroup}`));
              }
            } else if (verbose) {
              this.log(chalk.gray(`   ✓ Daemon user already in ${wtGroup}`));
            }
          }

          // Update the database to set unix_group
          if (dryRun) {
            this.log(
              chalk.gray(
                `   [dry-run] Would update database: SET unix_group = '${wtGroup}' WHERE worktree_id = '${rawWt.worktree_id}'`
              )
            );
          } else {
            try {
              await update(db, worktrees)
                .set({ unix_group: wtGroup })
                .where(eq(worktrees.worktree_id, rawWt.worktree_id))
                .run();
              this.log(chalk.green(`   ✓ Updated database with unix_group`));
            } catch (error) {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed to update database: ${error}`));
              this.log('');
              continue;
            }
          }

          worktreesBackfilled++;
          this.log('');
        }

        this.log(chalk.bold('Worktree Group Backfill Summary:'));
        this.log(`  Worktrees backfilled: ${worktreesBackfilled}${dryRun ? ' (dry-run)' : ''}`);
        this.log('');

        // Refresh for the permission sync phase
        allWorktreesForBackfill = await select(db).from(worktrees).all();
      }

      // ========================================
      // Worktree Permission Sync Phase
      // Archive-aware: handles missing directories, skips archived+deleted
      // ========================================

      this.log(chalk.cyan.bold('\n━━━ Sync Worktree Permissions ━━━\n'));

      // Get all worktrees with unix_group set (including newly backfilled)
      const allWorktreesForSync = allWorktreesForBackfill;
      const worktreesWithGroup = allWorktreesForSync.filter(
        (wt: { unix_group: string | null }) => wt.unix_group !== null
      );

      if (worktreesWithGroup.length === 0) {
        this.log(chalk.yellow('No worktrees with unix_group found\n'));
      } else {
        this.log(chalk.cyan(`Found ${worktreesWithGroup.length} worktree(s) with unix_group\n`));

        for (const wt of worktreesWithGroup) {
          const rawWorktree = wt as {
            worktree_id: string;
            name: string;
            unix_group: string;
            archived: boolean;
            filesystem_status: string | null;
            others_fs_access: 'none' | 'read' | 'write' | null;
            data: { path?: string } | null;
          };

          const worktreePath = rawWorktree.data?.path;

          // Skip worktrees without a path in the data blob
          if (!worktreePath) {
            if (verbose) {
              this.log(chalk.gray(`   ⚠ ${rawWorktree.name}: no path in data, skipping`));
            }
            worktreesSkipped++;
            continue;
          }

          const dirExists = existsSync(worktreePath);
          const action = this.getWorktreeDirectoryAction(
            dirExists,
            rawWorktree.archived,
            rawWorktree.filesystem_status
          );

          if (action === 'skip') {
            if (verbose) {
              const reason =
                rawWorktree.filesystem_status === 'deleted'
                  ? 'archived+deleted'
                  : rawWorktree.filesystem_status === 'creating'
                    ? 'still creating'
                    : rawWorktree.filesystem_status === 'failed'
                      ? 'creation failed'
                      : rawWorktree.archived && !dirExists
                        ? `archived (${rawWorktree.filesystem_status || 'unknown'}), dir missing`
                        : 'unknown';
              this.log(chalk.gray(`   ⊘ ${rawWorktree.name}: ${reason}, skipping`));
            }
            worktreesSkipped++;
            continue;
          }

          this.log(chalk.bold(`📁 ${rawWorktree.name}`));
          this.log(chalk.gray(`   worktree_id: ${rawWorktree.worktree_id.substring(0, 8)}`));
          this.log(chalk.gray(`   unix_group: ${rawWorktree.unix_group}`));
          this.log(chalk.gray(`   path: ${worktreePath}`));
          if (rawWorktree.archived) {
            this.log(
              chalk.gray(`   archived: yes (fs: ${rawWorktree.filesystem_status || 'preserved'})`)
            );
          }

          // Create missing directory for non-archived worktrees
          if (action === 'create') {
            this.log(chalk.yellow(`   → Directory missing, creating...`));
            if (dryRun) {
              this.log(chalk.gray(`   [dry-run] Would run: mkdir -p "${worktreePath}"`));
            } else {
              try {
                execSync(`sudo -n mkdir -p "${worktreePath}"`, { stdio: 'pipe' });
                worktreeDirsCreated++;
                this.log(chalk.green(`   ✓ Created directory`));
              } catch (error) {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to create directory: ${error}`));
                this.log('');
                continue;
              }
            }
          }

          // Calculate permission mode based on others_fs_access
          const othersAccess = rawWorktree.others_fs_access || 'read';
          const permissionMode = getWorktreePermissionMode(othersAccess);

          this.log(chalk.gray(`   others_fs_access: ${othersAccess} → mode: ${permissionMode}`));

          if (dryRun) {
            this.log(
              chalk.gray(
                `   [dry-run] Would set group ${rawWorktree.unix_group} with mode ${permissionMode}`
              )
            );
          } else {
            try {
              for (const cmd of UnixGroupCommands.setDirectoryGroup(
                worktreePath,
                rawWorktree.unix_group,
                permissionMode
              )) {
                execSync(cmd, { stdio: 'pipe' });
              }

              worktreesSynced++;
              this.log(chalk.green(`   ✓ Applied permissions (${permissionMode})`));
            } catch (error) {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed to set permissions: ${error}`));
            }
          }

          // Apply daemon user ACL so the running daemon can access without restart
          if (daemonUser && (dirExists || action === 'create')) {
            if (dryRun) {
              this.log(chalk.gray(`   [dry-run] Would set daemon user ACL for ${daemonUser}`));
            } else {
              try {
                for (const cmd of UnixGroupCommands.setUserAcl(worktreePath, daemonUser)) {
                  execSync(cmd, { stdio: 'pipe' });
                }
                daemonAclsApplied++;
                if (verbose) {
                  this.log(chalk.green(`   ✓ Applied daemon ACL for ${daemonUser}`));
                }
              } catch (error) {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to set daemon ACL: ${error}`));
              }
            }
          }

          this.log('');
        }

        // Summary for worktree sync
        this.log(chalk.bold('Worktree Sync Summary:'));
        this.log(`  Worktrees synced: ${worktreesSynced}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Directories created: ${worktreeDirsCreated}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Daemon ACLs applied: ${daemonAclsApplied}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Skipped: ${worktreesSkipped}`);
        if (syncErrors > 0) {
          this.log(chalk.red(`  Errors: ${syncErrors}`));
        }
        this.log('');
      }

      // ========================================
      // Repo .git Permission Sync Phase
      // (For repos that already have unix_group but need permissions applied)
      // ========================================

      // The backfill phase above handled repos without unix_group.
      // Now we need to ensure permissions are set on repos that already have unix_group.
      this.log(chalk.cyan.bold('\n━━━ Sync Repo Permissions ━━━\n'));

      // Get all repos with unix_group set (these already have groups, just need permission check)
      const allReposForSync = await select(db).from(repos).all();
      const reposWithGroup = allReposForSync.filter(
        (r: { unix_group: string | null }) => r.unix_group !== null
      );

      if (reposWithGroup.length === 0) {
        this.log(chalk.yellow('No repos with unix_group found\n'));
      } else {
        this.log(chalk.cyan(`Found ${reposWithGroup.length} repo(s) with unix_group\n`));

        for (const repo of reposWithGroup) {
          // Extract local_path from the data JSON blob
          const rawRepo = repo as {
            repo_id: string;
            slug: string;
            unix_group: string;
            data: { local_path?: string } | null;
          };

          const repoPath = rawRepo.data?.local_path;

          // Skip repos without a path
          if (!repoPath) {
            this.log(chalk.yellow(`📁 ${rawRepo.slug}`));
            this.log(chalk.gray(`   repo_id: ${rawRepo.repo_id.substring(0, 8)}`));
            this.log(chalk.gray(`   unix_group: ${rawRepo.unix_group}`));
            this.log(chalk.red(`   ⚠ No local_path found in repo data, skipping\n`));
            continue;
          }

          const gitPath = `${repoPath}/.git`;

          // Skip if .git directory doesn't exist on disk
          if (!existsSync(gitPath)) {
            if (verbose) {
              this.log(
                chalk.gray(`   ⊘ ${rawRepo.slug}: .git path missing (${gitPath}), skipping`)
              );
            }
            continue;
          }

          this.log(chalk.bold(`📁 ${rawRepo.slug}`));
          this.log(chalk.gray(`   repo_id: ${rawRepo.repo_id.substring(0, 8)}`));
          this.log(chalk.gray(`   unix_group: ${rawRepo.unix_group}`));
          this.log(chalk.gray(`   .git path: ${gitPath}`));
          this.log(chalk.gray(`   mode: ${REPO_GIT_PERMISSION_MODE} (setgid, owner+group rwx)`));

          // Ensure daemon user is in this repo group
          if (daemonUser) {
            const daemonInThisRepoGroup = dryRun
              ? false
              : this.isUserInGroup(daemonUser, rawRepo.unix_group);
            if (!daemonInThisRepoGroup) {
              this.log(
                chalk.yellow(`   → Adding daemon user ${daemonUser} to ${rawRepo.unix_group}...`)
              );
              if (this.addUserToGroup(daemonUser, rawRepo.unix_group, dryRun)) {
                daemonMembershipsAdded++;
                this.log(chalk.green(`   ✓ Added daemon user to ${rawRepo.unix_group}`));
              } else {
                this.log(chalk.red(`   ✗ Failed to add daemon user to ${rawRepo.unix_group}`));
              }
            } else if (verbose) {
              this.log(chalk.gray(`   ✓ Daemon user already in ${rawRepo.unix_group}`));
            }
          }

          if (dryRun) {
            this.log(
              chalk.gray(`   [dry-run] Would run: chgrp -R ${rawRepo.unix_group} "${gitPath}"`)
            );
            this.log(
              chalk.gray(
                `   [dry-run] Would run: chmod -R ${REPO_GIT_PERMISSION_MODE} "${gitPath}"`
              )
            );
            this.log('');
          } else {
            try {
              // Run each command separately (no sh -c wrapper for security)
              for (const cmd of UnixGroupCommands.setDirectoryGroup(
                gitPath,
                rawRepo.unix_group,
                REPO_GIT_PERMISSION_MODE
              )) {
                execSync(cmd, { stdio: 'pipe' });
              }

              reposPermSynced++;
              this.log(
                chalk.green(`   ✓ Applied .git permissions (${REPO_GIT_PERMISSION_MODE})\n`)
              );
            } catch (error) {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed: ${error}\n`));
            }
          }
        }

        // Summary for repo permission sync
        this.log(chalk.bold('Repo Permission Sync Summary:'));
        this.log(`  Repos synced: ${reposPermSynced}${dryRun ? ' (dry-run)' : ''}`);
        if (syncErrors > 0) {
          this.log(chalk.red(`  Errors: ${syncErrors}`));
        }
        this.log('');
      }

      // ========================================
      // Membership Pruning Phase
      // Removes users from worktree groups they no longer own
      // ========================================

      this.log(chalk.cyan.bold('\n━━━ Prune Stale Group Memberships ━━━\n'));

      {
        // Build a map of worktree group → expected members (owners + daemon)
        const allWtForPrune = await select(db).from(worktrees).all();
        const allOwnerRows = await select(db).from(worktreeOwners).all();

        // Map worktree_id → unix_group
        const wtGroupMap = new Map<string, string>();
        for (const wt of allWtForPrune) {
          const raw = wt as { worktree_id: string; unix_group: string | null };
          if (raw.unix_group) {
            wtGroupMap.set(raw.worktree_id, raw.unix_group);
          }
        }

        // Map unix_group → set of expected user_ids
        const groupToOwnerIds = new Map<string, Set<string>>();
        for (const row of allOwnerRows) {
          const raw = row as { worktree_id: string; user_id: string };
          const group = wtGroupMap.get(raw.worktree_id);
          if (group) {
            const owners = groupToOwnerIds.get(group) || new Set();
            owners.add(raw.user_id);
            groupToOwnerIds.set(group, owners);
          }
        }

        // Map user_id → unix_username for all users with unix_username
        const allUsersForPrune = (await select(db).from(users).all()) as UserWithUnix[];
        const userIdToUnixName = new Map<string, string>();
        const unixNameToUserId = new Map<string, string>();
        for (const u of allUsersForPrune) {
          if (u.unix_username) {
            userIdToUnixName.set(u.user_id, u.unix_username);
            unixNameToUserId.set(u.unix_username, u.user_id);
          }
        }

        // Iterate ALL worktree groups (including those with zero owners)
        let pruneChecked = 0;
        for (const [, group] of wtGroupMap.entries()) {
          if (!this.groupExists(group)) continue;
          pruneChecked++;

          // Get expected unix_usernames for this group (may be empty if no owners)
          const ownerIds = groupToOwnerIds.get(group) || new Set<string>();
          const expectedUsernames = new Set<string>();
          for (const ownerId of ownerIds) {
            const uname = userIdToUnixName.get(ownerId);
            if (uname) expectedUsernames.add(uname);
          }
          // Daemon user is always expected
          if (daemonUser) expectedUsernames.add(daemonUser);

          // Get actual members from OS
          const actualMembers = this.getGroupMembers(group);

          for (const member of actualMembers) {
            if (expectedUsernames.has(member)) continue;
            // Skip the daemon user (safety)
            if (daemonUser && member === daemonUser) continue;
            // Only prune DB-managed users (skip manually-added system users)
            if (!unixNameToUserId.has(member)) continue;

            this.log(chalk.yellow(`   → Removing ${member} from ${group} (no longer owner)`));
            if (this.removeUserFromGroup(member, group, dryRun)) {
              membershipsRemoved++;
              this.log(chalk.green(`   ✓ Removed ${member} from ${group}`));
            } else {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed to remove ${member} from ${group}`));
            }
          }
        }

        if (membershipsRemoved === 0) {
          this.log(
            chalk.green(`   ✓ No stale memberships found (checked ${pruneChecked} groups)\n`)
          );
        } else {
          this.log('');
          this.log(chalk.bold('Membership Pruning Summary:'));
          this.log(`  Memberships removed: ${membershipsRemoved}${dryRun ? ' (dry-run)' : ''}`);
          this.log('');
        }
      }

      // ========================================
      // Symlink Sync Phase
      // Creates missing symlinks, removes broken ones
      // ========================================

      if (validUsers.length > 0) {
        this.log(chalk.cyan.bold('\n━━━ Sync User Symlinks ━━━\n'));

        // Build worktree ownership data for symlink creation
        const allWtForSymlinks = await select(db).from(worktrees).all();
        const allOwnershipsForSymlinks = await select(db).from(worktreeOwners).all();

        // Map worktree_id → worktree info
        const wtInfoMap = new Map<
          string,
          {
            name: string;
            path: string | undefined;
            archived: boolean;
            filesystem_status: string | null;
          }
        >();
        for (const wt of allWtForSymlinks) {
          const raw = wt as {
            worktree_id: string;
            name: string;
            archived: boolean;
            filesystem_status: string | null;
            data: { path?: string } | null;
          };
          wtInfoMap.set(raw.worktree_id, {
            name: raw.name,
            path: raw.data?.path,
            archived: raw.archived,
            filesystem_status: raw.filesystem_status,
          });
        }

        // Map user_id → list of worktree_ids they own
        const userToWorktrees = new Map<string, string[]>();
        for (const row of allOwnershipsForSymlinks) {
          const raw = row as { user_id: string; worktree_id: string };
          const existing = userToWorktrees.get(raw.user_id) || [];
          existing.push(raw.worktree_id);
          userToWorktrees.set(raw.user_id, existing);
        }

        for (const user of validUsers) {
          const worktreesDir = getUserWorktreesDir(user.unix_username);

          if (verbose) {
            this.log(chalk.gray(`   ${user.unix_username}: checking symlinks...`));
          }

          // Ensure ~/agor/worktrees/ directory exists
          if (!existsSync(worktreesDir)) {
            if (dryRun) {
              this.log(chalk.gray(`   [dry-run] Would create ${worktreesDir}`));
            } else {
              try {
                for (const cmd of UnixUserCommands.setupWorktreesDir(user.unix_username)) {
                  execSync(cmd, { stdio: 'pipe' });
                }
              } catch {
                // May already exist or user home may not exist yet
                if (verbose) {
                  this.log(chalk.gray(`   ⚠ Could not create ${worktreesDir}`));
                }
                continue;
              }
            }
          }

          // Clean up broken symlinks
          if (!dryRun && existsSync(worktreesDir)) {
            try {
              execSync(SymlinkCommands.removeBrokenSymlinks(worktreesDir), { stdio: 'pipe' });
              symlinksCleaned++; // Count users cleaned, not individual symlinks
            } catch {
              // Non-fatal
            }
          }

          // Create symlinks for owned worktrees where directory exists
          const ownedWtIds = userToWorktrees.get(user.user_id) || [];
          for (const wtId of ownedWtIds) {
            const wtInfo = wtInfoMap.get(wtId);
            if (!wtInfo?.path) continue;

            // Skip archived+deleted worktrees
            if (wtInfo.archived && wtInfo.filesystem_status === 'deleted') continue;

            // Skip if target directory doesn't exist
            if (!existsSync(wtInfo.path)) continue;

            const symlinkPath = getWorktreeSymlinkPath(user.unix_username, wtInfo.name);

            // Check if symlink already exists and points to the correct target
            let needsCreate = true;
            try {
              const currentTarget = readlinkSync(symlinkPath);
              if (currentTarget === wtInfo.path) {
                needsCreate = false;
              }
            } catch {
              // Symlink doesn't exist or isn't a symlink — needs creation
            }

            if (!needsCreate) continue;

            if (dryRun) {
              this.log(
                chalk.gray(`   [dry-run] Would create symlink: ${wtInfo.name} → ${wtInfo.path}`)
              );
              symlinksCreated++;
            } else {
              try {
                // Uses ln -sfn which replaces existing symlinks
                for (const cmd of SymlinkCommands.createSymlinkWithOwnership(
                  wtInfo.path,
                  symlinkPath,
                  user.unix_username
                )) {
                  execSync(`sudo -n ${cmd}`, { stdio: 'pipe' });
                }
                symlinksCreated++;
                if (verbose) {
                  this.log(
                    chalk.green(`   ✓ ${user.unix_username}: ${wtInfo.name} → ${wtInfo.path}`)
                  );
                }
              } catch {
                if (verbose) {
                  this.log(chalk.red(`   ✗ Failed to create symlink for ${wtInfo.name}`));
                }
                syncErrors++;
              }
            }
          }
        }

        if (symlinksCreated > 0 || symlinksCleaned > 0) {
          this.log('');
          this.log(chalk.bold('Symlink Sync Summary:'));
          this.log(`  Symlinks created: ${symlinksCreated}${dryRun ? ' (dry-run)' : ''}`);
          this.log(`  Users cleaned: ${symlinksCleaned}${dryRun ? ' (dry-run)' : ''}`);
          this.log('');
        } else {
          this.log(chalk.green('   ✓ All symlinks up to date\n'));
        }
      }

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

        // Cleanup stale repo groups
        this.log(chalk.cyan('Checking for stale repo groups...\n'));

        // Get all repo groups that should exist (from DB)
        const allReposForCleanup = await select(db).from(repos).all();
        const expectedRepoGroups = new Set(
          allReposForCleanup.map(
            (r: { repo_id: string; unix_group: string | null }) =>
              r.unix_group || generateRepoGroupName(r.repo_id as RepoID)
          )
        );

        // Get all agor_rp_* groups on the system
        const systemRepoGroups = this.listRepoGroups();

        if (verbose) {
          this.log(chalk.gray(`   Found ${systemRepoGroups.length} agor_rp_* group(s) on system`));
          this.log(chalk.gray(`   Expected ${expectedRepoGroups.size} group(s) from database`));
        }

        // Find stale repo groups (on system but not in DB)
        const staleRepoGroups = systemRepoGroups.filter((g) => !expectedRepoGroups.has(g));

        if (staleRepoGroups.length === 0) {
          this.log(chalk.green('   ✓ No stale repo groups found\n'));
        } else {
          this.log(
            chalk.yellow(`   Found ${staleRepoGroups.length} stale repo group(s) to remove:\n`)
          );

          for (const groupName of staleRepoGroups) {
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
      const userSyncErrors = results.reduce((acc, r) => acc + r.errors.length, 0);
      const totalErrors = userSyncErrors + cleanupErrors + syncErrors;

      const dryRunSuffix = dryRun ? ' (dry-run)' : '';

      // Sync stats
      this.log(chalk.bold('Sync:'));
      this.log(`  Users checked:     ${validUsers.length}`);
      this.log(`  Users created:     ${usersCreated}${dryRunSuffix}`);
      this.log(`  Groups created:    ${groupsCreated}${dryRunSuffix}`);
      this.log(`  Memberships added: ${groupsAdded}${dryRunSuffix}`);
      this.log(`  Memberships removed: ${membershipsRemoved}${dryRunSuffix}`);
      if (daemonUser) {
        this.log(`  Daemon memberships: ${daemonMembershipsAdded}${dryRunSuffix}`);
      }

      // Worktree/Repo sync stats
      this.log('');
      this.log(chalk.bold('Filesystem Sync:'));
      this.log(`  WT groups backfilled: ${worktreesBackfilled}${dryRunSuffix}`);
      this.log(`  Worktrees synced:  ${worktreesSynced}${dryRunSuffix}`);
      this.log(`  Dirs created:      ${worktreeDirsCreated}${dryRunSuffix}`);
      this.log(`  Skipped:           ${worktreesSkipped}`);
      this.log(`  Daemon ACLs:       ${daemonAclsApplied}${dryRunSuffix}`);
      this.log(`  Repos backfilled:  ${reposBackfilled}${dryRunSuffix}`);
      this.log(`  Repo perms synced: ${reposPermSynced}${dryRunSuffix}`);

      // Symlink stats
      this.log('');
      this.log(chalk.bold('Symlinks:'));
      this.log(`  Created:           ${symlinksCreated}${dryRunSuffix}`);
      this.log(`  Users cleaned:     ${symlinksCleaned}${dryRunSuffix}`);

      if (syncErrors > 0) {
        this.log('');
        this.log(chalk.red(`  Sync errors:       ${syncErrors}`));
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
        daemonMembershipsAdded > 0 ||
        membershipsRemoved > 0 ||
        usersDeleted > 0 ||
        groupsDeleted > 0 ||
        worktreesSynced > 0 ||
        worktreesBackfilled > 0 ||
        worktreeDirsCreated > 0 ||
        daemonAclsApplied > 0 ||
        reposBackfilled > 0 ||
        reposPermSynced > 0 ||
        symlinksCreated > 0 ||
        symlinksCleaned > 0;
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
