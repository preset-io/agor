/**
 * Unix Sync Command Handlers for Executor
 *
 * These handlers execute privileged Unix operations directly in the executor process.
 * They implement high-level "sync" operations that are idempotent and handle all
 * necessary Unix state for a given entity (worktree, repo, or user).
 *
 * Architecture:
 * - Daemon fires-and-forgets these commands via spawnExecutorFireAndForget()
 * - Executor runs as privileged user (sudo or root)
 * - Executor fetches current state from daemon via Feathers client
 * - Executor applies necessary changes to Unix groups/permissions
 * - Executor updates DB records via Feathers to reflect Unix state
 *
 * This replaces the UnixIntegrationService that was in @agor/core.
 * Key difference: executor runs commands directly, not via CommandExecutor abstraction.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepoID, WorktreeID } from '@agor/core/types';
import {
  AGOR_USERS_GROUP,
  generateRepoGroupName,
  generateWorktreeGroupName,
  getWorktreePermissionMode,
  REPO_GIT_PERMISSION_MODE,
  UnixGroupCommands,
  UnixUserCommands,
} from '@agor/core/unix';
import type {
  ExecutorResult,
  UnixSyncRepoPayload,
  UnixSyncUserPayload,
  UnixSyncWorktreePayload,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

const execAsync = promisify(exec);

// ============================================================
// SHELL COMMAND HELPERS
// ============================================================

/**
 * Execute a shell command
 *
 * NOTE: Commands from UnixGroupCommands already include `sudo -n` where needed.
 * This function simply executes the command string as-is.
 */
async function runCommand(
  command: string,
  options: { ignoreErrors?: boolean } = {}
): Promise<string> {
  try {
    const { stdout } = await execAsync(command);
    return stdout.trim();
  } catch (error) {
    if (options.ignoreErrors) {
      return '';
    }
    throw error;
  }
}

/**
 * Execute a command and check if it succeeds (returns true/false)
 *
 * NOTE: Commands from UnixGroupCommands already include `sudo -n` where needed.
 * This function simply executes the command string as-is.
 */
async function checkCommand(command: string): Promise<boolean> {
  try {
    await execAsync(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute multiple commands sequentially
 */
async function runCommands(commands: string[]): Promise<void> {
  for (const command of commands) {
    await runCommand(command);
  }
}

// ============================================================
// REPO SYNC OPERATIONS
// ============================================================

/**
 * Sync Unix state for a repository
 *
 * This is idempotent - safe to call multiple times.
 * Handles:
 * - Ensure repo Unix group exists
 * - Set permissions on .git/ directory
 * - Add daemon user to group (if provided)
 * - Add all worktree owners to repo group
 */
export async function handleUnixSyncRepo(
  payload: UnixSyncRepoPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'unix.sync-repo', repoId: payload.params.repoId },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[unix.sync-repo] Connected to daemon');

    const repoId = payload.params.repoId;

    // Handle delete mode
    if (payload.params.delete) {
      // Fetch repo to get group name
      const repo = await client.service('repos').get(repoId);
      if (repo.unix_group) {
        const exists = await checkCommand(UnixGroupCommands.groupExists(repo.unix_group));
        if (exists) {
          await runCommand(UnixGroupCommands.deleteGroup(repo.unix_group));
          console.log(`[unix.sync-repo] Deleted group ${repo.unix_group}`);
        }
      }
      return { success: true, data: { repoId, deleted: true } };
    }

    // Fetch repo details
    const repo = await client.service('repos').get(repoId);
    if (!repo.local_path) {
      return {
        success: false,
        error: { code: 'REPO_NO_PATH', message: 'Repo has no local_path' },
      };
    }

    const groupName = generateRepoGroupName(repoId as RepoID);
    console.log(`[unix.sync-repo] Syncing repo ${repoId.substring(0, 8)} with group ${groupName}`);

    // Ensure group exists
    const groupExists = await checkCommand(UnixGroupCommands.groupExists(groupName));
    if (!groupExists) {
      await runCommand(UnixGroupCommands.createGroup(groupName));
      console.log(`[unix.sync-repo] Created group ${groupName}`);
    }

    // Set permissions on .git/ directory
    const gitPath = `${repo.local_path}/.git`;
    const permCommands = UnixGroupCommands.setDirectoryGroup(
      gitPath,
      groupName,
      REPO_GIT_PERMISSION_MODE
    );
    await runCommands(permCommands);
    console.log(`[unix.sync-repo] Set .git/ permissions`);

    // Add daemon user if provided
    if (payload.params.daemonUser) {
      const inGroup = await checkCommand(
        UnixGroupCommands.isUserInGroup(payload.params.daemonUser, groupName)
      );
      if (!inGroup) {
        await runCommand(UnixGroupCommands.addUserToGroup(payload.params.daemonUser, groupName));
        console.log(`[unix.sync-repo] Added daemon user ${payload.params.daemonUser} to group`);
      }
    }

    // Update repo record with group name
    if (repo.unix_group !== groupName) {
      await client.service('repos').patch(repoId, { unix_group: groupName });
      console.log(`[unix.sync-repo] Updated repo record with unix_group`);
    }

    // Fetch all worktrees for this repo and add their owners to repo group
    const worktreesResult = await client.service('worktrees').find({
      query: { repo_id: repoId, $limit: 1000 },
    });
    const worktrees = Array.isArray(worktreesResult) ? worktreesResult : worktreesResult.data;

    const addedUsers = new Set<string>();
    for (const wt of worktrees) {
      // Get owners for this worktree
      try {
        const ownersResult = await client.service(`worktrees/${wt.worktree_id}/owners`).find({});
        const owners = Array.isArray(ownersResult) ? ownersResult : ownersResult.data || [];

        for (const owner of owners as Array<{ unix_username?: string }>) {
          if (owner.unix_username && !addedUsers.has(owner.unix_username)) {
            const inGroup = await checkCommand(
              UnixGroupCommands.isUserInGroup(owner.unix_username, groupName)
            );
            if (!inGroup) {
              await runCommand(UnixGroupCommands.addUserToGroup(owner.unix_username, groupName));
              console.log(`[unix.sync-repo] Added user ${owner.unix_username} to repo group`);
            }
            addedUsers.add(owner.unix_username);
          }
        }
      } catch (_error) {
        // Worktree owners service might not exist if RBAC is disabled
        console.log(
          `[unix.sync-repo] Could not fetch owners for worktree ${wt.worktree_id.substring(0, 8)}`
        );
      }
    }

    return {
      success: true,
      data: {
        repoId,
        groupName,
        usersAdded: addedUsers.size,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[unix.sync-repo] Failed:', errorMessage);
    return {
      success: false,
      error: { code: 'UNIX_SYNC_REPO_FAILED', message: errorMessage },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore
      }
    }
  }
}

// ============================================================
// WORKTREE SYNC OPERATIONS
// ============================================================

/**
 * Sync Unix state for a worktree
 *
 * This is idempotent - safe to call multiple times.
 * Handles:
 * - Ensure worktree Unix group exists
 * - Set permissions based on others_fs_access
 * - Add daemon user to group (if provided)
 * - Add all owners to worktree group
 * - Add owners to repo group (for .git/ access)
 * - Fix .git/worktrees/<name>/ permissions
 */
export async function handleUnixSyncWorktree(
  payload: UnixSyncWorktreePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'unix.sync-worktree', worktreeId: payload.params.worktreeId },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[unix.sync-worktree] Connected to daemon');

    const worktreeId = payload.params.worktreeId;

    // Handle delete mode
    if (payload.params.delete) {
      // Fetch worktree to get group name
      try {
        const worktree = await client.service('worktrees').get(worktreeId);
        if (worktree.unix_group) {
          const exists = await checkCommand(UnixGroupCommands.groupExists(worktree.unix_group));
          if (exists) {
            await runCommand(UnixGroupCommands.deleteGroup(worktree.unix_group));
            console.log(`[unix.sync-worktree] Deleted group ${worktree.unix_group}`);
          }
        }
      } catch {
        // Worktree might already be deleted from DB
        console.log(`[unix.sync-worktree] Worktree ${worktreeId} not found in DB, skipping`);
      }
      return { success: true, data: { worktreeId, deleted: true } };
    }

    // Fetch worktree details
    const worktree = await client.service('worktrees').get(worktreeId);
    if (!worktree.path) {
      return {
        success: false,
        error: { code: 'WORKTREE_NO_PATH', message: 'Worktree has no path' },
      };
    }

    const groupName = generateWorktreeGroupName(worktreeId as WorktreeID);
    console.log(
      `[unix.sync-worktree] Syncing worktree ${worktreeId.substring(0, 8)} with group ${groupName}`
    );

    // Ensure group exists
    const groupExists = await checkCommand(UnixGroupCommands.groupExists(groupName));
    if (!groupExists) {
      await runCommand(UnixGroupCommands.createGroup(groupName));
      console.log(`[unix.sync-worktree] Created group ${groupName}`);
    }

    // Set permissions on worktree directory
    const othersAccess = (worktree.others_fs_access as 'none' | 'read' | 'write') || 'read';
    const permissionMode = getWorktreePermissionMode(othersAccess);
    const permCommands = UnixGroupCommands.setDirectoryGroup(
      worktree.path,
      groupName,
      permissionMode
    );
    await runCommands(permCommands);
    console.log(`[unix.sync-worktree] Set worktree permissions (mode: ${permissionMode})`);

    // Add daemon user if provided
    if (payload.params.daemonUser) {
      const inGroup = await checkCommand(
        UnixGroupCommands.isUserInGroup(payload.params.daemonUser, groupName)
      );
      if (!inGroup) {
        await runCommand(UnixGroupCommands.addUserToGroup(payload.params.daemonUser, groupName));
        console.log(`[unix.sync-worktree] Added daemon user to worktree group`);
      }
    }

    // Update worktree record with group name
    if (worktree.unix_group !== groupName) {
      await client.service('worktrees').patch(worktreeId, { unix_group: groupName });
      console.log(`[unix.sync-worktree] Updated worktree record with unix_group`);
    }

    // Fetch and add all owners to worktree group
    let ownersAdded = 0;
    try {
      const ownersResult = await client.service(`worktrees/${worktreeId}/owners`).find({});
      const owners = Array.isArray(ownersResult) ? ownersResult : ownersResult.data || [];

      for (const owner of owners as Array<{ unix_username?: string }>) {
        if (owner.unix_username) {
          const inGroup = await checkCommand(
            UnixGroupCommands.isUserInGroup(owner.unix_username, groupName)
          );
          if (!inGroup) {
            await runCommand(UnixGroupCommands.addUserToGroup(owner.unix_username, groupName));
            ownersAdded++;
            console.log(`[unix.sync-worktree] Added user ${owner.unix_username} to worktree group`);
          }
        }
      }
    } catch (_error) {
      console.log(`[unix.sync-worktree] Could not fetch owners, skipping user sync`);
    }

    // Also sync repo group (ensure owners have .git/ access)
    if (worktree.repo_id) {
      try {
        const repo = await client.service('repos').get(worktree.repo_id);
        if (repo.unix_group) {
          // Add daemon user to repo group if provided
          if (payload.params.daemonUser) {
            const inRepoGroup = await checkCommand(
              UnixGroupCommands.isUserInGroup(payload.params.daemonUser, repo.unix_group)
            );
            if (!inRepoGroup) {
              await runCommand(
                UnixGroupCommands.addUserToGroup(payload.params.daemonUser, repo.unix_group)
              );
            }
          }

          // Fix .git/worktrees/<name>/ permissions
          const worktreeName = worktree.path.split('/').pop();
          if (worktreeName && repo.local_path) {
            const worktreeGitDir = `${repo.local_path}/.git/worktrees/${worktreeName}`;
            try {
              const fixCommands = UnixGroupCommands.setDirectoryGroup(
                worktreeGitDir,
                repo.unix_group,
                REPO_GIT_PERMISSION_MODE
              );
              await runCommands(fixCommands);
              console.log(`[unix.sync-worktree] Fixed .git/worktrees/${worktreeName}/ permissions`);
            } catch {
              // Directory might not exist yet
              console.log(
                `[unix.sync-worktree] Could not fix .git/worktrees permissions (dir may not exist)`
              );
            }
          }
        }
      } catch {
        console.log(`[unix.sync-worktree] Could not fetch repo, skipping repo group sync`);
      }
    }

    return {
      success: true,
      data: {
        worktreeId,
        groupName,
        ownersAdded,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[unix.sync-worktree] Failed:', errorMessage);
    return {
      success: false,
      error: { code: 'UNIX_SYNC_WORKTREE_FAILED', message: errorMessage },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore
      }
    }
  }
}

// ============================================================
// USER SYNC OPERATIONS
// ============================================================

/**
 * Sync Unix state for a user
 *
 * This is idempotent - safe to call multiple times.
 * Handles:
 * - Ensure Unix user exists
 * - Add to agor_users group
 * - Sync password (if provided)
 * - Setup home directory configs
 */
export async function handleUnixSyncUser(
  payload: UnixSyncUserPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'unix.sync-user', userId: payload.params.userId },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[unix.sync-user] Connected to daemon');

    const userId = payload.params.userId;

    // Fetch user details
    const user = await client.service('users').get(userId);
    if (!user.unix_username) {
      console.log(`[unix.sync-user] User ${userId.substring(0, 8)} has no unix_username, skipping`);
      return {
        success: true,
        data: { userId, skipped: true, reason: 'no_unix_username' },
      };
    }

    const unixUsername = user.unix_username;

    // Handle delete mode
    if (payload.params.delete) {
      const userExists = await checkCommand(`id ${unixUsername} > /dev/null 2>&1`);
      if (userExists) {
        // Remove from agor_users group first
        const inGroup = await checkCommand(
          UnixGroupCommands.isUserInGroup(unixUsername, AGOR_USERS_GROUP)
        );
        if (inGroup) {
          await runCommand(UnixGroupCommands.removeUserFromGroup(unixUsername, AGOR_USERS_GROUP));
        }

        // Delete the user
        const deleteCmd = payload.params.deleteHome
          ? UnixUserCommands.deleteUserWithHome(unixUsername)
          : UnixUserCommands.deleteUser(unixUsername);
        await runCommand(deleteCmd);
        console.log(`[unix.sync-user] Deleted Unix user ${unixUsername}`);
      }
      return { success: true, data: { userId, deleted: true } };
    }

    console.log(`[unix.sync-user] Syncing user ${userId.substring(0, 8)} (${unixUsername})`);

    // Ensure user exists
    const userExists = await checkCommand(`id ${unixUsername} > /dev/null 2>&1`);
    if (!userExists) {
      // Create user with home directory
      await runCommand(UnixUserCommands.createUser(unixUsername));
      console.log(`[unix.sync-user] Created Unix user ${unixUsername}`);
    }

    // Ensure agor_users group exists
    const agorGroupExists = await checkCommand(UnixGroupCommands.groupExists(AGOR_USERS_GROUP));
    if (!agorGroupExists) {
      await runCommand(UnixGroupCommands.createGroup(AGOR_USERS_GROUP));
      console.log(`[unix.sync-user] Created ${AGOR_USERS_GROUP} group`);
    }

    // Add to agor_users group
    const inAgorGroup = await checkCommand(
      UnixGroupCommands.isUserInGroup(unixUsername, AGOR_USERS_GROUP)
    );
    if (!inAgorGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(unixUsername, AGOR_USERS_GROUP));
      console.log(`[unix.sync-user] Added ${unixUsername} to ${AGOR_USERS_GROUP}`);
    }

    // Configure git safe.directory for worktrees (if requested by daemon)
    // This prevents "dubious ownership" errors when user runs git commands
    // in worktrees owned by the daemon user (only needed when unix impersonation is enabled)
    if (payload.params.configureGitSafeDirectory) {
      try {
        const worktreesPattern = '/var/lib/agor/home/agorpg/.agor/worktrees/*/*';

        // Check if safe.directory is already configured (idempotent)
        let existingEntries: string[] = [];
        try {
          const checkCmd = `sudo -u ${unixUsername} git config --global --get-all safe.directory`;
          const { stdout } = await execAsync(checkCmd);
          existingEntries = stdout ? stdout.split('\n').filter(Boolean) : [];
        } catch {
          // Config doesn't exist yet, that's fine
        }

        if (!existingEntries.includes(worktreesPattern)) {
          // Add wildcard safe.directory for all worktrees
          await runCommand(
            `sudo -u ${unixUsername} git config --global --add safe.directory '${worktreesPattern}'`
          );
          console.log(`[unix.sync-user] Configured git safe.directory for ${unixUsername}`);
        } else {
          console.log(`[unix.sync-user] git safe.directory already configured for ${unixUsername}`);
        }
      } catch (error) {
        // Non-fatal - log warning and continue
        console.warn(`[unix.sync-user] Failed to configure git safe.directory:`, error);
      }
    }

    // Sync password if provided
    if (payload.params.password) {
      // Use chpasswd with stdin for security (password not in process list)
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('chpasswd', [], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.write(`${unixUsername}:${payload.params.password}\n`);
        proc.stdin.end();
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`chpasswd exited with code ${code}`));
        });
        proc.on('error', reject);
      });
      console.log(`[unix.sync-user] Synced password for ${unixUsername}`);
    }

    return {
      success: true,
      data: {
        userId,
        unixUsername,
        created: !userExists,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[unix.sync-user] Failed:', errorMessage);
    return {
      success: false,
      error: { code: 'UNIX_SYNC_USER_FAILED', message: errorMessage },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore
      }
    }
  }
}

// ============================================================
// HELPERS FOR GIT COMMANDS (used by git.ts)
// ============================================================

/**
 * Initialize Unix group for a repository (called from git.clone)
 */
export async function initializeRepoGroup(
  repoId: string,
  repoPath: string,
  client: AgorClient,
  daemonUser?: string
): Promise<string> {
  const groupName = generateRepoGroupName(repoId as RepoID);

  console.log(`[unix] Creating repo group ${groupName} for repo ${repoId.substring(0, 8)}`);

  // Check if group already exists
  const exists = await checkCommand(UnixGroupCommands.groupExists(groupName));
  if (!exists) {
    await runCommand(UnixGroupCommands.createGroup(groupName));
    console.log(`[unix] Created group ${groupName}`);
  }

  // Set permissions on .git directory
  const gitPath = `${repoPath}/.git`;
  const permCommands = UnixGroupCommands.setDirectoryGroup(
    gitPath,
    groupName,
    REPO_GIT_PERMISSION_MODE
  );
  await runCommands(permCommands);

  // Add daemon user to group if provided
  if (daemonUser) {
    const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(daemonUser, groupName));
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(daemonUser, groupName));
      console.log(`[unix] Added daemon user ${daemonUser} to group ${groupName}`);
    }
  }

  // Update repo record with group name via Feathers
  await client.service('repos').patch(repoId, { unix_group: groupName });
  console.log(`[unix] Updated repo ${repoId.substring(0, 8)} with unix_group=${groupName}`);

  return groupName;
}

/**
 * Initialize Unix group for a worktree (called from git.worktree.add)
 */
export async function initializeWorktreeGroup(
  worktreeId: string,
  worktreePath: string,
  othersAccess: 'none' | 'read' | 'write',
  client: AgorClient,
  daemonUser?: string,
  creatorUnixUsername?: string
): Promise<string> {
  const groupName = generateWorktreeGroupName(worktreeId as WorktreeID);

  console.log(
    `[unix] Creating worktree group ${groupName} for worktree ${worktreeId.substring(0, 8)}`
  );

  // Check if group already exists
  const exists = await checkCommand(UnixGroupCommands.groupExists(groupName));
  if (!exists) {
    await runCommand(UnixGroupCommands.createGroup(groupName));
    console.log(`[unix] Created group ${groupName}`);
  }

  // Set permissions on worktree directory
  const permissionMode = getWorktreePermissionMode(othersAccess);
  const permCommands = UnixGroupCommands.setDirectoryGroup(worktreePath, groupName, permissionMode);
  await runCommands(permCommands);

  // Add daemon user to group if provided
  if (daemonUser) {
    const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(daemonUser, groupName));
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(daemonUser, groupName));
      console.log(`[unix] Added daemon user ${daemonUser} to group ${groupName}`);
    }
  }

  // Add creator to group if provided (worktree owner gets access)
  if (creatorUnixUsername) {
    const inGroup = await checkCommand(
      UnixGroupCommands.isUserInGroup(creatorUnixUsername, groupName)
    );
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(creatorUnixUsername, groupName));
      console.log(`[unix] Added creator ${creatorUnixUsername} to group ${groupName}`);
    }
  }

  // Update worktree record with group name via Feathers
  await client.service('worktrees').patch(worktreeId, { unix_group: groupName });
  console.log(`[unix] Updated worktree ${worktreeId.substring(0, 8)} with unix_group=${groupName}`);

  return groupName;
}

/**
 * Fix permissions on worktree's .git/worktrees/<name>/ directory
 */
export async function fixWorktreeGitDirPermissions(
  repoPath: string,
  worktreeName: string,
  repoGroupName: string
): Promise<void> {
  const worktreeGitDir = `${repoPath}/.git/worktrees/${worktreeName}`;

  console.log(`[unix] Setting .git/worktrees/${worktreeName} permissions`);

  const permCommands = UnixGroupCommands.setDirectoryGroup(
    worktreeGitDir,
    repoGroupName,
    REPO_GIT_PERMISSION_MODE
  );
  await runCommands(permCommands);
}
