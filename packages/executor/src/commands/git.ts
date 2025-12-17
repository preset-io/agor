/**
 * Git Command Handlers for Executor
 *
 * These handlers execute git operations directly in the executor process.
 * This enables:
 * 1. Running as a different Unix user with fresh group memberships
 * 2. Proper isolation for RBAC-protected worktrees
 * 3. Consistent environment (credentials, env vars) resolution
 *
 * After git operations, results are reported back to the daemon via Feathers.
 * The daemon handles database record creation and Unix group setup.
 */

import { cloneRepo, createWorktree, getReposDir, removeWorktree } from '@agor/core/git';
import type {
  ExecutorResult,
  GitClonePayload,
  GitWorktreeAddPayload,
  GitWorktreeRemovePayload,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

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
 * Handle git.clone command
 *
 * Clones a repository to the local filesystem.
 * Returns the result for the daemon to create the database record.
 */
export async function handleGitClone(
  payload: GitClonePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
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
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon (for auth validation and potential future use)
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.clone] Connected to daemon');

    // Resolve git credentials from environment
    const env = resolveGitCredentials();
    if (Object.keys(env).length > 0) {
      console.log('[git.clone] Resolved credentials:', Object.keys(env));
    }

    // Determine output path
    const outputPath = payload.params.outputPath || getReposDir();

    // Clone the repository
    console.log(`[git.clone] Cloning ${payload.params.url} to ${outputPath}...`);
    const result = await cloneRepo({
      url: payload.params.url,
      targetDir: outputPath,
      bare: payload.params.bare,
      env,
    });

    console.log(`[git.clone] Clone successful: ${result.path}`);

    // Return the result - the daemon will create the DB record
    return {
      success: true,
      data: {
        path: result.path,
        repoName: result.repoName,
        defaultBranch: result.defaultBranch,
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
 * Returns the result for the daemon to create the database record.
 */
export async function handleGitWorktreeAdd(
  payload: GitWorktreeAddPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.add',
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
    // Connect to daemon (for auth validation)
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.worktree.add] Connected to daemon');

    // Resolve git credentials from environment (needed for fetch operations)
    const env = resolveGitCredentials();

    // Get parameters
    const worktreePath = payload.params.worktreePath;
    const repoPath = payload.params.repoPath;
    const branch = payload.params.branch || payload.params.worktreeName;
    const createBranch = payload.params.createBranch ?? false;
    const sourceBranch = payload.params.sourceBranch;

    console.log(`[git.worktree.add] Creating worktree at ${worktreePath}...`);
    console.log(
      `[git.worktree.add] Repo: ${repoPath}, Branch: ${branch}, CreateBranch: ${createBranch}`
    );

    // Create the worktree
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

    // Return the result - the daemon will create the DB record
    return {
      success: true,
      data: {
        worktreePath,
        branch,
        repoPath,
        created: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.worktree.add] Failed:', errorMessage);

    return {
      success: false,
      error: {
        code: 'GIT_WORKTREE_ADD_FAILED',
        message: errorMessage,
        details: {
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
 * Removes a worktree from the filesystem.
 */
export async function handleGitWorktreeRemove(
  payload: GitWorktreeRemovePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.worktree.remove',
        worktreePath: payload.params.worktreePath,
        force: payload.params.force,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon (for auth validation)
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.worktree.remove] Connected to daemon');

    const worktreePath = payload.params.worktreePath;

    console.log(`[git.worktree.remove] Removing worktree at ${worktreePath}...`);

    // Find the repo path from the worktree's .git file
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { join, dirname, basename } = await import('node:path');

    const gitFile = join(worktreePath, '.git');

    if (!existsSync(gitFile)) {
      // Worktree doesn't exist or already removed
      console.log('[git.worktree.remove] Worktree does not exist, nothing to remove');
      return {
        success: true,
        data: {
          worktreePath,
          removed: false,
          reason: 'Worktree does not exist',
        },
      };
    }

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

    console.log(`[git.worktree.remove] Worktree removed successfully`);

    return {
      success: true,
      data: {
        worktreePath,
        removed: true,
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
