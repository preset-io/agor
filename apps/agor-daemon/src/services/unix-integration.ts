/**
 * Unix Integration Service
 *
 * Orchestrates Unix-level operations for worktree isolation:
 * - Creates/deletes Unix groups for worktrees
 * - Adds/removes users from groups when ownership changes
 * - Sets filesystem permissions based on RBAC settings
 *
 * Security: All privileged operations are executed via `sudo agor admin <command>`
 * to maintain clean separation between daemon and root privileges.
 *
 * @see context/explorations/unix-user-modes.md
 * @see context/explorations/rbac.md
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database } from '@agor/core/db';
import { UsersRepository, WorktreeRepository } from '@agor/core/db';
import type { UUID, WorktreeID } from '@agor/core/types';
import { generateWorktreeGroupName, getWorktreePermissionMode } from '@agor/core/unix';

const execAsync = promisify(exec);

/**
 * Unix integration configuration
 */
export interface UnixIntegrationConfig {
  /** Enable Unix user modes (default: false) */
  enabled: boolean;

  /** Path to agor CLI binary (default: 'agor') */
  cliPath?: string;

  /** Use sudo for admin commands (default: true) */
  useSudo?: boolean;
}

/**
 * Unix Integration Service
 *
 * Handles lifecycle hooks for worktree Unix groups and user management.
 */
export class UnixIntegrationService {
  private config: UnixIntegrationConfig;
  private worktreeRepo: WorktreeRepository;
  private usersRepo: UsersRepository;

  constructor(db: Database, config: UnixIntegrationConfig = { enabled: false }) {
    this.config = {
      cliPath: 'agor',
      useSudo: true,
      ...config,
    };
    this.worktreeRepo = new WorktreeRepository(db);
    this.usersRepo = new UsersRepository(db);
  }

  /**
   * Check if Unix integration is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Execute an admin command via sudo
   *
   * @param command - Admin command to execute (e.g., 'create-worktree-group')
   * @param args - Command arguments
   * @returns Command output
   */
  private async execAdminCommand(command: string, args: string[]): Promise<string> {
    if (!this.config.enabled) {
      console.log(
        `[Unix Integration] Skipping admin command (disabled): ${command} ${args.join(' ')}`
      );
      return '';
    }

    const cliPath = this.config.cliPath || 'agor';
    const sudo = this.config.useSudo ? 'sudo' : '';
    const fullCommand = `${sudo} ${cliPath} admin ${command} ${args.join(' ')}`.trim();

    console.log(`[Unix Integration] Executing: ${fullCommand}`);

    try {
      const { stdout, stderr } = await execAsync(fullCommand);
      if (stderr) {
        console.warn(`[Unix Integration] stderr: ${stderr}`);
      }
      return stdout;
      // biome-ignore lint/suspicious/noExplicitAny: Error type from exec can be any
    } catch (error: any) {
      console.error(`[Unix Integration] Command failed: ${fullCommand}`, error);
      throw new Error(`Admin command failed: ${error.message}`);
    }
  }

  /**
   * Create a Unix group for a worktree
   *
   * Called when a worktree is created.
   *
   * @param worktreeId - Worktree ID
   * @returns Group name created
   */
  async createWorktreeGroup(worktreeId: WorktreeID): Promise<string> {
    const groupName = generateWorktreeGroupName(worktreeId);

    console.log(
      `[Unix Integration] Creating group ${groupName} for worktree ${worktreeId.substring(0, 8)}`
    );

    await this.execAdminCommand('create-worktree-group', ['--worktree-id', worktreeId]);

    // Update worktree record with group name
    await this.worktreeRepo.update(worktreeId, {
      unix_group: groupName,
    });

    return groupName;
  }

  /**
   * Delete a Unix group for a worktree
   *
   * Called when a worktree is permanently deleted.
   *
   * @param worktreeId - Worktree ID
   */
  async deleteWorktreeGroup(worktreeId: WorktreeID): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(`[Unix Integration] No Unix group for worktree ${worktreeId.substring(0, 8)}`);
      return;
    }

    console.log(
      `[Unix Integration] Deleting group ${worktree.unix_group} for worktree ${worktreeId.substring(0, 8)}`
    );

    await this.execAdminCommand('delete-worktree-group', ['--group', worktree.unix_group]);
  }

  /**
   * Add a user to a worktree's Unix group
   *
   * Called when a user becomes an owner of a worktree.
   *
   * @param worktreeId - Worktree ID
   * @param userId - User ID to add
   */
  async addUserToWorktreeGroup(worktreeId: WorktreeID, userId: UUID): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(
        `[Unix Integration] No Unix group for worktree ${worktreeId.substring(0, 8)}, skipping user add`
      );
      return;
    }

    // Get user's Unix username
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      console.log(
        `[Unix Integration] User ${userId.substring(0, 8)} has no Unix username, skipping group add`
      );
      return;
    }

    console.log(
      `[Unix Integration] Adding user ${user.unix_username} to group ${worktree.unix_group}`
    );

    await this.execAdminCommand('add-to-worktree-group', [
      '--username',
      user.unix_username,
      '--group',
      worktree.unix_group,
    ]);
  }

  /**
   * Remove a user from a worktree's Unix group
   *
   * Called when a user is no longer an owner of a worktree.
   *
   * @param worktreeId - Worktree ID
   * @param userId - User ID to remove
   */
  async removeUserFromWorktreeGroup(worktreeId: WorktreeID, userId: UUID): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(
        `[Unix Integration] No Unix group for worktree ${worktreeId.substring(0, 8)}, skipping user remove`
      );
      return;
    }

    // Get user's Unix username
    const user = await this.usersRepo.findById(userId);
    if (!user?.unix_username) {
      console.log(
        `[Unix Integration] User ${userId.substring(0, 8)} has no Unix username, skipping group remove`
      );
      return;
    }

    console.log(
      `[Unix Integration] Removing user ${user.unix_username} from group ${worktree.unix_group}`
    );

    await this.execAdminCommand('remove-from-worktree-group', [
      '--username',
      user.unix_username,
      '--group',
      worktree.unix_group,
    ]);
  }

  /**
   * Initialize Unix group for an existing worktree
   *
   * Useful for migrating existing worktrees to Unix modes.
   * Creates group and adds all current owners.
   *
   * @param worktreeId - Worktree ID
   */
  async initializeWorktreeGroup(worktreeId: WorktreeID): Promise<void> {
    // Create group
    const groupName = await this.createWorktreeGroup(worktreeId);

    // Add all current owners
    const ownerIds = await this.worktreeRepo.getOwners(worktreeId);
    for (const ownerId of ownerIds) {
      await this.addUserToWorktreeGroup(worktreeId, ownerId);
    }

    console.log(
      `[Unix Integration] Initialized group ${groupName} with ${ownerIds.length} owner(s)`
    );
  }

  /**
   * Set filesystem permissions for a worktree directory
   *
   * Updates directory group and permissions based on worktree's others_fs_access setting.
   *
   * @param worktreeId - Worktree ID
   * @param worktreePath - Absolute path to worktree directory
   */
  async setWorktreePermissions(worktreeId: WorktreeID, worktreePath: string): Promise<void> {
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree?.unix_group) {
      console.log(
        `[Unix Integration] No Unix group for worktree ${worktreeId.substring(0, 8)}, skipping permissions`
      );
      return;
    }

    const permissionMode = getWorktreePermissionMode(worktree.others_fs_access || 'read');

    console.log(
      `[Unix Integration] Setting permissions ${permissionMode} for ${worktreePath} (group: ${worktree.unix_group})`
    );

    // Use chgrp + chmod
    await execAsync(`sudo chgrp -R ${worktree.unix_group} "${worktreePath}"`);
    await execAsync(`sudo chmod -R ${permissionMode} "${worktreePath}"`);
  }
}
