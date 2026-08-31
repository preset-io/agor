/**
 * Operational Git Utilities for Agor
 *
 * Provides Git operations for repo management and branch isolation shared by daemon compatibility paths and executor commands.
 * Supports SSH keys, user environment variables (GITHUB_TOKEN), and system credential helpers.
 */

import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { resolveGitBinary } from './git-binary';
import {
  assertSafeGitRemoteUrl,
  buildAuthHeaderEnv,
  buildGitConfigEnv,
  extractRepoName,
  filterUserGitEnvironment,
  gitUrlHasUserinfo,
  parseHostFromGitUrl,
  parseHttpGitRemoteScope,
  redactGitUrlCredentials,
  stripGitUrlCredentials,
  type UserGitEnvironment,
} from './pure';

export { resolveGitBinary } from './git-binary';

export type RepoCloneErrorCategory =
  | 'auth_failed'
  | 'not_found'
  | 'network'
  | 'git_unavailable'
  | 'unknown';

export interface GitDiagnostic {
  status: 'ready' | 'missing';
  binary?: string;
  version?: string;
  detail?: string;
}

export interface GitDiagnosticOptions {
  resolveBinary?: () => string;
  version?: () => Promise<{
    installed: boolean;
    major: number;
    minor: number;
    patch: number;
  }>;
}

/**
 * Exercise the same simple-git path used by repository operations.
 * This is local-only: it neither reads a remote nor resolves credentials.
 * Call it in the process that will actually run the clone; daemon-side
 * checks cannot see an executor's filtered PATH or external-launcher environment.
 */
export async function diagnoseGit(options: GitDiagnosticOptions = {}): Promise<GitDiagnostic> {
  try {
    const binary = (options.resolveBinary ?? resolveGitBinary)();
    const result = await (options.version ?? (() => createGit().git.version()))();
    if (!result.installed) {
      return {
        status: 'missing',
        detail:
          'Git executable is unavailable. Install Git, ensure it is executable on PATH, ' +
          'and verify `git --version` before retrying.',
      };
    }
    return {
      status: 'ready',
      binary,
      version: `${result.major}.${result.minor}.${result.patch}`,
    };
  } catch (error) {
    return {
      status: 'missing',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

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
  await validateNamespacedGitRef(ref, 'heads', 'Invalid git ref');
}

async function validateNamespacedGitRef(
  ref: unknown,
  namespace: 'heads' | 'tags',
  errorPrefix: string
): Promise<void> {
  if (typeof ref !== 'string') {
    throw new Error(`${errorPrefix}: expected string, got ${typeof ref}`);
  }
  if (ref.length === 0) {
    throw new Error(`${errorPrefix}: empty string`);
  }
  if (ref.startsWith('-')) {
    throw new Error(
      `${errorPrefix}: refs starting with '-' are rejected to prevent option injection`
    );
  }
  // Whitespace, newlines, NUL — none of these are valid in refs, and a
  // newline in particular lets an attacker smuggle a second command.
  if (/[\s\0]/.test(ref)) {
    throw new Error(`${errorPrefix}: contains whitespace, newline, or NUL byte`);
  }

  // Final authoritative check: ask git itself.
  //
  // Use `check-ref-format refs/heads/<name>` (not `--branch`). `--branch`
  // mode resolves `@{-N}` against the current repository, which means it
  // fails outside a git branch — breaking callers like the seed script
  // that validate refs before a repo exists. The non-`--branch` form is
  // pure syntactic validation and needs no git context.
  //
  // Route through `createGit` so this pure syntactic check also uses the
  // package's isolated process environment and scanner policy.
  const { git } = createGit();
  try {
    await git.raw(['check-ref-format', `refs/${namespace}/${ref}`]);
  } catch {
    throw new Error(`${errorPrefix}: rejected by git check-ref-format: ${ref}`);
  }
}

/**
 * Get git binary path. Memoized — every git op routes through `createGit`,
 * so a per-call filesystem walk over 3 candidate paths × ~19 callsites adds
 * up on hot paths like branch refreshes. Resolved once at first use.
 */
let cachedGitBinary: string | undefined;
function getGitBinary(): string {
  if (cachedGitBinary === undefined) cachedGitBinary = resolveGitBinary();
  return cachedGitBinary;
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
 * Named for the underlying `git worktree add` CLI primitive rather than the
 * Agor "branch" entity it materialises — the carve-out keeps `worktree` in
 * names that wrap the git CLI directly, so a reader of this module isn't
 * misled into thinking "branch" here means a git branch.
 *
 * Exported so tests can assert the argv shape without spawning a real git.
 */
export function buildWorktreeAddArgs(params: {
  branchPath: string;
  ref: string;
  createBranch: boolean;
  sourceBranch?: string;
  refType?: 'branch' | 'tag';
  fetchSucceeded: boolean;
}): string[] {
  const { branchPath, ref, createBranch, sourceBranch, refType, fetchSucceeded } = params;

  const optionArgs: string[] = [];
  const positionalArgs: string[] = [branchPath];

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
 * {@link parseHostFromGitUrl}; authenticated transports always bind directly
 * to a trusted remote URL rather than a mutable repository remote.
 */
const DEFAULT_AUTH_HEADER_HOST = 'github.com';

export interface GitRemoteCredentialFinding {
  configPath: string;
  remote: string;
  key: 'url' | 'pushurl';
  redactedUrl: string;
  sanitizedUrl: string;
}

export interface GitRemoteCredentialScanResult {
  repoPath: string;
  configPaths: string[];
  findings: GitRemoteCredentialFinding[];
}

export interface GitRemoteCredentialScrubResult extends GitRemoteCredentialScanResult {
  changed: boolean;
}

function parseGitdirPointer(raw: string): string | undefined {
  const match = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  return match?.[1];
}

async function findGitConfigPaths(
  repoPath: string,
  options: { followWorktreePointer: boolean }
): Promise<string[]> {
  const dotGit = join(repoPath, '.git');
  const paths = new Set<string>();

  let dotGitStat: Awaited<ReturnType<typeof lstat>>;
  try {
    // Never let a checkout-controlled symlink select a config outside the
    // authoritative repository root. Legitimate linked worktrees use a plain
    // `.git` pointer file, handled separately for read-only scans below.
    dotGitStat = await lstat(dotGit);
  } catch {
    return [];
  }

  if (dotGitStat.isDirectory()) {
    paths.add(join(dotGit, 'config'));
  } else if (dotGitStat.isFile() && options.followWorktreePointer) {
    const pointer = parseGitdirPointer(await readFile(dotGit, 'utf8'));
    if (pointer) {
      const gitDir = isAbsolute(pointer) ? pointer : resolve(repoPath, pointer);
      paths.add(join(gitDir, 'config'));
      paths.add(join(gitDir, 'config.worktree'));

      // Git worktrees keep remotes in the common dir's config, while the
      // per-worktree gitdir may also have config.worktree. Check both.
      try {
        const commonDirRaw = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
        if (commonDirRaw) {
          const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(gitDir, commonDirRaw);
          paths.add(join(commonDir, 'config'));
        }
      } catch {
        // No commondir (or unreadable) — candidate above is enough.
      }
    }
  }

  const existing: string[] = [];
  for (const candidate of paths) {
    try {
      const candidateStat = await lstat(candidate);
      if (candidateStat.isFile()) existing.push(candidate);
    } catch {
      // Ignore missing candidate configs.
    }
  }
  return existing;
}

function parseRemoteSection(line: string): string | undefined {
  const match = line.match(/^\s*\[remote\s+"((?:\\.|[^"])*)"\]\s*(?:[#;].*)?$/);
  return match?.[1]?.replace(/\\"/g, '"');
}

function scrubGitConfigText(
  configPath: string,
  text: string,
  writeChanges: boolean
): { text: string; findings: GitRemoteCredentialFinding[]; changed: boolean } {
  const lines = text.split('\n');
  const findings: GitRemoteCredentialFinding[] = [];
  let currentRemote: string | undefined;
  let changed = false;

  const nextLines = lines.map((line) => {
    const remote = parseRemoteSection(line);
    if (remote !== undefined) {
      currentRemote = remote;
      return line;
    }
    if (/^\s*\[/.test(line)) {
      currentRemote = undefined;
      return line;
    }
    if (!currentRemote) return line;

    const match = line.match(/^(\s*)(url|pushurl)(\s*=\s*)(.*?)(\r?)$/i);
    if (!match) return line;

    const [, indent, rawKey, sep, rawValue, cr] = match;
    const value = rawValue.trim();
    if (!gitUrlHasUserinfo(value)) return line;

    const key = rawKey.toLowerCase() as 'url' | 'pushurl';
    const sanitizedUrl = stripGitUrlCredentials(value);
    findings.push({
      configPath,
      remote: currentRemote,
      key,
      redactedUrl: redactGitUrlCredentials(value),
      sanitizedUrl,
    });
    changed = true;
    return writeChanges ? `${indent}${rawKey}${sep}${sanitizedUrl}${cr}` : line;
  });

  return { text: nextLines.join('\n'), findings, changed };
}

/**
 * Scan a repo or worktree for credential-bearing remote URLs in its git config
 * without invoking git. For worktree pointer files, this checks both the
 * per-worktree gitdir and the shared common `.git/config`.
 */
export async function scanGitConfigRemoteCredentials(
  repoPath: string
): Promise<GitRemoteCredentialScanResult> {
  const configPaths = await findGitConfigPaths(repoPath, { followWorktreePointer: true });
  const findings: GitRemoteCredentialFinding[] = [];

  for (const configPath of configPaths) {
    const text = await readFile(configPath, 'utf8');
    findings.push(...scrubGitConfigText(configPath, text, false).findings);
  }

  return { repoPath, configPaths, findings };
}

/**
 * Repair credential-bearing remote URL entries in `.git/config` by replacing
 * each `remote.<name>.url` / `pushurl` value with the same URL minus userinfo.
 * Findings contain only redacted/sanitized values.
 */
export async function scrubGitConfigRemoteCredentials(
  repoPath: string
): Promise<GitRemoteCredentialScrubResult> {
  // Writes are intentionally limited to a direct `.git/config`. A mutable
  // worktree pointer is suitable for read-only diagnosis but is not authority
  // to choose a write destination. Managed worktree operations scrub the
  // daemon-selected base repository instead.
  const configPaths = await findGitConfigPaths(repoPath, { followWorktreePointer: false });
  const findings: GitRemoteCredentialFinding[] = [];
  let changed = false;

  for (const configPath of configPaths) {
    // O_NOFOLLOW closes the final-component swap between discovery and open;
    // retaining one descriptor for read/truncate/write avoids a second
    // pathname lookup after inspection.
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(configPath, constants.O_RDWR | constants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) continue;
      const text = await handle.readFile({ encoding: 'utf8' });
      const result = scrubGitConfigText(configPath, text, true);
      findings.push(...result.findings);
      if (result.changed) {
        await handle.truncate(0);
        await handle.writeFile(result.text, { encoding: 'utf8' });
        await handle.sync();
        changed = true;
      }
    } catch (error) {
      // A symlink/race is an unsafe target, not a reason to fall back to a
      // pathname-based write. Missing configs are harmless; other failures
      // propagate so callers never report a repair that did not happen.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      await handle?.close();
    }
  }

  return { repoPath, configPaths, findings, changed };
}

/**
 * Bucket a git error message into a coarse category so callers (UI, MCP) can
 * suggest the right next step.
 *
 * Returns the canonical `RepoCloneErrorCategory` union shared with the core
 * repository types so callers can persist it onto `Repo.clone_error.category`
 * without redeclaring the values. The matching is intentionally loose — git's stderr varies across
 * versions and remotes, and a false-positive `auth_failed` is cheaper than
 * `unknown` for the user trying to recover. `'auth_failed'` is the bucket whose
 * copy points users at User Settings → Env Vars (the most common reason private
 * clones silently failed pre-#1126).
 */
export function categorizeGitError(stderr: string): RepoCloneErrorCategory {
  const s = stderr.toLowerCase();
  if (
    s.includes('git executable is unavailable') ||
    s.includes('spawn git enoent') ||
    (s.includes('enoent') && s.includes('git'))
  ) {
    return 'git_unavailable';
  }
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
    s.includes('network error') ||
    s.includes('server certificate verification failed') ||
    s.includes('ssl certificate problem') ||
    s.includes('certificate verify failed') ||
    s.includes('certificate has expired') ||
    s.includes('self-signed certificate') ||
    s.includes('unable to verify the first certificate') ||
    s.includes('certificate subject name') ||
    s.includes('problem with the ssl ca cert') ||
    s.includes('unable to get local issuer certificate')
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
 * Minimal daemon/substrate process metadata a Git child may inherit.
 *
 * This is intentionally defined in the Git package rather than importing the
 * broader agent-runtime allowlist from `@agor/core` (which depends on this
 * package). In particular, no ambient proxy/TLS setting, `GIT_*`, XDG path,
 * SSH/GPG agent capability, or Agor deployment variable is copied. Network,
 * identity, and credential values must come from the explicit user Git DTO.
 */
const GIT_PROCESS_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'HOSTNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TERM',
  // Set by the daemon from security.git_config_parameters. User-controlled
  // maps cannot occupy this name; managed Git combines it with the stricter
  // operation-specific GIT_CONFIG_COUNT entries below.
  'GIT_CONFIG_PARAMETERS',
]);

export function buildGitProcessEnvironment(
  source: Record<string, string | undefined> = process.env
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (GIT_PROCESS_ENV_NAMES.has(key) || key.startsWith('LC_')) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Parse the exact single-quote protocol emitted by buildGitConfigParameters. */
function parseTrustedGitConfigParameters(encoded: string | undefined): [string, string][] {
  if (!encoded) return [];
  const entries: [string, string][] = [];
  let index = 0;
  const fail = () => {
    throw new Error('Invalid trusted GIT_CONFIG_PARAMETERS encoding');
  };
  while (index < encoded.length) {
    while (encoded[index] === ' ') index += 1;
    if (index >= encoded.length) break;
    if (encoded[index] !== "'") fail();
    index += 1;
    let pair = '';
    let closed = false;
    while (index < encoded.length) {
      if (encoded.startsWith("'\\''", index)) {
        pair += "'";
        index += 4;
        continue;
      }
      if (encoded[index] === "'") {
        index += 1;
        closed = true;
        break;
      }
      pair += encoded[index];
      index += 1;
    }
    if (!closed || (index < encoded.length && encoded[index] !== ' ')) fail();
    const equals = pair.indexOf('=');
    if (equals <= 0) fail();
    entries.push([pair.slice(0, equals), pair.slice(equals + 1)]);
  }
  return entries;
}

const FIXED_GIT_SECURITY_CONFIG: [string, string][] = [
  // Automated Agor operations must never execute checkout/commit hooks from a
  // mutable repository while an authenticated Git capability is in scope.
  ['core.hooksPath', '/dev/null'],
  // fsmonitor and ext transports are executable configuration surfaces.
  ['core.fsmonitor', 'false'],
  ['protocol.ext.allow', 'never'],
  // An empty helper resets lower-priority helper lists. Authentication is the
  // host-scoped extraheader constructed below, never repository-local code.
  ['credential.helper', ''],
  ['credential.interactive', 'false'],
];

function buildFixedGitEnvironment(
  configEntries: [string, string][],
  processSource: Record<string, string | undefined>
): Record<string, string> {
  const processEnv = buildGitProcessEnvironment(processSource);
  const trustedPolicy = parseTrustedGitConfigParameters(processEnv.GIT_CONFIG_PARAMETERS);
  delete processEnv.GIT_CONFIG_PARAMETERS;
  return {
    ...processEnv,
    // Managed Git never reads the executor account's personal or machine
    // config. Remote/network policy is an explicit user capability DTO;
    // local safety policy is constructed below. This prevents url rewrites,
    // includes, helpers, filters, and command hooks from entering through an
    // ambient daemon/executor installation.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // Operator policy is explicit trusted configuration, but command-specific
    // constraints are appended afterward and therefore win on duplicate keys.
    ...buildGitConfigEnv([...trustedPolicy, ...configEntries]),
  };
}

function isHttpRemote(remoteUrl: string): boolean {
  try {
    const protocol = new URL(remoteUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function authenticatedRemoteProtocolConfig(remoteUrl: string): [string, string][] {
  let protocol = 'file';
  if (/^https:\/\//i.test(remoteUrl)) protocol = 'https';
  else if (/^http:\/\//i.test(remoteUrl)) protocol = 'http';
  else if (/^git:\/\//i.test(remoteUrl)) protocol = 'git';
  else if (
    /^ssh:\/\//i.test(remoteUrl) ||
    (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remoteUrl) && /^(?:[^@\s]+@)?[^/:\s]+:/.test(remoteUrl))
  ) {
    protocol = 'ssh';
  }
  return [
    ['protocol.allow', 'never'],
    [`protocol.${protocol}.allow`, 'always'],
  ];
}

/**
 * Build the exact environment used by fixed Git children.
 *
 * The raw token is consumed to construct a host-scoped Authorization header,
 * then removed from the child map. This still treats the generated
 * `GIT_CONFIG_VALUE_n` as secret, but prevents hooks/helpers/other descendants
 * from receiving both the header and an unrelated generic credential bag.
 */
export function buildAuthenticatedGitTransportEnvironment(
  remoteUrl: string,
  userEnv: UserGitEnvironment | undefined,
  processSource: Record<string, string | undefined> = process.env
): Record<string, string> {
  const safeRemoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(remoteUrl));
  // HTTP credentials and credential-bearing proxy URLs are meaningful only
  // to Git's HTTP transport. Never expose them to local/file/SSH transports,
  // whose upload-pack/ssh descendants would otherwise receive the values.
  const { env: safeUserEnv } = filterUserGitEnvironment(isHttpRemote(safeRemoteUrl) ? userEnv : {});
  const rawToken = safeUserEnv.GITHUB_TOKEN ?? safeUserEnv.GH_TOKEN;
  const { GITHUB_TOKEN: _githubToken, GH_TOKEN: _ghToken, ...nonTokenUserEnv } = safeUserEnv;
  const httpScope = parseHttpGitRemoteScope(safeRemoteUrl);
  if (rawToken && httpScope?.protocol === 'http:') {
    throw new Error('Refusing to send a managed Git token over plain HTTP');
  }
  const configEntries = [
    ...FIXED_GIT_SECURITY_CONFIG,
    ...authenticatedRemoteProtocolConfig(safeRemoteUrl),
    ...buildAuthHeaderEnv(rawToken, httpScope?.authority ?? DEFAULT_AUTH_HEADER_HOST),
  ];

  return {
    ...buildFixedGitEnvironment(configEntries, processSource),
    ...nonTokenUserEnv,
  } as Record<string, string>;
}

function createGitClient(
  baseDir: string | undefined,
  spawnEnv: Record<string, string>
): { git: ReturnType<typeof simpleGit> } {
  const git = simpleGit({
    baseDir,
    binary: getGitBinary(),
    config: [],
    unsafe: {
      // simple-git's scanner cannot distinguish Agor's fixed defensive
      // GIT_CONFIG_* entries from attacker-controlled overrides. These are
      // the exact categories constructed in this module; caller maps never
      // receive a general unsafe opt-out.
      allowUnsafeConfigPaths: true,
      allowUnsafeConfigEnvCount: true,
      allowUnsafeHooksPath: true,
      allowUnsafeFsMonitor: true,
      allowUnsafeProtocolOverride: true,
      allowUnsafeCredentialHelper: true,
    },
  });
  git.env(spawnEnv);
  return { git };
}

/**
 * Create a credential-free local Git client.
 *
 * Repository-selected programs may still execute for operations such as
 * checkout and worktree add, but this process environment deliberately
 * contains no managed user or daemon credentials. Authenticated remote
 * transport uses the separate clean-staging capability below; filesystem
 * isolation remains the responsibility of the configured execution mode.
 */
export function createGit(baseDir?: string): { git: ReturnType<typeof simpleGit> } {
  const localConfig: [string, string][] = [...FIXED_GIT_SECURITY_CONFIG];
  if (baseDir) localConfig.push(['safe.directory', baseDir]);
  return createGitClient(baseDir, buildFixedGitEnvironment(localConfig, process.env));
}

/**
 * Credential-free client for Agor-controlled local object transfer only.
 *
 * The ordinary mutable-repository client keeps every transport disabled.
 * This narrower client admits the file transport solely where the caller
 * supplies an Agor-created private staging path, after the authenticated
 * network process has exited.
 */
function createLocalTransferGit(baseDir?: string): { git: ReturnType<typeof simpleGit> } {
  const localConfig: [string, string][] = [
    ...FIXED_GIT_SECURITY_CONFIG,
    ['protocol.allow', 'never'],
    ['protocol.file.allow', 'always'],
  ];
  if (baseDir) localConfig.push(['safe.directory', baseDir]);
  return createGitClient(baseDir, buildFixedGitEnvironment(localConfig, process.env));
}

/**
 * Create the only Git client allowed to carry user network credentials.
 *
 * `baseDir` must be an Agor-created, private, clean staging repository. Never
 * point this at a tenant/user-controlled repository: Git repository config is
 * executable policy (filters, sshCommand, askpass, url rewrites, includes,
 * helpers, and more). Callers use the higher-level staging helpers below.
 */
function createAuthenticatedGitTransport(
  remoteUrl: string,
  env: UserGitEnvironment | undefined,
  baseDir: string
): { git: ReturnType<typeof simpleGit> } {
  return createGitClient(
    baseDir,
    buildAuthenticatedGitTransportEnvironment(remoteUrl, env, process.env)
  );
}

async function withCleanTransportRepository<T>(
  remoteUrl: string,
  env: UserGitEnvironment | undefined,
  work: (git: ReturnType<typeof simpleGit>, stagingRepo: string) => Promise<T>
): Promise<T> {
  const safeRemoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(remoteUrl));
  const stagingRepo = await mkdtemp(join(tmpdir(), 'agor-git-transport-'));
  try {
    // Init is credential-free. Only after the empty private repository exists
    // do we construct the remote-bound client that carries the user's bounded
    // network capability.
    await createGit(stagingRepo).git.init(true);
    const { git } = createAuthenticatedGitTransport(safeRemoteUrl, env, stagingRepo);
    return await work(git, stagingRepo);
  } finally {
    await rm(stagingRepo, { recursive: true, force: true });
  }
}

interface RemoteRefTransfer {
  remoteRef: string;
  localRef: string;
}

/**
 * Fetch remote objects/refs through a private clean repository, then transfer
 * them into the mutable destination with a credential-free local fetch.
 */
async function transferRemoteRefs(
  repoPath: string,
  remoteUrl: string,
  env: UserGitEnvironment | undefined,
  refs: RemoteRefTransfer[]
): Promise<void> {
  if (refs.length === 0) return;
  const safeRemoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(remoteUrl));
  await withCleanTransportRepository(safeRemoteUrl, env, async (transportGit, stagingRepo) => {
    const operation = randomUUID();
    const staged = refs.map((ref, index) => ({
      ...ref,
      stagingRef: `refs/agor/transport/${operation}/${index}${ref.remoteRef.includes('*') ? '/*' : ''}`,
    }));
    await transportGit.fetch([
      safeRemoteUrl,
      ...staged.map(({ remoteRef, stagingRef }) => `+${remoteRef}:${stagingRef}`),
    ]);

    const localGit = createLocalTransferGit(repoPath).git;
    await localGit.fetch([
      stagingRepo,
      ...staged.map(({ stagingRef, localRef }) => `+${stagingRef}:${localRef}`),
    ]);
  });
}

async function listRemoteRef(
  remoteUrl: string,
  ref: string,
  env: UserGitEnvironment | undefined,
  kind: 'heads' | 'tags'
): Promise<string> {
  const safeRemoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(remoteUrl));
  return withCleanTransportRepository(safeRemoteUrl, env, (git) =>
    git.listRemote([kind === 'tags' ? '--tags' : '--heads', safeRemoteUrl, ref])
  );
}

async function cloneWithoutCredentialsAtCheckout(options: {
  remoteUrl: string;
  targetPath: string;
  cloneArgs: string[];
  env?: UserGitEnvironment;
  bare?: boolean;
}): Promise<void> {
  const safeRemoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(options.remoteUrl));
  if (!existsSync(options.targetPath)) await mkdir(options.targetPath, { recursive: true });

  // Keep authenticated transport in the executor's private tmp projection.
  // The final path is a distinct daemon-authorized sandbox mount, so no
  // rename of the surrounding worktrees/repos directory is required.
  const stagingRoot = await mkdtemp(join(tmpdir(), 'agor-git-clone-'));
  const transportRepo = join(stagingRoot, 'transport.git');
  const stagedClone = join(stagingRoot, 'repository');
  try {
    await mkdir(transportRepo);
    await createGit(transportRepo).git.init(true);
    const { git } = createAuthenticatedGitTransport(safeRemoteUrl, options.env, transportRepo);
    const cloneArgs = options.bare
      ? [...options.cloneArgs]
      : [...options.cloneArgs, '--no-checkout'];
    await git.clone(safeRemoteUrl, stagedClone, cloneArgs);

    // The second clone is local and credential-free. It copies the clean
    // object/ref result into the pre-created sandbox mount without contacting
    // a remote or materializing files.
    await createLocalTransferGit().git.clone(stagedClone, options.targetPath, [
      options.bare ? '--bare' : '--no-checkout',
      '--no-hardlinks',
    ]);
    await ensureGitRemoteUrl(options.targetPath, 'origin', safeRemoteUrl);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  if (!options.bare) {
    // Materialization may execute repository-selected filters. It therefore
    // happens only after the credential-bearing transport process has exited.
    await createGit(options.targetPath).git.raw(['reset', '--hard', 'HEAD']);
  }
}

/**
 * Register `path` as a git `safe.directory` in the daemon user's global
 * gitconfig. Delegated storage may expose paths owned by a different runtime principal,
 * which trips "dubious ownership". Non-fatal: logs a warning
 * and returns on failure, since the branch itself is already on disk.
 *
 * This is the one explicit host-global configuration operation in the
 * package. It carries no user/deployment secrets and uses only essential
 * runtime metadata. Ordinary managed Git clients never read that global file;
 * the entry exists for interactive/external Git processes sharing the
 * execution account.
 */
export async function addSafeDirectoryBestEffort(path: string, logPrefix?: string): Promise<void> {
  const prefix = logPrefix ? `${logPrefix} ` : '';
  try {
    const { git } = createGitClient(path, {
      ...buildGitProcessEnvironment(process.env),
      GIT_TERMINAL_PROMPT: '0',
    });
    await git.addConfig('safe.directory', path, true, 'global');
    console.log(`${prefix}✅ Added ${path} to git safe.directory`);
  } catch (error) {
    console.warn(
      `${prefix}⚠️  Failed to add ${path} to safe.directory:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export interface CloneOptions {
  url: string;
  /** Caller-resolved destination; this package does not own application filesystem layout. */
  targetDir: string;
  bare?: boolean;
  /**
   * Pin the working tree to a specific branch instead of the remote's HEAD.
   * Forwarded as `git clone --branch <name>`. Used when the operator wants
   * the repo's effective base to be a non-default branch — e.g. so `.agor.yml`
   * on a feature branch is what the daemon reads at clone time.
   */
  branch?: string;
  onProgress?: (progress: CloneProgress) => void;
  env?: UserGitEnvironment;
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

// Re-export pure git helpers for backward compatibility
export {
  assertSafeGitRemoteUrl,
  buildAuthHeaderEnv,
  buildGitConfigEnv,
  buildGitConfigParameters,
  extractRepoName,
  filterUserGitEnvironment,
  gitUrlHasUserinfo,
  isLikelyGitToken,
  parseHostFromGitUrl,
  parseHttpGitRemoteScope,
  redactGitUrlCredentials,
  stripGitUrlCredentials,
} from './pure';

/** Clone a Git repository to the caller-owned, explicitly resolved target directory. */
export async function cloneRepo(options: CloneOptions): Promise<CloneResult> {
  const cloneUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(options.url));
  if (cloneUrl !== options.url) {
    console.warn(
      `🔒 Stripped credentials from clone URL before use: ${redactGitUrlCredentials(options.url)}`
    );
  }

  const repoName = extractRepoName(cloneUrl);
  if (!options.targetDir) {
    throw new Error('cloneRepo requires an explicitly resolved targetDir');
  }
  const targetPath = options.targetDir;

  // Auth is delivered exclusively via the `http.<host>.extraheader` env-var
  // path configured by `createGit`. We deliberately do NOT splice the token
  // into the clone URL: doing so puts the credential on the child process's
  // argv (visible via `ps` / `/proc/<pid>/cmdline` to anyone on the host),
  // which is exactly the leak this refactor exists to close. See PR #1103.

  // Ensure the clone parent exists. Slug-derived targetDir values may be nested
  // (for example ~/.agor/repos/org/repo), not just direct children of reposDir.
  await mkdir(dirname(targetPath), { recursive: true });

  // Check if target directory already exists
  if (existsSync(targetPath)) {
    const targetStat = await lstat(targetPath);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`Clone target already exists and is not a real directory: ${targetPath}`);
    }
    // Check if it's a valid git repository
    const isValid = await isGitRepo(targetPath);

    if (isValid) {
      await scrubGitConfigRemoteCredentials(targetPath);
      // Repository already exists and is valid — reuse it. If the caller
      // pinned a branch, the working tree has to actually be on that branch
      // before we return: skipping the checkout silently leaves disk on the
      // previous branch while the caller writes the pin into the repo DB
      // record, so `.agor.yml` parsed at the cached `path` would come from
      // the wrong branch and the UI would log "no environment variants
      // configured" even though the user picked the right branch.
      console.log(`Repository already exists at ${targetPath}, using existing clone`);

      const existingGit = createGit(targetPath).git;

      if (options.branch) {
        const branches = await existingGit.branch();
        if (branches.current !== options.branch) {
          // Fetch from origin to make sure the pinned branch (and any
          // updates to it) are visible locally before checkout.
          try {
            await transferRemoteRefs(targetPath, cloneUrl, options.env, [
              {
                remoteRef: `refs/heads/${options.branch}`,
                localRef: `refs/remotes/origin/${options.branch}`,
              },
            ]);
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
    } else if ((await readdir(targetPath)).length > 0) {
      // Directory exists but is not a valid git repo
      throw new Error(
        `Directory exists but is not a valid git repository: ${targetPath}\n` +
          `Please delete this directory manually and try again.`
      );
    }
    // Git supports retrying a clone into an existing empty real directory.
  }

  // Clone into a private staging directory without a checkout, transfer the
  // clean repository locally into place, then materialize with a
  // credential-free client.
  // Repository filters/configuration therefore never coexist with the user's
  // token or credential-bearing proxy settings.
  const cloneArgs: string[] = [];
  if (options.bare) cloneArgs.push('--bare');
  if (options.branch) cloneArgs.push('--branch', options.branch);
  console.log(
    `Cloning ${redactGitUrlCredentials(cloneUrl)} to ${targetPath}${options.branch ? ` (branch: ${options.branch})` : ''}...`
  );
  await cloneWithoutCredentialsAtCheckout({
    remoteUrl: cloneUrl,
    targetPath,
    cloneArgs,
    env: options.env,
    bare: options.bare,
  });

  await scrubGitConfigRemoteCredentials(targetPath);

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
    return remoteObj?.refs.fetch ? stripGitUrlCredentials(remoteObj.refs.fetch) : null;
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
  expectedUrl: string
): Promise<EnsureRemoteUrlResult> {
  const { git } = createGit(repoPath);
  const safeExpectedUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(expectedUrl));
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
  if (currentUrls.length === 1 && currentUrls[0] === safeExpectedUrl) {
    return { changed: false, previousUrl: currentUrls[0] };
  }

  await git.raw(['config', '--replace-all', configKey, safeExpectedUrl]);
  return { changed: true, previousUrl: currentUrls.join('\n') };
}

/**
 * Parsed entry from `git worktree list --porcelain` output. Describes a
 * git-worktree primitive — not the Agor Branch entity (which carries env
 * config, board placement, owners, etc. on top of this).
 */
export interface GitWorktreeInfo {
  name: string;
  path: string;
  ref: string;
  sha: string;
  detached: boolean;
}

/**
 * Create a git branch
 */
export async function createBranch(
  repoPath: string,
  branchPath: string,
  ref: string,
  createBranch: boolean = false,
  pullLatest: boolean = true,
  sourceBranch?: string,
  env?: UserGitEnvironment,
  refType?: 'branch' | 'tag',
  /** Remote that owns sourceBranch when it differs from repoPath's origin. */
  sourceRemoteUrl?: string,
  /** Canonical tenant-owned destination remote from the database. */
  destinationRemoteUrl?: string
): Promise<void> {
  console.log('🔍 createBranch called with:', {
    repoPath,
    branchPath,
    ref,
    createBranch,
    pullLatest,
    sourceBranch,
    refType,
    sourceRemoteUrl: sourceRemoteUrl ? redactGitUrlCredentials(sourceRemoteUrl) : sourceRemoteUrl,
    destinationRemoteUrl: destinationRemoteUrl
      ? redactGitUrlCredentials(destinationRemoteUrl)
      : destinationRemoteUrl,
  });

  if (!repoPath) {
    throw new Error('repoPath is required but was null/undefined');
  }

  const scrubResult = await scrubGitConfigRemoteCredentials(repoPath);
  if (scrubResult.findings.length > 0) {
    console.warn(
      `🔒 Scrubbed ${scrubResult.findings.length} credential-bearing git remote URL(s) from ${scrubResult.configPaths.length} git config file(s) before creating a worktree branch.`
    );
  }

  // Refuse to clobber an existing directory. Matches createBranchAsClone's
  // guard, so worktree-mode and clone-mode surface the same user-facing
  // error when the path is already taken (typically by an archived or
  // partially-cleaned branch). Used to live in the daemon as a
  // synchronous preflight; moved here so the executor / core layer is the
  // single source of truth for filesystem facts.
  if (existsSync(branchPath)) {
    throw new Error(
      `Target directory '${branchPath}' already exists on disk. ` +
        'Please choose a different name or clean up the existing directory.'
    );
  }

  // Validate caller-supplied refs before they hit the git CLI, to prevent
  // option injection (e.g. ref = "--upload-pack=/tmp/payload") and command
  // smuggling via newlines.
  await validateGitRef(ref);
  if (sourceBranch !== undefined) {
    await validateGitRef(sourceBranch);
  }

  const safeSourceRemoteUrl = sourceRemoteUrl
    ? assertSafeGitRemoteUrl(stripGitUrlCredentials(sourceRemoteUrl))
    : undefined;
  const safeDestinationRemoteUrl = destinationRemoteUrl
    ? assertSafeGitRemoteUrl(stripGitUrlCredentials(destinationRemoteUrl))
    : undefined;
  if (
    pullLatest &&
    !safeSourceRemoteUrl &&
    !safeDestinationRemoteUrl &&
    Object.keys(env ?? {}).length > 0
  ) {
    throw new Error('Credential-bearing branch fetch requires destinationRemoteUrl');
  }
  if (safeSourceRemoteUrl && (!createBranch || !sourceBranch)) {
    throw new Error('sourceRemoteUrl requires createBranch=true and a sourceBranch');
  }
  if (
    safeSourceRemoteUrl &&
    (safeSourceRemoteUrl.startsWith('-') || /[\0\r\n]/.test(safeSourceRemoteUrl))
  ) {
    throw new Error('Invalid sourceRemoteUrl');
  }

  const { git } = createGit(repoPath);

  let fetchSucceeded = false;
  let effectiveSourceBranch = sourceBranch;
  let temporarySourceRef: string | undefined;

  // When the base ref belongs to another repository, fetch exactly that ref
  // into an operation-local namespace. Do not add a persistent remote: origin
  // must remain the destination repository for future pushes and restores.
  if (safeSourceRemoteUrl && sourceBranch) {
    const namespace = refType === 'tag' ? 'refs/tags' : 'refs/heads';
    temporarySourceRef = `refs/agor/base/${randomUUID()}`;
    try {
      await transferRemoteRefs(repoPath, safeSourceRemoteUrl, env, [
        {
          remoteRef: `${namespace}/${sourceBranch}`,
          localRef: temporarySourceRef,
        },
      ]);
    } catch (error) {
      // A failed fetch is normally atomic, but clean defensively in case the
      // transport updated the temporary ref before failing later.
      try {
        await git.raw(['update-ref', '-d', temporarySourceRef]);
      } catch {
        // Preserve the authoritative fetch failure.
      }
      throw error;
    }
    effectiveSourceBranch = temporarySourceRef;
    console.log(
      `✅ Fetched base ${namespace}/${sourceBranch} from ${redactGitUrlCredentials(safeSourceRemoteUrl)}`
    );
  } else if (pullLatest) {
    try {
      if (safeDestinationRemoteUrl) {
        const refs: RemoteRefTransfer[] = [
          { remoteRef: 'refs/heads/*', localRef: 'refs/remotes/origin/*' },
        ];
        if (refType === 'tag') {
          refs.push({ remoteRef: 'refs/tags/*', localRef: 'refs/tags/*' });
        }
        await transferRemoteRefs(repoPath, safeDestinationRemoteUrl, env, refs);
      } else {
        // Backwards-compatible credential-free path for local/test callers.
        // Production executor calls always supply the canonical database URL.
        const fetchArgs = refType === 'tag' ? ['origin', '--tags'] : ['origin'];
        await git.fetch(fetchArgs);
      }
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
    branchPath,
    ref,
    createBranch,
    sourceBranch: effectiveSourceBranch,
    refType,
    fetchSucceeded,
  });

  if (createBranch && sourceBranch && refType === 'tag') {
    console.log(`📌 Creating branch '${ref}' from tag '${sourceBranch}'`);
  }

  try {
    try {
      await git.raw(worktreeAddArgs);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle stale branch from previously deleted branch
      if (createBranch && errorMessage.includes('already exists')) {
        console.warn(
          `⚠️  Branch '${ref}' already exists. Checking if it's orphaned (stale from a deleted branch)...`
        );

        // Check if the branch is in use by another git worktree
        const worktrees = await listGitWorktrees(repoPath);
        const branchInUse = worktrees.some((wt) => wt.ref === ref);

        if (branchInUse) {
          throw new Error(
            `A branch named '${ref}' already exists and is in use by another branch. ` +
              `Please choose a different name.`
          );
        }

        // Branch exists but is orphaned — delete it and retry.
        // `git branch -D` doesn't support `--`; ref was validated above.
        console.log(`🧹 Deleting orphaned branch '${ref}' and retrying branch creation...`);
        await git.raw(['branch', '-D', ref]);

        // Retry the branch creation
        await git.raw(worktreeAddArgs);
        console.log(`✅ Successfully created branch after cleaning up stale branch '${ref}'`);
      } else {
        throw error;
      }
    }
  } finally {
    if (temporarySourceRef) {
      try {
        await git.raw(['update-ref', '-d', temporarySourceRef]);
      } catch (error) {
        console.warn(
          `⚠️  Failed to clean temporary base ref '${temporarySourceRef}':`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  // Register the branch as a safe.directory in the daemon user's
  // ~/.gitconfig — multi-user setups (branches owned by one uid, accessed
  // by another) trip "dubious ownership" otherwise. Non-fatal; the branch
  // itself is already on disk.
  await addSafeDirectoryBestEffort(branchPath);
}

/**
 * Options for {@link createBranchAsClone} — the self-standing-clone
 * counterpart to {@link createBranch}.
 *
 * Branch storage mode = 'clone' produces a working directory whose `.git/`
 * is a real directory (not a `gitdir:` pointer file), with its own
 * `.git/config`, refs, and credentials surface. Closes the cross-branch
 * leak vectors that the Layer A defenses exist to mitigate. See
 * `context/explorations/clone-redesign.md` §1.
 */
export interface CreateBranchAsCloneOptions {
  /** Remote URL to clone from (https://, ssh://, git@host:path, file://, or local path). */
  remoteUrl: string;
  /**
   * Destination URL to retain as origin after cloning from remoteUrl.
   * Use when the base ref is hosted by a separate template repository.
   */
  originRemoteUrl?: string;
  /** Absolute path where the new clone should land. Must not already exist by default. */
  targetPath: string;
  /**
   * Branch to clone. Forwarded as `git clone --branch <ref>`. The remote
   * must already have this ref. When {@link newBranchName} is also set,
   * this is the *base* ref the new branch is created off (the typical
   * "feature off main" flow).
   */
  ref: string;
  /**
   * Optional new branch to create after the clone, via
   * `git checkout -b <newBranchName>` against the cloned tip of {@link ref}.
   * Use this when the caller wants `createBranch=true` semantics in
   * clone-mode: the remote doesn't have the new branch yet, so we clone
   * the source and fork locally. Omit to just check out `ref` directly.
   */
  newBranchName?: string;
  /**
   * Optional shallow-clone depth. Positive integer → `--depth N`. Omit (or
   * pass `undefined`) for a full clone with complete history.
   */
  depth?: number;
  /**
   * `--single-branch`. Defaults to `true` — we only need the one branch we
   * just asked for, and skipping the rest is cheaper. Pass `false` for the
   * rare case where you want every remote ref locally.
   */
  singleBranch?: boolean;
  /**
   * Optional `git clone --reference <path>` object-cache borrow.
   *
   * When set AND the path is a full Git repository on the calling process's
   * filesystem at runtime, this turns the per-branch `.git/objects/` into an
   * `alternates` pointer at `<path>/.git/objects/` — disk drops from "full
   * pack copy" (hundreds of MB for big repos) to "a few MB of refs/config".
   * The config/credentials isolation that clone mode buys is preserved: only
   * the immutable object store is shared with the daemon-owned base clone.
   *
   * When set but the path is missing, invalid, or shallow (executor running
   * in a different mount, base clone not yet seeded, etc.), the `--reference`
   * flag is dropped and a regular clone runs — at higher disk cost but still
   * correct. Git rejects shallow reference repositories outright, so this is
   * part of the correctness fallback rather than only an optimization.
   *
   * That probe only covers *this* process's view. The alternates pointer it
   * writes is consumed by every later git command in the branch, from a
   * context that may not see `<path>` at all — lifecycle and session commands
   * run in the branch projection, and `sandbox.home_mode: per_user` masks the
   * daemon's `repos/` unless the authoritative lifecycle payload re-exposes a
   * path. Nothing observable here can predict that, so the decision is
   * made from configuration upstream: `shouldUseCloneReferencePath`
   * (apps/agor-daemon/src/utils/clone-reference.ts) stops the daemon passing a
   * `referencePath` at all for those deployments.
   *
   * NEVER paired with `--dissociate` for the normal path: dissociate repacks
   * the borrowed objects into the new clone, so the disk win is gone
   * (~equivalent to a naïve clone) even though the network transfer is still
   * saved. See design doc §5. It remains the right tool for *repairing* a
   * clone whose borrow already turned out to be unresolvable — `git repack -a
   * -d` (no `-l`, which would exclude exactly the borrowed objects) followed
   * by deleting `.git/objects/info/alternates`.
   *
   * Operational caveat: `git gc --prune=now` against the reference can
   * orphan objects that branches' alternates pointers still depend on.
   * Daemon-side base-cache management must avoid `--prune=now` (a future
   * `branch_storage.base_cache_gc_prune` config knob will enforce this).
   */
  referencePath?: string;
  /** Bounded user Git HTTP transport capability. */
  env?: UserGitEnvironment;
}

/**
 * Result of {@link createBranchAsClone}. Shape mirrors what the executor
 * handler wants out of {@link createBranch} so the call sites can stay
 * uniform across storage modes.
 */
export interface CreateBranchAsCloneResult {
  /** Absolute path of the created clone (echoes back `targetPath`). */
  path: string;
  /**
   * Branch the working tree is actually on after the call. Equal to
   * `newBranchName` when set (post-checkout); otherwise equal to `ref`.
   */
  ref: string;
}

export interface AssertRemoteRefVisibleForCloneOptions {
  /** Remote URL/path that clone-mode will pass to `git clone`. */
  remoteUrl: string;
  /** Branch/tag name that clone-mode will pass to `git clone --branch`. */
  ref: string;
  /** Which namespace to check. Defaults to branch refs. */
  refType?: 'branch' | 'tag';
  /** Bounded user Git HTTP transport capability. */
  env?: UserGitEnvironment;
}

/**
 * Check whether a clone-mode ref is visible from a remote.
 *
 * An empty, successful `ls-remote` means the ref is absent. Transport,
 * authentication, and other lookup failures are deliberately thrown so a
 * restore caller never mistakes an unavailable destination for a missing
 * branch and replaces it with a fresh base.
 */
export async function isRemoteRefVisibleForClone(
  options: AssertRemoteRefVisibleForCloneOptions
): Promise<boolean> {
  const remoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(options.remoteUrl));
  const refType = options.refType ?? 'branch';
  const ref = options.ref;

  if (!remoteUrl) {
    throw new Error('remoteUrl is required');
  }
  if (refType === 'branch') {
    await validateGitRef(ref);
  } else {
    await validateNamespacedGitRef(ref, 'tags', 'Invalid git tag ref');
  }

  const namespace = refType === 'tag' ? 'refs/tags' : 'refs/heads';
  let output: string;
  try {
    output = await listRemoteRef(
      remoteUrl,
      `${namespace}/${ref}`,
      options.env,
      refType === 'tag' ? 'tags' : 'heads'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot validate clone-mode ${refType} '${ref}' against remote ` +
        `${redactGitUrlCredentials(remoteUrl)}: ${message}`
    );
  }

  return output.trim().length > 0;
}

/**
 * Preflight a clone-mode base ref before Agor persists any branch/session
 * records. Clone mode can only materialise refs visible from the clone remote
 * (typically `origin`); a local-only branch in the daemon's base clone is not
 * cloneable via `git clone --branch`.
 */
export async function assertRemoteRefVisibleForClone(
  options: AssertRemoteRefVisibleForCloneOptions
): Promise<void> {
  if (!(await isRemoteRefVisibleForClone(options))) {
    const remoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(options.remoteUrl));
    const refType = options.refType ?? 'branch';
    throw new Error(
      `Clone mode cannot clone local-only or missing ${refType} '${options.ref}' because it is not visible on ` +
        `the remote ${redactGitUrlCredentials(remoteUrl)}. Push '${options.ref}' to origin, choose a remote ` +
        `${refType}, or use storage_mode='worktree' if it is enabled.`
    );
  }
}

/**
 * Create a self-standing clone of a remote at `targetPath` and check out a
 * branch. Sibling to {@link createBranch}; chosen at branch-create time
 * by the `storage_mode = 'clone'` opt-in.
 *
 * Two flows:
 *  - Without `newBranchName`: clone `ref` directly. Equivalent to
 *    `git clone --branch <ref> [--depth N] --single-branch <remoteUrl> <targetPath>`.
 *  - With `newBranchName`: clone `ref` as the base, then
 *    `git checkout -b <newBranchName>`. This is the typical "feature off
 *    main" flow that the create-time UI emits; the new branch doesn't
 *    exist on the remote yet, so we can't `git clone --branch <new>`.
 *
 * Unlike {@link createBranch}, this issues a real `git clone` and does
 * not touch the per-repo base clone at `~/.agor/repos/<slug>/`. The
 * resulting working directory has its own `.git/` directory — `.git/config`,
 * remotes, credentials, hooks, and refs are all branch-local.
 *
 * Implemented via `simple-git`; no `execSync`/`spawn`. Credentials are
 * delivered via `http.<host>.extraheader` env vars exactly like
 * {@link cloneRepo}, never on argv.
 *
 * @throws if `targetPath` already exists, either ref is invalid, the
 *         underlying clone fails (network, auth, missing base ref, …), or
 *         the post-clone `checkout -b` fails.
 */
export async function createBranchAsClone(
  options: CreateBranchAsCloneOptions
): Promise<CreateBranchAsCloneResult> {
  const { targetPath, ref, newBranchName, depth, referencePath, env } = options;
  const remoteUrl = assertSafeGitRemoteUrl(stripGitUrlCredentials(options.remoteUrl));
  const originRemoteUrl = options.originRemoteUrl
    ? assertSafeGitRemoteUrl(stripGitUrlCredentials(options.originRemoteUrl))
    : undefined;
  const singleBranch = options.singleBranch ?? true;

  if (!remoteUrl) {
    throw new Error('remoteUrl is required');
  }
  if (remoteUrl !== options.remoteUrl) {
    console.warn(
      `🔒 Stripped credentials from clone-mode remote URL before use: ${redactGitUrlCredentials(options.remoteUrl)}`
    );
  }
  if (options.originRemoteUrl && !originRemoteUrl) {
    throw new Error('originRemoteUrl is required when provided');
  }
  if (!targetPath) {
    throw new Error('targetPath is required');
  }
  await validateGitRef(ref);
  if (newBranchName !== undefined) {
    await validateGitRef(newBranchName);
  }
  if (depth !== undefined && (!Number.isInteger(depth) || depth <= 0)) {
    throw new Error(`Invalid clone depth: expected positive integer, got ${depth}`);
  }

  if (existsSync(targetPath)) {
    throw new Error(
      `Target directory '${targetPath}' already exists. ` +
        'Refusing to clone over existing contents — pick a different path or remove the directory first.'
    );
  }

  // Resolve `--reference` opportunistically: caller passes the base-cache
  // path they'd *like* to use; we verify it is a full Git repository on this
  // process's filesystem and otherwise fall back. Git refuses shallow
  // reference repositories, while remote executors may see an absent or
  // unrelated path. None of those cache-hint failures should prevent the
  // authoritative remote clone from succeeding.
  let useReference = false;
  if (referencePath) {
    if (!existsSync(referencePath)) {
      console.log(
        `[createBranchAsClone] referencePath '${referencePath}' not present on this filesystem — ` +
          `falling back to a full clone without --reference.`
      );
    } else {
      try {
        const { git: referenceGit } = createGit(referencePath);
        const rawGitDir = (await referenceGit.revparse(['--git-dir'])).trim();
        const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(referencePath, rawGitDir);
        if (existsSync(join(gitDir, 'shallow'))) {
          console.log(
            `[createBranchAsClone] referencePath '${referencePath}' is shallow — ` +
              `falling back to a clone without --reference.`
          );
        } else {
          useReference = true;
        }
      } catch (error) {
        console.warn(
          `[createBranchAsClone] referencePath '${referencePath}' is not a usable Git repository — ` +
            `falling back to a clone without --reference: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // `--branch <ref>` pins the working tree to the ref instead of remote HEAD.
  // `--single-branch` avoids pulling sibling branches we'll never look at.
  // `--depth N` (optional) shallow-truncates history.
  // `--reference <path>` (optional) borrows objects from a local base
  // clone via alternates; deliberately NOT paired with `--dissociate`
  // (see option doc above + design doc §5).
  const cloneArgs: string[] = ['--branch', ref];
  if (singleBranch) cloneArgs.push('--single-branch');
  if (depth !== undefined) cloneArgs.push('--depth', String(depth));
  if (useReference && referencePath) cloneArgs.push('--reference', referencePath);

  console.log(
    `[createBranchAsClone] Cloning ${redactGitUrlCredentials(remoteUrl)} → ${targetPath} ` +
      `(ref=${ref}${newBranchName ? `, newBranch=${newBranchName}` : ''}, ` +
      `depth=${depth ?? 'full'}, singleBranch=${singleBranch}, ` +
      `reference=${useReference ? referencePath : 'none'})`
  );
  await cloneWithoutCredentialsAtCheckout({
    remoteUrl,
    targetPath,
    cloneArgs,
    env,
  });
  await scrubGitConfigRemoteCredentials(targetPath);

  // Optional post-clone fork: create the new branch off the cloned tip.
  // simple-git's `.checkoutLocalBranch` issues `git checkout -b <name>`.
  // Re-scope to the working tree (not the original `git` instance, which
  // wasn't bound to a baseDir).
  let finalRef = ref;
  if (newBranchName) {
    console.log(
      `[createBranchAsClone] Creating local branch '${newBranchName}' off cloned '${ref}'`
    );
    const { git: cloneGit } = createGit(targetPath);
    await cloneGit.checkoutLocalBranch(newBranchName);
    finalRef = newBranchName;
  }

  // A template repository may own the base ref while the newly-created
  // branch belongs to a private destination repository. Clone the former to
  // materialize the right content, then restore origin to the latter so
  // future push/pull operations never target the template repository.
  if (originRemoteUrl && originRemoteUrl !== remoteUrl) {
    await ensureGitRemoteUrl(targetPath, 'origin', originRemoteUrl);
    const { git: cloneGit } = createGit(targetPath);

    // `--single-branch` leaves origin's fetch refspec pinned to the template
    // branch. Once origin points at the destination, that refspec would make
    // ordinary fetches ignore every destination branch. Reset it to the
    // normal full-heads mapping and remove remote-tracking refs that describe
    // the template source, not the newly configured origin.
    await cloneGit.raw([
      'config',
      '--replace-all',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    const staleOriginRefs = (
      await cloneGit.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
    )
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    for (const staleOriginRef of staleOriginRefs) {
      await cloneGit.raw(['update-ref', '-d', staleOriginRef]);
    }
    const localBranches = await cloneGit.branchLocal();
    if (newBranchName && localBranches.all.includes(ref)) {
      await cloneGit.deleteLocalBranch(ref, true);
    }
  }

  await addSafeDirectoryBestEffort(targetPath, '[createBranchAsClone]');

  return { path: targetPath, ref: finalRef };
}

/**
 * Result of a branch restoration attempt
 */
export interface RestoreBranchResult {
  success: boolean;
  /** Which strategy was used: 'checkout' (existing branch) or 'create' (new branch from base) */
  strategy: 'checkout' | 'create';
  /** Error message if restoration failed */
  error?: string;
}

/**
 * Restore a branch directory by checking out the branch or creating it from a base ref.
 *
 * Shared logic used by both:
 * - `unarchive()` daemon method (via executor's git.branch.add command)
 *
 * Strategy:
 * 1. Fetch from remote to ensure we have latest refs
 * 2. Check if the branch exists on the remote via `ls-remote`
 * 3. If YES: `createBranch(repoPath, path, ref, false)` — checkout existing branch
 * 4. If NO: `createBranch(repoPath, path, ref, true, true, baseRef)` — create new branch from base
 *
 * This is safe because we only create a new branch when `ls-remote` confirms it
 * doesn't exist on the remote, avoiding the orphan cleanup force-delete risk
 * in `createBranch()`.
 *
 * @param repoPath - Absolute path to the base repository
 * @param branchPath - Absolute path where the branch should be created
 * @param ref - Branch name to restore
 * @param baseRef - Fallback base branch (e.g., 'main') if ref doesn't exist on remote
 * @param env - Optional environment variables for git operations (GITHUB_TOKEN, etc.)
 * @param baseRemoteUrl - Optional remote that owns baseRef when it differs from origin
 * @param baseRefType - Namespace of baseRef when creating the fallback branch
 */
export async function restoreBranchFilesystem(
  repoPath: string,
  branchPath: string,
  ref: string,
  baseRef: string,
  env?: UserGitEnvironment,
  baseRemoteUrl?: string,
  baseRefType: 'branch' | 'tag' = 'branch',
  /** Canonical tenant-owned destination remote from the database. */
  destinationRemoteUrl?: string
): Promise<RestoreBranchResult> {
  // Validate refs early — this function both passes them to createBranch
  // (which re-validates) and to ls-remote (which does not).
  await validateGitRef(ref);
  await validateGitRef(baseRef);

  const scrubResult = await scrubGitConfigRemoteCredentials(repoPath);
  if (scrubResult.findings.length > 0) {
    console.warn(
      `[restoreBranch] Scrubbed ${scrubResult.findings.length} credential-bearing git remote URL(s) before restore.`
    );
  }

  const safeDestinationRemoteUrl = destinationRemoteUrl
    ? assertSafeGitRemoteUrl(stripGitUrlCredentials(destinationRemoteUrl))
    : undefined;
  if (!safeDestinationRemoteUrl && Object.keys(env ?? {}).length > 0) {
    throw new Error('Credential-bearing branch restore requires destinationRemoteUrl');
  }
  const { git } = createGit(repoPath);

  // Step 1: Fetch from remote
  try {
    if (safeDestinationRemoteUrl) {
      await transferRemoteRefs(repoPath, safeDestinationRemoteUrl, env, [
        { remoteRef: 'refs/heads/*', localRef: 'refs/remotes/origin/*' },
      ]);
    } else {
      await git.fetch(['origin']);
    }
    console.log(`[restoreBranch] Fetched latest from origin`);
  } catch (error) {
    console.warn(
      `[restoreBranch] Failed to fetch from origin (will use local refs):`,
      error instanceof Error ? error.message : String(error)
    );
  }

  // Step 2: Check if branch exists on remote via ls-remote
  // Using ls-remote instead of local branch list to get authoritative remote state
  let branchExistsOnRemote = false;
  try {
    const lsRemoteOutput = safeDestinationRemoteUrl
      ? await listRemoteRef(safeDestinationRemoteUrl, `refs/heads/${ref}`, env, 'heads')
      : await git.listRemote(['--heads', 'origin', ref]);
    branchExistsOnRemote = lsRemoteOutput.trim().length > 0;
  } catch (error) {
    // A cached remote-tracking branch is still safe to restore while the
    // destination is temporarily unavailable. Without one, however, the
    // failure is not evidence that the branch is absent: creating from the
    // template could discard work that was already pushed to the destination.
    try {
      const branches = await git.branch(['-r']);
      branchExistsOnRemote = branches.all.includes(`origin/${ref}`);
      if (!branchExistsOnRemote) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          strategy: 'checkout',
          error: `Cannot determine whether branch '${ref}' exists on origin: ${message}`,
        };
      }
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        strategy: 'checkout',
        error: `Cannot determine whether branch '${ref}' exists on origin: ${message}`,
      };
    }
  }

  // Step 3/4: Create branch with appropriate strategy
  try {
    if (branchExistsOnRemote) {
      // Branch exists on remote — checkout it directly
      console.log(`[restoreBranch] Branch '${ref}' found on remote, checking out`);
      await createBranch(
        repoPath,
        branchPath,
        ref,
        false,
        true,
        undefined,
        env,
        undefined,
        undefined,
        safeDestinationRemoteUrl
      );
      return { success: true, strategy: 'checkout' };
    }

    // Branch doesn't exist on remote — create new branch from base ref
    console.log(`[restoreBranch] Branch '${ref}' not on remote, creating from base '${baseRef}'`);
    await createBranch(
      repoPath,
      branchPath,
      ref,
      true,
      true,
      baseRef,
      env,
      baseRefType,
      baseRemoteUrl,
      safeDestinationRemoteUrl
    );
    return { success: true, strategy: 'create' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[restoreBranch] Failed to restore branch: ${msg}`);
    return {
      success: false,
      strategy: branchExistsOnRemote ? 'checkout' : 'create',
      error: msg,
    };
  }
}

/**
 * List git-worktree entries registered with a repository (parsed
 * `git worktree list --porcelain` output).
 *
 * Wraps the git-CLI primitive, so the name reflects what git sees ("worktrees"
 * with a real `.git/worktrees/<name>/` entry in the base repo). Agor "branches"
 * in clone storage mode are not git worktrees of the base repo and won't appear
 * here — that's intentional; callers wanting the canonical list of Agor
 * branches should use `BranchRepository`.
 */
export async function listGitWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const { git } = createGit(repoPath);
  const output = await git.raw(['worktree', 'list', '--porcelain']);

  const worktrees: GitWorktreeInfo[] = [];
  const lines = output.split('\n');

  let current: Partial<GitWorktreeInfo> = {};

  for (const line of lines) {
    // Prefixes are git porcelain field names ('worktree' for path, 'branch'
    // for ref) — not our domain names, do not rename.
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
        worktrees.push(current as GitWorktreeInfo);
      }
      current = {};
    }
  }

  // Handle last entry
  if (current.path && current.sha) {
    worktrees.push(current as GitWorktreeInfo);
  }

  return worktrees;
}

/**
 * Remove a git-worktree entry from the base repo (`git worktree remove --force`).
 *
 * Wraps the git CLI directly — the name reflects the primitive, not the
 * Agor "Branch" entity. Branches in clone storage mode aren't registered as
 * git worktrees of the base repo and shouldn't go through this path.
 */
export async function removeGitWorktree(repoPath: string, branchName: string): Promise<void> {
  const { git } = createGit(repoPath);
  await git.raw(['worktree', 'remove', '--force', branchName]);
}

/**
 * Clean a git branch (remove untracked files and build artifacts)
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
 * @param branchPath - Absolute path to the branch directory
 * @returns Disk space freed in bytes (approximate based on removed file count)
 */
export async function cleanBranch(branchPath: string): Promise<{ filesRemoved: number }> {
  const { git } = createGit(branchPath);

  // Run git clean -fdx (force, directories, ignored files)
  // -n flag for dry run to count files
  const dryRunResult = await git.clean('fdxn');

  // Count files that would be removed
  // CleanSummary has a files array with removed files
  const filesRemoved = Array.isArray(dryRunResult.files) ? dryRunResult.files.length : 0;

  // Run git clean
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
    // Some files could not be removed by the current execution substrate.
    console.warn(
      '[git.clean] Completed with warnings (some files could not be removed):',
      errorMessage
    );
  }

  return { filesRemoved };
}

/**
 * Prune stale git-worktree metadata (`git worktree prune`).
 *
 * Wraps the git CLI directly — used after manual filesystem removal to
 * tell git to drop the stale `.git/worktrees/<name>/` administrative entry.
 */
export async function pruneGitWorktrees(repoPath: string): Promise<void> {
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
          return clean ? trimmed : `${trimmed}-dirty`;
        }
      } catch {
        // Fall through to the documented unknown result. Owning callers decide
        // whether and how to record contextual diagnostics.
      }
      return 'unknown';
    }

    // Check if working directory is clean
    const clean = await isClean(repoPath);

    return clean ? sha : `${sha}-dirty`;
  } catch {
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
 * @param allowedReposDir - Explicit safety root (tenant-scoped when applicable)
 * @throws Error if the path is not inside the allowed repositories root
 */
export async function deleteRepoDirectory(
  repoPath: string,
  allowedReposDir: string
): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const { realpathSync, existsSync } = await import('node:fs');
  const { resolve, relative } = await import('node:path');

  // Safety check: ensure we're only deleting from ~/.agor/repos/
  const reposDir = allowedReposDir;

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
 * Delete a branch directory from filesystem
 *
 * Removes the branch directory and all its contents from the branches directory.
 *
 * @param branchPath - Absolute path to the branch directory
 * @param allowedBranchesDir - Explicit safety root (tenant-scoped when applicable)
 * @throws Error if the path is not inside the configured branches directory (safety check)
 */
export async function deleteBranchDirectory(
  branchPath: string,
  allowedBranchesDir: string
): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const { realpathSync, existsSync } = await import('node:fs');
  const { resolve, relative } = await import('node:path');

  // Safety check: ensure we're only deleting from configured branches directory
  const branchesDir = allowedBranchesDir;

  // Use realpathSync to follow symlinks and canonicalize paths.
  // If the branch directory was already removed (e.g. by `git worktree remove`),
  // fall back to resolve() — the safety check still works since the base dir exists.
  const resolvedBranchesDir = realpathSync(branchesDir);
  const resolvedBranchPath = existsSync(branchPath)
    ? realpathSync(branchPath)
    : resolve(realpathSync(resolve(branchPath, '..')), resolve(branchPath).split('/').pop()!);

  // Get relative path from branchesDir to branchPath
  const relativePath = relative(resolvedBranchesDir, resolvedBranchPath);

  // Check if relative path goes outside (starts with '..' or is absolute)
  if (relativePath.startsWith('..') || resolve(relativePath) === relativePath) {
    throw new Error(
      `Safety check failed: Branch path must be inside ${branchesDir}. Got: ${branchPath}`
    );
  }

  // Additional safety: don't allow deleting the branches directory itself
  if (resolvedBranchPath === resolvedBranchesDir || relativePath === '') {
    throw new Error('Cannot delete the branches directory itself');
  }

  await rm(resolvedBranchPath, { recursive: true, force: true });
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
 * Re-export for test helpers only.
 * Production service code must use createGit() to get the unsafe-ops flags,
 * env hardening, and consistent git binary selection.
 */
export { simpleGit };
