/**
 * Executor sandbox policy resolver (pure)
 *
 * Turns the operator-facing {@link AgorSandboxSettings} policy + the concrete
 * paths Agor already knows (branch dir, base repo, home, worktrees root) into a
 * **bubblewrap** argument list. The daemon prepends `bwrap <args> --` to each
 * AGENT executor spawn (prompt tasks + web terminals) at the `spawnExecutorLocal`
 * chokepoint, so the isolation policy is uniform across all agentic tools and
 * terminals. Daemon-internal bounded executor commands (file reads, OAuth,
 * branch inspection, and other lifecycle work) may run unwrapped as Agor's
 * own code; prompt Git-state snapshots run inside the prompt executor.
 *
 * The sandbox unshares the **user + mount** namespaces (and the **PID**
 * namespace where the host allows it — see `pidNamespace`) but NOT the network:
 * we do NOT pass `--unshare-net`, so the executor keeps its daemon/model
 * loopback connectivity. (SRT/`srt` always unshare-nets, which severs the
 * executor↔daemon loopback — hence raw bwrap.)
 *
 * Pure — no `fs`, no `os`. The daemon supplies concrete paths from its own
 * authoritative state (branch dir, `repo.local_path`, home) — it does NOT parse
 * on-disk git pointers — and spawns `bwrap`.
 *
 * Ordering matters: bubblewrap applies binds left-to-right, and a later bind on
 * an overlapping path wins. We emit base → writable → denials so masks win.
 * See `context/explorations/executor-sandboxing.md`.
 */

import { dirname, isAbsolute, join, relative } from 'node:path';
import { CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES } from '../codex/credential-authority.js';
import type { AgorSandboxSettings } from './types';

/** Effective defaults for the Agor sugar layer. */
export const SANDBOX_INCLUDE_DEFAULTS = {
  branch: true,
  base_repo: true,
  tmp: true,
  home: false,
} as const;

export const SANDBOX_PROTECT_SECRETS_DEFAULT = true;
export const SANDBOX_ISOLATE_BRANCHES_DEFAULT = true;
export const SANDBOX_FAIL_IF_UNAVAILABLE_DEFAULT = false;
export const SANDBOX_HOME_MODE_DEFAULT = 'shared' as const;

/** Temp roots replaced with a fresh (task-private) tmpfs when `include.tmp`. */
export const SANDBOX_TMP_DIRS = ['/tmp', '/var/tmp'] as const;

/**
 * Home-relative dirs kept writable when `include.home` is false, so agentic
 * tools can still write their own config/cache/auth state and function.
 */
export const SANDBOX_HOME_WRITABLE_SUBDIRS = [
  '.cache',
  '.config',
  '.local',
  '.npm',
  '.claude',
  '.codex',
  '.gemini',
] as const;

/** Home-relative credential FILES masked (read-as-empty) under `protect_secrets`. */
export const SANDBOX_SECRET_HOME_FILES = ['.npmrc'] as const;
/** Home-relative credential DIRS masked (hidden via empty tmpfs) under `protect_secrets`. */
export const SANDBOX_SECRET_HOME_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  join('.config', 'gcloud'),
] as const;

/** Concrete paths the resolver needs — all absolute. Supplied by the daemon. */
export interface SandboxPathContext {
  /** Branch working directory (the task cwd). */
  branchPath: string;
  /**
   * Whether to unshare a PID namespace (`--unshare-pid`). Default (unset/true)
   * adds it — the secure baseline that hides the daemon/siblings from the
   * sandbox's /proc. The daemon sets this to `false` when the host cannot mount
   * proc in a nested PID namespace (common in containers), degrading to a
   * user+mount sandbox rather than failing.
   */
  pidNamespace?: boolean;
  /**
   * The session owner's RBAC-resolved filesystem access to the branch, which
   * decides how the branch is mounted: `write` → `--bind` (rw), `read` →
   * `--ro-bind`, `none` → not mounted at all (task can't touch the branch).
   * Defaults to `write` (open-access / RBAC-off behavior) when omitted.
   */
  branchAccess?: 'write' | 'read' | 'none';
  /** The effective user's home directory (the passwd home / overlay mountpoint). */
  homeDir: string;
  /**
   * Canonical target of {@link homeDir}, when it differs because the passwd
   * home traverses symlinks. Both paths must be hidden: otherwise the same
   * files remain reachable through the canonical alias beneath the root bind.
   */
  canonicalHomeDir?: string;
  /**
   * Agor's daemon data root. In a conventional install this is under
   * {@link homeDir} and the per-user overlay hides it automatically. Hosted
   * installs may place it elsewhere (for example on a persistent volume), in
   * which case per-user mode must mask it explicitly before re-exposing the
   * authorized branch and managed tools.
   */
  dataHome?: string;
  /** Canonical target of {@link dataHome}, for the same alias protection. */
  canonicalDataHome?: string;
  /** Additional deployment data roots (for example a custom tenants base). */
  protectedDataRoots?: string[];
  /** The worktrees root containing every branch dir. Required for `isolate_branches`. */
  worktreesRoot?: string;
  /**
   * The base repo's working-copy root (`repo.local_path`) for a linked
   * worktree — the daemon threads this from its own DB state (NOT by parsing
   * the on-disk `.git` pointer). Its `<base>/.git` is bound writable so commits
   * from the worktree work. Unset for self-standing clones.
   */
  baseRepoPath?: string;
  /**
   * Per-owner home store to overlay at {@link homeDir} when
   * `home_mode: per_user`. When set, it REPLACES the shared-home logic: the
   * overlay hides the daemon `.agor` tree + other homes by construction, so the
   * branch / base repo / agentic-tools are re-exposed on top. Absolute path;
   * the daemon guarantees it exists before spawn.
   */
  ownerHomeStore?: string;
  /** Canonical target of {@link ownerHomeStore}, when it differs through symlinks. */
  canonicalOwnerHomeStore?: string;
  /** Canonical targets used only to analyze final `extra_allow_write` aliases. */
  canonicalExtraAllowWritePaths?: string[];
  /**
   * Managed agentic-tools dir (`~/.agor/agentic-tools`) re-exposed read-only in
   * `per_user` mode (the overlay would otherwise hide it). Ignored in shared
   * mode. `--ro-bind-try`, so a source-mode install without it is fine.
   */
  agenticToolsPath?: string;
  /** Absolute path to `~/.agor/config.yaml` — masked under protect_secrets. */
  agorConfigPath?: string;
  /** Absolute path to `~/.agor/agor.db` — masked under protect_secrets. */
  agorDbPath?: string;
  /**
   * Per-branch SDK home to bind INTO the sandbox at its own real path (design
   * §7). When set, the branch's `branch-homes/<branchId>` directory is
   * `--bind`ed at the identical absolute path inside the sandbox, so the tool's
   * relocated config/state env vars (which name real sub-paths of this dir)
   * resolve to the same location inside and outside the sandbox. The daemon
   * guarantees the source exists before spawn (bwrap aborts on a missing
   * `--bind` source; `dropMasksForMissingTargets` only drops tmpfs/ro-bind,
   * never `--bind` — design §7.2). Unset means this Session is stamped for its
   * execution home, even if another Session on the branch uses branch state.
   */
  branchSdkHomeDir?: string;
  /**
   * Already-open caller credential inodes to mount over files inside
   * {@link branchSdkHomeDir}. File descriptors are child-process descriptor
   * numbers, not host paths; this prevents a symlink swap between validation
   * and bubblewrap setup. Destinations must already exist and stay below the
   * branch SDK home. Currently used only for Codex `auth.json`.
   */
  branchSdkCredentialBinds?: Array<{ fd: number; destination: string }>;
}

/**
 * Resolve an {@link AgorSandboxSettings} policy + paths into a bubblewrap
 * argument list (everything before the trailing `-- <command>`). Pure. Assumes
 * the caller already checked `sandbox.enabled`.
 */
export function resolveBwrapArgs(sandbox: AgorSandboxSettings, ctx: SandboxPathContext): string[] {
  const include = { ...SANDBOX_INCLUDE_DEFAULTS, ...(sandbox.include ?? {}) };
  const protectSecrets = sandbox.protect_secrets ?? SANDBOX_PROTECT_SECRETS_DEFAULT;
  const isolateBranches = sandbox.isolate_branches ?? SANDBOX_ISOLATE_BRANCHES_DEFAULT;
  const homeMode = sandbox.home_mode ?? SANDBOX_HOME_MODE_DEFAULT;
  // FAIL CLOSED: `per_user` MUST have a resolved owner store. Silently falling
  // back to the shared daemon home would defeat the whole point of the mode
  // (the caller asked for per-user isolation and would instead get the daemon's
  // home). The daemon is responsible for resolving/creating the store before
  // calling; a missing store is a programming error, not a soft downgrade.
  if (homeMode === 'per_user' && !ctx.ownerHomeStore) {
    throw new Error(
      'sandbox home_mode=per_user requires an owner home store, but none was resolved. ' +
        'Refusing to fall back to a shared home (fail closed).'
    );
  }
  const perUser = homeMode === 'per_user';
  const preserveCanonicalHomeAlias =
    perUser &&
    sandbox.preserve_canonical_home_alias === true &&
    !!ctx.canonicalHomeDir &&
    ctx.canonicalHomeDir !== ctx.homeDir;
  if (preserveCanonicalHomeAlias) {
    if (!isAbsolute(ctx.canonicalHomeDir as string) || ctx.canonicalHomeDir === '/') {
      throw new Error(
        `Invalid canonical sandbox home ${ctx.canonicalHomeDir}: expected an absolute path below /`
      );
    }
  }
  // RBAC-aware branch mount: write → rw bind, read → ro bind, none → not mounted.
  const branchBindFlag =
    ctx.branchAccess === 'read' ? '--ro-bind' : ctx.branchAccess === 'none' ? null : '--bind';

  const args: string[] = [
    '--die-with-parent', // bwrap exits when the daemon kills the process group
    '--unshare-user', // unprivileged mount namespace (host uid preserved)
  ];
  // Fresh PID namespace: the sandbox's /proc shows ONLY its own processes, so a
  // same-uid executor cannot reach the daemon's or a sibling's
  // /proc/<pid>/{environ,root,fd,...} — closing the process-side route around
  // the filesystem masks (independent of host ptrace_scope/hidepid). bwrap
  // becomes PID 1 and reaps; verified compatible with Agor's pgid-based Stop
  // (SIGTERM to the executor's process group tears down the whole tree, and the
  // kernel kills the namespace when bwrap exits). BEST-EFFORT: many container
  // runtimes block mounting proc in a nested PID namespace, so the daemon sets
  // `pidNamespace: false` when the host can't do it and we fall back to a
  // user+mount sandbox (in a container the container itself is the boundary).
  // NOT --unshare-net: the network stays shared for daemon/model loopback.
  if (ctx.pidNamespace !== false) args.push('--unshare-pid');
  args.push(
    '--ro-bind',
    '/',
    '/', // everything readable, nothing writable by default
    '--dev',
    '/dev',
    '--proc',
    '/proc'
  );

  if (perUser) {
    // ── per-user home overlay ──────────────────────────────────────────────
    // First wipe the homes PARENT dir (e.g. /home) with an empty tmpfs, so
    // sibling homes are not readable via the `--ro-bind / /` above. This is the
    // cross-user leak fix: without it, once per-user homes live at /home/<user>
    // (the migration layout via `filesystem_home`), one owner's session could
    // read another owner's ~/.codex/auth.json. The overlay below only replaces
    // OUR passwd home, not its siblings. Skip if the parent is `/` (e.g. a
    // /root home) — tmpfs-ing `/` would be catastrophic and root has no sibling
    // homes under a homes dir anyway.
    const hiddenRoots = new Set<string>();
    const homeDirs = [ctx.homeDir, ctx.canonicalHomeDir].filter((path): path is string => !!path);
    for (const homeDir of homeDirs) {
      if (!isAbsolute(homeDir)) {
        throw new Error(`Invalid sandbox home path ${homeDir}: expected an absolute path`);
      }
      const homesParent = dirname(homeDir);
      if (homesParent && homesParent !== '/' && homesParent !== '.') hiddenRoots.add(homesParent);
    }
    if (!isAbsolute(ctx.ownerHomeStore as string) || ctx.ownerHomeStore === '/') {
      throw new Error(
        `Invalid sandbox owner home ${ctx.ownerHomeStore}: expected an absolute path below /`
      );
    }
    // The home overlay only hides data stored below the passwd home. A hosted
    // deployment may keep AGOR_DATA_HOME on a persistent volume elsewhere; the
    // read-only root bind would otherwise leave sibling branches and daemon
    // files visible. Mask that root, then re-expose only the authorized paths
    // below. Bubblewrap resolves bind sources before applying these mounts, so
    // owner stores/branches beneath the masked root remain valid sources.
    // Prefer the canonical deployment root when the configured data home is a
    // symlink. Mounting a tmpfs on both the symlink and its target is not only
    // redundant (the target mask closes both routes), but bwrap cannot mount a
    // filesystem on a symlink destination reliably.
    const dataHomes = [
      ctx.canonicalDataHome ?? ctx.dataHome,
      ...(ctx.protectedDataRoots ?? []),
    ].filter((path): path is string => !!path);
    for (const dataHome of dataHomes) {
      if (!isAbsolute(dataHome) || dataHome === '/') {
        throw new Error(`Invalid sandbox data root ${dataHome}: expected an absolute path below /`);
      }
      if (!homeDirs.some((homeDir) => isPathWithin(dataHome, homeDir))) {
        hiddenRoots.add(dataHome);
      }
    }
    // Keep only outermost masks. Applying a tmpfs to a parent removes nested
    // mountpoints, so emitting another tmpfs for a child could make bwrap fail
    // even though the broader parent mask already provides the protection.
    for (const root of [...hiddenRoots]) {
      if ([...hiddenRoots].some((parent) => parent !== root && isPathWithin(root, parent))) {
        hiddenRoots.delete(root);
      }
    }
    for (const root of hiddenRoots) args.push('--tmpfs', root);
    // Bind the owner's private store OVER the passwd home. This single mount:
    //   • makes `~` a persistent, per-owner home (passwd home + $HOME + tilde
    //     all agree — no `$HOME`-vs-passwd split);
    //   • hides the ENTIRE daemon `.agor` tree (config.yaml, agor.db,
    //     worktrees, repos) by construction — so protect_secrets +
    //     isolate_branches are satisfied without extra masks.
    // The bind SOURCE is resolved from the host root (before the tmpfs above),
    // so a `filesystem_home` under the same parent still binds correctly.
    // We then re-expose exactly what the task needs ON TOP of the overlay.
    args.push('--bind', ctx.ownerHomeStore as string, ctx.homeDir);
    if (preserveCanonicalHomeAlias) {
      args.push('--bind', ctx.ownerHomeStore as string, ctx.canonicalHomeDir as string);
    }

    if (include.tmp) {
      // /tmp lives in the user's OWN home (on disk, per-user, persists across
      // turns) — NOT a RAM tmpfs (which can OOM on big builds) and NOT a shared
      // host /tmp (leaky). Bind <store>/tmp over /tmp; the daemon guarantees the
      // dir exists. It is the SAME underlying dir as ~/tmp (the overlay maps the
      // store to the home), so `/tmp` and `~/tmp` are one place. /var/tmp stays
      // a small ephemeral tmpfs. TMPDIR is pinned below so tools agree.
      args.push('--bind', join(ctx.ownerHomeStore as string, 'tmp'), '/tmp');
      args.push('--tmpfs', '/var/tmp');
    }
    // Re-expose the branch (its worktrees ancestor is hidden by the overlay),
    // rw / ro / not-at-all per the owner's RBAC access.
    const branchPaths = homeAliasPaths(ctx.branchPath, ctx, preserveCanonicalHomeAlias);
    if (include.branch && branchBindFlag) {
      for (const destination of branchPaths) {
        args.push(branchBindFlag, ctx.branchPath, destination);
      }
    }
    // Re-expose the base repo's shared git dir. It is a linked worktree's common
    // `.git` (refs/objects/config/hooks) shared across ALL worktrees, so it must
    // honor the SAME RBAC flag as the branch — otherwise a `read` collaborator
    // could mutate shared refs/hooks and cross session boundaries. write → rw
    // (commits), read → ro, none → not mounted.
    if (include.base_repo && ctx.baseRepoPath && branchBindFlag) {
      const gitDir = join(ctx.baseRepoPath, '.git');
      for (const destination of homeAliasPaths(gitDir, ctx, preserveCanonicalHomeAlias)) {
        args.push(branchBindFlag, gitDir, destination);
      }
    }
    // Re-expose managed tool binaries (hidden by the overlay); ro, tolerant of
    // a source-mode install that has no such dir.
    if (ctx.agenticToolsPath) {
      for (const destination of homeAliasPaths(
        ctx.agenticToolsPath,
        ctx,
        preserveCanonicalHomeAlias
      )) {
        args.push('--ro-bind-try', ctx.agenticToolsPath, destination);
      }
    }
    // Per-branch SDK home (design §7.1). Bound at its own real path, ON TOP of
    // the home overlay and after the agentic-tools re-expose, but BEFORE the
    // unconditional trust-root masks below. The branch-homes root lives under
    // the tenant data root, which the overlay masks with a tmpfs above; bwrap
    // resolves the bind SOURCE from the host root before applying that mask, so
    // re-exposing it here is valid.
    appendBranchSdkHomeBinds(args, ctx);
    for (const p of sandbox.extra_allow_write ?? []) args.push('--bind', p, p);
    appendBranchSdkCredentialBinds(args, ctx);

    // Daemon trust-root masks — UNCONDITIONAL (not gated on protect_secrets).
    // Redundant when AGOR_DATA_HOME lives under the overlaid home (already
    // hidden by the overlay), but ESSENTIAL when it's OUTSIDE the home: the
    // overlay wouldn't cover it and `--ro-bind / /` would otherwise expose the
    // daemon's config.yaml / agor.db to a sandboxed executor.
    for (const file of [ctx.agorConfigPath, ctx.agorDbPath]) {
      if (!file) continue;
      for (const destination of homeAliasPaths(file, ctx, preserveCanonicalHomeAlias)) {
        args.push('--ro-bind', '/dev/null', destination);
      }
    }

    // Claude's refreshable subscription grant and its mutation authority are
    // daemon-owned. First bind the REAL owner-store `.claude` directory onto
    // every reachable runtime alias. A bind mount is writable inside but its
    // mountpoint cannot be renamed/replaced, so settings, plugins, projects,
    // transcripts, and new ordinary CLI files retain their canonical paths
    // without letting a task swap out the parent and recreate authority leaves.
    //
    // The daemon safely materializes this source directory and every authority
    // leaf before bwrap starts. Use required --bind/--ro-bind here: a missing
    // source or destination is a containment failure, never a best-effort
    // downgrade. A custom filesystem_home outside all hidden deployment roots
    // remains reachable through its physical source path, so bind/mask it too.
    const ownerClaudeDirectory = join(ctx.ownerHomeStore as string, '.claude');
    // A canonical target closes both its own route and every symlink route to
    // it. Do not also mount the symlink destination: after the canonical data
    // root is hidden, bwrap cannot create parents through that symlink.
    const ownerClaudeDirectories = new Set([
      join(ctx.canonicalOwnerHomeStore ?? (ctx.ownerHomeStore as string), '.claude'),
    ]);
    const claudeDirectoryAliases = new Set(
      homeAliasPaths(join(ctx.homeDir, '.claude'), ctx, preserveCanonicalHomeAlias)
    );
    const writableAliases = new Set([
      ...(sandbox.extra_allow_write ?? []),
      ...(ctx.canonicalExtraAllowWritePaths ?? []),
    ]);
    // `extra_allow_write` is applied after the hidden-root overlays above. A
    // bind that overlaps the authority tree makes the physical `.claude`
    // reachable again even though the initial namespace analysis classified
    // its owner store as hidden. This includes both an ancestor (for example
    // the deployment data root) and a direct descendant (including an exact
    // `.claude` or authority-leaf bind). Treat that final mount graph as
    // authoritative and re-apply the immutable parent + leaf masks at the
    // physical alias. This containment is unconditional: an API-key/Codex task
    // must not gain an old Claude refresh grant merely because new managed
    // Claude OAuth admission is disabled for escape-hatch configurations.
    for (const physicalClaudeDirectory of ownerClaudeDirectories) {
      const physicalStore = dirname(physicalClaudeDirectory);
      const physicalStoreIsReachableInitially =
        ![...hiddenRoots].some((root) => isPathWithin(physicalStore, root)) &&
        !homeDirs.some((homeDir) => isPathWithin(physicalStore, homeDir));
      const physicalStoreReexposedByWritableBind = [...writableAliases].some(
        (path) =>
          isPathWithin(physicalClaudeDirectory, path) || isPathWithin(path, physicalClaudeDirectory)
      );
      if (physicalStoreIsReachableInitially || physicalStoreReexposedByWritableBind) {
        claudeDirectoryAliases.add(physicalClaudeDirectory);
      }
    }
    for (const destination of claudeDirectoryAliases) {
      args.push('--bind', ownerClaudeDirectory, destination);
    }

    // Managed-file tasks receive only a short-lived
    // CLAUDE_CODE_OAUTH_TOKEN through the sensitive executor credential
    // channel. Mask both the refreshable credential and every sidecar that
    // controls generation/serialization; otherwise a task can permanently DoS
    // refresh or split the cross-replica flock across two inodes. `/dev/null`
    // may be unreadable when rebound onto a nodev store, which is an acceptable
    // stronger mask and is covered by the pinned runtime/live tests.
    // Do NOT mask .codex/auth.json: Codex containment remains separate work.
    const authorityFilenames = [
      '.credentials.json',
      ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES,
    ] as const;
    for (const directory of claudeDirectoryAliases) {
      for (const filename of authorityFilenames) {
        args.push('--ro-bind', '/dev/null', join(directory, filename));
      }
    }

    // Operator denials are the final mounts so the Claude parent re-bind above
    // cannot accidentally shadow a narrower configured deny.
    for (const p of sandbox.extra_deny_read ?? []) args.push('--ro-bind', '/dev/null', p);

    args.push('--setenv', 'HOME', ctx.homeDir);
    if (include.tmp) args.push('--setenv', 'TMPDIR', '/tmp');
    args.push('--chdir', canonicalHomePath(ctx.branchPath, ctx, preserveCanonicalHomeAlias));
    return args;
  }

  // ── shared home (default) ─────────────────────────────────────────────────
  // ── task-private tmp (fresh empty tmpfs) ──
  if (include.tmp) {
    for (const dir of SANDBOX_TMP_DIRS) args.push('--tmpfs', dir);
  }

  // ── cross-branch isolation: hide the whole worktrees tree (re-expose our branch below) ──
  if (isolateBranches && ctx.worktreesRoot) {
    args.push('--tmpfs', ctx.worktreesRoot);
  }

  // ── writable roots (branch re-exposed AFTER the worktrees tmpfs above) ──
  // rw / ro / not-at-all per the owner's RBAC access.
  if (include.branch && branchBindFlag) {
    args.push(branchBindFlag, ctx.branchPath, ctx.branchPath);
  }
  // Shared common `.git` follows the branch's RBAC flag (see per-user block).
  if (include.base_repo && ctx.baseRepoPath && branchBindFlag) {
    const gitDir = join(ctx.baseRepoPath, '.git');
    args.push(branchBindFlag, gitDir, gitDir);
  }
  if (include.home) {
    args.push('--bind', ctx.homeDir, ctx.homeDir);
  } else {
    // Keep tool state/cache dirs writable so agents can actually run.
    for (const sub of SANDBOX_HOME_WRITABLE_SUBDIRS) {
      args.push('--bind-try', join(ctx.homeDir, sub), join(ctx.homeDir, sub));
    }
  }
  // Per-branch SDK home (design §7.1). Inserted AFTER the home-subdir binds so
  // it overrides them: the tool's env vars point into this branch-owned mount
  // rather than the daemon's real home, giving one directory per branch instead
  // of one shared home for all branches and users.
  appendBranchSdkHomeBinds(args, ctx);
  for (const p of sandbox.extra_allow_write ?? []) args.push('--bind', p, p);
  appendBranchSdkCredentialBinds(args, ctx);

  // ── denials LAST so they win over any writable/home bind above ──
  if (protectSecrets) {
    for (const file of [ctx.agorConfigPath, ctx.agorDbPath]) {
      if (file) args.push('--ro-bind', '/dev/null', file); // mask file → reads empty
    }
    for (const sub of SANDBOX_SECRET_HOME_FILES) {
      args.push('--ro-bind-try', '/dev/null', join(ctx.homeDir, sub));
    }
    for (const sub of SANDBOX_SECRET_HOME_DIRS) {
      args.push('--tmpfs', join(ctx.homeDir, sub)); // hide dir contents
    }
  }
  for (const p of sandbox.extra_deny_read ?? []) args.push('--ro-bind', '/dev/null', p);

  // Run in the branch dir.
  args.push('--chdir', ctx.branchPath);

  return args;
}

/**
 * Append the per-branch SDK home binds (design §7). Shared by both home modes so
 * the mount is identical regardless of overlay. The branch home is bound at its
 * own real path. No-op for an execution-home Session — the inert default path.
 */
function appendBranchSdkHomeBinds(args: string[], ctx: SandboxPathContext): void {
  if (!ctx.branchSdkHomeDir) return;
  if (!isAbsolute(ctx.branchSdkHomeDir)) {
    throw new Error(`Invalid branch SDK home ${ctx.branchSdkHomeDir}: expected an absolute path`);
  }
  args.push('--bind', ctx.branchSdkHomeDir, ctx.branchSdkHomeDir);
}

/** Mount validated credential inodes after the writable branch home. */
function appendBranchSdkCredentialBinds(args: string[], ctx: SandboxPathContext): void {
  if (!ctx.branchSdkCredentialBinds?.length) return;
  if (!ctx.branchSdkHomeDir || !isAbsolute(ctx.branchSdkHomeDir)) {
    throw new Error('Branch SDK credential binds require an absolute branch SDK home');
  }
  for (const bind of ctx.branchSdkCredentialBinds) {
    if (!Number.isSafeInteger(bind.fd) || bind.fd < 3) {
      throw new Error(`Invalid branch SDK credential file descriptor ${bind.fd}`);
    }
    if (
      !isAbsolute(bind.destination) ||
      relative(ctx.branchSdkHomeDir, bind.destination) === '' ||
      !isPathWithin(bind.destination, ctx.branchSdkHomeDir)
    ) {
      throw new Error(
        `Branch SDK credential destination ${bind.destination} must stay below ${ctx.branchSdkHomeDir}`
      );
    }
    args.push('--bind-fd', String(bind.fd), bind.destination);
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function homeAliasPaths(
  candidate: string,
  ctx: SandboxPathContext,
  preserveCanonicalHomeAlias: boolean
): string[] {
  if (!preserveCanonicalHomeAlias || !ctx.canonicalHomeDir) return [candidate];

  const alias = isPathWithin(candidate, ctx.homeDir)
    ? join(ctx.canonicalHomeDir, relative(ctx.homeDir, candidate))
    : isPathWithin(candidate, ctx.canonicalHomeDir)
      ? join(ctx.homeDir, relative(ctx.canonicalHomeDir, candidate))
      : undefined;
  return alias && alias !== candidate ? [candidate, alias] : [candidate];
}

function canonicalHomePath(
  candidate: string,
  ctx: SandboxPathContext,
  preserveCanonicalHomeAlias: boolean
): string {
  if (preserveCanonicalHomeAlias && ctx.canonicalHomeDir && isPathWithin(candidate, ctx.homeDir)) {
    return join(ctx.canonicalHomeDir, relative(ctx.homeDir, candidate));
  }
  return candidate;
}
