/**
 * Git Utils for Agor
 *
 * Provides Git operations for repo management and worktree isolation
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Get git binary path
 *
 * Searches common locations for git executable.
 * Needed because daemon may not have git in PATH.
 */
function getGitBinary(): string | undefined {
  const commonPaths = [
    '/opt/homebrew/bin/git', // Homebrew on Apple Silicon
    '/usr/local/bin/git', // Homebrew on Intel
    '/usr/bin/git', // System git (Docker and Linux)
  ];

  for (const path of commonPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Fall back to 'git' in PATH
  return undefined;
}

/**
 * Create a configured simple-git instance
 *
 * Automatically detects git binary path for consistent behavior
 * across different environments (native, Docker, etc.)
 *
 * **SSH Host Key Checking:**
 * Always disabled by default to prevent interactive prompts.
 * Agor is an automation tool and should not require user interaction for SSH operations.
 *
 * @param baseDir - Base directory for git operations
 */
function createGit(baseDir?: string) {
  const gitBinary = getGitBinary();

  // NOTE: Git environment variables (GIT_TERMINAL_PROMPT, GIT_ASKPASS) are set
  // globally at daemon startup in apps/agor-daemon/src/index.ts
  // This prevents interactive credential prompts and makes git fail fast

  // Always disable strict host key checking for SSH operations
  // This prevents interactive prompts for unknown hosts in automated environments
  //
  // Also disable credential prompts to fail fast if auth is required but not available
  // This prevents git operations from hanging indefinitely waiting for user input
  const config = [
    'core.sshCommand=ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
    'core.askpass=', // Disable askpass helper (prevents GUI password prompts)
    'credential.helper=', // Disable credential helper (prevents interactive prompts)
  ];

  return simpleGit({
    baseDir,
    binary: gitBinary,
    config,
  });
}

export interface CloneOptions {
  url: string;
  targetDir?: string;
  bare?: boolean;
  onProgress?: (progress: CloneProgress) => void;
}

export interface CloneProgress {
  method: string;
  stage: string;
  progress: number;
  processed?: number;
  total?: number;
}

export interface CloneResult {
  path: string;
  repoName: string;
  defaultBranch: string;
}

/**
 * Get default Agor repos directory (~/.agor/repos)
 */
export function getReposDir(): string {
  return join(homedir(), '.agor', 'repos');
}

/**
 * Convert SSH Git URL to HTTPS
 *
 * Examples:
 * - git@github.com:apache/superset.git -> https://github.com/apache/superset.git
 * - git@github.com:apache/superset -> https://github.com/apache/superset
 *
 * @param url - Git URL (SSH or HTTPS)
 * @returns HTTPS URL
 */
export function normalizeGitUrl(url: string): string {
  // Already HTTPS - return as-is
  if (url.startsWith('https://') || url.startsWith('http://')) {
    return url;
  }

  // Convert SSH format to HTTPS
  // git@github.com:org/repo.git -> https://github.com/org/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    return `https://${host}/${path}`;
  }

  // Unknown format - return as-is (will likely fail, but let git handle the error)
  return url;
}

/**
 * Extract repo name from Git URL
 *
 * Examples:
 * - git@github.com:apache/superset.git -> superset
 * - https://github.com/facebook/react.git -> react
 */
export function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Could not extract repo name from URL: ${url}`);
  }
  return match[1];
}

/**
 * Clone a Git repository to ~/.agor/repos/<name>
 *
 * If the repository already exists and is valid, returns existing repo info.
 * If directory exists but is not a valid repo, throws an error with suggestion to delete.
 *
 * Automatically converts SSH URLs to HTTPS for environments without SSH keys.
 *
 * @param options - Clone options
 * @returns Clone result with path and metadata
 */
export async function cloneRepo(options: CloneOptions): Promise<CloneResult> {
  // Normalize URL (convert SSH to HTTPS if needed)
  const normalizedUrl = normalizeGitUrl(options.url);

  const repoName = extractRepoName(normalizedUrl);
  const reposDir = getReposDir();
  const targetPath = options.targetDir || join(reposDir, repoName);

  // Ensure repos directory exists
  await mkdir(reposDir, { recursive: true });

  // Check if target directory already exists
  if (existsSync(targetPath)) {
    // Check if it's a valid git repository
    const isValid = await isGitRepo(targetPath);

    if (isValid) {
      // Repository already exists and is valid - just use it!
      console.log(`Repository already exists at ${targetPath}, using existing clone`);

      const defaultBranch = await getDefaultBranch(targetPath);

      return {
        path: targetPath,
        repoName,
        defaultBranch,
      };
    } else {
      // Directory exists but is not a valid git repo
      throw new Error(
        `Directory exists but is not a valid git repository: ${targetPath}\n` +
          `Please delete this directory manually and try again.`
      );
    }
  }

  // Create git instance (SSH host key checking is always disabled)
  const git = createGit();

  if (options.onProgress) {
    git.outputHandler((_command, _stdout, _stderr) => {
      // Note: Progress tracking through outputHandler is limited
      // This is a simplified version - simple-git's progress callback
      // in constructor works better, but we need the binary path too
    });
  }

  // Clone the repo using normalized URL
  console.log(`Cloning ${normalizedUrl} to ${targetPath}...`);
  await git.clone(normalizedUrl, targetPath, options.bare ? ['--bare'] : []);

  // Get default branch from remote HEAD
  const defaultBranch = await getDefaultBranch(targetPath);

  return {
    path: targetPath,
    repoName,
    defaultBranch,
  };
}

/**
 * Check if a directory is a Git repository
 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const git = createGit(path);
    await git.status();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const git = createGit(repoPath);
  const status = await git.status();
  return status.current || '';
}

/**
 * Get repository's default branch
 *
 * This is the branch that the remote HEAD points to (e.g., 'main', 'master', 'develop').
 * Uses git symbolic-ref to determine the default branch accurately.
 *
 * @param repoPath - Path to repository
 * @param remote - Remote name (default: 'origin')
 * @returns Default branch name (e.g., 'main')
 */
export async function getDefaultBranch(
  repoPath: string,
  remote: string = 'origin'
): Promise<string> {
  const git = createGit(repoPath);

  try {
    // Try to get symbolic ref from remote HEAD
    const result = await git.raw(['symbolic-ref', `refs/remotes/${remote}/HEAD`]);
    // Output format: "refs/remotes/origin/main"
    const match = result.trim().match(/refs\/remotes\/[^/]+\/(.+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Symbolic ref might not be set, fall back to checking current branch
  }

  // Fallback: use current branch
  try {
    const branches = await git.branch();
    return branches.current || 'main';
  } catch {
    // Last resort fallback
    return 'main';
  }
}

/**
 * Get current commit SHA
 */
export async function getCurrentSha(repoPath: string): Promise<string> {
  const git = createGit(repoPath);
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || '';
}

/**
 * Check if working directory is clean (no uncommitted changes)
 */
export async function isClean(repoPath: string): Promise<boolean> {
  const git = createGit(repoPath);
  const status = await git.status();
  return status.isClean();
}

/**
 * Get remote URL
 */
export async function getRemoteUrl(repoPath: string, remote: string = 'origin'): Promise<string> {
  const git = createGit(repoPath);
  const remotes = await git.getRemotes(true);
  const remoteObj = remotes.find((r) => r.name === remote);
  return remoteObj?.refs.fetch || '';
}

/**
 * Get worktrees directory (~/.agor/worktrees)
 */
export function getWorktreesDir(): string {
  return join(homedir(), '.agor', 'worktrees');
}

/**
 * Get path for a specific worktree
 */
export function getWorktreePath(repoSlug: string, worktreeName: string): string {
  return join(getWorktreesDir(), repoSlug, worktreeName);
}

export interface WorktreeInfo {
  name: string;
  path: string;
  ref: string;
  sha: string;
  detached: boolean;
}

/**
 * Create a git worktree
 *
 * @param repoPath - Path to repository
 * @param worktreePath - Path where worktree should be created
 * @param ref - Branch/tag/commit to checkout
 * @param createBranch - Whether to create a new branch
 * @param pullLatest - Whether to fetch from remote before creating worktree (defaults to true)
 * @param sourceBranch - Source branch to base new branch on (used with createBranch)
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  ref: string,
  createBranch: boolean = false,
  pullLatest: boolean = true, // Changed default to true - always fetch latest!
  sourceBranch?: string
): Promise<void> {
  const git = createGit(repoPath);

  let fetchSucceeded = false;

  // Pull latest from remote if requested
  if (pullLatest) {
    try {
      // Fetch all branches to ensure remote tracking branches exist
      await git.fetch(['origin']);
      fetchSucceeded = true;
      console.log('✅ Fetched latest from origin');

      // If not creating a new branch, update local branch to match remote
      if (!createBranch) {
        try {
          // Check if local branch exists
          const branches = await git.branch();
          const localBranchExists = branches.all.includes(ref);

          if (localBranchExists) {
            // Update local branch to match remote (if remote exists)
            const remoteBranches = await git.branch(['-r']);
            const remoteBranchExists = remoteBranches.all.includes(`origin/${ref}`);

            if (remoteBranchExists) {
              // Reset local branch to match remote
              await git.raw(['branch', '-f', ref, `origin/${ref}`]);
              console.log(`✅ Updated local ${ref} to match origin/${ref}`);
            }
          }
        } catch (error) {
          console.warn(
            `⚠️  Failed to update local ${ref} branch:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } catch (error) {
      console.warn(
        '⚠️  Failed to fetch from origin (will use local refs):',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const args = [worktreePath];

  if (createBranch) {
    args.push('-b', ref);
    // Use sourceBranch as base (e.g., 'main' or 'origin/main')
    if (sourceBranch) {
      // If fetch succeeded, use origin/<branch> to get latest
      const baseRef = fetchSucceeded ? `origin/${sourceBranch}` : sourceBranch;
      args.push(baseRef);
    }
  } else {
    // Not creating a new branch - use the (now updated) local branch
    args.push(ref);
  }

  await git.raw(['worktree', 'add', ...args]);
}

/**
 * List all worktrees for a repository
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const git = createGit(repoPath);
  const output = await git.raw(['worktree', 'list', '--porcelain']);

  const worktrees: WorktreeInfo[] = [];
  const lines = output.split('\n');

  let current: Partial<WorktreeInfo> = {};

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      current.path = line.substring(9);
      current.name = basename(current.path);
    } else if (line.startsWith('HEAD ')) {
      current.sha = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.ref = line.substring(7).replace('refs/heads/', '');
      current.detached = false;
    } else if (line.startsWith('detached')) {
      current.detached = true;
    } else if (line === '') {
      if (current.path && current.sha) {
        worktrees.push(current as WorktreeInfo);
      }
      current = {};
    }
  }

  // Handle last entry
  if (current.path && current.sha) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
}

/**
 * Remove a git worktree
 */
export async function removeWorktree(repoPath: string, worktreeName: string): Promise<void> {
  const git = createGit(repoPath);
  await git.raw(['worktree', 'remove', worktreeName]);
}

/**
 * Prune stale worktree metadata
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.raw(['worktree', 'prune']);
}

/**
 * Check if a remote branch exists
 */
export async function hasRemoteBranch(
  repoPath: string,
  branchName: string,
  remote: string = 'origin'
): Promise<boolean> {
  const git = createGit(repoPath);
  const branches = await git.branch(['-r']);
  return branches.all.includes(`${remote}/${branchName}`);
}

/**
 * Get list of remote branches
 */
export async function getRemoteBranches(
  repoPath: string,
  remote: string = 'origin'
): Promise<string[]> {
  const git = createGit(repoPath);
  const branches = await git.branch(['-r']);
  return branches.all
    .filter((b) => b.startsWith(`${remote}/`))
    .map((b) => b.replace(`${remote}/`, ''));
}

/**
 * Get git state for a repository (SHA + dirty status)
 *
 * Returns the current commit SHA with "-dirty" suffix if working directory has uncommitted changes.
 * If not in a git repo or SHA cannot be determined, returns "unknown".
 *
 * Examples:
 * - "abc123def456" (clean working directory)
 * - "abc123def456-dirty" (uncommitted changes)
 * - "unknown" (not a git repo or error)
 */
export async function getGitState(repoPath: string): Promise<string> {
  try {
    // Check if it's a git repo first
    if (!(await isGitRepo(repoPath))) {
      return 'unknown';
    }

    // Get current SHA
    const sha = await getCurrentSha(repoPath);
    if (!sha) {
      return 'unknown';
    }

    // Check if working directory is clean
    const clean = await isClean(repoPath);

    return clean ? sha : `${sha}-dirty`;
  } catch (error) {
    console.warn(`Failed to get git state for ${repoPath}:`, error);
    return 'unknown';
  }
}
