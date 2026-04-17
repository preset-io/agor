/**
 * Git Utils for Agor
 *
 * Provides Git operations for repo management and worktree isolation.
 * Supports SSH keys, user environment variables (GITHUB_TOKEN), and system credential helpers.
 *
 * When worktree RBAC is enabled, git operations run via `sudo su -` to ensure
 * fresh Unix group memberships (groups are cached at login time).
 */

import type { SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { getReposDir, getWorktreesDir } from '../config/config-manager';

/**
 * Validate a user-supplied git ref (branch name, tag) before it is passed to
 * git subcommands.
 *
 * A ref that starts with `-` (e.g. `--upload-pack=/tmp/payload`) would be
 * interpreted as an option by git, giving an attacker code execution. Even
 * with `--` separators as defence-in-depth, callers must validate the ref
 * itself too.
 *
 * Rules:
 *  - Must be a non-empty string.
 *  - Must NOT start with `-` (option injection).
 *  - Must NOT contain whitespace, newlines, or NUL bytes.
 *  - Must pass `git check-ref-format --branch <ref>`.
 *
 * Callers must await this and bail out on rejection.
 */
export async function validateGitRef(ref: unknown): Promise<void> {
  if (typeof ref !== 'string') {
    throw new Error(`Invalid git ref: expected string, got ${typeof ref}`);
  }
  if (ref.length === 0) {
    throw new Error('Invalid git ref: empty string');
  }
  if (ref.startsWith('-')) {
    throw new Error(
      `Invalid git ref: refs starting with '-' are rejected to prevent option injection`
    );
  }
  // Whitespace, newlines, NUL — none of these are valid in refs, and a
  // newline in particular lets an attacker smuggle a second command.
  if (/[\s\0]/.test(ref)) {
    throw new Error('Invalid git ref: contains whitespace, newline, or NUL byte');
  }

  // Final authoritative check: ask git itself.
  //
  // Use `check-ref-format refs/heads/<name>` (not `--branch`). `--branch`
  // mode resolves `@{-N}` against the current repository, which means it
  // fails outside a git worktree — breaking callers like the seed script
  // that validate refs before a repo exists. The non-`--branch` form is
  // pure syntactic validation and needs no git context.
  const gitBinary = getGitBinary();
  const git = simpleGit({ binary: gitBinary });
  try {
    await git.raw(['check-ref-format', `refs/heads/${ref}`]);
  } catch {
    throw new Error(`Invalid git ref: rejected by git check-ref-format: ${ref}`);
  }
}

/**
 * Get git binary path
 *
 * Searches common locations for git executable.
 * Needed because daemon may not have git in PATH.
 */
function getGitBinary(): string {
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
  return 'git';
}

/**
 * Loose shape check for GitHub / GitLab personal access tokens we will put
 * into a git-credentials file. PATs and installation tokens fit in this set;
 * anything outside it suggests the value is either malformed or attacker-
 * shaped (e.g. contains `;`, newlines, `$()`). In that case we skip the
 * credential helper rather than embed it.
 */
export function isLikelyGitToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,255}$/.test(token);
}

/**
 * Build the argv for `git worktree add`, always inserting a `--` separator
 * before positional arguments.
 *
 * Even when {@link validateGitRef} has rejected option-shaped refs, we keep
 * the `--` separator as defence-in-depth — any value that slips through (e.g.
 * a future regression in validation, or a sourceBranch path) is still forced
 * into positional-argument semantics.
 *
 * Exported so tests can assert the argv shape without spawning a real git.
 */
export function buildWorktreeAddArgs(params: {
  worktreePath: string;
  ref: string;
  createBranch: boolean;
  sourceBranch?: string;
  refType?: 'branch' | 'tag';
  fetchSucceeded: boolean;
}): string[] {
  const { worktreePath, ref, createBranch, sourceBranch, refType, fetchSucceeded } = params;

  const optionArgs: string[] = [];
  const positionalArgs: string[] = [worktreePath];

  if (createBranch) {
    optionArgs.push('-b', ref);
    if (sourceBranch) {
      if (refType === 'tag') {
        positionalArgs.push(sourceBranch);
      } else {
        const baseRef = fetchSucceeded ? `origin/${sourceBranch}` : sourceBranch;
        positionalArgs.push(baseRef);
      }
    }
  } else {
    positionalArgs.push(ref);
  }

  return ['worktree', 'add', ...optionArgs, '--', ...positionalArgs];
}

/**
 * Track temp credential files so a process-exit handler can best-effort
 * clean them up if a caller forgot to (or a synchronous crash happened).
 */
const _activeCredFiles = new Set<string>();
let _credCleanupRegistered = false;
function _registerCredCleanup(): void {
  if (_credCleanupRegistered) return;
  _credCleanupRegistered = true;
  const cleanup = () => {
    for (const p of _activeCredFiles) {
      try {
        unlinkSync(p);
      } catch {
        // best-effort
      }
    }
    _activeCredFiles.clear();
  };
  process.once('exit', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
}

/**
 * Write a git-credentials-format file for GitHub HTTPS access.
 *
 * The token is URL-encoded — it has also been shape-checked upstream. This
 * replaces the previous inline shell credential helper, which interpolated
 * the token directly into a shell function body: a token containing `;`,
 * backticks, `$()`, `}`, or newlines would have escaped the function and
 * executed as shell.
 */
function writeGitCredentialsFile(token: string): string {
  _registerCredCleanup();
  const credPath = join(
    tmpdir(),
    `agor-git-creds-${process.pid}-${randomBytes(8).toString('hex')}`
  );
  const encodedToken = encodeURIComponent(token);
  const line = `https://x-access-token:${encodedToken}@github.com\n`;
  // mode 0600 — only our uid can read the credential.
  writeFileSync(credPath, line, { mode: 0o600 });
  _activeCredFiles.add(credPath);
  return credPath;
}

/**
 * Best-effort unlink of a temp credentials file created by
 * writeGitCredentialsFile. Safe to call multiple times.
 */
async function removeGitCredentialsFile(credPath: string | undefined): Promise<void> {
  if (!credPath) return;
  _activeCredFiles.delete(credPath);
  try {
    await unlink(credPath);
  } catch {
    // best-effort
  }
}

/**
 * Create a configured simple-git instance with user environment variables.
 *
 * IMPORTANT: This function does NOT handle user impersonation.
 * Impersonation is handled upstream when spawning the executor process.
 * When git operations run inside the executor, they inherit the executor's
 * user context automatically (no sudo needed).
 *
 * When a GitHub / GitLab PAT is supplied via `env.GITHUB_TOKEN` or
 * `env.GH_TOKEN`, a temporary 0600-mode credentials file is written and
 * referenced via `credential.helper=store --file=<path>`. The token value
 * is URL-encoded into the file and never ends up in a shell string. The
 * second return value, `credPath`, is the tempfile path (if any) and MUST
 * be passed to `removeGitCredentialsFile()` once all git operations for
 * this invocation complete.
 *
 * @param baseDir - Working directory for git operations
 * @param env - Environment variables (GITHUB_TOKEN, GH_TOKEN, etc.)
 */
function createGit(
  baseDir?: string,
  env?: Record<string, string>
): { git: ReturnType<typeof simpleGit>; credPath?: string } {
  const gitBinary = getGitBinary();

  const config = [
    'core.sshCommand=ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
  ];

  let credPath: string | undefined;

  // Configure credential helper for GitHub tokens via a tempfile (NOT via
  // an inline shell helper — which would let a token containing `;`,
  // backticks, `$()`, or newlines escape the shell function body).
  const rawToken = env?.GITHUB_TOKEN ?? env?.GH_TOKEN;
  if (rawToken) {
    if (isLikelyGitToken(rawToken)) {
      credPath = writeGitCredentialsFile(rawToken);
      config.push(`credential.helper=store --file=${credPath}`);
      console.debug('🔑 Configured credential helper via temp credentials file');
    } else {
      // Don't block — existing stored tokens may pre-date the validation
      // rule. Log and fall back to URL-embedded tokens (cloneRepo also
      // injects the token into the URL for HTTPS).
      console.warn(
        '🔑 Skipping git credential helper: token does not match expected shape. ' +
          'Tokens must match /^[A-Za-z0-9_-]{20,255}$/. ' +
          'Re-save the token to enable the credential helper.'
      );
    }
  }

  const git = simpleGit({
    baseDir,
    binary: gitBinary,
    config,
    unsafe: {
      allowUnsafeSshCommand: true,
    },
    spawnOptions: env
      ? ({
          env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        } as unknown as Pick<SpawnOptions, 'uid' | 'gid'>)
      : undefined,
  });

  return { git, credPath };
}

export interface CloneOptions {
  url: string;
  targetDir?: string;
  bare?: boolean;
  onProgress?: (progress: CloneProgress) => void;
  env?: Record<string, string>; // User environment variables (e.g., from resolveUserEnvironment)
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

// Re-export path helpers from config-manager for backward compatibility
export { getReposDir, getWorktreePath, getWorktreesDir } from '../config/config-manager';

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
 */
export async function cloneRepo(options: CloneOptions): Promise<CloneResult> {
  let cloneUrl = options.url;

  const repoName = extractRepoName(cloneUrl);
  const reposDir = getReposDir();
  const targetPath = options.targetDir || join(reposDir, repoName);

  // Inject token into URL for reliability (credential helper is also configured as backup).
  //
  // SECURITY: the token is interpolated into a URL's userinfo component. Any
  // `@`, `/`, `:`, `#`, `?`, whitespace, or control character in the token
  // would either change which host git connects to or break the URL parser.
  // We also shape-check the token with `isLikelyGitToken` so we never emit a
  // URL containing attacker-shaped bytes — and we percent-encode the value as
  // belt-and-braces.
  const rawToken = options.env?.GITHUB_TOKEN || options.env?.GH_TOKEN;
  const tokenSource = options.env?.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'GH_TOKEN';
  if (rawToken && cloneUrl.startsWith('https://github.com/')) {
    if (!isLikelyGitToken(rawToken)) {
      console.warn(
        `🔑 Skipping ${tokenSource} URL injection: value does not match expected token shape`
      );
    } else {
      const encodedToken = encodeURIComponent(rawToken);
      cloneUrl = cloneUrl.replace(
        'https://github.com/',
        `https://x-access-token:${encodedToken}@github.com/`
      );
      console.debug(`🔑 Injected ${tokenSource} into URL`);
    }
  }

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

  // Create git instance with user env vars (SSH host key checking is always disabled)
  const { git, credPath } = createGit(undefined, options.env);

  try {
    if (options.onProgress) {
      git.outputHandler((_command, _stdout, _stderr) => {
        // Note: Progress tracking through outputHandler is limited
        // This is a simplified version - simple-git's progress callback
        // in constructor works better, but we need the binary path too
      });
    }

    // Clone the repo using the URL (potentially with injected token)
    console.log(`Cloning ${options.url} to ${targetPath}...`);
    await git.clone(cloneUrl, targetPath, options.bare ? ['--bare'] : []);

    // Get default branch from remote HEAD
    const defaultBranch = await getDefaultBranch(targetPath);

    return {
      path: targetPath,
      repoName,
      defaultBranch,
    };
  } finally {
    await removeGitCredentialsFile(credPath);
  }
}

/**
 * Check if a directory is a Git repository
 */
/**
 * Validate that a path points to a git repository
 *
 * This checks both filesystem existence and git metadata.
 */
export async function isValidGitRepo(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      return false;
    }

    const { git } = createGit(path);
    await git.revparse(['--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * @deprecated Use `isValidGitRepo` instead.
 *
 * Kept for backwards compatibility.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  return isValidGitRepo(path);
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { git } = createGit(repoPath);
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
  const { git } = createGit(repoPath);

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
  const { git } = createGit(repoPath);
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || '';
}

/**
 * Check if working directory is clean (no uncommitted changes)
 */
export async function isClean(repoPath: string): Promise<boolean> {
  const { git } = createGit(repoPath);
  const status = await git.status();
  return status.isClean();
}

/**
 * Get remote URL
 */
export async function getRemoteUrl(
  repoPath: string,
  remote: string = 'origin'
): Promise<string | null> {
  try {
    const { git } = createGit(repoPath);
    const remotes = await git.getRemotes(true);
    const remoteObj = remotes.find((r) => r.name === remote);
    return remoteObj?.refs.fetch ?? null;
  } catch {
    return null;
  }
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
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  ref: string,
  createBranch: boolean = false,
  pullLatest: boolean = true,
  sourceBranch?: string,
  env?: Record<string, string>,
  refType?: 'branch' | 'tag'
): Promise<void> {
  console.log('🔍 createWorktree called with:', {
    repoPath,
    worktreePath,
    ref,
    createBranch,
    pullLatest,
    sourceBranch,
    refType,
  });

  if (!repoPath) {
    throw new Error('repoPath is required but was null/undefined');
  }

  // Validate caller-supplied refs before they hit the git CLI, to prevent
  // option injection (e.g. ref = "--upload-pack=/tmp/payload") and command
  // smuggling via newlines.
  await validateGitRef(ref);
  if (sourceBranch !== undefined) {
    await validateGitRef(sourceBranch);
  }

  const { git, credPath } = createGit(repoPath, env);

  let fetchSucceeded = false;

  try {
    // Pull latest from remote if requested
    if (pullLatest) {
      try {
        // Fetch branches, and tags only if working with a tag
        const fetchArgs = refType === 'tag' ? ['origin', '--tags'] : ['origin'];
        await git.fetch(fetchArgs);
        fetchSucceeded = true;
        console.log('✅ Fetched latest from origin');

        // If not creating a new branch and this is a branch (not a tag), update local branch to match remote
        // Tags don't need this update - they're immutable and don't have origin/ prefix
        if (!createBranch && refType !== 'tag') {
          try {
            // Check if local branch exists
            const branches = await git.branch();
            const localBranchExists = branches.all.includes(ref);

            if (localBranchExists) {
              // Update local branch to match remote (if remote exists)
              const remoteBranches = await git.branch(['-r']);
              const remoteBranchExists = remoteBranches.all.includes(`origin/${ref}`);

              if (remoteBranchExists) {
                // Reset local branch to match remote.
                // `--` separator not supported by `git branch`; ref has already
                // been validated by validateGitRef above.
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

    const worktreeAddArgs = buildWorktreeAddArgs({
      worktreePath,
      ref,
      createBranch,
      sourceBranch,
      refType,
      fetchSucceeded,
    });

    if (createBranch && sourceBranch && refType === 'tag') {
      console.log(`📌 Creating branch '${ref}' from tag '${sourceBranch}'`);
    }

    try {
      await git.raw(worktreeAddArgs);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle stale branch from previously deleted worktree
      if (createBranch && errorMessage.includes('already exists')) {
        console.warn(
          `⚠️  Branch '${ref}' already exists. Checking if it's orphaned (stale from a deleted worktree)...`
        );

        // Check if the branch is in use by another worktree
        const worktrees = await listWorktrees(repoPath);
        const branchInUse = worktrees.some((wt) => wt.ref === ref);

        if (branchInUse) {
          throw new Error(
            `A branch named '${ref}' already exists and is in use by another worktree. ` +
              `Please choose a different name.`
          );
        }

        // Branch exists but is orphaned — delete it and retry.
        // `git branch -D` doesn't support `--`; ref was validated above.
        console.log(`🧹 Deleting orphaned branch '${ref}' and retrying worktree creation...`);
        await git.raw(['branch', '-D', ref]);

        // Retry the worktree creation
        await git.raw(worktreeAddArgs);
        console.log(`✅ Successfully created worktree after cleaning up stale branch '${ref}'`);
      } else {
        throw error;
      }
    }

    // Add worktree to safe.directory to prevent "dubious ownership" errors
    // This is needed when worktrees are owned by a different user (e.g., daemon user)
    // but accessed by other users (e.g., in multi-user Linux environments)
    let safeDirCredPath: string | undefined;
    try {
      const result = createGit(worktreePath, env);
      safeDirCredPath = result.credPath;
      await result.git.addConfig('safe.directory', worktreePath, true, 'global');
      console.log(`✅ Added ${worktreePath} to git safe.directory`);
    } catch (error) {
      // Non-fatal - log warning and continue
      console.warn(
        `⚠️  Failed to add ${worktreePath} to safe.directory:`,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await removeGitCredentialsFile(safeDirCredPath);
    }
  } finally {
    await removeGitCredentialsFile(credPath);
  }
}

/**
 * Result of a worktree restoration attempt
 */
export interface RestoreWorktreeResult {
  success: boolean;
  /** Which strategy was used: 'checkout' (existing branch) or 'create' (new branch from base) */
  strategy: 'checkout' | 'create';
  /** Error message if restoration failed */
  error?: string;
}

/**
 * Restore a worktree directory by checking out the branch or creating it from a base ref.
 *
 * Shared logic used by both:
 * - `sync-unix` CLI command (restore action for failed worktrees)
 * - `unarchive()` daemon method (via executor's git.worktree.add command)
 *
 * Strategy:
 * 1. Fetch from remote to ensure we have latest refs
 * 2. Check if the branch exists on the remote via `ls-remote`
 * 3. If YES: `createWorktree(repoPath, path, ref, false)` — checkout existing branch
 * 4. If NO: `createWorktree(repoPath, path, ref, true, true, baseRef)` — create new branch from base
 *
 * This is safe because we only create a new branch when `ls-remote` confirms it
 * doesn't exist on the remote, avoiding the orphan cleanup force-delete risk
 * in `createWorktree()`.
 *
 * @param repoPath - Absolute path to the base repository
 * @param worktreePath - Absolute path where the worktree should be created
 * @param ref - Branch name to restore
 * @param baseRef - Fallback base branch (e.g., 'main') if ref doesn't exist on remote
 * @param env - Optional environment variables for git operations (GITHUB_TOKEN, etc.)
 */
export async function restoreWorktreeFilesystem(
  repoPath: string,
  worktreePath: string,
  ref: string,
  baseRef: string,
  env?: Record<string, string>
): Promise<RestoreWorktreeResult> {
  // Validate refs early — this function both passes them to createWorktree
  // (which re-validates) and to ls-remote (which does not).
  await validateGitRef(ref);
  await validateGitRef(baseRef);

  const { git, credPath } = createGit(repoPath, env);

  try {
    // Step 1: Fetch from remote
    try {
      await git.fetch(['origin']);
      console.log(`[restoreWorktree] Fetched latest from origin`);
    } catch (error) {
      console.warn(
        `[restoreWorktree] Failed to fetch from origin (will use local refs):`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Step 2: Check if branch exists on remote via ls-remote
    // Using ls-remote instead of local branch list to get authoritative remote state
    let branchExistsOnRemote = false;
    try {
      const lsRemoteOutput = await git.listRemote(['--heads', 'origin', ref]);
      branchExistsOnRemote = lsRemoteOutput.trim().length > 0;
    } catch {
      // ls-remote failed, fall through to local branch check
      try {
        const branches = await git.branch(['-r']);
        branchExistsOnRemote = branches.all.includes(`origin/${ref}`);
      } catch {
        // Can't determine remote state
      }
    }

    // Step 3/4: Create worktree with appropriate strategy
    try {
      if (branchExistsOnRemote) {
        // Branch exists on remote — checkout it directly
        console.log(`[restoreWorktree] Branch '${ref}' found on remote, checking out`);
        await createWorktree(repoPath, worktreePath, ref, false, true, undefined, env);
        return { success: true, strategy: 'checkout' };
      }

      // Branch doesn't exist on remote — create new branch from base ref
      console.log(
        `[restoreWorktree] Branch '${ref}' not on remote, creating from base '${baseRef}'`
      );
      await createWorktree(repoPath, worktreePath, ref, true, true, baseRef, env);
      return { success: true, strategy: 'create' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[restoreWorktree] Failed to restore worktree: ${msg}`);
      return {
        success: false,
        strategy: branchExistsOnRemote ? 'checkout' : 'create',
        error: msg,
      };
    }
  } finally {
    await removeGitCredentialsFile(credPath);
  }
}

/**
 * List all worktrees for a repository
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const { git } = createGit(repoPath);
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
  const { git } = createGit(repoPath);
  await git.raw(['worktree', 'remove', '--force', worktreeName]);
}

/**
 * Clean a git worktree (remove untracked files and build artifacts)
 *
 * Runs git clean -fdx which removes:
 * - Untracked files and directories (-f -d)
 * - Ignored files (node_modules, build artifacts, etc.) (-x)
 *
 * Preserves:
 * - .git directory
 * - Tracked files
 * - Git state (commits, branches)
 *
 * In multi-user worktrees, files may be owned by different users (e.g., build artifacts
 * created by different user sessions). This function attempts to fix ownership before
 * cleaning to ensure all files can be removed.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param fixOwnership - Whether to attempt ownership fix via sudo (default: true)
 * @returns Disk space freed in bytes (approximate based on removed file count)
 */
export async function cleanWorktree(
  worktreePath: string,
  fixOwnership: boolean = true
): Promise<{ filesRemoved: number }> {
  const { git } = createGit(worktreePath);

  // Run git clean -fdx (force, directories, ignored files)
  // -n flag for dry run to count files
  const dryRunResult = await git.clean('fdxn');

  // Count files that would be removed
  // CleanSummary has a files array with removed files
  const filesRemoved = Array.isArray(dryRunResult.files) ? dryRunResult.files.length : 0;

  // In multi-user worktrees, fix ownership before cleaning
  if (fixOwnership) {
    try {
      const { execSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      const os = await import('node:os');

      // Verify worktree path exists
      if (!existsSync(worktreePath)) {
        throw new Error(`Worktree path does not exist: ${worktreePath}`);
      }

      // Get current user (who will own the files after chown)
      // When running in executor via sudo -u, this returns the impersonated user (e.g., agorpg)
      const currentUser = os.userInfo().username;

      // Attempt to chown the worktree to current user
      // This allows git clean to remove files owned by other users
      //
      // IMPORTANT: This requires sudoers configuration:
      // agor ALL=(ALL) NOPASSWD: /usr/bin/chown * /home/*/.agor/*
      //
      // The executor is already running as the daemon user (via sudo -u agorpg),
      // so this is effectively: sudo -n chown -R agorpg: /path/to/worktree
      try {
        const escapedPath = worktreePath.replace(/'/g, "'\\''");
        execSync(`sudo -n chown -R ${currentUser}: '${escapedPath}'`, {
          stdio: 'pipe',
          encoding: 'utf-8',
        });
        console.log(`[git.clean] Fixed ownership to ${currentUser} before clean`);
      } catch (_chownError) {
        // Chown failed - log but continue with git clean
        // Git clean will still remove what it can
        // This is expected in environments without sudo configuration
        console.warn(
          '[git.clean] Could not fix ownership (sudo not configured), continuing anyway'
        );
      }
    } catch (error) {
      // Ownership fix failed - log but continue
      console.warn('[git.clean] Error fixing ownership, continuing with clean:', error);
    }
  }

  // Run git clean
  // After ownership fix, this should be able to remove all files
  try {
    await git.clean('fdx');
  } catch (error) {
    // Check if this is just warnings (permission denied on some files)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isWarningsOnly =
      errorMessage.includes('warning:') && errorMessage.includes('failed to remove');

    if (!isWarningsOnly) {
      // Real error - rethrow
      throw error;
    }

    // Warnings only - log but don't fail
    // Some files couldn't be removed (multi-user env without sudo)
    console.warn(
      '[git.clean] Completed with warnings (some files could not be removed):',
      errorMessage
    );
  }

  return { filesRemoved };
}

/**
 * Prune stale worktree metadata
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  const { git } = createGit(repoPath);
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
  const { git } = createGit(repoPath);
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
  const { git } = createGit(repoPath);
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
      console.warn(`[getGitState] Not a git repo: ${repoPath}`);
      return 'unknown';
    }

    // Get current SHA via git log
    const sha = await getCurrentSha(repoPath);
    if (!sha) {
      // git log returned no commits — could be orphan branch or empty repo
      // Fall back to git rev-parse HEAD which works even when log doesn't
      try {
        const { git } = createGit(repoPath);
        const headSha = await git.revparse(['HEAD']);
        if (headSha) {
          const clean = await isClean(repoPath);
          const trimmed = headSha.trim();
          console.log(
            `[getGitState] git.log() returned no SHA but rev-parse HEAD succeeded: ${trimmed.substring(0, 8)} (${repoPath})`
          );
          return clean ? trimmed : `${trimmed}-dirty`;
        }
      } catch (revParseError) {
        console.warn(
          `[getGitState] Both git.log() and rev-parse HEAD failed for ${repoPath}:`,
          revParseError
        );
      }
      console.warn(
        `[getGitState] Could not determine SHA for ${repoPath} (git log returned empty)`
      );
      return 'unknown';
    }

    // Check if working directory is clean
    const clean = await isClean(repoPath);

    return clean ? sha : `${sha}-dirty`;
  } catch (error) {
    console.warn(`[getGitState] Failed for ${repoPath}:`, error);
    return 'unknown';
  }
}

/**
 * Delete a repository directory from filesystem
 *
 * Removes the repository directory and all its contents from ~/.agor/repos/.
 * This is typically used when deleting a remote repository that was cloned by Agor.
 *
 * @param repoPath - Absolute path to the repository directory
 * @throws Error if the path is not inside ~/.agor/repos/ (safety check)
 */
export async function deleteRepoDirectory(repoPath: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const { realpathSync, existsSync } = await import('node:fs');
  const { resolve, relative } = await import('node:path');

  // Safety check: ensure we're only deleting from ~/.agor/repos/
  const reposDir = getReposDir();

  // Use realpathSync to follow symlinks and canonicalize paths.
  // If the directory was already removed, fall back to resolving via parent.
  const resolvedReposDir = realpathSync(reposDir);
  const resolvedRepoPath = existsSync(repoPath)
    ? realpathSync(repoPath)
    : resolve(realpathSync(resolve(repoPath, '..')), resolve(repoPath).split('/').pop()!);

  // Get relative path from reposDir to repoPath
  const relativePath = relative(resolvedReposDir, resolvedRepoPath);

  // Check if relative path goes outside (starts with '..' or is absolute)
  if (relativePath.startsWith('..') || resolve(relativePath) === relativePath) {
    throw new Error(
      `Safety check failed: Repository path must be inside ${reposDir}. Got: ${repoPath}`
    );
  }

  // Additional safety: don't allow deleting the repos directory itself
  if (resolvedRepoPath === resolvedReposDir || relativePath === '') {
    throw new Error('Cannot delete the repos directory itself');
  }

  await rm(resolvedRepoPath, { recursive: true, force: true });
}

/**
 * Delete a worktree directory from filesystem
 *
 * Removes the worktree directory and all its contents from the worktrees directory.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @throws Error if the path is not inside the configured worktrees directory (safety check)
 */
export async function deleteWorktreeDirectory(worktreePath: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const { realpathSync, existsSync } = await import('node:fs');
  const { resolve, relative } = await import('node:path');

  // Safety check: ensure we're only deleting from configured worktrees directory
  const worktreesDir = getWorktreesDir();

  // Use realpathSync to follow symlinks and canonicalize paths.
  // If the worktree directory was already removed (e.g. by `git worktree remove`),
  // fall back to resolve() — the safety check still works since the base dir exists.
  const resolvedWorktreesDir = realpathSync(worktreesDir);
  const resolvedWorktreePath = existsSync(worktreePath)
    ? realpathSync(worktreePath)
    : resolve(realpathSync(resolve(worktreePath, '..')), resolve(worktreePath).split('/').pop()!);

  // Get relative path from worktreesDir to worktreePath
  const relativePath = relative(resolvedWorktreesDir, resolvedWorktreePath);

  // Check if relative path goes outside (starts with '..' or is absolute)
  if (relativePath.startsWith('..') || resolve(relativePath) === relativePath) {
    throw new Error(
      `Safety check failed: Worktree path must be inside ${worktreesDir}. Got: ${worktreePath}`
    );
  }

  // Additional safety: don't allow deleting the worktrees directory itself
  if (resolvedWorktreePath === resolvedWorktreesDir || relativePath === '') {
    throw new Error('Cannot delete the worktrees directory itself');
  }

  await rm(resolvedWorktreePath, { recursive: true, force: true });
}

/**
 * Delete a local git branch
 *
 * Uses -D (force delete) to handle branches that haven't been merged.
 * Silently succeeds if the branch doesn't exist.
 *
 * @param repoPath - Path to the repository
 * @param branchName - Branch name to delete
 * @returns true if branch was deleted, false if it didn't exist
 */
export async function deleteBranch(repoPath: string, branchName: string): Promise<boolean> {
  // `git branch -D` doesn't support `--` — rely on ref validation only.
  await validateGitRef(branchName);

  const { git } = createGit(repoPath);
  try {
    await git.raw(['branch', '-D', branchName]);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('not found')) {
      return false;
    }
    throw error;
  }
}

/**
 * Re-export simpleGit for use in services
 * Allows other packages to use simple-git through @agor/core dependency
 */
export { simpleGit };
