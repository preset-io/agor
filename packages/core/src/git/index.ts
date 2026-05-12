/**
 * Git Utils for Agor
 *
 * Provides Git operations for repo management and worktree isolation.
 * Supports SSH keys, user environment variables (GITHUB_TOKEN), and system credential helpers.
 *
 * When worktree RBAC is enabled, git operations run via `sudo su -` to ensure
 * fresh Unix group memberships (groups are cached at login time).
 */

import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { getReposDir, getWorktreesDir } from '../config/config-manager';
import type { RepoCloneErrorCategory } from '../types/repo';
import { escapeShellArg } from '../unix/run-as-user';

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
 * Get git binary path. Memoized — every git op routes through `createGit`,
 * so a per-call filesystem walk over 3 candidate paths × ~19 callsites adds
 * up on hot paths like worktree refreshes. Resolved once at first use.
 */
let cachedGitBinary: string | undefined;
function getGitBinary(): string {
  if (cachedGitBinary !== undefined) return cachedGitBinary;
  const commonPaths = [
    '/opt/homebrew/bin/git', // Homebrew on Apple Silicon
    '/usr/local/bin/git', // Homebrew on Intel
    '/usr/bin/git', // System git (Docker and Linux)
  ];
  for (const path of commonPaths) {
    if (existsSync(path)) {
      cachedGitBinary = path;
      return path;
    }
  }
  cachedGitBinary = 'git'; // PATH fallback
  return cachedGitBinary;
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
 * Fallback host for the `http.<URL>.extraheader` scope when none can be
 * derived from a clone URL or origin remote. Callers should prefer
 * {@link parseHostFromGitUrl} / {@link resolveAuthHost} so GitHub Enterprise
 * and self-hosted GitLab work transparently.
 */
const DEFAULT_AUTH_HEADER_HOST = 'github.com';

/**
 * Extract the hostname from a git remote URL.
 *
 * Accepts the three common forms:
 *   - HTTPS:    `https://host[:port]/owner/repo(.git)?`
 *   - SSH:      `ssh://[user@]host[:port]/owner/repo(.git)?`
 *   - SCP-like: `user@host:owner/repo(.git)?` (e.g. `git@github.com:foo/bar`)
 *
 * Returns the hostname (no port, no userinfo), or `undefined` when the URL
 * doesn't match any recognised shape. Used to scope `http.<URL>.extraheader`
 * to the right host so a GitHub Enterprise / GitLab token isn't silently
 * widened to github.com (or vice versa).
 */
export function parseHostFromGitUrl(url: string): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;

  // https:// and ssh:// — let the platform parse them. URL.hostname strips
  // userinfo, port, and IPv6 brackets correctly.
  if (/^(?:https?|ssh):\/\//.test(url)) {
    try {
      return new URL(url).hostname || undefined;
    } catch {
      return undefined;
    }
  }

  // SCP-like:  [user@]host:path  (e.g. git@github.com:foo/bar.git).
  // URL parser rejects this shape, so we still need a regex.
  // Reject paths starting with `/` — that's a local filesystem path.
  return url.match(/^(?:[^@\s:]+@)?([^/:\s]+):(?!\/)/)?.[1];
}

/**
 * Resolve the auth-header host for an existing repo by reading its origin
 * remote. Falls back to {@link DEFAULT_AUTH_HEADER_HOST} (with a warning) when
 * the remote can't be read or parsed — that branch silently sends a token to
 * github.com, so callers should hear about it.
 */
async function resolveAuthHost(repoPath: string): Promise<string> {
  try {
    const origin = await getRemoteUrl(repoPath, 'origin');
    if (origin) {
      const host = parseHostFromGitUrl(origin);
      if (host) return host;
    }
  } catch {
    // fall through to default
  }
  console.warn(
    `🔑 Could not derive auth host from origin in ${repoPath}; falling back to ${DEFAULT_AUTH_HEADER_HOST}. ` +
      `If this repo lives on GitHub Enterprise or a self-hosted forge, the auth header will be ineffective.`
  );
  return DEFAULT_AUTH_HEADER_HOST;
}

/**
 * Build the `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * env-var trio git treats as ad-hoc config — equivalent to `-c key=value` but
 * without the value ever landing on the process argv.
 *
 * @see https://git-scm.com/docs/git-config#ENVIRONMENT
 */
export function buildGitConfigEnv(entries: [string, string][]): Record<string, string> {
  if (entries.length === 0) return {};
  const out: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return out;
}

/**
 * Encode pairs into the `GIT_CONFIG_PARAMETERS` env-var value (single-quote
 * protocol — quotes are literal, not shell escaping, but the close-escape-
 * reopen pattern matches).
 *
 * Empty input returns `''` so callers can avoid setting the var at all.
 *
 * @see https://git-scm.com/docs/git-config#ENVIRONMENT
 */
export function buildGitConfigParameters(pairs: readonly string[]): string {
  return pairs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => escapeShellArg(p))
    .join(' ');
}

/**
 * Build the `http.<scope>.extraheader=Authorization: Basic <b64>` config entry
 * for HTTPS git auth.
 *
 * Header shape `Basic base64("x-access-token:<PAT>")` works for
 * GitHub / GitHub Enterprise / GitLab (any non-blank username + PAT). Bitbucket
 * Cloud expects the username `x-bitbucket-api-token-auth` and is not currently
 * supported — that would need a per-host username map plumbed through here.
 *
 * The `host` arg scopes the header so a token bound to one host can't reach
 * another (e.g. a malicious submodule URL at attacker.com gets nothing).
 */
export function buildAuthHeaderEnv(
  token: string | undefined,
  host: string = DEFAULT_AUTH_HEADER_HOST
): [string, string][] {
  if (!token) return [];
  if (!isLikelyGitToken(token)) {
    // Don't embed unknown-shape tokens — refuse rather than risk passing a
    // malformed value to git via an env var. Without an auth header, the clone
    // will fail loudly for private repos, which is preferable to silently
    // emitting a corrupted credential.
    console.warn(
      '🔑 Skipping http.extraheader: token does not match expected shape. ' +
        'Tokens must match /^[A-Za-z0-9_-]{20,255}$/. ' +
        'Re-save the token to enable the auth header.'
    );
    return [];
  }
  const credential = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  // Per-host scope: the header is only attached to requests against the
  // configured host. Submodule fetches at any other host get nothing.
  const key = `http.https://${host}/.extraheader`;
  return [[key, `Authorization: Basic ${credential}`]];
}

/**
 * Bucket a git error message into a coarse category so callers (UI, MCP) can
 * suggest the right next step.
 *
 * Returns the canonical `RepoCloneErrorCategory` union from `@agor/core/types`
 * so callers can persist it onto `Repo.clone_error.category` without redeclaring
 * the values. The matching is intentionally loose — git's stderr varies across
 * versions and remotes, and a false-positive `auth_failed` is cheaper than
 * `unknown` for the user trying to recover. `'auth_failed'` is the bucket whose
 * copy points users at Settings → API Keys (the most common reason private
 * clones silently failed pre-#1126).
 */
export function categorizeGitError(stderr: string): RepoCloneErrorCategory {
  const s = stderr.toLowerCase();
  if (
    s.includes('authentication failed') ||
    s.includes('could not read username') ||
    s.includes('could not read password') ||
    s.includes('terminal prompts disabled') ||
    s.includes('fatal: authentication') ||
    s.includes('http basic') ||
    s.includes('403 forbidden') ||
    s.includes('permission denied (publickey)')
  ) {
    return 'auth_failed';
  }
  if (
    s.includes('repository not found') ||
    s.includes('not found') ||
    s.includes('does not exist') ||
    s.includes('404')
  ) {
    return 'not_found';
  }
  if (
    s.includes('could not resolve host') ||
    s.includes('connection refused') ||
    s.includes('connection timed out') ||
    s.includes('operation timed out') ||
    s.includes('network is unreachable') ||
    s.includes('network error')
  ) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Mask `GIT_CONFIG_VALUE_<n>` entries carrying an `Authorization:` header.
 * Use before serialising env into logs / error reports. The match is loose
 * on purpose — a false-positive redaction is cheaper than a leaked token.
 */
export function redactGitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined) continue;
    const isConfigValue = /^GIT_CONFIG_VALUE_\d+$/.test(key);
    const looksLikeAuth = /authorization:/i.test(raw);
    out[key] = isConfigValue && looksLikeAuth ? '<redacted>' : raw;
  }
  return out;
}

/**
 * Create a configured simple-git instance.
 *
 * Unix-user impersonation is handled upstream when spawning the executor;
 * per-user credentials reach this function via `env` (e.g. from
 * `users.getGitEnvironment`).
 *
 * When `env.GITHUB_TOKEN` / `env.GH_TOKEN` is set, the token is fed to git as
 * `http.https://<authHost>/.extraheader` via the `GIT_CONFIG_COUNT/KEY/VALUE`
 * env trio — keeping it off argv (where simple-git's `config: [...]` would
 * put it, exposed via `ps`, audit logs, error reports). Per-host scoping
 * prevents a GitHub Enterprise token from reaching github.com (or vice versa).
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` blocks inheritance from the daemon user's
 * `~/.gitconfig` (which may carry an ambient `credential.helper` from
 * `gh auth login` that would silently leak the daemon's identity). Git ops
 * run as the daemon user (see `git-impersonation.ts`), so HOME is the
 * daemon's; if that ever changes to a true uid switch this must be removed.
 * `/etc/gitconfig` is intentionally NOT killed — admin policy territory
 * (CA bundles, proxies, safe.directory).
 *
 * @param authHost - Host to scope the auth header to. When omitted, falls back
 *                   to github.com; callers should derive this via
 *                   {@link parseHostFromGitUrl} or {@link resolveAuthHost}.
 */
export function createGit(
  baseDir?: string,
  env?: Record<string, string>,
  authHost?: string
): { git: ReturnType<typeof simpleGit> } {
  const gitBinary = getGitBinary();

  // Non-secret config stays in `config:` (becomes `-c key=value` on argv,
  // which is fine for these values).
  const config = [
    'core.sshCommand=ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
  ];

  // Auth header config goes through env vars so the token never lands on
  // argv. buildAuthHeaderEnv returns [] when no usable token is supplied.
  const rawToken = env?.GITHUB_TOKEN ?? env?.GH_TOKEN;
  const authConfigEntries = buildAuthHeaderEnv(rawToken, authHost ?? DEFAULT_AUTH_HEADER_HOST);

  // Build git env vars. Always set the isolation knobs when we are passing a
  // user env (i.e. doing per-user git work) — otherwise leave the daemon
  // user's environment untouched so commands that don't need credentials
  // (e.g. listWorktrees) keep working as before.
  let spawnEnv: Record<string, string> | undefined;
  if (env || authConfigEntries.length > 0) {
    spawnEnv = {
      ...process.env,
      ...(env ?? {}),
      // Inheritance kill (GLOBAL only): ignore the daemon user's
      // ~/.gitconfig. /etc/gitconfig is intentionally NOT killed — it is
      // admin-policy territory (CA bundles, proxies). See block comment.
      GIT_CONFIG_GLOBAL: '/dev/null',
      // Fail fast instead of blocking on an interactive credential prompt
      // (which would hang the daemon).
      GIT_TERMINAL_PROMPT: '0',
      // Inject http.extraheader (and any future server-constructed config)
      // via the env-var protocol so it never lands on argv.
      ...buildGitConfigEnv(authConfigEntries),
    } as Record<string, string>;
  }

  const git = simpleGit({
    baseDir,
    binary: gitBinary,
    config,
    unsafe: {
      // simple-git's scanner blocks spawning when these env vars / config keys
      // are present. We own the daemon env (in strict mode it's the user's own
      // env) and inject GIT_CONFIG_* ourselves — opting in here mirrors what a
      // direct `git` invocation on the same machine does.
      allowUnsafeSshCommand: true,
      allowUnsafeConfigPaths: true,
      allowUnsafeConfigEnvCount: true,
      allowUnsafeEditor: true,
      allowUnsafeAskPass: true,
      allowUnsafePager: true,
      allowUnsafeGitProxy: true,
      allowUnsafeTemplateDir: true,
      allowUnsafeDiffExternal: true,
    },
  });

  // simple-git's constructor `spawnOptions` silently drops `env`; `git.env()`
  // is the supported path. It *replaces* the child's environment — we want
  // that, since the inheritance kill is the whole point.
  if (spawnEnv) {
    git.env(spawnEnv);
  }

  return { git };
}

export interface CloneOptions {
  url: string;
  targetDir?: string;
  bare?: boolean;
  /**
   * Pin the working tree to a specific branch instead of the remote's HEAD.
   * Forwarded as `git clone --branch <name>`. Used when the operator wants
   * the repo's effective base to be a non-default branch — e.g. so `.agor.yml`
   * on a feature branch is what the daemon reads at clone time.
   */
  branch?: string;
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
  const cloneUrl = options.url;

  const repoName = extractRepoName(cloneUrl);
  const reposDir = getReposDir();
  const targetPath = options.targetDir || join(reposDir, repoName);

  // Auth is delivered exclusively via the `http.<host>.extraheader` env-var
  // path configured by `createGit`. We deliberately do NOT splice the token
  // into the clone URL: doing so puts the credential on the child process's
  // argv (visible via `ps` / `/proc/<pid>/cmdline` to anyone on the host),
  // which is exactly the leak this refactor exists to close. See PR #1103.

  // Ensure repos directory exists
  await mkdir(reposDir, { recursive: true });

  // Check if target directory already exists
  if (existsSync(targetPath)) {
    // Check if it's a valid git repository
    const isValid = await isGitRepo(targetPath);

    if (isValid) {
      // Repository already exists and is valid — reuse it. If the caller
      // pinned a branch, the working tree has to actually be on that branch
      // before we return: skipping the checkout silently leaves disk on the
      // previous branch while the caller writes the pin into the repo DB
      // record, so `.agor.yml` parsed at the cached `path` would come from
      // the wrong branch and the UI would log "no environment variants
      // configured" even though the user picked the right branch.
      console.log(`Repository already exists at ${targetPath}, using existing clone`);

      const existingGit = createGit(targetPath, options.env, parseHostFromGitUrl(cloneUrl)).git;

      if (options.branch) {
        const branches = await existingGit.branch();
        if (branches.current !== options.branch) {
          // Fetch from origin to make sure the pinned branch (and any
          // updates to it) are visible locally before checkout.
          try {
            await existingGit.fetch(['origin', options.branch]);
          } catch (err) {
            throw new Error(
              `Existing clone at ${targetPath} is on branch '${branches.current}'; ` +
                `failed to fetch '${options.branch}' from origin: ${
                  err instanceof Error ? err.message : String(err)
                }`
            );
          }
          try {
            await existingGit.checkout(options.branch);
          } catch (err) {
            throw new Error(
              `Existing clone at ${targetPath} is on branch '${branches.current}'; ` +
                `failed to switch to pinned '${options.branch}': ${
                  err instanceof Error ? err.message : String(err)
                }`
            );
          }
        }
        return {
          path: targetPath,
          repoName,
          defaultBranch: options.branch,
        };
      }

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

  // Create git instance with user env vars (SSH host key checking is always disabled).
  // Derive the auth-header host from the clone URL so GitHub Enterprise and
  // self-hosted GitLab work without per-deployment configuration. (Bitbucket
  // Cloud needs a different username shape — see buildAuthHeaderEnv comments.)
  const authHost = parseHostFromGitUrl(cloneUrl);
  const { git } = createGit(undefined, options.env, authHost);

  if (options.onProgress) {
    git.outputHandler((_command, _stdout, _stderr) => {
      // Note: Progress tracking through outputHandler is limited
      // This is a simplified version - simple-git's progress callback
      // in constructor works better, but we need the binary path too
    });
  }

  // Clone using the original URL — auth is supplied via http.extraheader env vars.
  // If the caller pinned a branch, pass `--branch <name>` so the working tree
  // lands on that branch (instead of remote HEAD). Without this, repos whose
  // `.agor.yml` lives on a non-default branch would clone with the file
  // missing on disk and the daemon would log "No environment variants
  // configured" even though the user picked the right branch.
  const cloneArgs: string[] = [];
  if (options.bare) cloneArgs.push('--bare');
  if (options.branch) cloneArgs.push('--branch', options.branch);
  console.log(
    `Cloning ${options.url} to ${targetPath}${options.branch ? ` (branch: ${options.branch})` : ''}...`
  );
  await git.clone(cloneUrl, targetPath, cloneArgs);

  // Default branch: prefer the explicit pin (so the DB record matches what's
  // on disk); fall back to the remote's HEAD when the caller didn't pin one.
  const defaultBranch = options.branch ?? (await getDefaultBranch(targetPath));

  return {
    path: targetPath,
    repoName,
    defaultBranch,
  };
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

/**
 * `previousUrl` is newline-joined when the prior state was multi-valued (git
 * config legally allows that). Callers logging this MUST redact — values can
 * carry credentials.
 */
export interface EnsureRemoteUrlResult {
  changed: boolean;
  previousUrl: string | undefined;
}

/**
 * Realign `remote.<name>.url` to `expectedUrl`, leaving other remotes alone.
 * No-op when already matching; deliberately does NOT create the remote when
 * absent. Caller must trust `expectedUrl` (no validation here).
 *
 * Uses raw `git config --get-all` / `--replace-all` to handle the multi-value
 * case (`--add` semantics) — `simple-git.getRemotes()` surfaces only one
 * value, and `git remote set-url` errors when the key is multi-valued.
 */
export async function ensureGitRemoteUrl(
  repoPath: string,
  remoteName: string,
  expectedUrl: string,
  env?: Record<string, string>
): Promise<EnsureRemoteUrlResult> {
  const { git } = createGit(repoPath, env);
  const configKey = `remote.${remoteName}.url`;

  // `--get-all` exits 1 when the key is unset; absence ≡ "no remote".
  let currentUrls: string[];
  try {
    const raw = await git.raw(['config', '--get-all', configKey]);
    currentUrls = raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return { changed: false, previousUrl: undefined };
  }

  if (currentUrls.length === 0) {
    return { changed: false, previousUrl: undefined };
  }
  if (currentUrls.length === 1 && currentUrls[0] === expectedUrl) {
    return { changed: false, previousUrl: currentUrls[0] };
  }

  await git.raw(['config', '--replace-all', configKey, expectedUrl]);
  return { changed: true, previousUrl: currentUrls.join('\n') };
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

  // Derive the auth-header host from the repo's origin remote so the same
  // refactor works against GitHub Enterprise / self-hosted forges without
  // per-deployment config. Skip the extra `git remote -v` spawn when there's
  // no token to scope (the host would be unused).
  const hasToken = !!(env?.GITHUB_TOKEN ?? env?.GH_TOKEN);
  const authHost = hasToken ? await resolveAuthHost(repoPath) : undefined;
  const { git } = createGit(repoPath, env, authHost);

  let fetchSucceeded = false;

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
  // but accessed by other users (e.g., in multi-user Linux environments).
  //
  // IMPORTANT: do NOT pass the user `env` here. `createGit(_, env)` activates
  // the impersonation isolation block (`GIT_CONFIG_GLOBAL=/dev/null`), and
  // `addConfig(..., 'global')` writes to whatever `GIT_CONFIG_GLOBAL` points
  // at — git would try to lock `/dev/null` and fail with permission denied.
  // The safe.directory entry belongs in the daemon user's real `~/.gitconfig`
  // so daemon-side git ops (which do not load /dev/null) can find it.
  try {
    const { git: safeDirGit } = createGit(worktreePath);
    await safeDirGit.addConfig('safe.directory', worktreePath, true, 'global');
    console.log(`✅ Added ${worktreePath} to git safe.directory`);
  } catch (error) {
    // Non-fatal - log warning and continue
    console.warn(
      `⚠️  Failed to add ${worktreePath} to safe.directory:`,
      error instanceof Error ? error.message : String(error)
    );
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

  const hasToken = !!(env?.GITHUB_TOKEN ?? env?.GH_TOKEN);
  const authHost = hasToken ? await resolveAuthHost(repoPath) : undefined;
  const { git } = createGit(repoPath, env, authHost);

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
    console.log(`[restoreWorktree] Branch '${ref}' not on remote, creating from base '${baseRef}'`);
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
