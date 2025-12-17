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
 * 3. Unix group/ACL setup (when RBAC is enabled)
 *
 * Feathers hooks handle WebSocket broadcasts automatically when records are created/updated.
 */

import { join } from 'node:path';
import { parseAgorYml } from '@agor/core/config';
import {
  cleanWorktree,
  cloneRepo,
  createWorktree,
  getReposDir,
  removeWorktree,
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
import {
  fixWorktreeGitDirPermissions,
  initializeRepoGroup,
  initializeWorktreeGroup,
} from './unix.js';

/**
 * Resolve git credentials (GITHUB_TOKEN, GH_TOKEN)
 *
 * Checks environment variables for git authentication tokens.
 * These tokens are used to authenticate with GitHub/GitLab for private repos.
 */
function resolveGitCredentials(): Record<string, string> {
  const env: Record<string, string> = {};

  // Check for GITHUB_TOKEN in environment
  if (process.env.GITHUB_TOKEN) {
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  // Check for GH_TOKEN as fallback (GitHub CLI uses this)
  if (!env.GITHUB_TOKEN && process.env.GH_TOKEN) {
    env.GH_TOKEN = process.env.GH_TOKEN;
  }

  return env;
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

    // Resolve git credentials from environment
    const env = resolveGitCredentials();
    if (Object.keys(env).length > 0) {
      console.log('[git.clone] Resolved credentials:', Object.keys(env));
    }

    // Determine output path - only pass targetDir if explicitly specified
    // Otherwise let cloneRepo() compute the correct path (reposDir + repoName)
    const outputPath = payload.params.outputPath;
    const reposDir = getReposDir();

    // Clone the repository
    console.log(`[git.clone] Cloning ${payload.params.url} to ${outputPath || reposDir}...`);
    const cloneResult = await cloneRepo({
      url: payload.params.url,
      targetDir: outputPath, // undefined = let cloneRepo compute path
      bare: payload.params.bare,
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
      // Parse .agor.yml for environment config (if present)
      const agorYmlPath = join(cloneResult.path, '.agor.yml');
      let environmentConfig: import('@agor/core/types').RepoEnvironmentConfig | null = null;

      try {
        const parsed = parseAgorYml(agorYmlPath);
        if (parsed) {
          environmentConfig = parsed;
          console.log(`[git.clone] Loaded environment config from .agor.yml`);
        }
      } catch (error) {
        console.warn(
          `[git.clone] Failed to parse .agor.yml:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      console.log(`[git.clone] Creating repo record: slug=${slug}`);

      // Create repo via Feathers service
      // The daemon's repos service handles validation and hooks
      const repoRecord = await client.service('repos').create({
        repo_type: 'remote',
        slug,
        name: repoName,
        remote_url: payload.params.url,
        local_path: cloneResult.path,
        default_branch: cloneResult.defaultBranch,
        ...(environmentConfig ? { environment_config: environmentConfig } : {}),
      });

      repoId = repoRecord.repo_id;
      console.log(`[git.clone] Repo record created: ${repoId}`);

      // Initialize Unix group for repo isolation (if requested)
      if (payload.params.initUnixGroup && repoId) {
        try {
          console.log(`[git.clone] Initializing Unix group for repo ${repoId.substring(0, 8)}`);
          unixGroup = await initializeRepoGroup(
            repoId,
            cloneResult.path,
            client,
            payload.params.daemonUser
          );
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

    // Resolve git credentials from environment (needed for fetch operations)
    const env = resolveGitCredentials();

    // Get parameters
    const repoId = payload.params.repoId;
    const worktreePath = payload.params.worktreePath;
    const repoPath = payload.params.repoPath;
    const worktreeName = payload.params.worktreeName;
    const branch = payload.params.branch || worktreeName;
    const createBranch = payload.params.createBranch ?? false;
    const sourceBranch = payload.params.sourceBranch;

    console.log(`[git.worktree.add] Creating worktree at ${worktreePath}...`);
    console.log(
      `[git.worktree.add] Repo: ${repoPath}, Branch: ${branch}, CreateBranch: ${createBranch}`
    );

    // Create the git worktree on filesystem
    await createWorktree(
      repoPath,
      worktreePath,
      branch,
      createBranch,
      true, // pullLatest
      sourceBranch,
      env
    );

    console.log(`[git.worktree.add] Worktree created at ${worktreePath}`);

    // Initialize Unix group for worktree isolation (if requested)
    let unixGroup: string | undefined;
    if (payload.params.initUnixGroup && worktreeId) {
      try {
        const othersAccess = payload.params.othersAccess || 'read';
        console.log(
          `[git.worktree.add] Initializing Unix group for worktree ${worktreeId.substring(0, 8)}`
        );
        unixGroup = await initializeWorktreeGroup(
          worktreeId,
          worktreePath,
          othersAccess,
          client,
          payload.params.daemonUser
        );
        console.log(`[git.worktree.add] Unix group initialized: ${unixGroup}`);

        // Also fix permissions on the repo's .git/worktrees/<name>/ directory
        if (payload.params.repoUnixGroup) {
          await fixWorktreeGitDirPermissions(repoPath, worktreeName, payload.params.repoUnixGroup);
        }
      } catch (error) {
        // Log but don't fail the entire operation
        console.error(
          `[git.worktree.add] Failed to initialize Unix group:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Patch worktree status to 'ready' (DB record was created by daemon with 'creating')
    if (worktreeId) {
      console.log(`[git.worktree.add] Marking worktree ${worktreeId.substring(0, 8)} as ready`);
      await client.service('worktrees').patch(worktreeId, {
        filesystem_status: 'ready',
        ...(unixGroup ? { unix_group: unixGroup } : {}),
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

    // Try to mark worktree as failed (if we have a worktreeId and client)
    if (worktreeId && client) {
      try {
        await client.service('worktrees').patch(worktreeId, {
          filesystem_status: 'failed',
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
        message: errorMessage,
        details: {
          worktreeId,
          repoId: payload.params.repoId,
          repoPath: payload.params.repoPath,
          worktreeName: payload.params.worktreeName,
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

      // Remove the worktree using git
      await removeWorktree(repoPath, worktreeName);
      filesystemRemoved = true;

      console.log(`[git.worktree.remove] Worktree removed from filesystem`);
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
