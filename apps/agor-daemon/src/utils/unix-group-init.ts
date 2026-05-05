/**
 * Daemon-side Unix group initialization for repos and worktrees.
 *
 * These functions were previously called directly inside the executor process
 * (packages/executor/src/commands/unix.ts). Moving them to the daemon ensures
 * they run with daemon-level sudo privileges regardless of executor
 * impersonation mode (simple / insulated / strict).
 *
 * The executor now calls these via Feathers RPC:
 *   client.service('repos').initializeUnixGroup(...)
 *   client.service('worktrees').initializeUnixGroup(...)
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getDaemonUser } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import { UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { RepoID, WorktreeID } from '@agor/core/types';
import {
  generateRepoGroupName,
  generateWorktreeGroupName,
  getWorktreePermissionMode,
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
  db: Database,
  app: Application,
  repoId: string,
  userId?: string
): Promise<string> {
  const groupName = generateRepoGroupName(repoId as RepoID);
  const daemonUser = getDaemonUser();

  console.log(
    `[unix-group-init] Creating repo group ${groupName} for repo ${repoId.substring(0, 8)}`
  );

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
  console.log(
    `[unix-group-init] Updated repo ${repoId.substring(0, 8)} with unix_group=${groupName}`
  );

  return groupName;
}

// ── Worktree group init ──────────────────────────────────────────────────

export async function initializeWorktreeUnixGroup(
  db: Database,
  app: Application,
  worktreeId: string,
  othersAccess: 'none' | 'read' | 'write'
): Promise<string> {
  const groupName = generateWorktreeGroupName(worktreeId as WorktreeID);
  const daemonUser = getDaemonUser();

  console.log(
    `[unix-group-init] Creating worktree group ${groupName} for worktree ${worktreeId.substring(0, 8)}`
  );

  // Look up worktree from DB
  const worktree = await app.service('worktrees').get(worktreeId);
  const worktreePath = worktree.path;

  // Create group if it doesn't exist
  const exists = await checkCommand(UnixGroupCommands.groupExists(groupName));
  if (!exists) {
    await runCommand(UnixGroupCommands.createGroup(groupName));
    console.log(`[unix-group-init] Created group ${groupName}`);
  }

  // Set permissions on worktree directory
  const permissionMode = getWorktreePermissionMode(othersAccess);
  const permCommands = UnixGroupCommands.setDirectoryGroup(worktreePath, groupName, permissionMode);
  await runCommands(permCommands);

  // Set explicit user ACL for daemon
  if (daemonUser) {
    await runCommands(UnixGroupCommands.setUserAcl(worktreePath, daemonUser));
  }

  // Add daemon user to worktree group
  if (daemonUser) {
    const inGroup = await checkCommand(UnixGroupCommands.isUserInGroup(daemonUser, groupName));
    if (!inGroup) {
      await runCommand(UnixGroupCommands.addUserToGroup(daemonUser, groupName));
      console.log(
        `[unix-group-init] Added daemon user ${daemonUser} to worktree group ${groupName}`
      );
    }
  }

  // Add creator to worktree group
  const creatorId = worktree.created_by;
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
            `[unix-group-init] Added creator ${creatorUnixUsername} to worktree group ${groupName}`
          );
        }

        // Also add creator to repo group for .git/ access
        const repo = await app.service('repos').get(worktree.repo_id);
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
        `[unix-group-init] Could not add creator to worktree group:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Fix permissions on repo's .git/worktrees/<name>/ directory
  const repo = await app.service('repos').get(worktree.repo_id);
  if (repo.unix_group) {
    const worktreeGitDir = `${repo.local_path}/.git/worktrees/${worktree.name}`;
    const gitDirPermCommands = UnixGroupCommands.setDirectoryGroup(
      worktreeGitDir,
      repo.unix_group,
      REPO_GIT_PERMISSION_MODE
    );
    await runCommands(gitDirPermCommands);
    if (daemonUser) {
      await runCommands(UnixGroupCommands.setUserAcl(worktreeGitDir, daemonUser));
    }
  }

  // Update worktree record with group name
  await app.service('worktrees').patch(worktreeId, { unix_group: groupName });
  console.log(
    `[unix-group-init] Updated worktree ${worktreeId.substring(0, 8)} with unix_group=${groupName}`
  );

  return groupName;
}
