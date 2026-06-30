/**
 * Unix Integration Service
 *
 * Central controller for all Unix-level operations in Agor:
 * - Unix group management for branch isolation
 * - Unix group management for repo-root traversal + .git access
 * - Unix user creation/management
 * - Symlink management in user home directories
 *
 * This service can be used by both the daemon and CLI.
 * The CommandExecutor determines how privileged commands are executed.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { Database } from '../db/index.js';
import { BranchRepository, RepoRepository, UsersRepository } from '../db/repositories/index.js';
import { shortId } from '../lib/ids';
import type { BranchID, RepoID, UserID, UUID } from '../types/index.js';
import type { CommandExecutor } from './command-executor.js';
import { NoOpExecutor } from './command-executor.js';
import {
  AGOR_USERS_GROUP,
  generateBranchGroupName,
  generateRepoGroupName,
  getBranchPermissionMode,
  REPO_GIT_PERMISSION_MODE,
  UnixGroupCommands,
} from './group-manager.js';
import { getBranchSymlinkPath, SymlinkCommands } from './symlink-manager.js';
import {
  AGOR_DEFAULT_SHELL,
  AGOR_HOME_BASE,
  generateUnixUsername,
  getUserBranchesDir,
  getUserHomeDir,
  isValidUnixUsername,
  UnixUserCommands,
} from './user-manager.js';

/**
 * Minimal Zellij configuration for Agor users
 *
 * Only suppresses startup banners for cleaner UX.
 * Users can customize further by editing ~/.config/zellij/config.kdl
 */
export const AGOR_ZELLIJ_CONFIG = `// Agor Zellij Config
// Customize as needed

// Hide startup banners for cleaner embedded terminal UX
show_startup_tips false
show_release_notes false

// Clipboard configuration for web terminal (xterm.js)
// Disable Zellij clipboard handling to allow native browser copy/paste
mouse_mode false
copy_on_select false
`;

/**
 * Unix integration service configuration
 */
export interface UnixIntegrationConfig {
  /** Enable Unix integration (default: false) */
  enabled: boolean;

  /** Home directory base (default: /home) */
  homeBase?: string;

  /** Whether to auto-create Unix users when Agor users are created (default: false) */
  autoCreateUnixUsers?: boolean;

  /** Whether to auto-create symlinks when ownership changes (default: true when enabled) */
  autoManageSymlinks?: boolean;

  /** Unix user the daemon runs as. Added to all Unix groups to ensure daemon has access.
   * Should be resolved via getAgorDaemonUser() before passing to the service. */
  daemonUser?: string;
}

/**
 * Result of a Unix operation
 */
export interface UnixOperationResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Unix Integration Service
 *
 * Orchestrates all Unix-level operations for Agor RBAC.
 */
export class UnixIntegrationService {
  private config: Required<Omit<UnixIntegrationConfig, 'daemonUser'>> & { daemonUser?: string };
  private executor: CommandExecutor;
  private branchRepo: BranchRepository;
  private usersRepo: UsersRepository;
  private repoRepo: RepoRepository;

  constructor(
    db: Database,
    executor: CommandExecutor,
    config: UnixIntegrationConfig = { enabled: false }
  ) {
    // daemonUser should be resolved by the caller via getAgorDaemonUser()
    // If not provided, daemon user operations will be skipped
    this.config = {
      enabled: config.enabled,
      homeBase: config.homeBase || AGOR_HOME_BASE,
      autoCreateUnixUsers: config.autoCreateUnixUsers ?? false,
      autoManageSymlinks: config.autoManageSymlinks ?? config.enabled,
      daemonUser: config.daemonUser,
    };
    this.executor = config.enabled ? executor : new NoOpExecutor();
    this.branchRepo = new BranchRepository(db);
    this.usersRepo = new UsersRepository(db);
    this.repoRepo = new RepoRepository(db);
  }

  private async getUnixUsernamesForUsers(userIds: Iterable<UUID>): Promise<Set<string>> {
    const unixUsernames = new Set<string>();
    for (const userId of userIds) {
      const user = await this.usersRepo.findById(userId as UserID);
      if (user?.unix_username) {
        unixUsernames.add(user.unix_username);
      }
    }
    return unixUsernames;
  }

  private async reconcileUnixGroupMembers(
    groupName: string,
    allowedUnixUsernames: Set<string>,
    options: { label: string }
  ): Promise<void> {
    if (this.config.daemonUser) {
      allowedUnixUsernames.add(this.config.daemonUser);
    }

    const result = await this.executor.exec(UnixGroupCommands.listGroupMembers(groupName));
    const currentMembers = result.stdout.trim().split(',').filter(Boolean);
    for (const unixUsername of currentMembers) {
      if (allowedUnixUsernames.has(unixUsername)) continue;
      console.log(
        `[UnixIntegration] Removing stale ${options.label} group member ${unixUsername} from ${groupName}`
      );
      await this.executor.exec(UnixGroupCommands.removeUserFromGroup(unixUsername, groupName));
    }
  }

  /**
   * Get the configured daemon user
   *
   * Returns the Unix user that runs the daemon process, or undefined if not configured.
   * Used to ensure daemon has access to all Unix groups.
   */
  getDaemonUser(): string | undefined {
    return this.config.daemonUser;
  }

  /**
   * Check if Unix integration is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ============================================================
  // AGOR_USERS GROUP MANAGEMENT
  // ============================================================

  /**
   * Ensure the agor_users group exists
   *
   * This group contains all Agor-managed users. The daemon can only
   * impersonate users in this group, providing namespace containment.
   */
  async ensureAgorUsersGroup(): Promise<void> {
    const exists = await this.executor.check(UnixGroupCommands.groupExists(AGOR_USERS_GROUP));
    if (!exists) {
      console.log(`[UnixIntegration] Creating ${AGOR_USERS_GROUP} group`);
      await this.executor.exec(UnixGroupCommands.createGroup(AGOR_USERS_GROUP));
    }
  }

  /**
   * Add a user to the agor_users group
   *
   * Users must be in this group to be impersonated by the daemon.
   *
   * @param unixUsername - Unix username to add
   */
  async addUserToAgorUsersGroup(unixUsername: string): Promise<void> {
    // Ensure group exists first
    await this.ensureAgorUsersGroup();

    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(unixUsername, AGOR_USERS_GROUP)
    );
    if (!inGroup) {
      console.log(`[UnixIntegration] Adding ${unixUsername} to ${AGOR_USERS_GROUP}`);
      await this.executor.exec(UnixGroupCommands.addUserToGroup(unixUsername, AGOR_USERS_GROUP));
    }
  }

  /**
   * Remove a user from the agor_users group
   *
   * @param unixUsername - Unix username to remove
   */
  async removeUserFromAgorUsersGroup(unixUsername: string): Promise<void> {
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(unixUsername, AGOR_USERS_GROUP)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] Removing ${unixUsername} from ${AGOR_USERS_GROUP}`);
      await this.executor.exec(
        UnixGroupCommands.removeUserFromGroup(unixUsername, AGOR_USERS_GROUP)
      );
    }
  }

  /**
   * Check if a user is in the agor_users group
   *
   * @param unixUsername - Unix username to check
   * @returns true if user is in agor_users group
   */
  async isAgorManagedUser(unixUsername: string): Promise<boolean> {
    return this.executor.check(UnixGroupCommands.isUserInGroup(unixUsername, AGOR_USERS_GROUP));
  }

  // ============================================================
  // BRANCH GROUP MANAGEMENT
  // ============================================================

  /**
   * Create a Unix group for a branch
   *
   * @param branchId - Branch ID
   * @returns Group name created
   */
  async createBranchGroup(branchId: BranchID): Promise<string> {
    const groupName = generateBranchGroupName(branchId);

    console.log(`[UnixIntegration] Creating group ${groupName} for branch ${shortId(branchId)}`);

    // Check if group already exists
    const exists = await this.executor.check(UnixGroupCommands.groupExists(groupName));
    if (exists) {
      console.log(`[UnixIntegration] Group ${groupName} already exists`);
    } else {
      await this.executor.exec(UnixGroupCommands.createGroup(groupName));
    }

    // Fetch current branch to get existing data and path
    const branch = await this.branchRepo.findById(branchId);

    // Update branch record with group name (using repository)
    await this.branchRepo.update(branchId, {
      unix_group: groupName,
    });

    // Apply group ownership and permissions to branch directory
    if (branch?.path) {
      await this.setBranchPermissions(branchId, branch.path);
    }

    // Add the daemon user to the branch group so it can access the branch
    if (this.config.daemonUser) {
      await this.addUnixUserToBranchGroup(groupName, this.config.daemonUser);
    }

    return groupName;
  }

  /**
   * Add a Unix username directly to a branch group
   *
   * Used for adding the daemon user or other system users.
   *
   * @param groupName - Unix group name
   * @param unixUsername - Unix username to add
   */
  async addUnixUserToBranchGroup(groupName: string, unixUsername: string): Promise<void> {
    console.log(`[UnixIntegration] Adding Unix user ${unixUsername} to branch group ${groupName}`);

    // Check if already in group
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(unixUsername, groupName)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] User ${unixUsername} already in branch group ${groupName}`);
    } else {
      await this.executor.exec(UnixGroupCommands.addUserToGroup(unixUsername, groupName));
    }
  }

  /**
   * Delete a Unix group for a branch
   *
   * @param branchId - Branch ID
   */
  async deleteBranchGroup(branchId: BranchID): Promise<void> {
    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.unix_group) {
      console.log(`[UnixIntegration] No Unix group for branch ${shortId(branchId)}`);
      return;
    }

    console.log(
      `[UnixIntegration] Deleting group ${branch.unix_group} for branch ${shortId(branchId)}`
    );

    // Check if group exists before deleting
    const exists = await this.executor.check(UnixGroupCommands.groupExists(branch.unix_group));
    if (exists) {
      await this.executor.exec(UnixGroupCommands.deleteGroup(branch.unix_group));
    }
  }

  /**
   * Add a user to a branch's Unix group
   *
   * @param branchId - Branch ID
   * @param userId - User ID to add
   */
  async addUserToBranchGroup(branchId: BranchID, userId: UUID): Promise<void> {
    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for branch ${shortId(branchId)}, skipping user add`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${shortId(userId)} has no Unix username, skipping group add`
      );
      return;
    }

    console.log(
      `[UnixIntegration] Adding user ${user.unix_username} to group ${branch.unix_group}`
    );

    // Check if already in group
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(user.unix_username, branch.unix_group)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] User ${user.unix_username} already in group`);
    } else {
      await this.executor.exec(
        UnixGroupCommands.addUserToGroup(user.unix_username, branch.unix_group)
      );
    }

    // Also create symlink if auto-manage is enabled
    if (this.config.autoManageSymlinks && branch.path) {
      await this.createBranchSymlink(userId, branchId);
    }
  }

  /**
   * Remove a user from a branch's Unix group
   *
   * @param branchId - Branch ID
   * @param userId - User ID to remove
   */
  async removeUserFromBranchGroup(branchId: BranchID, userId: UUID): Promise<void> {
    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for branch ${shortId(branchId)}, skipping user remove`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${shortId(userId)} has no Unix username, skipping group remove`
      );
      return;
    }

    console.log(
      `[UnixIntegration] Removing user ${user.unix_username} from group ${branch.unix_group}`
    );

    // Check if in group before removing
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(user.unix_username, branch.unix_group)
    );
    if (inGroup) {
      await this.executor.exec(
        UnixGroupCommands.removeUserFromGroup(user.unix_username, branch.unix_group)
      );
    }

    // Also remove symlink if auto-manage is enabled
    if (this.config.autoManageSymlinks) {
      await this.removeBranchSymlink(userId, branchId);
    }
  }

  /**
   * Set filesystem permissions for a branch directory
   *
   * @param branchId - Branch ID
   * @param branchPath - Absolute path to branch directory
   */
  async setBranchPermissions(branchId: BranchID, branchPath: string): Promise<void> {
    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for branch ${shortId(branchId)}, skipping permissions`
      );
      return;
    }

    const permissionMode = getBranchPermissionMode(branch.others_fs_access || 'read');

    console.log(
      `[UnixIntegration] Setting permissions ${permissionMode} for ${branchPath} (group: ${branch.unix_group})`
    );

    await this.executor.execAll(
      UnixGroupCommands.setDirectoryGroup(branchPath, branch.unix_group, permissionMode)
    );

    // Set explicit user ACL for the daemon user so it can access branch files
    // even when its supplementary groups are stale (groups added after process
    // startup are not picked up by the running process)
    if (this.config.daemonUser) {
      await this.executor.execAll(UnixGroupCommands.setUserAcl(branchPath, this.config.daemonUser));
    }
  }

  /**
   * Initialize Unix group for an existing branch
   *
   * Creates group and adds all users with explicit filesystem access.
   *
   * @param branchId - Branch ID
   */
  async initializeBranchGroup(branchId: BranchID): Promise<void> {
    const groupName = await this.createBranchGroup(branchId);

    const userIds = await this.branchRepo.findExplicitFsAccessUserIds(branchId);
    for (const userId of userIds) {
      await this.addUserToBranchGroup(branchId, userId);
    }
    await this.reconcileUnixGroupMembers(groupName, await this.getUnixUsernamesForUsers(userIds), {
      label: 'branch',
    });

    console.log(
      `[UnixIntegration] Initialized group ${groupName} with ${userIds.length} explicit filesystem user(s)`
    );

    const branch = await this.branchRepo.findById(branchId);
    if (branch?.repo_id) {
      await this.syncRepo(branch.repo_id as RepoID);
    }
  }

  // ============================================================
  // REPO GROUP MANAGEMENT
  // ============================================================

  /**
   * Create a Unix group for a repo's .git directory
   *
   * The repo group controls access to the shared .git/ directory.
   * Users who have access to ANY branch in this repo get added to this group,
   * enabling git operations (commit, push, pull, etc).
   *
   * @param repoId - Repo ID
   * @returns Group name created
   */
  async createRepoGroup(repoId: RepoID): Promise<string> {
    const groupName = generateRepoGroupName(repoId);

    console.log(`[UnixIntegration] Creating repo group ${groupName} for repo ${shortId(repoId)}`);

    // Check if group already exists
    const exists = await this.executor.check(UnixGroupCommands.groupExists(groupName));
    if (exists) {
      console.log(`[UnixIntegration] Repo group ${groupName} already exists`);
    } else {
      await this.executor.exec(UnixGroupCommands.createGroup(groupName));
    }

    // Update repo record with group name
    await this.repoRepo.update(repoId, {
      unix_group: groupName,
    });

    // Apply group ownership and permissions to repo Unix-group-managed paths:
    // - repo root (non-recursive, traversal)
    // - `.git` (recursive, shared git objects/refs + branch metadata)
    const repo = await this.repoRepo.findById(repoId);
    if (repo?.local_path) {
      await this.setRepoPermissions(repoId, repo.local_path);
    }

    // Add the daemon user to the repo group so it can run git commands
    // The daemon needs access to .git for branch creation, fetching, etc.
    if (this.config.daemonUser) {
      await this.addUnixUserToRepoGroup(groupName, this.config.daemonUser);
    }

    return groupName;
  }

  /**
   * Add a Unix username directly to a repo group
   *
   * Used for adding the daemon user or other system users.
   *
   * @param groupName - Unix group name
   * @param unixUsername - Unix username to add
   */
  async addUnixUserToRepoGroup(groupName: string, unixUsername: string): Promise<void> {
    console.log(`[UnixIntegration] Adding Unix user ${unixUsername} to repo group ${groupName}`);

    // Check if already in group
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(unixUsername, groupName)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] User ${unixUsername} already in repo group ${groupName}`);
    } else {
      await this.executor.exec(UnixGroupCommands.addUserToGroup(unixUsername, groupName));
    }
  }

  /**
   * Delete a Unix group for a repo
   *
   * @param repoId - Repo ID
   */
  async deleteRepoGroup(repoId: RepoID): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(`[UnixIntegration] No Unix group for repo ${shortId(repoId)}`);
      return;
    }

    console.log(
      `[UnixIntegration] Deleting repo group ${repo.unix_group} for repo ${shortId(repoId)}`
    );

    // Check if group exists before deleting
    const exists = await this.executor.check(UnixGroupCommands.groupExists(repo.unix_group));
    if (exists) {
      await this.executor.exec(UnixGroupCommands.deleteGroup(repo.unix_group));
    }
  }

  /**
   * Set filesystem permissions for a repo directory
   *
   * Applies group ownership/ACLs to:
   * - repo root directory (non-recursive) for traversal
   * - `.git` directory (recursive) for shared git data and metadata
   *
   * @param repoId - Repo ID
   * @param repoPath - Absolute path to repo directory
   */
  async setRepoPermissions(repoId: RepoID, repoPath: string): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for repo ${shortId(repoId)}, skipping repo permissions`
      );
      return;
    }

    const gitPath = `${repoPath}/.git`;
    const gitExists = await this.executor.check(`[ -d "${gitPath}" ]`);

    console.log(
      `[UnixIntegration] Setting repo permissions ${REPO_GIT_PERMISSION_MODE} for ${repoPath}${gitExists ? ' and .git' : ''} (group: ${repo.unix_group})`
    );

    await this.executor.execAll(
      UnixGroupCommands.setDirectoryGroupShallow(
        repoPath,
        repo.unix_group,
        REPO_GIT_PERMISSION_MODE
      )
    );

    if (gitExists) {
      await this.executor.execAll(
        UnixGroupCommands.setDirectoryGroup(gitPath, repo.unix_group, REPO_GIT_PERMISSION_MODE)
      );
    }

    // Set explicit user ACL for the daemon user:
    // - repo root (shallow): traversal even with stale supplementary groups
    // - `.git` (recursive): git operations even with stale supplementary groups
    if (this.config.daemonUser) {
      await this.executor.execAll(
        UnixGroupCommands.setUserAclShallow(repoPath, this.config.daemonUser)
      );
      if (gitExists) {
        await this.executor.execAll(UnixGroupCommands.setUserAcl(gitPath, this.config.daemonUser));
      }
    }
  }

  /**
   * Fix permissions on a branch's .git/worktrees/<name>/ directory
   *
   * When git creates a branch, it creates a subdirectory in .git/worktrees/.
   * Due to umask, this directory may not have group write permission even though
   * setgid causes it to inherit the repo group. This method fixes those permissions.
   *
   * @param branchId - Branch ID
   */
  async fixBranchGitDirPermissions(branchId: BranchID): Promise<void> {
    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.repo_id) {
      console.log(
        `[UnixIntegration] Branch ${shortId(branchId)} has no repo, skipping .git/worktrees fix`
      );
      return;
    }

    const repo = await this.repoRepo.findById(branch.repo_id as RepoID);
    if (!repo?.unix_group || !repo?.local_path) {
      console.log(`[UnixIntegration] Repo has no Unix group or path, skipping .git/worktrees fix`);
      return;
    }

    // The branch's git dir is at .git/worktrees/<branch-name>/
    // Extract branch name from path (last component)
    const branchName = branch.path.split('/').pop();
    if (!branchName) {
      console.log(`[UnixIntegration] Could not determine branch name from path: ${branch.path}`);
      return;
    }

    const branchGitDir = `${repo.local_path}/.git/worktrees/${branchName}`;

    console.log(
      `[UnixIntegration] Setting .git/worktrees/${branchName} permissions ${REPO_GIT_PERMISSION_MODE} (group: ${repo.unix_group})`
    );

    await this.executor.execAll(
      UnixGroupCommands.setDirectoryGroup(branchGitDir, repo.unix_group, REPO_GIT_PERMISSION_MODE)
    );

    // Set explicit user ACL for the daemon user on .git/worktrees/<name>
    if (this.config.daemonUser) {
      await this.executor.execAll(
        UnixGroupCommands.setUserAcl(branchGitDir, this.config.daemonUser)
      );
    }
  }

  /**
   * Add a user to a repo's Unix group
   *
   * Called when a user gains access to any branch in the repo.
   *
   * @param repoId - Repo ID
   * @param userId - User ID to add
   */
  async addUserToRepoGroup(repoId: RepoID, userId: UUID): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(`[UnixIntegration] No Unix group for repo ${shortId(repoId)}, skipping user add`);
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${shortId(userId)} has no Unix username, skipping repo group add`
      );
      return;
    }

    console.log(
      `[UnixIntegration] Adding user ${user.unix_username} to repo group ${repo.unix_group}`
    );

    // Check if already in group
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(user.unix_username, repo.unix_group)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] User ${user.unix_username} already in repo group`);
    } else {
      await this.executor.exec(
        UnixGroupCommands.addUserToGroup(user.unix_username, repo.unix_group)
      );
    }
  }

  /**
   * Remove a user from a repo's Unix group
   *
   * Called when a user loses access to ALL branches in the repo.
   * Use shouldUserBeInRepoGroup() first to check if removal is appropriate.
   *
   * @param repoId - Repo ID
   * @param userId - User ID to remove
   */
  async removeUserFromRepoGroup(repoId: RepoID, userId: UUID): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for repo ${shortId(repoId)}, skipping user remove`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${shortId(userId)} has no Unix username, skipping repo group remove`
      );
      return;
    }

    console.log(
      `[UnixIntegration] Removing user ${user.unix_username} from repo group ${repo.unix_group}`
    );

    // Check if in group before removing
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(user.unix_username, repo.unix_group)
    );
    if (inGroup) {
      await this.executor.exec(
        UnixGroupCommands.removeUserFromGroup(user.unix_username, repo.unix_group)
      );
    }
  }

  /**
   * Check if a user should be in a repo's Unix group
   *
   * A user should be in the repo group if they have explicit filesystem access
   * to ANY branch in that repo.
   *
   * @param repoId - Repo ID
   * @param userId - User ID to check
   * @returns true if user should remain in the repo group
   */
  async shouldUserBeInRepoGroup(repoId: RepoID, userId: UUID): Promise<boolean> {
    // Get all branches for this repo
    const branches = await this.branchRepo.findAll({ repo_id: repoId });

    for (const wt of branches) {
      const userIds = await this.branchRepo.findExplicitFsAccessUserIds(wt.branch_id);
      if (userIds.includes(userId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Initialize Unix group for an existing repo
   *
   * Creates group, sets .git permissions, and adds all users who have explicit
   * filesystem access to any branch in the repo.
   *
   * @param repoId - Repo ID
   */
  async initializeRepoGroup(repoId: RepoID): Promise<void> {
    const groupName = await this.createRepoGroup(repoId);

    const branches = await this.branchRepo.findAll({ repo_id: repoId });
    const userIds = new Set<UUID>();

    for (const wt of branches) {
      const branchUserIds = await this.branchRepo.findExplicitFsAccessUserIds(wt.branch_id);
      for (const userId of branchUserIds) {
        userIds.add(userId);
      }
    }

    // Add each unique filesystem-access user to the repo group
    for (const userId of userIds) {
      await this.addUserToRepoGroup(repoId, userId);
    }
    await this.reconcileUnixGroupMembers(groupName, await this.getUnixUsernamesForUsers(userIds), {
      label: 'repo',
    });

    console.log(
      `[UnixIntegration] Initialized repo group ${groupName} with ${userIds.size} unique filesystem user(s)`
    );
  }

  /**
   * Full sync for a repo
   *
   * Ensures repo group exists, .git permissions are set, and all
   * branch filesystem-access users are in the repo group.
   *
   * @param repoId - Repo ID
   */
  async syncRepo(repoId: RepoID): Promise<void> {
    console.log(`[UnixIntegration] Full sync for repo ${shortId(repoId)}`);

    // Ensure repo group exists and .git permissions are set
    await this.createRepoGroup(repoId);

    const branches = await this.branchRepo.findAll({ repo_id: repoId });
    const userIds = new Set<UUID>();

    for (const wt of branches) {
      const branchUserIds = await this.branchRepo.findExplicitFsAccessUserIds(wt.branch_id);
      for (const userId of branchUserIds) {
        userIds.add(userId);
      }
    }

    // Add each unique filesystem-access user to repo group
    for (const userId of userIds) {
      await this.addUserToRepoGroup(repoId, userId);
    }
    const repo = await this.repoRepo.findById(repoId);
    if (repo?.unix_group) {
      await this.reconcileUnixGroupMembers(
        repo.unix_group,
        await this.getUnixUsernamesForUsers(userIds),
        { label: 'repo' }
      );
    }
  }

  // ============================================================
  // UNIX USER MANAGEMENT
  // ============================================================

  /**
   * Ensure a Unix user exists for an Agor user
   *
   * Creates the Unix user if it doesn't exist.
   * Also sets up the ~/agor/worktrees directory.
   *
   * @param userId - Agor user ID
   * @returns Unix username (existing or newly created)
   */
  async ensureUnixUser(userId: UserID): Promise<string> {
    const user = await this.usersRepo.findById(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // If user already has a unix_username, ensure it exists on the system
    let unixUsername = user.unix_username;

    if (!unixUsername) {
      // Generate a default username
      unixUsername = generateUnixUsername(userId);
      console.log(
        `[UnixIntegration] Generated Unix username: ${unixUsername} for user ${shortId(userId)}`
      );
    }

    // Validate username format
    if (!isValidUnixUsername(unixUsername)) {
      throw new Error(`Invalid Unix username format: ${unixUsername}`);
    }

    // Check if Unix user exists
    const exists = await this.executor.check(UnixUserCommands.userExists(unixUsername));

    if (!exists) {
      console.log(`[UnixIntegration] Creating Unix user: ${unixUsername}`);
      // Pass homeBase to ensure home directory is created in the configured location
      await this.executor.exec(
        UnixUserCommands.createUser(unixUsername, AGOR_DEFAULT_SHELL, this.config.homeBase)
      );

      // Setup ~/agor/worktrees directory
      await this.executor.execAll(
        UnixUserCommands.setupBranchesDir(unixUsername, this.config.homeBase)
      );
    } else {
      console.log(`[UnixIntegration] Unix user ${unixUsername} already exists`);

      // Ensure ~/agor/worktrees exists
      const branchesDir = getUserBranchesDir(unixUsername, this.config.homeBase);
      const dirExists = await this.executor.check(SymlinkCommands.pathExists(branchesDir));
      if (!dirExists) {
        await this.executor.execAll(
          UnixUserCommands.setupBranchesDir(unixUsername, this.config.homeBase)
        );
      }
    }

    // Update Agor user record if username was generated
    if (!user.unix_username) {
      await this.usersRepo.update(userId, { unix_username: unixUsername });
    }

    // Add user to agor_users group (enables impersonation)
    await this.addUserToAgorUsersGroup(unixUsername);

    // Prepare user's home directory with default configs
    await this.prepareUserHome(unixUsername);

    return unixUsername;
  }

  /**
   * Sync user password to Unix (if enabled in config)
   *
   * SECURITY: Password is passed via stdin to chpasswd, NOT as command-line argument.
   * This prevents command injection and password exposure in process listings.
   *
   * Only syncs when:
   * - Unix integration is enabled
   * - sync_unix_passwords config is true (default)
   * - User has a unix_username set
   *
   * @param userId - User ID
   * @param plaintextPassword - Plaintext password to sync
   */
  async syncPassword(userId: UserID, plaintextPassword: string): Promise<void> {
    if (!this.isEnabled()) {
      return; // Unix integration disabled
    }

    // Check if password sync is enabled (default: true)
    const { loadConfig } = await import('../config/config-manager.js');
    const config = await loadConfig();
    const syncEnabled = config.execution?.sync_unix_passwords ?? true;

    if (!syncEnabled) {
      return; // Password sync disabled via config
    }

    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      return; // No unix username set
    }

    try {
      // SECURITY: Use execWithInput to pass password via stdin, not command line
      const cmd = UnixUserCommands.setPasswordCommand();
      const input = UnixUserCommands.formatPasswordInput(user.unix_username, plaintextPassword);
      await this.executor.execWithInput(cmd, { input });
      console.log(`[UnixIntegration] Synced password for ${user.unix_username}`);
    } catch (error) {
      console.error(`[UnixIntegration] Failed to sync password for ${user.unix_username}:`, error);
      throw error;
    }
  }

  /**
   * Prepare a user's home directory with Agor default configurations
   *
   * Sets up:
   * - ~/.config/zellij/config.kdl - Zellij config optimized for xterm.js embedding
   *
   * @param unixUsername - Unix username
   */
  async prepareUserHome(unixUsername: string): Promise<void> {
    const homeDir = getUserHomeDir(unixUsername, this.config.homeBase);
    const zellijConfigDir = `${homeDir}/.config/zellij`;
    const zellijConfigPath = `${zellijConfigDir}/config.kdl`;

    // Check if config already exists - don't overwrite user customizations
    const configExists = await this.executor.check(SymlinkCommands.pathExists(zellijConfigPath));
    if (configExists) {
      console.log(`[UnixIntegration] Zellij config already exists for ${unixUsername}, skipping`);
      return;
    }

    console.log(`[UnixIntegration] Preparing home directory for ${unixUsername}`);

    // Create ~/.config/zellij directory with proper ownership
    await this.executor.execAll(
      UnixUserCommands.createOwnedDirectory(zellijConfigDir, unixUsername, unixUsername, '755')
    );

    // Write Zellij config file
    // Use tee with stdin to write the file content, avoiding shell escaping issues
    // The execWithInput method passes data via stdin (safe from command injection)
    await this.executor.execWithInput(['tee', zellijConfigPath], {
      input: AGOR_ZELLIJ_CONFIG,
    });
    // Set ownership and permissions
    await this.executor.execAll([
      `chown "${unixUsername}:${unixUsername}" "${zellijConfigPath}"`,
      `chmod 644 "${zellijConfigPath}"`,
    ]);

    console.log(`[UnixIntegration] Created Zellij config at ${zellijConfigPath}`);
  }

  /**
   * Delete a Unix user
   *
   * @param userId - Agor user ID
   * @param deleteHome - Also delete home directory (default: false)
   */
  async deleteUnixUser(userId: UserID, deleteHome: boolean = false): Promise<void> {
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      console.log(`[UnixIntegration] User ${shortId(userId)} has no Unix username`);
      return;
    }

    const exists = await this.executor.check(UnixUserCommands.userExists(user.unix_username));
    if (!exists) {
      console.log(`[UnixIntegration] Unix user ${user.unix_username} does not exist`);
      return;
    }

    console.log(
      `[UnixIntegration] Deleting Unix user: ${user.unix_username} (deleteHome: ${deleteHome})`
    );

    // Remove from agor_users group first
    await this.removeUserFromAgorUsersGroup(user.unix_username);

    if (deleteHome) {
      await this.executor.exec(UnixUserCommands.deleteUserWithHome(user.unix_username));
    } else {
      await this.executor.exec(UnixUserCommands.deleteUser(user.unix_username));
    }
  }

  /**
   * Lock a Unix user account (disable login)
   *
   * @param userId - Agor user ID
   */
  async lockUnixUser(userId: UserID): Promise<void> {
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      return;
    }

    console.log(`[UnixIntegration] Locking Unix user: ${user.unix_username}`);
    await this.executor.exec(UnixUserCommands.lockUser(user.unix_username));
  }

  /**
   * Unlock a Unix user account
   *
   * @param userId - Agor user ID
   */
  async unlockUnixUser(userId: UserID): Promise<void> {
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      return;
    }

    console.log(`[UnixIntegration] Unlocking Unix user: ${user.unix_username}`);
    await this.executor.exec(UnixUserCommands.unlockUser(user.unix_username));
  }

  // ============================================================
  // SYMLINK MANAGEMENT
  // ============================================================

  /**
   * Create a symlink for a branch in a user's home directory
   *
   * @param userId - User ID
   * @param branchId - Branch ID
   */
  async createBranchSymlink(userId: UUID, branchId: BranchID): Promise<void> {
    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${shortId(userId)} has no Unix username, skipping symlink`
      );
      return;
    }

    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.path || !branch.name) {
      console.log(
        `[UnixIntegration] Branch ${shortId(branchId)} has no path/name, skipping symlink`
      );
      return;
    }

    const linkPath = getBranchSymlinkPath(user.unix_username, branch.name, this.config.homeBase);

    console.log(`[UnixIntegration] Creating symlink: ${linkPath} -> ${branch.path}`);

    await this.executor.execAll(
      SymlinkCommands.createSymlinkWithOwnership(branch.path, linkPath, user.unix_username)
    );
  }

  /**
   * Remove a symlink for a branch from a user's home directory
   *
   * @param userId - User ID
   * @param branchId - Branch ID
   */
  async removeBranchSymlink(userId: UUID, branchId: BranchID): Promise<void> {
    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      return;
    }

    const branch = await this.branchRepo.findById(branchId);
    if (!branch?.name) {
      return;
    }

    const linkPath = getBranchSymlinkPath(user.unix_username, branch.name, this.config.homeBase);

    console.log(`[UnixIntegration] Removing symlink: ${linkPath}`);

    await this.executor.exec(SymlinkCommands.removeSymlink(linkPath));
  }

  /**
   * Sync all symlinks for a user based on their branch ownership
   *
   * Removes stale symlinks and creates missing ones.
   *
   * @param userId - User ID
   */
  async syncUserSymlinks(userId: UserID): Promise<void> {
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      console.log(`[UnixIntegration] User ${shortId(userId)} has no Unix username`);
      return;
    }

    console.log(`[UnixIntegration] Syncing symlinks for user: ${user.unix_username}`);

    const branchesDir = getUserBranchesDir(user.unix_username, this.config.homeBase);

    // Get all branches the user owns
    const allBranches = await this.branchRepo.findAll();
    const ownedBranchIds = new Set<string>();

    for (const wt of allBranches) {
      const isOwner = await this.branchRepo.isOwner(wt.branch_id, userId);
      if (isOwner) {
        ownedBranchIds.add(wt.branch_id);
      }
    }

    // Remove broken symlinks
    await this.executor.exec(SymlinkCommands.removeBrokenSymlinks(branchesDir));

    // Create symlinks for owned branches
    for (const branchId of ownedBranchIds) {
      await this.createBranchSymlink(userId, branchId as BranchID);
    }

    console.log(
      `[UnixIntegration] Synced ${ownedBranchIds.size} symlinks for ${user.unix_username}`
    );
  }

  /**
   * Sync all symlinks for a branch (for all owners)
   *
   * @param branchId - Branch ID
   */
  async syncBranchSymlinks(branchId: BranchID): Promise<void> {
    const ownerIds = await this.branchRepo.getOwners(branchId);

    console.log(
      `[UnixIntegration] Syncing symlinks for branch ${shortId(branchId)} (${ownerIds.length} owners)`
    );

    for (const ownerId of ownerIds) {
      await this.createBranchSymlink(ownerId, branchId);
    }
  }

  // ============================================================
  // BULK / SYNC OPERATIONS
  // ============================================================

  /**
   * Full sync for a branch
   *
   * Ensures group exists, all explicit filesystem-access users are in group,
   * and symlinks are created.
   *
   * @param branchId - Branch ID
   */
  async syncBranch(branchId: BranchID): Promise<void> {
    console.log(`[UnixIntegration] Full sync for branch ${shortId(branchId)}`);

    // Ensure group exists and permissions are set
    // Note: createBranchGroup() handles setting directory permissions internally
    await this.createBranchGroup(branchId);

    // Add all explicit filesystem-access users to group and create symlinks
    const userIds = await this.branchRepo.findExplicitFsAccessUserIds(branchId);
    for (const userId of userIds) {
      await this.addUserToBranchGroup(branchId, userId);
    }
    const branch = await this.branchRepo.findById(branchId);
    if (branch?.unix_group) {
      await this.reconcileUnixGroupMembers(
        branch.unix_group,
        await this.getUnixUsernamesForUsers(userIds),
        { label: 'branch' }
      );
    }
    if (branch?.repo_id) {
      await this.syncRepo(branch.repo_id as RepoID);
    }
  }

  /**
   * Full sync for a user
   *
   * Ensures Unix user exists, syncs all branch symlinks.
   *
   * @param userId - User ID
   */
  async syncUser(userId: UserID): Promise<void> {
    console.log(`[UnixIntegration] Full sync for user ${shortId(userId)}`);

    // Ensure Unix user exists
    await this.ensureUnixUser(userId);

    // Sync symlinks
    await this.syncUserSymlinks(userId);
  }

  /**
   * Sync everything
   *
   * Full system sync - use with caution on large installations.
   */
  async syncAll(): Promise<void> {
    console.log('[UnixIntegration] Starting full system sync...');

    // Sync all repos first (creates repo groups and sets .git permissions)
    const repos = await this.repoRepo.findAll();
    for (const repo of repos) {
      try {
        await this.syncRepo(repo.repo_id as RepoID);
      } catch (error) {
        console.error(`[UnixIntegration] Failed to sync repo ${repo.repo_id}:`, error);
      }
    }

    // Sync all branches
    const branches = await this.branchRepo.findAll();
    for (const wt of branches) {
      try {
        await this.syncBranch(wt.branch_id);
      } catch (error) {
        console.error(`[UnixIntegration] Failed to sync branch ${wt.branch_id}:`, error);
      }
    }

    console.log(
      `[UnixIntegration] Full sync complete. Synced ${repos.length} repos and ${branches.length} branches.`
    );
  }
}
