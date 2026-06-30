/**
 * Unix Sync Command Handlers for Executor
 *
 * These handlers execute privileged Unix operations directly in the executor process.
 * They implement high-level "sync" operations that are idempotent and handle all
 * necessary Unix state for a given entity (branch, repo, or user).
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

import { exec, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { shortId } from '@agor/core/db';
import type { BranchID, RepoID } from '@agor/core/types';
import {
  AGOR_USERS_GROUP,
  assertChpasswdInputSafe,
  generateBranchGroupName,
  generateRepoGroupName,
  getBranchPermissionMode,
  isValidUnixUsername,
  REPO_GIT_PERMISSION_MODE,
  UnixGroupCommands,
  UnixUserCommands,
} from '@agor/core/unix';
import type {
  ExecutorResult,
  UnixSyncBoardPayload,
  UnixSyncBranchPayload,
  UnixSyncRepoPayload,
  UnixSyncUserPayload,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Shape-check for a branch name before it is embedded in a shell or
 * passed to privileged tools. Matches conservative filesystem-friendly set:
 * starts with alnum, followed by alnum / dot / dash / underscore, max 64
 * chars. Rejects `..`, `/`, shell metachars, leading `-`.
 */
export function isValidBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/**
 * Resolve an absolute path to the `chmod` binary. Using an absolute path
 * prevents a poisoned `$PATH` from substituting a different `chmod`.
 *
 * Falls back to bare `chmod` if no known location exists (macOS / Linux
 * distros put it in different places). execFile runs argv-style regardless.
 */
function resolveChmodBinary(): string {
  for (const candidate of ['/bin/chmod', '/usr/bin/chmod']) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'chmod';
}
const CHMOD_BIN = resolveChmodBinary();

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

function parseGroupMembers(output: string): string[] {
  return output.trim().split(',').filter(Boolean);
}

async function addUsersToGroup(usernames: Iterable<string>, groupName: string): Promise<number> {
  let added = 0;
  for (const username of usernames) {
    const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(username, groupName));
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(username, groupName));
      added++;
    }
  }
  return added;
}

async function reconcileGroupMembers(
  groupName: string,
  allowedUsernames: Set<string>,
  logPrefix: string
): Promise<void> {
  const currentMembers = parseGroupMembers(
    await runCommand(UnixGroupCommands.listGroupMembers(groupName))
  );
  for (const username of currentMembers) {
    if (allowedUsernames.has(username)) continue;
    await runCommand(UnixGroupCommands.removeUserFromGroup(username, groupName), {
      ignoreErrors: true,
    });
    console.log(`${logPrefix} Removed stale group member ${username} from ${groupName}`);
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
 * - Add all branch owners to repo group
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
    console.log(`[unix.sync-repo] Syncing repo ${shortId(repoId)} with group ${groupName}`);

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
    // Set explicit user ACL for daemon to bypass stale supplementary groups
    if (payload.params.daemonUser) {
      await runCommands(UnixGroupCommands.setUserAcl(gitPath, payload.params.daemonUser));
    }
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

    // Fetch all branches for this repo and add their owners to repo group
    const branchesResult = await client.service('branches').find({
      query: { repo_id: repoId, $limit: 1000 },
    });
    const branches = Array.isArray(branchesResult) ? branchesResult : branchesResult.data;

    const addedUsers = new Set<string>();
    for (const wt of branches) {
      // Get owners for this branch
      try {
        const ownersResult = await client.service(`branches/${wt.branch_id}/owners`).find({});
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
        // Branch owners service might not exist if RBAC is disabled
        console.log(`[unix.sync-repo] Could not fetch owners for branch ${shortId(wt.branch_id)}`);
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
// BRANCH SYNC OPERATIONS
// ============================================================

/**
 * Sync Unix state for a branch
 *
 * This is idempotent - safe to call multiple times.
 * Handles:
 * - Ensure branch Unix group exists
 * - Set permissions based on others_fs_access
 * - Add daemon user to group (if provided)
 * - Add all owners to branch group
 * - Add owners to repo group (for .git/ access)
 * - Fix .git/worktrees/<name>/ permissions
 */
export async function handleUnixSyncBranch(
  payload: UnixSyncBranchPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'unix.sync-branch', branchId: payload.params.branchId },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[unix.sync-branch] Connected to daemon');

    const branchId = payload.params.branchId;

    // Handle delete mode
    if (payload.params.delete) {
      // Fetch branch to get group name
      try {
        const branch = await client.service('branches').get(branchId);
        if (branch.unix_group) {
          const exists = await checkCommand(UnixGroupCommands.groupExists(branch.unix_group));
          if (exists) {
            await runCommand(UnixGroupCommands.deleteGroup(branch.unix_group));
            console.log(`[unix.sync-branch] Deleted group ${branch.unix_group}`);
          }
        }
      } catch {
        // Branch might already be deleted from DB
        console.log(`[unix.sync-branch] Branch ${branchId} not found in DB, skipping`);
      }
      return { success: true, data: { branchId, deleted: true } };
    }

    // Fetch branch details
    const branch = await client.service('branches').get(branchId);
    if (!branch.path) {
      return {
        success: false,
        error: { code: 'BRANCH_NO_PATH', message: 'Branch has no path' },
      };
    }

    const groupName = generateBranchGroupName(branchId as BranchID);
    console.log(`[unix.sync-branch] Syncing branch ${shortId(branchId)} with group ${groupName}`);

    // Ensure group exists
    const groupExists = await checkCommand(UnixGroupCommands.groupExists(groupName));
    if (!groupExists) {
      await runCommand(UnixGroupCommands.createGroup(groupName));
      console.log(`[unix.sync-branch] Created group ${groupName}`);
    }

    // Set permissions on branch directory
    const othersAccess = (branch.others_fs_access as 'none' | 'read' | 'write') || 'read';
    const permissionMode = getBranchPermissionMode(othersAccess);
    const permCommands = UnixGroupCommands.setDirectoryGroup(
      branch.path,
      groupName,
      permissionMode
    );
    await runCommands(permCommands);
    // Set explicit user ACL for daemon to bypass stale supplementary groups
    if (payload.params.daemonUser) {
      await runCommands(UnixGroupCommands.setUserAcl(branch.path, payload.params.daemonUser));
    }
    console.log(`[unix.sync-branch] Set branch permissions (mode: ${permissionMode})`);

    // Add daemon user if provided
    if (payload.params.daemonUser) {
      const inGroup = await checkCommand(
        UnixGroupCommands.isUserInGroup(payload.params.daemonUser, groupName)
      );
      if (!inGroup) {
        await runCommand(UnixGroupCommands.addUserToGroup(payload.params.daemonUser, groupName));
        console.log(`[unix.sync-branch] Added daemon user to branch group`);
      }
    }

    // Update branch record with group name
    if (branch.unix_group !== groupName) {
      await client.service('branches').patch(branchId, { unix_group: groupName });
      console.log(`[unix.sync-branch] Updated branch record with unix_group`);
    }

    // Fetch and add all owners to branch group
    let ownersAdded = 0;
    // Collect owner unix_usernames to avoid re-adding them as session users
    const ownerUsernames = new Set<string>();
    try {
      const ownersResult = await client.service(`branches/${branchId}/owners`).find({});
      const owners = Array.isArray(ownersResult) ? ownersResult : ownersResult.data || [];

      for (const owner of owners as Array<{ unix_username?: string }>) {
        if (owner.unix_username) {
          ownerUsernames.add(owner.unix_username);
          const inGroup = await checkCommand(
            UnixGroupCommands.isUserInGroup(owner.unix_username, groupName)
          );
          if (!inGroup) {
            await runCommand(UnixGroupCommands.addUserToGroup(owner.unix_username, groupName));
            ownersAdded++;
            console.log(`[unix.sync-branch] Added user ${owner.unix_username} to branch group`);
          }
        }
      }
    } catch (_error) {
      console.log(`[unix.sync-branch] Could not fetch owners, skipping user sync`);
    }

    // Fetch and add all users with explicit filesystem access. This expands
    // branch groups plus board owners/groups for board-aligned branches.
    const explicitFsUsernames = new Set(ownerUsernames);
    let fsAccessUsersAdded = 0;
    let explicitFsUsersFetched = false;
    try {
      const fsUsersResult = await client.service(`branches/${branchId}/fs-access-users`).find({});
      const fsUsers = Array.isArray(fsUsersResult) ? fsUsersResult : fsUsersResult.data || [];
      for (const user of fsUsers as Array<{ unix_username?: string | null }>) {
        if (user.unix_username) {
          explicitFsUsernames.add(user.unix_username);
        }
      }
      explicitFsUsersFetched = true;
      fsAccessUsersAdded = await addUsersToGroup(explicitFsUsernames, groupName);
      if (fsAccessUsersAdded > 0) {
        console.log(
          `[unix.sync-branch] Added ${fsAccessUsersAdded} explicit filesystem access user(s) to branch group`
        );
      }
    } catch (_error) {
      console.log(`[unix.sync-branch] Could not fetch filesystem access users, skipping`);
    }

    // When others_fs_access is 'write', non-owner session users need branch group
    // membership for full read-write access. For 'read' mode, they rely on ACL "others"
    // bits (o::rX) on the branch directory — adding them to the branch group would
    // escalate to write access since the group always has rwx.
    //
    // For both 'read' and 'write', non-owners still need repo group membership (added
    // below) for .git/ access, which always uses 2770 (no others access).
    let sessionUsersAdded = 0;
    if (othersAccess === 'write') {
      try {
        const sessionsResult = await client.service('sessions').find({
          query: {
            branch_id: branchId,
            $select: ['unix_username'],
            $limit: 500,
          },
        });
        const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data || [];

        // Collect unique non-owner unix_usernames from sessions
        const sessionUsernames = new Set<string>();
        for (const session of sessions as Array<{ unix_username?: string | null }>) {
          if (session.unix_username && !explicitFsUsernames.has(session.unix_username)) {
            sessionUsernames.add(session.unix_username);
          }
        }

        for (const username of sessionUsernames) {
          const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(username, groupName));
          if (!inGroup) {
            await runCommand(UnixGroupCommands.addUserToGroup(username, groupName));
            sessionUsersAdded++;
            console.log(
              `[unix.sync-branch] Added session user ${username} to branch group (others_fs_access: ${othersAccess})`
            );
          }
        }
      } catch (_error) {
        console.log(`[unix.sync-branch] Could not fetch sessions for non-owner group sync`);
      }
    }

    const allowedBranchMembers = new Set(explicitFsUsernames);
    if (payload.params.daemonUser) allowedBranchMembers.add(payload.params.daemonUser);
    if (othersAccess === 'write') {
      try {
        const sessionsResult = await client.service('sessions').find({
          query: {
            branch_id: branchId,
            $select: ['unix_username'],
            $limit: 500,
          },
        });
        const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data || [];
        for (const session of sessions as Array<{ unix_username?: string | null }>) {
          if (session.unix_username) allowedBranchMembers.add(session.unix_username);
        }
      } catch {
        // Best-effort stale-member cleanup only.
      }
    }
    if (explicitFsUsersFetched) {
      await reconcileGroupMembers(groupName, allowedBranchMembers, '[unix.sync-branch]');
    } else {
      console.log(
        '[unix.sync-branch] Skipping stale branch group member cleanup because explicit filesystem access users could not be fetched'
      );
    }

    // Also sync repo group (ensure owners and authorized session users have .git/ access)
    if (branch.repo_id) {
      try {
        const repo = await client.service('repos').get(branch.repo_id);
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
              console.log(`[unix.sync-branch] Added daemon user to repo group ${repo.unix_group}`);
            }
          }

          // Add all explicit filesystem access users to repo group (for .git/ access)
          await addUsersToGroup(explicitFsUsernames, repo.unix_group);

          // Add all branch owners to repo group (for .git/ access)
          // This ensures owners can run git commands which need .git/ access
          try {
            const ownersResult = await client.service(`branches/${branchId}/owners`).find({});
            const owners = Array.isArray(ownersResult) ? ownersResult : ownersResult.data || [];

            for (const owner of owners as Array<{ unix_username?: string }>) {
              if (owner.unix_username) {
                const inRepoGroup = await checkCommand(
                  UnixGroupCommands.isUserInGroup(owner.unix_username, repo.unix_group)
                );
                if (!inRepoGroup) {
                  await runCommand(
                    UnixGroupCommands.addUserToGroup(owner.unix_username, repo.unix_group)
                  );
                  console.log(
                    `[unix.sync-branch] Added owner ${owner.unix_username} to repo group ${repo.unix_group}`
                  );
                }
              }
            }
          } catch (_error) {
            console.log(`[unix.sync-branch] Could not fetch owners for repo group sync`);
          }

          // Add non-owner session users to repo group when others_fs_access allows
          // This is critical: the .git/ directory uses 2770 (no others access),
          // so non-owners MUST be in the repo group to run git operations
          if (othersAccess !== 'none') {
            try {
              const sessionsResult = await client.service('sessions').find({
                query: {
                  branch_id: branchId,
                  $select: ['unix_username'],
                  $limit: 500,
                },
              });
              const sessions = Array.isArray(sessionsResult)
                ? sessionsResult
                : sessionsResult.data || [];

              const sessionUsernames = new Set<string>();
              for (const session of sessions as Array<{ unix_username?: string | null }>) {
                if (session.unix_username && !explicitFsUsernames.has(session.unix_username)) {
                  sessionUsernames.add(session.unix_username);
                }
              }

              for (const username of sessionUsernames) {
                const inRepoGroup = await checkCommand(
                  UnixGroupCommands.isUserInGroup(username, repo.unix_group)
                );
                if (!inRepoGroup) {
                  await runCommand(UnixGroupCommands.addUserToGroup(username, repo.unix_group));
                  console.log(
                    `[unix.sync-branch] Added session user ${username} to repo group ${repo.unix_group} (others_fs_access: ${othersAccess})`
                  );
                }
              }
            } catch (_error) {
              console.log(`[unix.sync-branch] Could not fetch sessions for repo group sync`);
            }
          }

          // Fix .git/worktrees/<name>/ permissions
          const branchName = branch.path.split('/').pop();
          if (branchName && repo.local_path) {
            const branchGitDir = `${repo.local_path}/.git/worktrees/${branchName}`;
            try {
              const fixCommands = UnixGroupCommands.setDirectoryGroup(
                branchGitDir,
                repo.unix_group,
                REPO_GIT_PERMISSION_MODE
              );
              await runCommands(fixCommands);
              // Set explicit user ACL for daemon to bypass stale supplementary groups
              if (payload.params.daemonUser) {
                await runCommands(
                  UnixGroupCommands.setUserAcl(branchGitDir, payload.params.daemonUser)
                );
              }
              console.log(`[unix.sync-branch] Fixed .git/worktrees/${branchName}/ permissions`);
            } catch {
              // Directory might not exist yet
              console.log(
                `[unix.sync-branch] Could not fix .git/worktrees permissions (dir may not exist)`
              );
            }
          }
        }
      } catch {
        console.log(`[unix.sync-branch] Could not fetch repo, skipping repo group sync`);
      }
    }

    return {
      success: true,
      data: {
        branchId,
        groupName,
        ownersAdded,
        fsAccessUsersAdded,
        sessionUsersAdded,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[unix.sync-branch] Failed:', errorMessage);
    return {
      success: false,
      error: { code: 'UNIX_SYNC_BRANCH_FAILED', message: errorMessage },
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
// BOARD SYNC OPERATIONS
// ============================================================

/**
 * Sync Unix state for every branch currently aligned with a board.
 *
 * This keeps board permission propagation in one executor process while
 * preserving the branch-level sync semantics and no-overgrant alignment gate.
 */
export async function handleUnixSyncBoard(
  payload: UnixSyncBoardPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'unix.sync-board', boardId: payload.params.boardId },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[unix.sync-board] Connected to daemon');

    const boardId = payload.params.boardId;
    const branchesResult = await client.service(`boards/${boardId}/aligned-branches`).find({});
    const branches = Array.isArray(branchesResult) ? branchesResult : branchesResult.data || [];

    console.log(
      `[unix.sync-board] Syncing ${branches.length} board-aligned branch(es) for board ${shortId(boardId)}`
    );

    // Keep this authenticated client open while nested branch syncs run.
    // Branch syncs currently open their own daemon clients, but all work still
    // runs inside this one executor process. Disconnecting here can race the
    // auth client's async re-auth/logout bookkeeping while the nested syncs
    // start. The finally block below closes the board client after all branch
    // work finishes.

    const results: Array<{ branchId: string; success: boolean; error?: unknown }> = [];
    for (const branch of branches as Array<{ branch_id?: string }>) {
      if (!branch.branch_id) continue;
      const result = await handleUnixSyncBranch(
        {
          ...payload,
          command: 'unix.sync-branch',
          params: {
            branchId: branch.branch_id,
            daemonUser: payload.params.daemonUser,
          },
        },
        options
      );
      results.push({ branchId: branch.branch_id, success: result.success, error: result.error });
    }

    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
      return {
        success: false,
        data: { boardId, synced: results.length, failed },
        error: {
          code: 'UNIX_SYNC_BOARD_PARTIAL_FAILURE',
          message: `Failed to sync ${failed.length} of ${results.length} board-aligned branch(es)`,
        },
      };
    }

    return { success: true, data: { boardId, synced: results.length } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[unix.sync-board] Failed:', errorMessage);
    return {
      success: false,
      error: { code: 'UNIX_SYNC_BOARD_FAILED', message: errorMessage },
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
      console.log(`[unix.sync-user] User ${shortId(userId)} has no unix_username, skipping`);
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

    console.log(`[unix.sync-user] Syncing user ${shortId(userId)} (${unixUsername})`);

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

    // Configure git safe.directory for branches (if requested by daemon)
    // This prevents "dubious ownership" errors when user runs git commands
    // in branches owned by the daemon user (only needed when unix impersonation is enabled)
    //
    // NOTE: Git does NOT support wildcard patterns like /path/*/* in safe.directory.
    // The only wildcard supported is a literal '*' which trusts ALL directories (security risk).
    // Instead, we use '*' to trust all directories globally for this user.
    if (payload.params.configureGitSafeDirectory) {
      try {
        const trustAllPattern = '*';

        // Check if safe.directory is already configured (idempotent)
        let existingEntries: string[] = [];
        try {
          const checkCmd = `sudo -u ${unixUsername} git config --global --get-all safe.directory`;
          const { stdout } = await execAsync(checkCmd);
          existingEntries = stdout ? stdout.split('\n').filter(Boolean) : [];
        } catch {
          // Config doesn't exist yet, that's fine
        }

        if (!existingEntries.includes(trustAllPattern)) {
          // Add '*' to trust all directories for this user
          // This is acceptable because each user is isolated and only accesses their assigned branches
          await runCommand(
            `sudo -u ${unixUsername} git config --global --add safe.directory '${trustAllPattern}'`
          );
          console.log(`[unix.sync-user] Configured git safe.directory='*' for ${unixUsername}`);
        } else {
          console.log(
            `[unix.sync-user] git safe.directory='*' already configured for ${unixUsername}`
          );
        }
      } catch (error) {
        // Non-fatal - log warning and continue
        console.warn(`[unix.sync-user] Failed to configure git safe.directory:`, error);
      }
    }

    // Sync password if provided
    if (payload.params.password) {
      const password = payload.params.password;

      // chpasswd reads lines of the form `username:password\n`. A `:` in the
      // username or a newline in the password would let an attacker rewrite
      // ANY user's password in a single batch — validate before writing.
      if (!isValidUnixUsername(unixUsername)) {
        throw new Error(
          `Refusing to sync password: invalid unix_username ${JSON.stringify(unixUsername)}`
        );
      }
      assertChpasswdInputSafe(unixUsername, password);

      // Use chpasswd with stdin for security (password not in process list)
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('sudo', ['-n', '/usr/sbin/chpasswd'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stdin.write(`${unixUsername}:${password}\n`);
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
//
// Privileged group/ACL setup for newly cloned repos and freshly created
// branches lives in the daemon (apps/agor-daemon/src/utils/unix-group-init.ts)
// and is invoked via Feathers RPC: `repos.initializeUnixGroup` and
// `branches.initializeUnixGroup`. This keeps the privileged work running with
// daemon sudo regardless of executor impersonation mode. The executor only
// retains the basic-mode chmod helper below for non-RBAC paths.

/**
 * Fix permissions on branch's .git/worktrees/<name>/ directory without RBAC
 *
 * This ensures basic accessibility for git operations when RBAC is disabled.
 * Sets world-readable permissions (755) so users can access the git metadata.
 */
export async function fixBranchGitDirPermissionsBasic(
  repoPath: string,
  branchName: string
): Promise<void> {
  // Branch names flow into a path that is then passed to chmod under
  // sudo. Validate aggressively at the call site — metacharacters in the
  // name would mean command execution. (The branch service should also
  // validate at ingest; that's cross-branch scope and intentionally not
  // fixed in this pass.)
  if (!isValidBranchName(branchName)) {
    throw new Error(
      `Invalid branch name: ${JSON.stringify(branchName)}. ` +
        `Must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.`
    );
  }

  const branchGitDir = `${repoPath}/.git/worktrees/${branchName}`;

  console.log(`[unix] Setting basic permissions for .git/worktrees/${branchName}`);

  // Use argv form (execFile) so the name cannot be interpreted as shell even
  // if validation were weaker. Use absolute chmod path so a poisoned $PATH
  // can't substitute the binary. u+rwX,g+rX,o+rX: capital X only adds execute
  // bit to directories, not files — so metadata files stay non-executable.
  await execFileAsync(CHMOD_BIN, ['-R', 'u+rwX,g+rX,o+rX', branchGitDir]);
}
