/**
 * Admin Command: Sync Unix Users and Groups
 *
 * Full sync of Unix users and groups with the Agor database. This command
 * ensures all users, groups, and permissions are correctly configured.
 *
 * Default behavior (no flags needed):
 * - Creates missing Unix users for users with unix_username set
 * - Creates missing branch groups (agor_wt_*) and repo groups (agor_rp_*)
 * - Backfills unix_group on branches that don't have one
 * - Sets filesystem permissions on branches and repo directories (incl. .git)
 * - Creates missing branch directories for non-archived branches
 * - Adds users to their branch and repo groups
 * - Prunes stale group memberships (users no longer owning a branch)
 * - Ensures agor_users group exists and contains all managed users
 * - Applies daemon user ACLs on branch directories
 * - Syncs user symlinks (creates missing, removes broken)
 *
 * Cleanup (opt-in, destructive):
 * - --cleanup: Deletes stale users and groups not in database
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromFile } from '@agor/core/config';
import {
  and,
  branches,
  branchOwners,
  createDatabase,
  eq,
  inArray,
  isNull,
  repos,
  resolveDatabaseUrl,
  select,
  shortId,
  update,
  users,
} from '@agor/core/db';
import { restoreBranchFilesystem } from '@agor/core/git/exec';
import {
  AGOR_USERS_GROUP,
  CommandError,
  createAdminExecutor,
  generateBranchGroupName,
  generateRepoGroupName,
  getBranchDirectoryAction,
  getBranchPermissionMode,
  getBranchSymlinkPath,
  getGroupMembers,
  getUserBranchesDir,
  getUserGroups,
  groupExists,
  isLegacyManagedGroupName,
  isUserInGroup,
  listAgorUsers,
  listBranchGroups,
  listRepoGroups,
  REPO_GIT_PERMISSION_MODE,
  resolveBranchGroupName,
  resolveRepoGroupName,
  SymlinkCommands,
  UnixGroupCommands,
  UnixUserCommands,
  unixUserExists,
} from '@agor/core/unix';
import type { BranchID, RepoID } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

interface UserWithUnix {
  user_id: string;
  email: string;
  name: string | null;
  unix_username: string;
}

interface BranchOwnership {
  branch_id: string;
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

/** Whether this DB view can prove facts about the host-global Unix namespace. */
export function canVerifyGlobalUnixState(databaseUrl: string): boolean {
  return databaseUrl.startsWith('file:');
}

export default class SyncUnix extends Command {
  static override description =
    'Sync Unix users and groups with database (admin only). Creates missing users and fixes group memberships. NOTE: This command does NOT sync passwords - password hashes are one-way and cannot be converted to Unix passwords. Passwords are only synced in real-time during user creation or password updates via the web API.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>                # Full sync (creates users, groups, sets permissions)',
    '<%= config.bin %> <%= command.id %> --dry-run      # Preview what would be done',
    '<%= config.bin %> <%= command.id %> --cleanup      # Full sync + remove stale users/groups',
    '<%= config.bin %> <%= command.id %> --verbose      # Show detailed output',
    '<%= config.bin %> <%= command.id %> --branch-id <uuid> --dry-run  # Preview sync for a single branch',
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
    'branch-id': Flags.string({
      char: 'w',
      description:
        'Sync a single branch and its parent repo (skips unrelated user/membership/symlink phases)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SyncUnix);
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;

    // Cleanup flags - --cleanup enables both
    const cleanupGroups = flags.cleanup || flags['cleanup-groups'];
    const cleanupUsers = flags.cleanup || flags['cleanup-users'];
    const targetBranchId = flags['branch-id'];

    if (targetBranchId) {
      this.log(chalk.cyan(`🎯 Targeting single branch: ${targetBranchId}\n`));
    }

    if (dryRun) {
      this.log(chalk.yellow('🔍 Dry run mode - no changes will be made\n'));
    }

    // Create executor for all privileged operations (handles dry-run + verbose)
    const executor = createAdminExecutor({ 'dry-run': dryRun, verbose });

    // Helper: print the underlying command failure so callers' generic
    // "✗ Failed to ..." messages are preceded by actionable details (the
    // failing command and its stderr). Without this, errors are silently
    // swallowed and the user has no signal about what went wrong.
    const logCmdError = (err: unknown, fallbackCmd?: string) => {
      if (err instanceof CommandError) {
        const cmd = err.command || fallbackCmd;
        const stderr = err.result.stderr.trim();
        if (cmd) this.log(chalk.red(`      ↳ ${cmd}`));
        if (stderr) {
          for (const line of stderr.split('\n').slice(0, 10)) {
            this.log(chalk.red(`        ${line}`));
          }
        }
        this.log(chalk.red(`        (exit ${err.result.exitCode})`));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (fallbackCmd) this.log(chalk.red(`      ↳ ${fallbackCmd}`));
        this.log(chalk.red(`        ${msg}`));
      }
    };

    // Helper: execute a single command, return true on success
    const execCmd = async (cmd: string): Promise<boolean> => {
      try {
        await executor.exec(cmd);
        return true;
      } catch (err) {
        logCmdError(err, cmd);
        return false;
      }
    };

    // Helper: execute multiple commands sequentially, return true on success.
    // On failure, CommandError carries the specific command that failed along
    // with its stderr — logCmdError surfaces both.
    const execAllCmds = async (cmds: string[]): Promise<boolean> => {
      try {
        await executor.execAll(cmds);
        return true;
      } catch (err) {
        logCmdError(err);
        return false;
      }
    };

    // Track stats
    let groupsCreated = 0;
    let groupsDeleted = 0;
    let usersDeleted = 0;
    let cleanupErrors = 0;
    let branchesSynced = 0;
    let branchesBackfilled = 0; // Branches that needed unix_group set in DB
    let branchDirsCreated = 0; // Branch directories created on disk
    let branchesRestored = 0; // Branches restored from failed status
    let groupsCleaned = 0; // Archived+deleted branch groups removed
    let statusFixed = 0; // Branches with filesystem_status corrected to 'ready'
    let branchesSkipped = 0; // Branches skipped (archived/deleted, missing path, etc.)
    let reposBackfilled = 0; // Repos that needed unix_group set in DB
    let reposPermSynced = 0; // Repos that had root/.git permissions synced
    let membershipsRemoved = 0; // Stale group memberships pruned
    let daemonAclsApplied = 0; // Daemon user ACLs applied
    let symlinksCreated = 0; // User symlinks created
    let symlinksCleaned = 0; // Broken symlinks removed
    let syncErrors = 0;

    try {
      // Resolve both config and database relative to the invoking user. When
      // running via sudo, os.homedir() points at /root rather than the Agor
      // installation being administered.
      const sudoUser = process.env.SUDO_USER;
      let operatorHome = homedir();
      if (sudoUser) {
        try {
          const passwdEntry = execFileSync('getent', ['passwd', sudoUser], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore'],
          }).trim();
          operatorHome = passwdEntry.split(':')[5] || join('/home', sudoUser);
        } catch {
          operatorHome = join('/home', sudoUser);
        }
      }

      const agorHome = join(operatorHome, '.agor');
      const configPath = join(agorHome, 'config.yaml');
      if (!existsSync(configPath)) {
        this.error(`Config not found: ${configPath}`);
      }
      const config = await loadConfigFromFile(configPath);
      const resolvedDatabaseUrl = resolveDatabaseUrl({
        config,
        env: process.env,
        homeDir: operatorHome,
      });
      const databaseUrl =
        resolvedDatabaseUrl.startsWith('file:') || /^[a-z][a-z0-9+.-]*:/i.test(resolvedDatabaseUrl)
          ? resolvedDatabaseUrl
          : `file:${resolvedDatabaseUrl}`;
      const hasGlobalUnixStateView = canVerifyGlobalUnixState(databaseUrl);

      if ((cleanupGroups || cleanupUsers) && !hasGlobalUnixStateView) {
        this.error(
          'sync-unix cleanup supports only the host-local SQLite database. ' +
            'Unix users and groups are system-global, so a PostgreSQL/RLS or remote database view cannot prove that another tenant or host is not still using them.'
        );
      }

      if (hasGlobalUnixStateView) {
        const dbPath = databaseUrl.slice('file:'.length);
        if (!existsSync(dbPath)) {
          this.error(`Database not found: ${dbPath}`);
        }
      }

      const db = createDatabase({ url: databaseUrl });

      // Get daemon user from the same operator config used for DB resolution.
      // The daemon user must be added to all Unix groups so it can access files
      // Since this command runs under sudo, we MUST require explicit config
      // (process.env.USER would return 'root' which is wrong)
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
            `   (from config.daemon.unix_user, will be added to all repo and branch groups)\n`
          )
        );
      }

      // Track daemon memberships added
      let daemonMembershipsAdded = 0;

      // Resolve the parent repo when scoping to a single branch.
      // --branch-id is expected to sync *everything* the branch depends on,
      // including the parent repo's group/permissions — otherwise a migrated
      // box with a broken repo root leaves the targeted branch unusable.
      let targetRepoId: RepoID | undefined;
      if (targetBranchId) {
        const targetWts = await select(db)
          .from(branches)
          .where(eq(branches.branch_id, targetBranchId))
          .all();
        if (targetWts.length === 0) {
          this.log(chalk.red(`✗ Branch ${targetBranchId} not found in database\n`));
          process.exit(1);
        }
        targetRepoId = (targetWts[0] as { repo_id: string }).repo_id as RepoID;
        this.log(
          chalk.cyan(`   Parent repo: ${shortId(targetRepoId)} (also scoped to this repo)\n`)
        );
      }

      // Ensure agor_users group exists (global group for all managed users)
      this.log(chalk.cyan(`Checking ${AGOR_USERS_GROUP} group...\n`));
      if (!groupExists(AGOR_USERS_GROUP)) {
        this.log(chalk.yellow(`   → Creating ${AGOR_USERS_GROUP} group...`));
        if (await execCmd(UnixGroupCommands.createGroup(AGOR_USERS_GROUP))) {
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

      // ========================================
      // Sync Repos Phase (deterministic)
      //
      // For every repo in scope, brings the system into the canonical state:
      //   1. Unix group exists on the system (creates if missing — covers
      //      both fresh repos and migrations where the DB has a group name
      //      but /etc/group was not carried over).
      //   2. Daemon user is a member of the group.
      //   3. unix_group is backfilled in the DB if NULL.
      //   4. Group ownership + ACLs + setgid applied to repo root
      //      (non-recursive, for traversal) and recursively to `.git`
      //      (shared git objects/refs + branch metadata).
      //
      // Idempotent: steps 1–3 only run when state drift is detected; step 4
      // always runs because ACL/perm drift is cheap to fix and hard to detect.
      //
      // Runs BEFORE user/branch phases because they depend on repo groups
      // being in place. In --branch-id mode, scoped to the parent repo only.
      // ========================================
      {
        const reposInScope = targetRepoId
          ? await select(db).from(repos).where(eq(repos.repo_id, targetRepoId)).all()
          : await select(db).from(repos).all();

        this.log(chalk.cyan.bold('\n━━━ Sync Repos ━━━\n'));

        if (reposInScope.length === 0) {
          this.log(chalk.yellow('   No repos in scope\n'));
        } else {
          this.log(chalk.cyan(`Processing ${reposInScope.length} repo(s)\n`));
        }

        for (const repo of reposInScope) {
          const rawRepo = repo as {
            repo_id: string;
            slug: string;
            unix_group: string | null;
            data: { local_path?: string } | null;
          };

          const dbNeedsBackfill = rawRepo.unix_group === null;
          let expectedGroup =
            rawRepo.unix_group == null
              ? generateRepoGroupName(rawRepo.repo_id as RepoID)
              : resolveRepoGroupName(rawRepo.repo_id as RepoID, rawRepo.unix_group);
          const repoPath = rawRepo.data?.local_path;
          const pathUsable = repoPath ? existsSync(repoPath) : false;
          let hadError = false;

          // Persist before any system-global group or filesystem operation.
          if (dbNeedsBackfill) {
            if (dryRun) {
              this.log(
                chalk.gray(
                  `   [dry-run] Would update database: SET unix_group = '${expectedGroup}' WHERE repo_id = '${rawRepo.repo_id}'`
                )
              );
              reposBackfilled++;
            } else {
              try {
                await update(db, repos)
                  .set({ unix_group: expectedGroup })
                  .where(and(eq(repos.repo_id, rawRepo.repo_id), isNull(repos.unix_group)))
                  .run();
                const stampedRepo = await select(db, { unix_group: repos.unix_group })
                  .from(repos)
                  .where(eq(repos.repo_id, rawRepo.repo_id))
                  .one();
                if (!stampedRepo?.unix_group) {
                  throw new Error('unix_group remained absent after stamping');
                }
                expectedGroup = resolveRepoGroupName(
                  rawRepo.repo_id as RepoID,
                  stampedRepo.unix_group
                );
                reposBackfilled++;
                this.log(chalk.green(`   ✓ Backfilled unix_group in database`));
              } catch (error) {
                syncErrors++;
                hadError = true;
                this.log(chalk.red(`   ✗ Failed to update database: ${error}`));
              }
            }
          }

          this.log(chalk.bold(`📁 ${rawRepo.slug}`));
          this.log(chalk.gray(`   repo_id: ${shortId(rawRepo.repo_id)}`));
          this.log(
            chalk.gray(`   unix_group: ${expectedGroup}${dbNeedsBackfill ? ' (to backfill)' : ''}`)
          );
          if (repoPath) {
            this.log(chalk.gray(`   repo path: ${repoPath}${pathUsable ? '' : ' (missing)'}`));
          } else {
            this.log(chalk.gray(`   repo path: <none in data.local_path>`));
          }

          if (hadError) {
            this.log('');
            continue;
          }

          const groupMissingOnSystem = !groupExists(expectedGroup);

          // 1. Ensure Unix group exists on the system
          if (groupMissingOnSystem) {
            this.log(chalk.yellow(`   → Creating Unix group ${expectedGroup}...`));
            if (await execCmd(UnixGroupCommands.createGroup(expectedGroup))) {
              groupsCreated++;
              this.log(chalk.green(`   ✓ Created Unix group ${expectedGroup}`));
            } else {
              syncErrors++;
              hadError = true;
              this.log(chalk.red(`   ✗ Failed to create Unix group ${expectedGroup}`));
            }
          } else if (verbose) {
            this.log(chalk.gray(`   ✓ Unix group exists`));
          }

          // 2. Ensure daemon user is in the group
          if (!hadError && daemonUser) {
            const daemonInGroup = dryRun ? false : isUserInGroup(daemonUser, expectedGroup);
            if (!daemonInGroup) {
              this.log(
                chalk.yellow(`   → Adding daemon user ${daemonUser} to ${expectedGroup}...`)
              );
              if (await execCmd(UnixGroupCommands.addUserToGroup(daemonUser, expectedGroup))) {
                daemonMembershipsAdded++;
                this.log(chalk.green(`   ✓ Added daemon user to ${expectedGroup}`));
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to add daemon user to ${expectedGroup}`));
              }
            } else if (verbose) {
              this.log(chalk.gray(`   ✓ Daemon user already in ${expectedGroup}`));
            }
          }

          // 3. Apply permissions (idempotent; always run unless error)
          if (!hadError) {
            if (!repoPath) {
              this.log(chalk.yellow(`   ⚠ No local_path in repo data, skipping permissions`));
            } else if (!pathUsable) {
              if (verbose) {
                this.log(chalk.gray(`   ⊘ Repo path missing on disk, skipping permissions`));
              }
            } else {
              const gitPath = `${repoPath}/.git`;
              const rootCmds = UnixGroupCommands.setDirectoryGroupShallow(
                repoPath,
                expectedGroup,
                REPO_GIT_PERMISSION_MODE
              );
              const cmds = existsSync(gitPath)
                ? [
                    ...rootCmds,
                    ...UnixGroupCommands.setDirectoryGroup(
                      gitPath,
                      expectedGroup,
                      REPO_GIT_PERMISSION_MODE
                    ),
                  ]
                : rootCmds;
              if (await execAllCmds(cmds)) {
                reposPermSynced++;
                this.log(
                  chalk.green(`   ✓ Applied repo permissions (${REPO_GIT_PERMISSION_MODE})`)
                );
                if (!existsSync(gitPath) && verbose) {
                  this.log(chalk.gray(`   ⊘ .git path missing on disk, root traversal only`));
                }
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to set repo permissions`));
              }
            }
          }

          this.log('');
        }

        if (reposInScope.length > 0) {
          this.log(chalk.bold('Sync Repos Summary:'));
          this.log(`  DB backfilled:     ${reposBackfilled}${dryRun ? ' (dry-run)' : ''}`);
          this.log(`  Permissions synced:${reposPermSynced}${dryRun ? ' (dry-run)' : ''}`);
          this.log('');
        }
      }

      // Stamp every active branch before any membership or filesystem phase
      // can use its group. This is intentionally DB-first: if a later host
      // operation fails, rerunning converges on the same persisted name.
      const branchesForStamp = targetBranchId
        ? await select(db).from(branches).where(eq(branches.branch_id, targetBranchId)).all()
        : await select(db).from(branches).all();
      const unstampedBranches = branchesForStamp.filter(
        (row: { archived: boolean; filesystem_status: string | null; unix_group: string | null }) =>
          row.unix_group == null && !(row.archived && row.filesystem_status === 'deleted')
      ) as Array<{ branch_id: string; name: string; unix_group: null }>;

      if (unstampedBranches.length > 0) {
        this.log(chalk.cyan.bold('\n━━━ Stamp Branch Unix Groups ━━━\n'));
      }
      for (const branch of unstampedBranches) {
        const candidate = generateBranchGroupName(branch.branch_id as BranchID);
        if (dryRun) {
          branchesBackfilled++;
          this.log(
            chalk.gray(`   [dry-run] ${branch.name}: would persist unix_group ${candidate}`)
          );
          continue;
        }

        try {
          await update(db, branches)
            .set({ unix_group: candidate })
            .where(and(eq(branches.branch_id, branch.branch_id), isNull(branches.unix_group)))
            .run();
          const stampedBranch = await select(db, { unix_group: branches.unix_group })
            .from(branches)
            .where(eq(branches.branch_id, branch.branch_id))
            .one();
          if (!stampedBranch?.unix_group) {
            throw new Error('unix_group remained absent after stamping');
          }
          resolveBranchGroupName(branch.branch_id as BranchID, stampedBranch.unix_group);
          branchesBackfilled++;
          this.log(chalk.green(`   ✓ ${branch.name}: persisted ${stampedBranch.unix_group}`));
        } catch (error) {
          syncErrors++;
          this.log(chalk.red(`   ✗ ${branch.name}: failed to persist unix_group: ${error}`));
        }
      }
      if (unstampedBranches.length > 0) this.log('');

      if (targetBranchId) {
        this.log(chalk.gray('   ⊘ Skipping user sync phase (--branch-id mode)\n'));
      } else if (validUsers.length === 0) {
        this.log(chalk.yellow('No users with unix_username found in database'));
        this.log(chalk.gray('\nTo set a unix_username for a user:'));
        this.log(chalk.gray('  agor user update <email> --unix-username <username>\n'));
        // Don't return early - still need to run cleanup if requested
      } else {
        this.log(chalk.cyan(`Found ${validUsers.length} user(s) with unix_username\n`));

        // Prefetch all branch ownerships in a single query to avoid N+1
        const userIds = validUsers.map((u) => u.user_id);
        // biome-ignore lint/suspicious/noExplicitAny: Join query requires type assertion
        const allOwnerships = await (db as any)
          .select()
          .from(branchOwners)
          .innerJoin(branches, eq(branchOwners.branch_id, branches.branch_id))
          .where(inArray(branchOwners.user_id, userIds));

        // Group ownerships by user_id for O(1) lookup
        const ownershipsByUser = new Map<string, BranchOwnership[]>();
        for (const row of allOwnerships) {
          const userId = (
            row as {
              branch_owners: { user_id: string };
              branches: {
                branch_id: string;
                name: string;
                unix_group: string | null;
                repo_id: string;
              };
            }
          ).branch_owners.user_id;
          const ownership: BranchOwnership = {
            branch_id: (row as { branches: { branch_id: string } }).branches.branch_id,
            name: (row as { branches: { name: string } }).branches.name,
            unix_group: (row as { branches: { unix_group: string | null } }).branches.unix_group,
            repo_id: (row as { branches: { repo_id: string } }).branches.repo_id,
          };
          const existing = ownershipsByUser.get(userId) || [];
          existing.push(ownership);
          ownershipsByUser.set(userId, existing);
        }

        // Build a map of repo_id -> unix_group for quick lookup in the
        // per-user loop. The Sync Repos phase above already ensured every
        // repo has a unix_group assigned (when it needed one).
        const allRepos = await select(db).from(repos).all();
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
          this.log(chalk.gray(`   user_id: ${shortId(user.user_id)}`));

          // Check if Unix user exists
          result.unixUserExists = unixUserExists(user.unix_username);

          if (result.unixUserExists) {
            this.log(chalk.green(`   ✓ Unix user exists`));
          } else {
            this.log(chalk.red(`   ✗ Unix user does not exist`));

            this.log(chalk.yellow(`   → Creating Unix user...`));
            if (await execCmd(UnixUserCommands.createUser(user.unix_username))) {
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
            result.groups.actual = result.unixUserExists ? getUserGroups(user.unix_username) : [];

            if (verbose && result.groups.actual.length > 0) {
              this.log(chalk.gray(`   Current groups: ${result.groups.actual.join(', ')}`));
            }

            // Ensure user is in agor_users group
            if (!result.groups.actual.includes(AGOR_USERS_GROUP)) {
              this.log(chalk.yellow(`   → Adding to ${AGOR_USERS_GROUP}...`));
              if (
                await execCmd(
                  UnixGroupCommands.addUserToGroup(user.unix_username, AGOR_USERS_GROUP)
                )
              ) {
                result.groups.added.push(AGOR_USERS_GROUP);
                this.log(chalk.green(`   ✓ Added to ${AGOR_USERS_GROUP}`));
              } else {
                result.errors.push(`Failed to add to ${AGOR_USERS_GROUP}`);
                this.log(chalk.red(`   ✗ Failed to add to ${AGOR_USERS_GROUP}`));
              }
            }

            // Get branches owned by this user (from prefetched data)
            const ownedBranches: BranchOwnership[] = ownershipsByUser.get(user.user_id) || [];

            if (verbose) {
              this.log(chalk.gray(`   Owns ${ownedBranches.length} branch(s)`));
            }

            // Build expected groups from owned branches
            for (const wt of ownedBranches) {
              if (wt.unix_group == null && !dryRun) {
                const message = `Branch ${wt.name} has no persisted unix_group; skipping host group access`;
                result.errors.push(message);
                this.log(chalk.red(`   ✗ ${message}`));
                continue;
              }
              // A dry-run may plan an absent stamp, but every mutating run
              // reaches this phase only after the DB-first stamping pass.
              const expectedGroup =
                wt.unix_group == null
                  ? generateBranchGroupName(wt.branch_id as BranchID)
                  : resolveBranchGroupName(wt.branch_id as BranchID, wt.unix_group);
              result.groups.expected.push(expectedGroup);

              const isInGroup = result.groups.actual.includes(expectedGroup);
              const groupExistsOnSystem = groupExists(expectedGroup);

              if (verbose) {
                this.log(
                  chalk.gray(
                    `   Branch "${wt.name}" → group ${expectedGroup} ` +
                      `(exists: ${groupExistsOnSystem ? 'yes' : 'no'}, member: ${isInGroup ? 'yes' : 'no'})`
                  )
                );
              }

              let groupReady = groupExistsOnSystem;

              // Create group if it doesn't exist
              if (!groupExistsOnSystem) {
                this.log(chalk.yellow(`   → Creating group ${expectedGroup}...`));
                if (await execCmd(UnixGroupCommands.createGroup(expectedGroup))) {
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
                if (
                  await execCmd(UnixGroupCommands.addUserToGroup(user.unix_username, expectedGroup))
                ) {
                  result.groups.added.push(expectedGroup);
                  this.log(chalk.green(`   ✓ Added to ${expectedGroup}`));
                } else {
                  result.errors.push(`Failed to add to group ${expectedGroup}`);
                  this.log(chalk.red(`   ✗ Failed to add to ${expectedGroup}`));
                }
              }

              // Add daemon user to branch group
              if (groupReady && daemonUser) {
                const daemonInWtGroup = dryRun ? false : isUserInGroup(daemonUser, expectedGroup);
                if (!daemonInWtGroup) {
                  this.log(
                    chalk.yellow(`   → Adding daemon user ${daemonUser} to ${expectedGroup}...`)
                  );
                  if (await execCmd(UnixGroupCommands.addUserToGroup(daemonUser, expectedGroup))) {
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

            // Sync repo groups - user should be in repo group for each unique repo they own branches in
            const repoIdsSeen = new Set<string>();
            for (const wt of ownedBranches) {
              if (repoIdsSeen.has(wt.repo_id)) continue;
              repoIdsSeen.add(wt.repo_id);

              const persistedRepoGroup = repoGroupMap.get(wt.repo_id);
              if (persistedRepoGroup == null && !dryRun) {
                const message = `Repo ${shortId(wt.repo_id)} has no persisted unix_group; skipping host group access`;
                result.errors.push(message);
                this.log(chalk.red(`   ✗ ${message}`));
                continue;
              }
              const repoGroup =
                persistedRepoGroup == null
                  ? generateRepoGroupName(wt.repo_id as RepoID)
                  : resolveRepoGroupName(wt.repo_id as RepoID, persistedRepoGroup);
              result.groups.expected.push(repoGroup);

              const isInRepoGroup = result.groups.actual.includes(repoGroup);
              const repoGroupExistsOnSystem = groupExists(repoGroup);

              if (verbose) {
                this.log(
                  chalk.gray(
                    `   Repo ${shortId(wt.repo_id)} → group ${repoGroup} ` +
                      `(exists: ${repoGroupExistsOnSystem ? 'yes' : 'no'}, member: ${isInRepoGroup ? 'yes' : 'no'})`
                  )
                );
              }

              let repoGroupReady = repoGroupExistsOnSystem;

              // Create repo group if it doesn't exist
              if (!repoGroupExistsOnSystem) {
                this.log(chalk.yellow(`   → Creating repo group ${repoGroup}...`));
                if (await execCmd(UnixGroupCommands.createGroup(repoGroup))) {
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
                if (
                  await execCmd(UnixGroupCommands.addUserToGroup(user.unix_username, repoGroup))
                ) {
                  result.groups.added.push(repoGroup);
                  this.log(chalk.green(`   ✓ Added to ${repoGroup}`));
                } else {
                  result.errors.push(`Failed to add to repo group ${repoGroup}`);
                  this.log(chalk.red(`   ✗ Failed to add to repo group ${repoGroup}`));
                }
              }

              // Add daemon user to repo group
              if (repoGroupReady && daemonUser) {
                const daemonInRpGroup = dryRun ? false : isUserInGroup(daemonUser, repoGroup);
                if (!daemonInRpGroup) {
                  this.log(
                    chalk.yellow(`   → Adding daemon user ${daemonUser} to ${repoGroup}...`)
                  );
                  if (await execCmd(UnixGroupCommands.addUserToGroup(daemonUser, repoGroup))) {
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
      } // end if (targetBranchId / validUsers.length)

      // ========================================
      // Sync Branch Groups Phase (deterministic)
      //
      // For every non-archived-deleted branch in scope, brings group
      // state to canonical:
      //   1. Unix group exists on the system (creates if missing — covers
      //      fresh branches and DB-migration cruft).
      //   2. Daemon user is a member of the group.
      // Group names were persisted by the DB-first stamping phase above.
      //
      // Archived+deleted branches are left alone here; the Sync Branch
      // Permissions phase below handles their group cleanup.
      // ========================================

      this.log(chalk.cyan.bold('\n━━━ Sync Branch Groups ━━━\n'));

      // Existence of the target branch was already verified earlier
      // when resolving targetRepoId, so we can safely scope the fetch here.
      const allBranchesForBackfill = targetBranchId
        ? await select(db).from(branches).where(eq(branches.branch_id, targetBranchId)).all()
        : await select(db).from(branches).all();

      const branchesForGroupSync = allBranchesForBackfill.filter(
        (wt: { archived: boolean; filesystem_status: string | null }) =>
          !(wt.archived && wt.filesystem_status === 'deleted')
      );

      if (branchesForGroupSync.length === 0) {
        this.log(chalk.yellow('   No active branches in scope\n'));
      } else {
        this.log(chalk.cyan(`Processing ${branchesForGroupSync.length} branch(s)\n`));

        for (const wt of branchesForGroupSync) {
          const rawWt = wt as {
            branch_id: string;
            name: string;
            repo_id: string;
            unix_group: string | null;
            data: { path?: string } | null;
          };

          const dbNeedsBackfill = rawWt.unix_group === null;
          if (dbNeedsBackfill && !dryRun) {
            this.log(
              chalk.red(
                `   ✗ ${rawWt.name}: unix_group is still absent; skipping host group access`
              )
            );
            continue;
          }
          const expectedGroup =
            rawWt.unix_group == null
              ? generateBranchGroupName(rawWt.branch_id as BranchID)
              : resolveBranchGroupName(rawWt.branch_id as BranchID, rawWt.unix_group);
          const groupMissingOnSystem = !groupExists(expectedGroup);

          // Skip logging for branches already in canonical state (quiet mode)
          if (!dbNeedsBackfill && !groupMissingOnSystem && !verbose) {
            // Still need to ensure daemon membership, which is cheap to check
            if (daemonUser && !isUserInGroup(daemonUser, expectedGroup)) {
              this.log(chalk.bold(`📁 ${rawWt.name}`));
              this.log(
                chalk.yellow(`   → Adding daemon user ${daemonUser} to ${expectedGroup}...`)
              );
              if (await execCmd(UnixGroupCommands.addUserToGroup(daemonUser, expectedGroup))) {
                daemonMembershipsAdded++;
                this.log(chalk.green(`   ✓ Added daemon user to ${expectedGroup}\n`));
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to add daemon user to ${expectedGroup}\n`));
              }
            }
            continue;
          }

          this.log(chalk.bold(`📁 ${rawWt.name}`));
          this.log(chalk.gray(`   branch_id: ${shortId(rawWt.branch_id)}`));
          this.log(
            chalk.gray(`   unix_group: ${expectedGroup}${dbNeedsBackfill ? ' (to backfill)' : ''}`)
          );

          let hadError = false;

          // 1. Ensure Unix group exists on the system
          if (groupMissingOnSystem) {
            this.log(chalk.yellow(`   → Creating Unix group ${expectedGroup}...`));
            if (await execCmd(UnixGroupCommands.createGroup(expectedGroup))) {
              groupsCreated++;
              this.log(chalk.green(`   ✓ Created Unix group ${expectedGroup}`));
            } else {
              syncErrors++;
              hadError = true;
              this.log(chalk.red(`   ✗ Failed to create Unix group ${expectedGroup}`));
            }
          } else if (verbose) {
            this.log(chalk.gray(`   ✓ Unix group exists`));
          }

          // 2. Ensure daemon user is in the group
          if (!hadError && daemonUser) {
            const daemonInGroup = dryRun ? false : isUserInGroup(daemonUser, expectedGroup);
            if (!daemonInGroup) {
              this.log(
                chalk.yellow(`   → Adding daemon user ${daemonUser} to ${expectedGroup}...`)
              );
              if (await execCmd(UnixGroupCommands.addUserToGroup(daemonUser, expectedGroup))) {
                daemonMembershipsAdded++;
                this.log(chalk.green(`   ✓ Added daemon user to ${expectedGroup}`));
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to add daemon user to ${expectedGroup}`));
              }
            } else if (verbose) {
              this.log(chalk.gray(`   ✓ Daemon user already in ${expectedGroup}`));
            }
          }

          this.log('');
        }

        if (branchesBackfilled > 0 || groupsCreated > 0 || daemonMembershipsAdded > 0) {
          this.log(chalk.bold('Sync Branch Groups Summary:'));
          this.log(`  DB backfilled: ${branchesBackfilled}${dryRun ? ' (dry-run)' : ''}`);
          this.log('');
        }
      }

      // ========================================
      // Branch Permission Sync Phase
      // Archive-aware: handles missing directories, skips archived+deleted
      // ========================================

      this.log(chalk.cyan.bold('\n━━━ Sync Branch Permissions ━━━\n'));

      // Refresh from DB to use only persisted unix_group values.
      const allBranchesForSync = targetBranchId
        ? await select(db).from(branches).where(eq(branches.branch_id, targetBranchId)).all()
        : await select(db).from(branches).all();
      const branchesWithGroup = allBranchesForSync.filter(
        (wt: { unix_group: string | null }) => wt.unix_group !== null
      );

      // Build repo path lookup map for git branch operations
      const allReposForWtSync = await select(db).from(repos).all();
      const repoPathMap = new Map<string, { localPath: string; defaultBranch: string }>();
      for (const repo of allReposForWtSync) {
        const r = repo as {
          repo_id: string;
          data: { local_path?: string; default_branch?: string } | null;
        };
        if (r.data?.local_path) {
          repoPathMap.set(r.repo_id, {
            localPath: r.data.local_path,
            defaultBranch: r.data.default_branch || 'main',
          });
        }
      }

      if (branchesWithGroup.length === 0) {
        this.log(chalk.yellow('No branches with unix_group found\n'));
      } else {
        this.log(chalk.cyan(`Found ${branchesWithGroup.length} branch(s) with unix_group\n`));

        for (const wt of branchesWithGroup) {
          const rawBranch = wt as {
            branch_id: string;
            name: string;
            ref: string;
            repo_id: string;
            unix_group: string;
            archived: boolean;
            filesystem_status: string | null;
            others_fs_access: 'none' | 'read' | 'write' | null;
            data: { path?: string; base_ref?: string } | null;
          };

          const branchPath = rawBranch.data?.path;
          const branchGroup = resolveBranchGroupName(
            rawBranch.branch_id as BranchID,
            rawBranch.unix_group
          );

          // Skip branches without a path in the data blob
          if (!branchPath) {
            if (verbose) {
              this.log(chalk.gray(`   ⚠ ${rawBranch.name}: no path in data, skipping`));
            }
            branchesSkipped++;
            continue;
          }

          const dirExists = existsSync(branchPath);
          const action = getBranchDirectoryAction(
            dirExists,
            rawBranch.archived,
            rawBranch.filesystem_status
          );

          if (action === 'cleanup') {
            // Archived+deleted: remove Unix group cruft
            const wtGroup = branchGroup;
            if (isLegacyManagedGroupName(wtGroup)) {
              this.log(
                chalk.yellow(
                  `   ⊘ ${rawBranch.name}: retaining shared-capable legacy group ${wtGroup}; use agor local fix-group-uuids`
                )
              );
              continue;
            }
            if (groupExists(wtGroup)) {
              this.log(
                chalk.yellow(
                  `   🧹 ${rawBranch.name}: archived+deleted, removing group ${wtGroup}...`
                )
              );
              if (await execCmd(UnixGroupCommands.deleteGroup(wtGroup))) {
                groupsCleaned++;
                this.log(chalk.green(`   ✓ Deleted group ${wtGroup}`));
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to delete group ${wtGroup}`));
              }
            } else if (verbose) {
              this.log(
                chalk.gray(
                  `   ⊘ ${rawBranch.name}: archived+deleted, group ${wtGroup} already gone`
                )
              );
            }
            continue;
          }

          if (action === 'skip') {
            if (verbose) {
              const reason =
                rawBranch.filesystem_status === 'creating'
                  ? 'still creating'
                  : rawBranch.archived && !dirExists
                    ? `archived (${rawBranch.filesystem_status || 'unknown'}), dir missing`
                    : 'unknown';
              this.log(chalk.gray(`   ⊘ ${rawBranch.name}: ${reason}, skipping`));
            }
            branchesSkipped++;
            continue;
          }

          // Restore failed non-archived branches via shared restoreBranchFilesystem()
          if (action === 'restore') {
            const repoInfo = repoPathMap.get(rawBranch.repo_id);
            if (!repoInfo) {
              if (verbose) {
                this.log(
                  chalk.gray(`   ⊘ ${rawBranch.name}: failed, no repo path found, skipping restore`)
                );
              }
              branchesSkipped++;
              continue;
            }

            const baseRef = rawBranch.data?.base_ref || repoInfo.defaultBranch;

            this.log(chalk.bold(`🔧 ${rawBranch.name}`));
            this.log(chalk.gray(`   branch_id: ${shortId(rawBranch.branch_id)}`));
            this.log(chalk.gray(`   status: failed → attempting restore`));
            this.log(chalk.gray(`   ref: ${rawBranch.ref}, base: ${baseRef}`));
            this.log(chalk.gray(`   path: ${branchPath}`));

            if (dryRun) {
              this.log(
                chalk.gray(
                  `   [dry-run] Would attempt restoreBranchFilesystem() for ${rawBranch.ref} at ${branchPath}`
                )
              );
              branchesRestored++;
              this.log('');
              continue;
            }

            this.log(chalk.yellow(`   → Restoring branch filesystem...`));
            const result = await restoreBranchFilesystem(
              repoInfo.localPath,
              branchPath,
              rawBranch.ref,
              baseRef
            );

            if (result.success) {
              // Update filesystem_status to ready
              await update(db, branches)
                .set({ filesystem_status: 'ready' })
                .where(eq(branches.branch_id, rawBranch.branch_id))
                .run();

              branchesRestored++;
              this.log(chalk.green(`   ✓ Restored branch (${result.strategy}), status → ready`));
            } else {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed to restore branch: ${result.error}`));
            }
            this.log('');
            continue;
          }

          this.log(chalk.bold(`📁 ${rawBranch.name}`));
          this.log(chalk.gray(`   branch_id: ${shortId(rawBranch.branch_id)}`));
          this.log(chalk.gray(`   unix_group: ${branchGroup}`));
          this.log(chalk.gray(`   path: ${branchPath}`));
          if (rawBranch.archived) {
            this.log(
              chalk.gray(`   archived: yes (fs: ${rawBranch.filesystem_status || 'preserved'})`)
            );
          }

          // Create missing branch directory using shared restoreBranchFilesystem()
          if (action === 'create') {
            const repoInfo = repoPathMap.get(rawBranch.repo_id);

            if (repoInfo) {
              const baseRef = rawBranch.data?.base_ref || repoInfo.defaultBranch;
              this.log(
                chalk.yellow(
                  `   → Directory missing, creating git branch (branch: ${rawBranch.ref}, base: ${baseRef})...`
                )
              );

              if (dryRun) {
                branchDirsCreated++;
                this.log(
                  chalk.gray(
                    `   [dry-run] Would run restoreBranchFilesystem() for ${rawBranch.ref} at ${branchPath}`
                  )
                );
              } else {
                const result = await restoreBranchFilesystem(
                  repoInfo.localPath,
                  branchPath,
                  rawBranch.ref,
                  baseRef
                );

                if (result.success) {
                  branchDirsCreated++;
                  this.log(chalk.green(`   ✓ Created git branch (${result.strategy})`));
                } else {
                  // Fallback to mkdir -p
                  this.log(
                    chalk.yellow(
                      `   ⚠ git worktree add failed (${result.error}), falling back to mkdir -p`
                    )
                  );
                  if (await execCmd(`sudo -n mkdir -p "${branchPath}"`)) {
                    branchDirsCreated++;
                    this.log(chalk.green(`   ✓ Created directory (mkdir fallback)`));
                  } else {
                    syncErrors++;
                    this.log(chalk.red(`   ✗ Failed to create directory`));
                    this.log('');
                    continue;
                  }
                }
              }
            } else {
              // No repo info available, fall back to mkdir -p
              this.log(
                chalk.yellow(`   → Directory missing, creating (no repo path for git branch)...`)
              );
              if (await execCmd(`sudo -n mkdir -p "${branchPath}"`)) {
                branchDirsCreated++;
                this.log(chalk.green(`   ✓ Created directory`));
              } else {
                syncErrors++;
                this.log(chalk.red(`   ✗ Failed to create directory`));
                this.log('');
                continue;
              }
            }
          }

          // Fix filesystem_status for active branches stuck as 'deleted' or 'preserved'
          if (
            action === 'sync' &&
            !rawBranch.archived &&
            (rawBranch.filesystem_status === 'deleted' ||
              rawBranch.filesystem_status === 'preserved')
          ) {
            // Verify it's a valid git branch (has .git file)
            const gitFilePath = join(branchPath, '.git');
            if (existsSync(gitFilePath)) {
              const oldStatus = rawBranch.filesystem_status;
              this.log(chalk.yellow(`   → Fixing filesystem_status: ${oldStatus} → ready`));
              if (!dryRun) {
                try {
                  await update(db, branches)
                    .set({ filesystem_status: 'ready' })
                    .where(eq(branches.branch_id, rawBranch.branch_id))
                    .run();
                  this.log(
                    chalk.green(
                      `   ✓ Fixed filesystem_status: ${oldStatus} → ready for ${rawBranch.name}`
                    )
                  );
                } catch (error) {
                  syncErrors++;
                  this.log(chalk.red(`   ✗ Failed to fix filesystem_status: ${error}`));
                }
              } else {
                this.log(
                  chalk.gray(
                    `   [dry-run] Would fix filesystem_status: ${oldStatus} → ready for ${rawBranch.name}`
                  )
                );
              }
              statusFixed++;
            }
          }

          // Calculate permission mode based on others_fs_access
          const othersAccess = rawBranch.others_fs_access || 'read';
          const permissionMode = getBranchPermissionMode(othersAccess);

          this.log(chalk.gray(`   others_fs_access: ${othersAccess} → mode: ${permissionMode}`));

          const permCmds = UnixGroupCommands.setDirectoryGroup(
            branchPath,
            branchGroup,
            permissionMode
          );
          if (await execAllCmds(permCmds)) {
            branchesSynced++;
            this.log(chalk.green(`   ✓ Applied permissions (${permissionMode})`));
          } else {
            syncErrors++;
            this.log(chalk.red(`   ✗ Failed to set permissions`));
          }

          // Apply daemon user ACL so the running daemon can access without restart
          if (daemonUser && (dirExists || action === 'create')) {
            const aclCmds = UnixGroupCommands.setUserAcl(branchPath, daemonUser);
            if (await execAllCmds(aclCmds)) {
              daemonAclsApplied++;
              if (verbose) {
                this.log(chalk.green(`   ✓ Applied daemon ACL for ${daemonUser}`));
              }
            } else {
              syncErrors++;
              this.log(chalk.red(`   ✗ Failed to set daemon ACL`));
            }
          }

          this.log('');
        }

        // Summary for branch sync
        this.log(chalk.bold('Branch Sync Summary:'));
        this.log(`  Branches synced: ${branchesSynced}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Directories created: ${branchDirsCreated}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Branches restored: ${branchesRestored}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Groups cleaned: ${groupsCleaned}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Status fixed: ${statusFixed}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Daemon ACLs applied: ${daemonAclsApplied}${dryRun ? ' (dry-run)' : ''}`);
        this.log(`  Skipped: ${branchesSkipped}`);
        if (syncErrors > 0) {
          this.log(chalk.red(`  Errors: ${syncErrors}`));
        }
        this.log('');
      }

      // ========================================
      // Membership Pruning Phase
      // Removes users from branch groups they no longer own
      // ========================================

      if (targetBranchId) {
        this.log(chalk.gray('   ⊘ Skipping membership pruning phase (--branch-id mode)\n'));
      } else if (!hasGlobalUnixStateView) {
        this.log(
          chalk.yellow(
            '   ⊘ Skipping membership pruning: a PostgreSQL/RLS or remote database view cannot prove global Unix group membership\n'
          )
        );
      } else {
        this.log(chalk.cyan.bold('\n━━━ Prune Stale Group Memberships ━━━\n'));

        {
          // Build a map of branch group → expected members (owners + daemon)
          const allWtForPrune = await select(db).from(branches).all();
          const allOwnerRows = await select(db).from(branchOwners).all();

          // Map branch_id → unix_group
          const wtGroupMap = new Map<string, string>();
          for (const wt of allWtForPrune) {
            const raw = wt as { branch_id: string; unix_group: string | null };
            if (raw.unix_group) {
              wtGroupMap.set(
                raw.branch_id,
                resolveBranchGroupName(raw.branch_id as BranchID, raw.unix_group)
              );
            }
          }

          // Map unix_group → set of expected user_ids
          const groupToOwnerIds = new Map<string, Set<string>>();
          for (const row of allOwnerRows) {
            const raw = row as { branch_id: string; user_id: string };
            const group = wtGroupMap.get(raw.branch_id);
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

          // Iterate ALL branch groups (including those with zero owners)
          let pruneChecked = 0;
          for (const [, group] of wtGroupMap.entries()) {
            if (!groupExists(group)) continue;
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
            const actualMembers = getGroupMembers(group);

            for (const member of actualMembers) {
              if (expectedUsernames.has(member)) continue;
              // Skip the daemon user (safety)
              if (daemonUser && member === daemonUser) continue;
              // Only prune DB-managed users (skip manually-added system users)
              if (!unixNameToUserId.has(member)) continue;

              this.log(chalk.yellow(`   → Removing ${member} from ${group} (no longer owner)`));
              if (await execCmd(UnixGroupCommands.removeUserFromGroup(member, group))) {
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
      } // end if (!targetBranchId) for membership pruning

      // ========================================
      // Symlink Sync Phase
      // Creates missing symlinks, removes broken ones
      // ========================================

      if (targetBranchId) {
        this.log(chalk.gray('   ⊘ Skipping symlink sync phase (--branch-id mode)\n'));
      } else if (validUsers.length > 0) {
        this.log(chalk.cyan.bold('\n━━━ Sync User Symlinks ━━━\n'));

        // Build branch ownership data for symlink creation
        const allWtForSymlinks = await select(db).from(branches).all();
        const allOwnershipsForSymlinks = await select(db).from(branchOwners).all();

        // Map branch_id → branch info
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
            branch_id: string;
            name: string;
            archived: boolean;
            filesystem_status: string | null;
            data: { path?: string } | null;
          };
          wtInfoMap.set(raw.branch_id, {
            name: raw.name,
            path: raw.data?.path,
            archived: raw.archived,
            filesystem_status: raw.filesystem_status,
          });
        }

        // Map user_id → list of branch_ids they own
        const userToBranches = new Map<string, string[]>();
        for (const row of allOwnershipsForSymlinks) {
          const raw = row as { user_id: string; branch_id: string };
          const existing = userToBranches.get(raw.user_id) || [];
          existing.push(raw.branch_id);
          userToBranches.set(raw.user_id, existing);
        }

        for (const user of validUsers) {
          const branchesDir = getUserBranchesDir(user.unix_username);

          if (verbose) {
            this.log(chalk.gray(`   ${user.unix_username}: checking symlinks...`));
          }

          // Ensure ~/agor/worktrees/ directory exists
          if (!existsSync(branchesDir)) {
            const setupCmds = UnixUserCommands.setupBranchesDir(user.unix_username);
            if (!(await execAllCmds(setupCmds))) {
              // May already exist or user home may not exist yet
              if (verbose) {
                this.log(chalk.gray(`   ⚠ Could not create ${branchesDir}`));
              }
              continue;
            }
          }

          // Clean up broken symlinks
          if (existsSync(branchesDir)) {
            await execCmd(SymlinkCommands.removeBrokenSymlinks(branchesDir));
            symlinksCleaned++; // Count users cleaned, not individual symlinks
          }

          // Create symlinks for owned branches where directory exists
          const ownedWtIds = userToBranches.get(user.user_id) || [];
          for (const wtId of ownedWtIds) {
            const wtInfo = wtInfoMap.get(wtId);
            if (!wtInfo?.path) continue;

            // Skip archived+deleted branches
            if (wtInfo.archived && wtInfo.filesystem_status === 'deleted') continue;

            // Skip if target directory doesn't exist
            if (!existsSync(wtInfo.path)) continue;

            const symlinkPath = getBranchSymlinkPath(user.unix_username, wtInfo.name);

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

            // SymlinkCommands don't include sudo prefix, so prepend it
            const symlinkCmds = SymlinkCommands.createSymlinkWithOwnership(
              wtInfo.path,
              symlinkPath,
              user.unix_username
            ).map((cmd) => `sudo -n ${cmd}`);
            if (await execAllCmds(symlinkCmds)) {
              symlinksCreated++;
              if (verbose) {
                this.log(
                  chalk.green(`   ✓ ${user.unix_username}: ${wtInfo.name} → ${wtInfo.path}`)
                );
              }
            } else {
              if (verbose) {
                this.log(chalk.red(`   ✗ Failed to create symlink for ${wtInfo.name}`));
              }
              syncErrors++;
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

      if (targetBranchId && (cleanupGroups || cleanupUsers)) {
        this.log(chalk.gray('   ⊘ Skipping cleanup phase (--branch-id mode)\n'));
      } else if (cleanupGroups || cleanupUsers) {
        this.log(chalk.cyan.bold('━━━ Cleanup ━━━\n'));
      }

      // Cleanup stale branch groups
      if (cleanupGroups && !targetBranchId) {
        this.log(chalk.cyan('Checking for stale branch groups...\n'));

        // Get all branch groups that should exist (from DB)
        const allBranches = await select(db).from(branches).all();
        const expectedGroups = new Set(
          allBranches.flatMap((wt: { branch_id: string; unix_group: string | null }) =>
            wt.unix_group ? [resolveBranchGroupName(wt.branch_id as BranchID, wt.unix_group)] : []
          )
        );

        // Get all agor_wt_* groups on the system
        const systemGroups = listBranchGroups();

        if (verbose) {
          this.log(chalk.gray(`   Found ${systemGroups.length} agor_wt_* group(s) on system`));
          this.log(chalk.gray(`   Expected ${expectedGroups.size} group(s) from database`));
        }

        // Find stale groups (on system but not in DB)
        const staleGroups = systemGroups.filter((g) => !expectedGroups.has(g));

        if (staleGroups.length === 0) {
          this.log(chalk.green('   ✓ No stale branch groups found\n'));
        } else {
          this.log(chalk.yellow(`   Found ${staleGroups.length} stale group(s) to remove:\n`));

          for (const groupName of staleGroups) {
            if (isLegacyManagedGroupName(groupName)) {
              this.log(
                chalk.yellow(
                  `   ⊘ Retaining legacy group ${groupName}; use agor local fix-group-uuids for globally verified cleanup`
                )
              );
              continue;
            }
            this.log(chalk.yellow(`   → Deleting group ${groupName}...`));
            if (await execCmd(UnixGroupCommands.deleteGroup(groupName))) {
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
          allReposForCleanup.flatMap((r: { repo_id: string; unix_group: string | null }) =>
            r.unix_group ? [resolveRepoGroupName(r.repo_id as RepoID, r.unix_group)] : []
          )
        );

        // Get all agor_rp_* groups on the system
        const systemRepoGroups = listRepoGroups();

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
            if (isLegacyManagedGroupName(groupName)) {
              this.log(
                chalk.yellow(
                  `   ⊘ Retaining legacy group ${groupName}; use agor local fix-group-uuids for globally verified cleanup`
                )
              );
              continue;
            }
            this.log(chalk.yellow(`   → Deleting group ${groupName}...`));
            if (await execCmd(UnixGroupCommands.deleteGroup(groupName))) {
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
      if (cleanupUsers && !targetBranchId) {
        this.log(chalk.cyan('Checking for stale Agor users...\n'));

        // Get all unix_usernames that should exist (from DB)
        // Only auto-generated ones (agor_<8-hex>) are candidates for cleanup
        const expectedUsers = new Set(
          validUsers.map((u) => u.unix_username).filter((u) => /^agor_[0-9a-f]{8}$/.test(u))
        );

        // Get all agor_* users on the system (only auto-generated format)
        const systemUsers = listAgorUsers();

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
            if (await execCmd(UnixUserCommands.deleteUser(username))) {
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

      // Branch/Repo sync stats
      this.log('');
      this.log(chalk.bold('Filesystem Sync:'));
      this.log(`  WT groups backfilled: ${branchesBackfilled}${dryRunSuffix}`);
      this.log(`  Branches synced:  ${branchesSynced}${dryRunSuffix}`);
      this.log(`  Dirs created:      ${branchDirsCreated}${dryRunSuffix}`);
      this.log(`  Branches restored:${branchesRestored}${dryRunSuffix}`);
      this.log(`  Groups cleaned:    ${groupsCleaned}${dryRunSuffix}`);
      this.log(`  Status fixed:      ${statusFixed}${dryRunSuffix}`);
      this.log(`  Skipped:           ${branchesSkipped}`);
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
        branchesSynced > 0 ||
        branchesBackfilled > 0 ||
        branchDirsCreated > 0 ||
        branchesRestored > 0 ||
        groupsCleaned > 0 ||
        statusFixed > 0 ||
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
