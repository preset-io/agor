/**
 * Daemon-side Unix group initialization for repos and branches.
 *
 * These functions were previously called directly inside the executor process
 * (packages/executor/src/commands/unix.ts). Moving them to the daemon ensures
 * they run with daemon-level sudo privileges regardless of executor
 * impersonation mode (simple / insulated / strict).
 *
 * The executor now calls these via Feathers RPC:
 *   client.service('repos').initializeUnixGroup(...)
 *   client.service('branches').initializeUnixGroup(...)
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getDaemonUser } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { shortId, UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, RepoID } from '@agor/core/types';
import {
  generateBranchGroupName,
  generateRepoGroupName,
  getBranchPermissionMode,
  REPO_GIT_PERMISSION_MODE,
  UnixGroupCommands,
} from '@agor/core/unix';

const execAsync = promisify(exec);

// ── Shell helpers (thin wrappers, same as executor/commands/unix.ts) ──────

async function runCommand(command: string): Promise<string> {
  const { stdout } = await execAsync(command);
  return stdout.trim();
}

async function checkCommand(command: string): Promise<boolean> {
  try {
    await execAsync(command);
    return true;
  } catch {
    return false;
  }
}

async function runCommands(commands: string[]): Promise<void> {
  for (const cmd of commands) {
    await runCommand(cmd);
  }
}

// ── Repo group init ──────────────────────────────────────────────────────

export async function initializeRepoUnixGroup(
  db: TenantScopeAwareDatabase,
  app: Application,
  repoId: string,
  userId?: string
): Promise<string> {
  const groupName = generateRepoGroupName(repoId as RepoID);
  const daemonUser = getDaemonUser();

  console.log(`[unix-group-init] Creating repo group ${groupName} for repo ${shortId(repoId)}`);

  // Create group if it doesn't exist
  const exists = await checkCommand(UnixGroupCommands.groupExists(groupName));
  if (!exists) {
    await runCommand(UnixGroupCommands.createGroup(groupName));
    console.log(`[unix-group-init] Created group ${groupName}`);
  }

  // Look up repo local_path from DB
  const repo = await app.service('repos').get(repoId);
  const repoPath = repo.local_path;

  // Set permissions on repo directory
  const permCommands = UnixGroupCommands.setDirectoryGroup(
    repoPath,
    groupName,
    REPO_GIT_PERMISSION_MODE
  );
  await runCommands(permCommands);

  // Set explicit user ACL for daemon
  if (daemonUser) {
    await runCommands(UnixGroupCommands.setUserAcl(repoPath, daemonUser));
  }
  console.log(`[unix-group-init] Set repo directory permissions with group ${groupName}`);

  // Add daemon user to group
  if (daemonUser) {
    const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(daemonUser, groupName));
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(daemonUser, groupName));
      console.log(`[unix-group-init] Added daemon user ${daemonUser} to group ${groupName}`);
    }
  }

  // Add creator to repo group if userId provided
  if (userId) {
    try {
      const userRepo = new UsersRepository(db);
      const user = await userRepo.findById(userId);
      const creatorUnixUsername = user?.unix_username;
      if (creatorUnixUsername) {
        const inGroup = await checkCommand(
          UnixGroupCommands.isUserInGroup(creatorUnixUsername, groupName)
        );
        if (!inGroup) {
          await runCommand(UnixGroupCommands.addUserToGroup(creatorUnixUsername, groupName));
          console.log(
            `[unix-group-init] Added creator ${creatorUnixUsername} to repo group ${groupName}`
          );
        }
      }
    } catch (error) {
      console.warn(
        `[unix-group-init] Could not add creator to repo group:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Update repo record with group name
  await app.service('repos').patch(repoId, { unix_group: groupName });
  console.log(`[unix-group-init] Updated repo ${shortId(repoId)} with unix_group=${groupName}`);

  return groupName;
}

// ── Branch group init ──────────────────────────────────────────────────

export async function initializeBranchUnixGroup(
  db: TenantScopeAwareDatabase,
  app: Application,
  branchId: string,
  othersAccess: 'none' | 'read' | 'write'
): Promise<string> {
  const groupName = generateBranchGroupName(branchId as BranchID);
  const daemonUser = getDaemonUser();

  console.log(
    `[unix-group-init] Creating branch group ${groupName} for branch ${shortId(branchId)}`
  );

  // Look up branch from DB
  const branch = await app.service('branches').get(branchId);
  const branchPath = branch.path;

  // Create group if it doesn't exist
  const exists = await checkCommand(UnixGroupCommands.groupExists(groupName));
  if (!exists) {
    await runCommand(UnixGroupCommands.createGroup(groupName));
    console.log(`[unix-group-init] Created group ${groupName}`);
  }

  // Set permissions on branch directory
  const permissionMode = getBranchPermissionMode(othersAccess);
  const permCommands = UnixGroupCommands.setDirectoryGroup(branchPath, groupName, permissionMode);
  await runCommands(permCommands);

  // Set explicit user ACL for daemon
  if (daemonUser) {
    await runCommands(UnixGroupCommands.setUserAcl(branchPath, daemonUser));
  }

  // Add daemon user to branch group
  if (daemonUser) {
    const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(daemonUser, groupName));
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(daemonUser, groupName));
      console.log(`[unix-group-init] Added daemon user ${daemonUser} to branch group ${groupName}`);
    }
  }

  // Add creator to branch group
  const creatorId = branch.created_by;
  if (creatorId) {
    try {
      const userRepo = new UsersRepository(db);
      const creator = await userRepo.findById(creatorId);
      const creatorUnixUsername = creator?.unix_username;
      if (creatorUnixUsername) {
        const inGroup = await checkCommand(
          UnixGroupCommands.isUserInGroup(creatorUnixUsername, groupName)
        );
        if (!inGroup) {
          await runCommand(UnixGroupCommands.addUserToGroup(creatorUnixUsername, groupName));
          console.log(
            `[unix-group-init] Added creator ${creatorUnixUsername} to branch group ${groupName}`
          );
        }

        // Also add creator to repo group for .git/ access
        const repo = await app.service('repos').get(branch.repo_id);
        const repoUnixGroup = repo.unix_group;
        if (repoUnixGroup) {
          const inRepoGroup = await checkCommand(
            UnixGroupCommands.isUserInGroup(creatorUnixUsername, repoUnixGroup)
          );
          if (!inRepoGroup) {
            await runCommand(UnixGroupCommands.addUserToGroup(creatorUnixUsername, repoUnixGroup));
            console.log(
              `[unix-group-init] Added creator ${creatorUnixUsername} to repo group ${repoUnixGroup}`
            );
          }
        }
      }
    } catch (error) {
      console.warn(
        `[unix-group-init] Could not add creator to branch group:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Fix permissions on repo's .git/worktrees/<name>/ directory
  const repo = await app.service('repos').get(branch.repo_id);
  if (repo.unix_group) {
    const branchGitDir = `${repo.local_path}/.git/worktrees/${branch.name}`;
    const gitDirPermCommands = UnixGroupCommands.setDirectoryGroup(
      branchGitDir,
      repo.unix_group,
      REPO_GIT_PERMISSION_MODE
    );
    await runCommands(gitDirPermCommands);
    if (daemonUser) {
      await runCommands(UnixGroupCommands.setUserAcl(branchGitDir, daemonUser));
    }
  }

  // Update branch record with group name
  await app.service('branches').patch(branchId, { unix_group: groupName });
  console.log(`[unix-group-init] Updated branch ${shortId(branchId)} with unix_group=${groupName}`);

  return groupName;
}
