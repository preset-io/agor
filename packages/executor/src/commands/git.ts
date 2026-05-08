/**
 * Git Command Handlers for Executor
 *
 * These handlers execute git operations directly in the executor process.
 * This enables:
 * 1. Running as a different Unix user with fresh group memberships
 * 2. Proper isolation for RBAC-protected worktrees
 * 3. Consistent environment (credentials, env vars) resolution
 *
 * The executor handles the complete transaction:
 * 1. Filesystem operations (git clone, git worktree add/remove)
 * 2. Database record creation via Feathers services
 * 3. Privileged Unix group/ACL setup is delegated to the daemon via Feathers RPC
 *    (`repos.initializeUnixGroup`, `worktrees.initializeUnixGroup`) so it runs
 *    with daemon sudo privileges regardless of executor impersonation mode.
 *
 * Feathers hooks handle WebSocket broadcasts automatically when records are created/updated.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgorYml } from '@agor/core/config';
import {
  cleanWorktree,
  cloneRepo,
  createWorktree,
  deleteBranch,
  deleteWorktreeDirectory,
  getReposDir,
  removeWorktree,
  restoreWorktreeFilesystem,
} from '@agor/core/git';
import type {
  ExecutorResult,
  GitClonePayload,
  GitWorktreeAddPayload,
  GitWorktreeCleanPayload,
  GitWorktreeRemovePayload,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';
import { fixWorktreeGitDirPermissionsBasic } from './unix.js';

/**
 * Fetch the requesting user's git environment via Feathers RPC.
 *
 * Calls `users.getGitEnvironment` on the daemon, which decrypts the user's
 * stored env vars (GITHUB_TOKEN, etc.) and returns them. Returns an empty
 * object only when no userId is provided (e.g. local-path repos that skip
 * credentials entirely).
 *
 * RPC failures are intentionally NOT swallowed: this is the channel through
 * which per-user credentials reach git ops in strict mode. If we returned `{}`
 * on failure, git would silently fall back to the daemon user's ambient
 * credentials (e.g. `gh auth login`), which is exactly the cross-user leak
 * this whole flow is designed to prevent.
 */
async function fetchUserGitEnvironment(
  client: AgorClient,
  userId: string | undefined
): Promise<Record<string, string>> {
  if (!userId) return {};
  return client.service('users').getGitEnvironment({ userId });
}

/**
 * Compute repo slug from URL
 *
 * Examples:
 * - https://github.com/preset-io/agor.git -> preset-io/agor
 * - git@github.com:preset-io/agor.git -> preset-io/agor
 * - /local/path/to/repo -> local-path-to-repo
 */
function computeRepoSlug(url: string): string {
  // Handle SSH URLs: git@github.com:org/repo.git
  const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // Handle HTTPS URLs: https://github.com/org/repo.git
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return pathname;
  } catch {
    // Not a valid URL, use the path as-is (sanitized)
    return url.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/^-+|-+$/g, '');
  }
}

/**
 * Extract repo name from slug
 */
function extractRepoName(slug: string): string {
  const parts = slug.split('/');
  return parts[parts.length - 1] || slug;
}

/**
 * Handle git.clone command
 *
 * Clones a repository to the local filesystem and creates the database record.
 * This is a complete transaction - filesystem + DB in one atomic operation.
 */
export async function handleGitClone(
  payload: GitClonePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const createDbRecord = payload.params.createDbRecord ?? true;

  // Dry run mode - just validate and return
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.clone',
        url: payload.params.url,
        outputPath: payload.params.outputPath,
        branch: payload.params.branch,
        bare: payload.params.bare,
        // Surface user-pinned default_branch in the dry-run trace so callers
        // (and tests) can verify the field threaded through from the schema.
        default_branch: payload.params.default_branch,
        createDbRecord,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.clone] Connected to daemon');

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client, payload.params.userId);
    if (Object.keys(env).length > 0) {
      console.log('[git.clone] Resolved credentials:', Object.keys(env));
    }

    // Determine output path - only pass targetDir if explicitly specified
    // Otherwise let cloneRepo() compute the correct path (reposDir + repoName)
    const outputPath = payload.params.outputPath;
    const reposDir = getReposDir();

    // Clone the repository. If the caller pinned a default_branch, forward
    // it as `branch` so the working tree lands on that branch — otherwise
    // `.agor.yml` on a non-default branch wouldn't be visible at parse time
    // below.
    const pinnedBranch = payload.params.default_branch?.trim() || undefined;
    console.log(
      `[git.clone] Cloning ${payload.params.url} to ${outputPath || reposDir}` +
        (pinnedBranch ? ` (branch: ${pinnedBranch})` : '') +
        '...'
    );
    const cloneResult = await cloneRepo({
      url: payload.params.url,
      targetDir: outputPath, // undefined = let cloneRepo compute path
      bare: payload.params.bare,
      branch: pinnedBranch,
      env,
    });

    console.log(`[git.clone] Clone successful: ${cloneResult.path}`);

    // Compute slug for the repo
    const slug = payload.params.slug || computeRepoSlug(payload.params.url);
    const repoName = extractRepoName(slug);

    // Create DB record if requested (default: true)
    let repoId: string | undefined;
    let unixGroup: string | undefined;

    if (createDbRecord) {
      // Parse .agor.yml for environment config (if present). Returns v2
      // RepoEnvironment; legacy v1 files are wrapped as variants.default.
      const agorYmlPath = join(cloneResult.path, '.agor.yml');
      let environment: import('@agor/core/types').RepoEnvironment | null = null;

      try {
        const parsed = parseAgorYml(agorYmlPath);
        if (parsed) {
          environment = parsed;
          console.log(`[git.clone] Loaded environment config from .agor.yml`);
        }
      } catch (error) {
        console.warn(
          `[git.clone] Failed to parse .agor.yml:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      // User-supplied default_branch wins over the auto-detected origin/HEAD.
      // Only fall back to the auto-detected value when the caller didn't
      // pin one. This is what makes "Add Repository → Default Branch =
      // some-feature-branch" actually persist into the DB record instead
      // of being silently overwritten by whatever GitHub's HEAD points at.
      const defaultBranch = payload.params.default_branch?.trim() || cloneResult.defaultBranch;
      console.log(
        `[git.clone] Creating repo record: slug=${slug} default_branch=${defaultBranch}` +
          (payload.params.default_branch ? ' (user-supplied)' : ' (auto-detected)')
      );

      // Create repo via Feathers service
      // The daemon's repos service handles validation and hooks
      const repoRecord = await client.service('repos').create({
        repo_type: 'remote',
        slug,
        name: repoName,
        remote_url: payload.params.url,
        local_path: cloneResult.path,
        default_branch: defaultBranch,
        ...(environment ? { environment } : {}),
      });

      repoId = repoRecord.repo_id;
      console.log(`[git.clone] Repo record created: ${repoId}`);

      // Initialize Unix group for repo isolation via daemon RPC (if requested).
      // Runs daemon-side so that groupadd/chgrp/setfacl execute with daemon
      // sudo privileges regardless of executor impersonation mode.
      if (payload.params.initUnixGroup && repoId) {
        try {
          console.log(`[git.clone] Initializing Unix group for repo ${repoId.substring(0, 8)}`);
          const result = await client
            .service('repos')
            .initializeUnixGroup({ repoId, userId: payload.params.userId });
          unixGroup = result.unixGroup;
          console.log(`[git.clone] Unix group initialized: ${unixGroup}`);
        } catch (error) {
          // Log but don't fail the entire operation
          console.error(
            `[git.clone] Failed to initialize Unix group:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }

    return {
      success: true,
      data: {
        path: cloneResult.path,
        repoName: cloneResult.repoName,
        defaultBranch: cloneResult.defaultBranch,
        slug,
        repoId,
        dbRecordCreated: createDbRecord,
        unixGroup,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.clone] Failed:', errorMessage);

    return {
      success: false,
      error: {
        code: 'GIT_CLONE_FAILED',
        message: errorMessage,
        details: {
          url: payload.params.url,
          outputPath: payload.params.outputPath,
        },
      },
    };
  } finally {
    // Disconnect from daemon
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Render environment command templates with full context including GID
 *
 * Fetches worktree and repo from database, gets GID from Unix group (if available),
 * and renders all environment templates with complete context.
 *
 * @param client - Feathers client
 * @param worktreeId - Worktree ID
 * @param repoId - Repo ID
 * @param unixGroup - Unix group name (to look up GID), undefined if RBAC disabled
 * @returns Rendered template fields
 */
async function renderEnvironmentTemplates(
  client: AgorClient,
  worktreeId: string,
  repoId: string,
  unixGroup: string | undefined
): Promise<{
  start_command?: string;
  stop_command?: string;
  nuke_command?: string;
  health_check_url?: string;
  app_url?: string;
  logs_command?: string;
  environment_variant?: string;
}> {
  // Import dependencies dynamically
  const { renderWorktreeSnapshot } = await import('@agor/core/environment/render-snapshot');
  const { getGidFromGroupName } = await import('@agor/core/unix');
  const { loadConfig } = await import('@agor/core/config');
  const { resolveHostIpAddress } = await import('@agor/core/utils/host-ip');

  // Fetch worktree and repo from database
  const worktree = await client.service('worktrees').get(worktreeId);
  const repo = await client.service('repos').get(repoId);

  // v2 environment is the source of truth; `environment_config` is a derived
  // legacy view. If neither is present, nothing to render.
  if (!repo.environment) {
    return {};
  }

  // Look up GID from Unix group (only if group was created)
  const unixGid = unixGroup ? getGidFromGroupName(unixGroup) : undefined;

  // Resolve host IP for {{host.ip_address}} (frozen into rendered commands).
  const config = await loadConfig();
  const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);

  // Honor an explicit variant override if the worktree already picked one;
  // otherwise fall through to `environment.default` inside renderWorktreeSnapshot.
  let snapshot: ReturnType<typeof renderWorktreeSnapshot>;
  try {
    snapshot = renderWorktreeSnapshot(
      { slug: repo.slug, environment: repo.environment },
      {
        worktree_unique_id: worktree.worktree_unique_id,
        name: worktree.name,
        path: worktree.path,
        custom_context: worktree.custom_context,
        unix_gid: unixGid,
        host_ip_address: hostIpAddress,
      },
      worktree.environment_variant
    );
  } catch (err) {
    console.warn(
      `[renderEnvironmentTemplates] Failed to render environment for ${worktree.name}:`,
      err
    );
    return {};
  }
  if (!snapshot) return {};

  return {
    start_command: snapshot.start || undefined,
    stop_command: snapshot.stop || undefined,
    nuke_command: snapshot.nuke,
    health_check_url: snapshot.health,
    app_url: snapshot.app,
    logs_command: snapshot.logs,
    environment_variant: snapshot.variant,
  };
}

/**
 * Handle git.worktree.add command
 *
 * Creates a git worktree at the specified path.
 * The DB record is created by the daemon BEFORE this runs (with filesystem_status: 'creating').
 * This handler patches the worktree to 'ready' when complete (or leaves as 'creating' on failure).
 */
export async function handleGitWorktreeAdd(
  payload: GitWorktreeAddPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const worktreeId = payload.params.worktreeId;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.add',
        worktreeId,
        repoId: payload.params.repoId,
        repoPath: payload.params.repoPath,
        worktreeName: payload.params.worktreeName,
        worktreePath: payload.params.worktreePath,
        branch: payload.params.branch,
        sourceBranch: payload.params.sourceBranch,
        createBranch: payload.params.createBranch,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.worktree.add] Connected to daemon');

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client, payload.params.userId);

    // Get parameters
    const repoId = payload.params.repoId;
    const worktreePath = payload.params.worktreePath;
    const repoPath = payload.params.repoPath;
    const worktreeName = payload.params.worktreeName;
    const branch = payload.params.branch || worktreeName;
    const createBranch = payload.params.createBranch ?? false;
    const sourceBranch = payload.params.sourceBranch;
    const refType = payload.params.refType;
    const restoreMode = payload.params.restoreMode ?? false;

    console.log(`[git.worktree.add] Creating worktree at ${worktreePath}...`);
    console.log(
      `[git.worktree.add] Repo: ${repoPath}, Branch: ${branch}, CreateBranch: ${createBranch}, RestoreMode: ${restoreMode}, RefType: ${refType || 'branch'}`
    );

    // Create the git worktree on filesystem
    if (restoreMode && sourceBranch) {
      // Restore mode: smart branch detection — checks if branch exists on remote,
      // falls back to creating from base ref if not. Safe because it only creates
      // a new branch when ls-remote confirms the branch doesn't exist anywhere.
      console.log(
        `[git.worktree.add] Using restoreWorktreeFilesystem (branch: ${branch}, base: ${sourceBranch})`
      );
      const result = await restoreWorktreeFilesystem(
        repoPath,
        worktreePath,
        branch,
        sourceBranch,
        env
      );
      if (!result.success) {
        throw new Error(`restoreWorktreeFilesystem failed: ${result.error}`);
      }
      console.log(`[git.worktree.add] Restored worktree via ${result.strategy} strategy`);
    } else {
      await createWorktree(
        repoPath,
        worktreePath,
        branch,
        createBranch,
        true, // pullLatest
        sourceBranch,
        env,
        refType
      );
    }

    console.log(`[git.worktree.add] Worktree created at ${worktreePath}`);

    // Initialize Unix group for worktree isolation via daemon RPC (if requested).
    // Runs daemon-side so that groupadd/chgrp/setfacl execute with daemon
    // sudo privileges regardless of executor impersonation mode.
    let unixGroup: string | undefined;
    if (payload.params.initUnixGroup && worktreeId) {
      try {
        const othersAccess = payload.params.othersAccess || 'read';
        console.log(
          `[git.worktree.add] Initializing Unix group for worktree ${worktreeId.substring(0, 8)}`
        );
        const result = await client
          .service('worktrees')
          .initializeUnixGroup({ worktreeId, othersAccess });
        unixGroup = result.unixGroup;
        console.log(`[git.worktree.add] Unix group initialized: ${unixGroup}`);
      } catch (error) {
        // Log but don't fail the entire operation
        console.error(
          `[git.worktree.add] Failed to initialize Unix group:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    } else if (!payload.params.initUnixGroup) {
      // RBAC is explicitly disabled - set basic permissions for .git/worktrees/<name>/
      // This ensures git operations work even without Unix group isolation
      try {
        console.log(
          `[git.worktree.add] RBAC disabled, setting basic permissions for .git/worktrees/${worktreeName}`
        );
        await fixWorktreeGitDirPermissionsBasic(repoPath, worktreeName);
      } catch (error) {
        console.error(
          `[git.worktree.add] Failed to set basic .git/worktrees permissions:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    // else: initUnixGroup is true but worktreeId is missing - skip both paths (this shouldn't happen)

    // Render environment command templates (after Unix group creation if applicable)
    // Templates should be rendered regardless of RBAC status, but GID will only be available
    // when Unix groups are enabled
    let renderedTemplates:
      | {
          start_command?: string;
          stop_command?: string;
          nuke_command?: string;
          health_check_url?: string;
          app_url?: string;
          logs_command?: string;
        }
      | undefined;

    if (worktreeId) {
      try {
        const logSuffix = unixGroup
          ? `with GID for worktree ${worktreeId.substring(0, 8)}`
          : `for worktree ${worktreeId.substring(0, 8)} (no Unix group)`;
        console.log(`[git.worktree.add] Rendering environment templates ${logSuffix}`);
        renderedTemplates = await renderEnvironmentTemplates(client, worktreeId, repoId, unixGroup);
        console.log(`[git.worktree.add] Templates rendered successfully`);
      } catch (error) {
        console.error(
          `[git.worktree.add] Failed to render templates:`,
          error instanceof Error ? error.message : String(error)
        );
        // Don't fail the entire operation if template rendering fails
      }
    }

    // Patch worktree status to 'ready' (DB record was created by daemon with 'creating')
    if (worktreeId) {
      console.log(`[git.worktree.add] Marking worktree ${worktreeId.substring(0, 8)} as ready`);
      await client.service('worktrees').patch(worktreeId, {
        filesystem_status: 'ready',
        ...(unixGroup ? { unix_group: unixGroup } : {}),
        ...(renderedTemplates || {}),
      });
      console.log(`[git.worktree.add] Worktree marked as ready`);
    }

    return {
      success: true,
      data: {
        worktreePath,
        worktreeName,
        branch,
        repoPath,
        repoId,
        worktreeId,
        unixGroup,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.worktree.add] Failed:', errorMessage);

    // Fallback: ensure the directory exists with correct perms/ACLs even when
    // git worktree add fails (e.g., branch deleted during archive). This
    // unblocks sync-unix, sessions, and manual recovery — the directory just
    // won't be a proper git worktree. Also repairs perms if a prior attempt
    // created the dir but failed on group initialization.
    const fallbackPath = payload.params.worktreePath;
    let fallbackCreated = false;
    let fallbackPermissionsApplied = false;
    if (fallbackPath) {
      // Step 1: Ensure directory exists
      if (!existsSync(fallbackPath)) {
        try {
          mkdirSync(fallbackPath, { recursive: true });
          console.log(`[git.worktree.add] Fallback: created empty directory ${fallbackPath}`);
          fallbackCreated = true;
        } catch (mkdirError) {
          console.error(
            '[git.worktree.add] Fallback: failed to create directory:',
            mkdirError instanceof Error ? mkdirError.message : String(mkdirError)
          );
        }
      }

      // Step 2: Apply perms/ACLs via daemon RPC (runs even if dir already existed from a prior attempt)
      if (existsSync(fallbackPath) && payload.params.initUnixGroup && worktreeId && client) {
        try {
          const othersAccess = payload.params.othersAccess || 'read';
          await client.service('worktrees').initializeUnixGroup({ worktreeId, othersAccess });
          console.log(`[git.worktree.add] Fallback: applied Unix group permissions`);
          fallbackPermissionsApplied = true;
        } catch (permError) {
          console.error(
            '[git.worktree.add] Fallback: failed to set Unix group permissions:',
            permError instanceof Error ? permError.message : String(permError)
          );
        }
      }
    }

    // Provide user-friendly error messages for common failures
    let userMessage = errorMessage;
    if (errorMessage.includes('already exists')) {
      if (errorMessage.includes('branch')) {
        userMessage = `A branch named '${payload.params.branch || payload.params.worktreeName}' already exists and is in use by another worktree. Please choose a different name.`;
      } else {
        userMessage = `Directory '${payload.params.worktreePath || payload.params.worktreeName}' already exists. An archived or partially-cleaned worktree may still occupy this path.`;
      }
    }

    // Try to mark worktree as failed with error details (if we have a worktreeId and client)
    if (worktreeId && client) {
      try {
        await client.service('worktrees').patch(worktreeId, {
          filesystem_status: 'failed',
          error_message: userMessage,
        });
        console.log(`[git.worktree.add] Marked worktree as failed`);
      } catch (patchError) {
        console.error(
          '[git.worktree.add] Failed to mark worktree as failed:',
          patchError instanceof Error ? patchError.message : String(patchError)
        );
      }
    }

    return {
      success: false,
      error: {
        code: 'GIT_WORKTREE_ADD_FAILED',
        message: userMessage,
        details: {
          worktreeId,
          repoId: payload.params.repoId,
          repoPath: payload.params.repoPath,
          worktreeName: payload.params.worktreeName,
          worktreePath: payload.params.worktreePath,
          fallbackDirectoryCreated: fallbackCreated,
          fallbackPermissionsApplied,
        },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.worktree.remove command
 *
 * Removes a worktree from the filesystem and deletes the database record.
 * This is a complete transaction - filesystem + DB in one atomic operation.
 */
export async function handleGitWorktreeRemove(
  payload: GitWorktreeRemovePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const deleteDbRecord = payload.params.deleteDbRecord ?? true;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.remove',
        worktreeId: payload.params.worktreeId,
        worktreePath: payload.params.worktreePath,
        force: payload.params.force,
        deleteDbRecord,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.worktree.remove] Connected to daemon');

    const worktreeId = payload.params.worktreeId;
    const worktreePath = payload.params.worktreePath;

    console.log(`[git.worktree.remove] Removing worktree at ${worktreePath}...`);

    // Find the repo path from the worktree's .git file
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { join, dirname, basename } = await import('node:path');

    const gitFile = join(worktreePath, '.git');
    let filesystemRemoved = false;

    if (existsSync(gitFile)) {
      // Read .git file to find the main repo
      // Format: gitdir: /path/to/repo/.git/worktrees/<name>
      const gitContent = await readFile(gitFile, 'utf-8');
      const match = gitContent.match(/gitdir:\s*(.+)/);

      if (!match) {
        throw new Error(`Invalid .git file in worktree: ${gitFile}`);
      }

      // Extract repo path from gitdir path
      // gitdir points to: <repo>/.git/worktrees/<name>
      // We need: <repo>
      const gitdirPath = match[1].trim();
      const gitWorktreesDir = dirname(gitdirPath); // <repo>/.git/worktrees
      const dotGitDir = dirname(gitWorktreesDir); // <repo>/.git
      const repoPath = dirname(dotGitDir); // <repo>

      const worktreeName = basename(worktreePath);

      console.log(`[git.worktree.remove] Repo path: ${repoPath}, Worktree name: ${worktreeName}`);

      // Remove the worktree using git (deregisters from .git/worktrees/)
      await removeWorktree(repoPath, worktreeName);
      console.log(`[git.worktree.remove] Git worktree deregistered`);

      // git worktree remove --force may leave residual files on disk.
      // Fully delete the directory to reclaim all disk space.
      if (existsSync(worktreePath)) {
        console.log(`[git.worktree.remove] Directory still exists, removing residual files...`);
        await deleteWorktreeDirectory(worktreePath);
        console.log(`[git.worktree.remove] Directory fully removed`);
      }

      filesystemRemoved = true;
      console.log(`[git.worktree.remove] Worktree removed from filesystem`);

      // Delete the associated branch if requested
      if (payload.params.deleteBranch && payload.params.branch) {
        const branchToDelete = payload.params.branch;
        try {
          console.log(`[git.worktree.remove] Deleting branch '${branchToDelete}'...`);
          const deleted = await deleteBranch(repoPath, branchToDelete);
          if (deleted) {
            console.log(`[git.worktree.remove] Branch '${branchToDelete}' deleted`);
          } else {
            console.log(
              `[git.worktree.remove] Branch '${branchToDelete}' not found (already deleted)`
            );
          }
        } catch (branchError) {
          // Log but don't fail the overall operation
          console.warn(
            `[git.worktree.remove] Failed to delete branch '${branchToDelete}':`,
            branchError instanceof Error ? branchError.message : String(branchError)
          );
        }
      }
    } else if (existsSync(worktreePath)) {
      // No .git file but directory exists — orphaned directory from a previous partial removal.
      // Clean it up completely.
      console.log(
        '[git.worktree.remove] No .git file but directory exists (orphaned), removing directory...'
      );
      await deleteWorktreeDirectory(worktreePath);
      filesystemRemoved = true;
      console.log('[git.worktree.remove] Orphaned directory removed');
    } else {
      console.log(
        '[git.worktree.remove] Worktree does not exist on filesystem, skipping git removal'
      );
    }

    // Delete DB record if requested (default: true)
    let dbRecordDeleted = false;

    if (deleteDbRecord) {
      console.log(`[git.worktree.remove] Deleting worktree record: ${worktreeId}`);

      // Delete worktree via Feathers service
      // The daemon's worktrees service handles cascades and hooks
      await client.service('worktrees').remove(worktreeId);
      dbRecordDeleted = true;

      console.log(`[git.worktree.remove] Worktree record deleted`);
    }

    return {
      success: true,
      data: {
        worktreeId,
        worktreePath,
        filesystemRemoved,
        dbRecordDeleted,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.worktree.remove] Failed:', errorMessage);

    return {
      success: false,
      error: {
        code: 'GIT_WORKTREE_REMOVE_FAILED',
        message: errorMessage,
        details: {
          worktreeId: payload.params.worktreeId,
          worktreePath: payload.params.worktreePath,
        },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.worktree.clean command
 *
 * Removes untracked files and build artifacts from the worktree.
 * Uses `git clean -fdx` which removes untracked files, directories,
 * and ignored files (node_modules, build artifacts, etc.)
 */
export async function handleGitWorktreeClean(
  payload: GitWorktreeCleanPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.clean',
        worktreePath: payload.params.worktreePath,
      },
    };
  }

  try {
    const worktreePath = payload.params.worktreePath;

    console.log(`[git.worktree.clean] Cleaning worktree at ${worktreePath}...`);

    // Clean the worktree
    const result = await cleanWorktree(worktreePath);

    console.log(`[git.worktree.clean] Cleaned ${result.filesRemoved} files from ${worktreePath}`);

    return {
      success: true,
      data: {
        worktreePath,
        filesRemoved: result.filesRemoved,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.worktree.clean] Failed:', errorMessage);

    return {
      success: false,
      error: {
        code: 'GIT_WORKTREE_CLEAN_FAILED',
        message: errorMessage,
        details: {
          worktreePath: payload.params.worktreePath,
        },
      },
    };
  }
}
