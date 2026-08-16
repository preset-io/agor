/**
 * Executor filesystem-sandbox policy resolver (pure)
 *
 * Turns the operator-facing {@link AgorSandboxSettings} policy + the concrete
 * paths Agor already knows (branch dir, base repo, home, worktrees root) into a
 * **bubblewrap** argument list. The daemon prepends `bwrap <args> --` to every
 * executor invocation at the single spawn chokepoint, so filesystem isolation
 * is uniform across all agentic tools, terminals, and git/file ops.
 *
 * This is a **filesystem sandbox only**: we do NOT pass `--unshare-net`, so the
 * network namespace stays shared and the executor keeps its daemon/model
 * connectivity. (SRT/`srt` always unshare-nets, which severs the executor↔daemon
 * loopback — hence raw bwrap.)
 *
 * Pure — no `fs`, no `os`. The daemon supplies concrete paths from its own
 * authoritative state (branch dir, `repo.local_path`, home) — it does NOT parse
 * on-disk git pointers — and spawns `bwrap`.
 *
 * Ordering matters: bubblewrap applies binds left-to-right, and a later bind on
 * an overlapping path wins. We emit base → writable → denials so masks win.
 * See `context/explorations/executor-sandboxing.md`.
 */

import { dirname, join } from 'node:path';
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
   * The session owner's RBAC-resolved filesystem access to the branch, which
   * decides how the branch is mounted: `write` → `--bind` (rw), `read` →
   * `--ro-bind`, `none` → not mounted at all (task can't touch the branch).
   * Defaults to `write` (open-access / RBAC-off behavior) when omitted.
   */
  branchAccess?: 'write' | 'read' | 'none';
  /** The effective user's home directory (the passwd home / overlay mountpoint). */
  homeDir: string;
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
  // RBAC-aware branch mount: write → rw bind, read → ro bind, none → not mounted.
  const branchBindFlag =
    ctx.branchAccess === 'read' ? '--ro-bind' : ctx.branchAccess === 'none' ? null : '--bind';

  const args: string[] = [
    '--die-with-parent', // bwrap exits when the daemon kills the process group
    '--unshare-user', // unprivileged mount namespace (host uid preserved)
    '--ro-bind',
    '/',
    '/', // everything readable, nothing writable by default
    '--dev',
    '/dev',
    '--proc',
    '/proc',
  ];

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
    const homesParent = dirname(ctx.homeDir);
    if (homesParent && homesParent !== '/' && homesParent !== '.') {
      args.push('--tmpfs', homesParent);
    }
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
    if (include.branch && branchBindFlag) {
      args.push(branchBindFlag, ctx.branchPath, ctx.branchPath);
    }
    // Re-expose the base repo's shared git dir. It is a linked worktree's common
    // `.git` (refs/objects/config/hooks) shared across ALL worktrees, so it must
    // honor the SAME RBAC flag as the branch — otherwise a `read` collaborator
    // could mutate shared refs/hooks and cross session boundaries. write → rw
    // (commits), read → ro, none → not mounted.
    if (include.base_repo && ctx.baseRepoPath && branchBindFlag) {
      const gitDir = join(ctx.baseRepoPath, '.git');
      args.push(branchBindFlag, gitDir, gitDir);
    }
    // Re-expose managed tool binaries (hidden by the overlay); ro, tolerant of
    // a source-mode install that has no such dir.
    if (ctx.agenticToolsPath) {
      args.push('--ro-bind-try', ctx.agenticToolsPath, ctx.agenticToolsPath);
    }
    for (const p of sandbox.extra_allow_write ?? []) args.push('--bind', p, p);
    for (const p of sandbox.extra_deny_read ?? []) args.push('--ro-bind', '/dev/null', p);

    // Daemon trust-root masks — UNCONDITIONAL (not gated on protect_secrets).
    // Redundant when AGOR_DATA_HOME lives under the overlaid home (already
    // hidden by the overlay), but ESSENTIAL when it's OUTSIDE the home: the
    // overlay wouldn't cover it and `--ro-bind / /` would otherwise expose the
    // daemon's config.yaml / agor.db to a sandboxed executor.
    for (const file of [ctx.agorConfigPath, ctx.agorDbPath]) {
      if (file) args.push('--ro-bind', '/dev/null', file);
    }

    args.push('--setenv', 'HOME', ctx.homeDir);
    if (include.tmp) args.push('--setenv', 'TMPDIR', '/tmp');
    args.push('--chdir', ctx.branchPath);
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
  for (const p of sandbox.extra_allow_write ?? []) args.push('--bind', p, p);

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
