/**
 * Unix Integration Service
 *
 * Central controller for all Unix-level operations in Agor:
 * - Unix group management for worktree isolation
 * - Unix group management for repo .git/ access
 * - Unix user creation/management
 * - Symlink management in user home directories
 *
 * This service can be used by both the daemon and CLI.
 * The CommandExecutor determines how privileged commands are executed.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { Database } from '../db/index.js';
import { RepoRepository, UsersRepository, WorktreeRepository } from '../db/repositories/index.js';
import type { RepoID, UserID, UUID, WorktreeID } from '../types/index.js';
import type { CommandExecutor } from './command-executor.js';
import { NoOpExecutor } from './command-executor.js';
import {
  AGOR_USERS_GROUP,
  generateRepoGroupName,
  generateWorktreeGroupName,
  getWorktreePermissionMode,
  REPO_GIT_PERMISSION_MODE,
  UnixGroupCommands,
} from './group-manager.js';
import { getWorktreeSymlinkPath, SymlinkCommands } from './symlink-manager.js';
import {
  AGOR_DEFAULT_SHELL,
  AGOR_HOME_BASE,
  generateUnixUsername,
  getUserHomeDir,
  getUserWorktreesDir,
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
  private worktreeRepo: WorktreeRepository;
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
    this.worktreeRepo = new WorktreeRepository(db);
    this.usersRepo = new UsersRepository(db);
    this.repoRepo = new RepoRepository(db);
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
  // WORKTREE GROUP MANAGEMENT
  // ============================================================

  /**
   * Create a Unix group for a worktree
   *
   * @param worktreeId - Worktree ID
   * @returns Group name created
   */
  async createWorktreeGroup(worktreeId: WorktreeID): Promise<string> {
    const groupName = generateWorktreeGroupName(worktreeId);

    console.log(
      `[UnixIntegration] Creating group ${groupName} for worktree ${worktreeId.substring(0, 8)}`
    );

    // Check if group already exists
    const exists = await this.executor.check(UnixGroupCommands.groupExists(groupName));
    if (exists) {
      console.log(`[UnixIntegration] Group ${groupName} already exists`);
    } else {
      await this.executor.exec(UnixGroupCommands.createGroup(groupName));
    }

    // Update worktree record with group name
    await this.worktreeRepo.update(worktreeId, {
      unix_group: groupName,
    });

    // Apply group ownership and permissions to worktree directory
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (worktree?.path) {
      await this.setWorktreePermissions(worktreeId, worktree.path);
    }

    // Add the daemon user to the worktree group so it can access the worktree
    if (this.config.daemonUser) {
      await this.addUnixUserToWorktreeGroup(groupName, this.config.daemonUser);
    }

    return groupName;
  }

  /**
   * Add a Unix username directly to a worktree group
   *
   * Used for adding the daemon user or other system users.
   *
   * @param groupName - Unix group name
   * @param unixUsername - Unix username to add
   */
  async addUnixUserToWorktreeGroup(groupName: string, unixUsername: string): Promise<void> {
    console.log(
      `[UnixIntegration] Adding Unix user ${unixUsername} to worktree group ${groupName}`
    );

    // Check if already in group
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(unixUsername, groupName)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] User ${unixUsername} already in worktree group ${groupName}`);
    } else {
      await this.executor.exec(UnixGroupCommands.addUserToGroup(unixUsername, groupName));
    }
  }

  /**
   * Delete a Unix group for a worktree
   *
   * @param worktreeId - Worktree ID
   */
  async deleteWorktreeGroup(worktreeId: WorktreeID): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(`[UnixIntegration] No Unix group for worktree ${worktreeId.substring(0, 8)}`);
      return;
    }

    console.log(
      `[UnixIntegration] Deleting group ${worktree.unix_group} for worktree ${worktreeId.substring(0, 8)}`
    );

    // Check if group exists before deleting
    const exists = await this.executor.check(UnixGroupCommands.groupExists(worktree.unix_group));
    if (exists) {
      await this.executor.exec(UnixGroupCommands.deleteGroup(worktree.unix_group));
    }
  }

  /**
   * Add a user to a worktree's Unix group
   *
   * @param worktreeId - Worktree ID
   * @param userId - User ID to add
   */
  async addUserToWorktreeGroup(worktreeId: WorktreeID, userId: UUID): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for worktree ${worktreeId.substring(0, 8)}, skipping user add`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username, skipping group add`
      );
      return;
    }

    console.log(
      `[UnixIntegration] Adding user ${user.unix_username} to group ${worktree.unix_group}`
    );

    // Check if already in group
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(user.unix_username, worktree.unix_group)
    );
    if (inGroup) {
      console.log(`[UnixIntegration] User ${user.unix_username} already in group`);
    } else {
      await this.executor.exec(
        UnixGroupCommands.addUserToGroup(user.unix_username, worktree.unix_group)
      );
    }

    // Also create symlink if auto-manage is enabled
    if (this.config.autoManageSymlinks && worktree.path) {
      await this.createWorktreeSymlink(userId, worktreeId);
    }
  }

  /**
   * Remove a user from a worktree's Unix group
   *
   * @param worktreeId - Worktree ID
   * @param userId - User ID to remove
   */
  async removeUserFromWorktreeGroup(worktreeId: WorktreeID, userId: UUID): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for worktree ${worktreeId.substring(0, 8)}, skipping user remove`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username, skipping group remove`
      );
      return;
    }

    console.log(
      `[UnixIntegration] Removing user ${user.unix_username} from group ${worktree.unix_group}`
    );

    // Check if in group before removing
    const inGroup = await this.executor.check(
      UnixGroupCommands.isUserInGroup(user.unix_username, worktree.unix_group)
    );
    if (inGroup) {
      await this.executor.exec(
        UnixGroupCommands.removeUserFromGroup(user.unix_username, worktree.unix_group)
      );
    }

    // Also remove symlink if auto-manage is enabled
    if (this.config.autoManageSymlinks) {
      await this.removeWorktreeSymlink(userId, worktreeId);
    }
  }

  /**
   * Set filesystem permissions for a worktree directory
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Absolute path to worktree directory
   */
  async setWorktreePermissions(worktreeId: WorktreeID, worktreePath: string): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for worktree ${worktreeId.substring(0, 8)}, skipping permissions`
      );
      return;
    }

    const permissionMode = getWorktreePermissionMode(worktree.others_fs_access || 'read');

    console.log(
      `[UnixIntegration] Setting permissions ${permissionMode} for ${worktreePath} (group: ${worktree.unix_group})`
    );

    await this.executor.execAll(
      UnixGroupCommands.setDirectoryGroup(worktreePath, worktree.unix_group, permissionMode)
    );
  }

  /**
   * Initialize Unix group for an existing worktree
   *
   * Creates group and adds all current owners.
   *
   * @param worktreeId - Worktree ID
   */
  async initializeWorktreeGroup(worktreeId: WorktreeID): Promise<void> {
    const groupName = await this.createWorktreeGroup(worktreeId);

    const ownerIds = await this.worktreeRepo.getOwners(worktreeId);
    for (const ownerId of ownerIds) {
      await this.addUserToWorktreeGroup(worktreeId, ownerId);
    }

    console.log(
      `[UnixIntegration] Initialized group ${groupName} with ${ownerIds.length} owner(s)`
    );
  }

  // ============================================================
  // REPO GROUP MANAGEMENT
  // ============================================================

  /**
   * Create a Unix group for a repo's .git directory
   *
   * The repo group controls access to the shared .git/ directory.
   * Users who have access to ANY worktree in this repo get added to this group,
   * enabling git operations (commit, push, pull, etc).
   *
   * @param repoId - Repo ID
   * @returns Group name created
   */
  async createRepoGroup(repoId: RepoID): Promise<string> {
    const groupName = generateRepoGroupName(repoId);

    console.log(
      `[UnixIntegration] Creating repo group ${groupName} for repo ${repoId.substring(0, 8)}`
    );

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

    // Apply group ownership and permissions to .git directory
    const repo = await this.repoRepo.findById(repoId);
    if (repo?.local_path) {
      await this.setRepoGitPermissions(repoId, repo.local_path);
    }

    // Add the daemon user to the repo group so it can run git commands
    // The daemon needs access to .git for worktree creation, fetching, etc.
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
      console.log(`[UnixIntegration] No Unix group for repo ${repoId.substring(0, 8)}`);
      return;
    }

    console.log(
      `[UnixIntegration] Deleting repo group ${repo.unix_group} for repo ${repoId.substring(0, 8)}`
    );

    // Check if group exists before deleting
    const exists = await this.executor.check(UnixGroupCommands.groupExists(repo.unix_group));
    if (exists) {
      await this.executor.exec(UnixGroupCommands.deleteGroup(repo.unix_group));
    }
  }

  /**
   * Set filesystem permissions for a repo's .git directory
   *
   * Applies group ownership and setgid permissions to ensure
   * new git objects inherit the correct group.
   *
   * @param repoId - Repo ID
   * @param repoPath - Absolute path to repo directory
   */
  async setRepoGitPermissions(repoId: RepoID, repoPath: string): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for repo ${repoId.substring(0, 8)}, skipping .git permissions`
      );
      return;
    }

    const gitPath = `${repoPath}/.git`;

    console.log(
      `[UnixIntegration] Setting .git permissions ${REPO_GIT_PERMISSION_MODE} for ${gitPath} (group: ${repo.unix_group})`
    );

    await this.executor.execAll(
      UnixGroupCommands.setDirectoryGroup(gitPath, repo.unix_group, REPO_GIT_PERMISSION_MODE)
    );
  }

  /**
   * Add a user to a repo's Unix group
   *
   * Called when a user gains access to any worktree in the repo.
   *
   * @param repoId - Repo ID
   * @param userId - User ID to add
   */
  async addUserToRepoGroup(repoId: RepoID, userId: UUID): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for repo ${repoId.substring(0, 8)}, skipping user add`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username, skipping repo group add`
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
   * Called when a user loses access to ALL worktrees in the repo.
   * Use shouldUserBeInRepoGroup() first to check if removal is appropriate.
   *
   * @param repoId - Repo ID
   * @param userId - User ID to remove
   */
  async removeUserFromRepoGroup(repoId: RepoID, userId: UUID): Promise<void> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo?.unix_group) {
      console.log(
        `[UnixIntegration] No Unix group for repo ${repoId.substring(0, 8)}, skipping user remove`
      );
      return;
    }

    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username, skipping repo group remove`
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
   * A user should be in the repo group if they have ownership
   * of ANY worktree in that repo.
   *
   * @param repoId - Repo ID
   * @param userId - User ID to check
   * @returns true if user should remain in the repo group
   */
  async shouldUserBeInRepoGroup(repoId: RepoID, userId: UUID): Promise<boolean> {
    // Get all worktrees for this repo
    const worktrees = await this.worktreeRepo.findAll({ repo_id: repoId });

    // Check if user is owner of any worktree in this repo
    for (const wt of worktrees) {
      const isOwner = await this.worktreeRepo.isOwner(wt.worktree_id, userId as UserID);
      if (isOwner) {
        return true;
      }
    }

    return false;
  }

  /**
   * Initialize Unix group for an existing repo
   *
   * Creates group, sets .git permissions, and adds all users who
   * own any worktree in the repo.
   *
   * @param repoId - Repo ID
   */
  async initializeRepoGroup(repoId: RepoID): Promise<void> {
    const groupName = await this.createRepoGroup(repoId);

    // Find all unique owners across all worktrees in this repo
    const worktrees = await this.worktreeRepo.findAll({ repo_id: repoId });
    const ownerIds = new Set<string>();

    for (const wt of worktrees) {
      const wtOwners = await this.worktreeRepo.getOwners(wt.worktree_id);
      for (const ownerId of wtOwners) {
        ownerIds.add(ownerId);
      }
    }

    // Add each unique owner to the repo group
    for (const ownerId of ownerIds) {
      await this.addUserToRepoGroup(repoId, ownerId as UUID);
    }

    console.log(
      `[UnixIntegration] Initialized repo group ${groupName} with ${ownerIds.size} unique owner(s)`
    );
  }

  /**
   * Full sync for a repo
   *
   * Ensures repo group exists, .git permissions are set, and all
   * worktree owners are in the repo group.
   *
   * @param repoId - Repo ID
   */
  async syncRepo(repoId: RepoID): Promise<void> {
    console.log(`[UnixIntegration] Full sync for repo ${repoId.substring(0, 8)}`);

    // Ensure repo group exists and .git permissions are set
    await this.createRepoGroup(repoId);

    // Get all unique owners across all worktrees
    const worktrees = await this.worktreeRepo.findAll({ repo_id: repoId });
    const ownerIds = new Set<string>();

    for (const wt of worktrees) {
      const wtOwners = await this.worktreeRepo.getOwners(wt.worktree_id);
      for (const ownerId of wtOwners) {
        ownerIds.add(ownerId);
      }
    }

    // Add each unique owner to repo group
    for (const ownerId of ownerIds) {
      await this.addUserToRepoGroup(repoId, ownerId as UUID);
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
        `[UnixIntegration] Generated Unix username: ${unixUsername} for user ${userId.substring(0, 8)}`
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
        UnixUserCommands.setupWorktreesDir(unixUsername, this.config.homeBase)
      );
    } else {
      console.log(`[UnixIntegration] Unix user ${unixUsername} already exists`);

      // Ensure ~/agor/worktrees exists
      const worktreesDir = getUserWorktreesDir(unixUsername, this.config.homeBase);
      const dirExists = await this.executor.check(SymlinkCommands.pathExists(worktreesDir));
      if (!dirExists) {
        await this.executor.execAll(
          UnixUserCommands.setupWorktreesDir(unixUsername, this.config.homeBase)
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
      console.log(`[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username`);
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
   * Create a symlink for a worktree in a user's home directory
   *
   * @param userId - User ID
   * @param worktreeId - Worktree ID
   */
  async createWorktreeSymlink(userId: UUID, worktreeId: WorktreeID): Promise<void> {
    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      console.log(
        `[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username, skipping symlink`
      );
      return;
    }

    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.path || !worktree.name) {
      console.log(
        `[UnixIntegration] Worktree ${worktreeId.substring(0, 8)} has no path/name, skipping symlink`
      );
      return;
    }

    const linkPath = getWorktreeSymlinkPath(
      user.unix_username,
      worktree.name,
      this.config.homeBase
    );

    console.log(`[UnixIntegration] Creating symlink: ${linkPath} -> ${worktree.path}`);

    await this.executor.execAll(
      SymlinkCommands.createSymlinkWithOwnership(worktree.path, linkPath, user.unix_username)
    );
  }

  /**
   * Remove a symlink for a worktree from a user's home directory
   *
   * @param userId - User ID
   * @param worktreeId - Worktree ID
   */
  async removeWorktreeSymlink(userId: UUID, worktreeId: WorktreeID): Promise<void> {
    const user = await this.usersRepo.findById(userId as UserID);
    if (!user?.unix_username) {
      return;
    }

    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.name) {
      return;
    }

    const linkPath = getWorktreeSymlinkPath(
      user.unix_username,
      worktree.name,
      this.config.homeBase
    );

    console.log(`[UnixIntegration] Removing symlink: ${linkPath}`);

    await this.executor.exec(SymlinkCommands.removeSymlink(linkPath));
  }

  /**
   * Sync all symlinks for a user based on their worktree ownership
   *
   * Removes stale symlinks and creates missing ones.
   *
   * @param userId - User ID
   */
  async syncUserSymlinks(userId: UserID): Promise<void> {
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      console.log(`[UnixIntegration] User ${userId.substring(0, 8)} has no Unix username`);
      return;
    }

    console.log(`[UnixIntegration] Syncing symlinks for user: ${user.unix_username}`);

    const worktreesDir = getUserWorktreesDir(user.unix_username, this.config.homeBase);

    // Get all worktrees the user owns
    const allWorktrees = await this.worktreeRepo.findAll();
    const ownedWorktreeIds = new Set<string>();

    for (const wt of allWorktrees) {
      const isOwner = await this.worktreeRepo.isOwner(wt.worktree_id, userId);
      if (isOwner) {
        ownedWorktreeIds.add(wt.worktree_id);
      }
    }

    // Remove broken symlinks
    await this.executor.exec(SymlinkCommands.removeBrokenSymlinks(worktreesDir));

    // Create symlinks for owned worktrees
    for (const worktreeId of ownedWorktreeIds) {
      await this.createWorktreeSymlink(userId, worktreeId as WorktreeID);
    }

    console.log(
      `[UnixIntegration] Synced ${ownedWorktreeIds.size} symlinks for ${user.unix_username}`
    );
  }

  /**
   * Sync all symlinks for a worktree (for all owners)
   *
   * @param worktreeId - Worktree ID
   */
  async syncWorktreeSymlinks(worktreeId: WorktreeID): Promise<void> {
    const ownerIds = await this.worktreeRepo.getOwners(worktreeId);

    console.log(
      `[UnixIntegration] Syncing symlinks for worktree ${worktreeId.substring(0, 8)} (${ownerIds.length} owners)`
    );

    for (const ownerId of ownerIds) {
      await this.createWorktreeSymlink(ownerId, worktreeId);
    }
  }

  // ============================================================
  // BULK / SYNC OPERATIONS
  // ============================================================

  /**
   * Full sync for a worktree
   *
   * Ensures group exists, all owners are in group, and symlinks are created.
   *
   * @param worktreeId - Worktree ID
   */
  async syncWorktree(worktreeId: WorktreeID): Promise<void> {
    console.log(`[UnixIntegration] Full sync for worktree ${worktreeId.substring(0, 8)}`);

    // Ensure group exists and permissions are set
    // Note: createWorktreeGroup() handles setting directory permissions internally
    await this.createWorktreeGroup(worktreeId);

    // Add all owners to group and create symlinks
    const ownerIds = await this.worktreeRepo.getOwners(worktreeId);
    for (const ownerId of ownerIds) {
      await this.addUserToWorktreeGroup(worktreeId, ownerId);
    }
  }

  /**
   * Full sync for a user
   *
   * Ensures Unix user exists, syncs all worktree symlinks.
   *
   * @param userId - User ID
   */
  async syncUser(userId: UserID): Promise<void> {
    console.log(`[UnixIntegration] Full sync for user ${userId.substring(0, 8)}`);

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

    // Sync all worktrees
    const worktrees = await this.worktreeRepo.findAll();
    for (const wt of worktrees) {
      try {
        await this.syncWorktree(wt.worktree_id);
      } catch (error) {
        console.error(`[UnixIntegration] Failed to sync worktree ${wt.worktree_id}:`, error);
      }
    }

    console.log(
      `[UnixIntegration] Full sync complete. Synced ${repos.length} repos and ${worktrees.length} worktrees.`
    );
  }
}
