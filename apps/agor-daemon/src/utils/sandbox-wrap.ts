/**
 * Wrap an executor spawn in a filesystem-only OS sandbox (`bubblewrap`) at the
 * single spawn chokepoint, so EVERY agentic tool, terminal, and git/file op runs
 * under one filesystem policy — tool-agnostic.
 *
 * Filesystem-only by design: no `--unshare-net`, so the network namespace stays
 * shared and the executor keeps its daemon/model connectivity. Network egress
 * control, if wanted, is left to each tool's own config.
 *
 * Daemon-side + synchronous: takes the concrete paths the daemon already knows
 * from its own DB state (branch dir, base repo `local_path`, per-owner home
 * store) — it does NOT parse on-disk git pointers — resolves the policy via the
 * pure `@agor/core` resolver, and returns the `bwrap` command that replaces the
 * bare executor launch.
 *
 * See `context/explorations/executor-sandboxing.md`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  type AgorSandboxSettings,
  resolveBwrapArgs,
  type SandboxPathContext,
} from '@agor/core/config';

export interface SandboxWrap {
  cmd: string;
  args: string[];
  extraEnv: Record<string, string>;
}

let bwrapOnPathCache: boolean | undefined;
function bwrapAvailable(): boolean {
  if (bwrapOnPathCache !== undefined) return bwrapOnPathCache;
  bwrapOnPathCache = (process.env.PATH ?? '')
    .split(delimiter)
    .some((d) => d && existsSync(join(d, 'bwrap')));
  return bwrapOnPathCache;
}

/**
 * Build the `bwrap <args> -- <command>` wrapper for an executor command.
 * Returns null to spawn unwrapped (sandbox disabled, or `bwrap`/platform
 * unavailable and `fail_if_unavailable` is false). Throws when unavailable and
 * `fail_if_unavailable` is true.
 *
 * `baseRepoPath` (the base repo's `local_path` for a linked worktree) and
 * `ownerHomeStore` (the per-owner home store for `home_mode: per_user`) are
 * threaded from the daemon's authoritative state — never derived from disk.
 */
export function buildSandboxWrap(params: {
  sandbox: AgorSandboxSettings | undefined;
  cwd: string;
  cmd: string;
  args: string[];
  baseRepoPath?: string;
  ownerHomeStore?: string;
  /** RBAC-resolved fs access of the session owner to the branch. Default 'write'. */
  branchAccess?: 'write' | 'read' | 'none';
}): SandboxWrap | null {
  const { sandbox, cwd, cmd, args, baseRepoPath, ownerHomeStore, branchAccess } = params;
  if (!sandbox?.enabled) return null;

  const unavailableReason =
    process.platform !== 'linux'
      ? `filesystem sandbox requires Linux (bubblewrap); platform is ${process.platform}`
      : !bwrapAvailable()
        ? '`bwrap` (bubblewrap) is not on PATH'
        : null;
  if (unavailableReason) {
    if (sandbox.fail_if_unavailable) {
      throw new Error(
        `execution.sandbox.enabled but ${unavailableReason}. ` +
          'Install bubblewrap, or set execution.sandbox.fail_if_unavailable: false.'
      );
    }
    console.warn(`[Sandbox] ${unavailableReason} — spawning executor UNSANDBOXED.`);
    return null;
  }

  const home = homedir();
  const dataHome = process.env.AGOR_DATA_HOME?.trim() || join(home, '.agor');

  const perUser = sandbox.home_mode === 'per_user' && !!ownerHomeStore;
  if (perUser) {
    // The overlay `--bind`s the store over the passwd home; bwrap aborts if the
    // source is missing, so guarantee it exists (a fresh owner gets an empty
    // home; tools seed their own state, and migration pre-populates it).
    try {
      mkdirSync(ownerHomeStore as string, { recursive: true });
      // /tmp is bound to <store>/tmp (on-disk, per-user). bwrap `--bind` aborts
      // if the source is missing, so ensure it exists alongside the store.
      mkdirSync(join(ownerHomeStore as string, 'tmp'), { recursive: true });
    } catch (err) {
      throw new Error(
        `execution.sandbox.home_mode=per_user but the owner home store ` +
          `${ownerHomeStore} could not be created: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const ctx: SandboxPathContext = {
    branchPath: cwd,
    branchAccess,
    homeDir: home,
    // Worktrees root is <dataHome>/worktrees regardless of repo-slug depth
    // (slugs contain "/", so deriving from cwd is unreliable).
    worktreesRoot: join(dataHome, 'worktrees'),
    baseRepoPath,
    ownerHomeStore: perUser ? ownerHomeStore : undefined,
    agenticToolsPath: perUser ? join(dataHome, 'agentic-tools') : undefined,
    agorConfigPath: join(dataHome, 'config.yaml'),
    agorDbPath: join(dataHome, 'agor.db'),
  };

  const bwrapArgs = dropMasksForMissingTargets(resolveBwrapArgs(sandbox, ctx));
  return {
    cmd: 'bwrap',
    args: [...bwrapArgs, '--', cmd, ...args],
    // Tell the executor NOT to nest each tool's own sandbox inside ours.
    extraEnv: { AGOR_OUTER_SANDBOX: '1' },
  };
}

/**
 * A mask on a NON-existent path (`--tmpfs <dir>` or `--ro-bind /dev/null <file>`)
 * makes bubblewrap try to create the mountpoint under the read-only root and
 * abort. Drop such entries — a path that doesn't exist has nothing to hide.
 * (Real targets like /tmp and the worktrees root exist and are kept.)
 */
function dropMasksForMissingTargets(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    const a = args[i];
    if (a === '--tmpfs') {
      const dest = args[i + 1];
      if (dest && existsSync(dest)) out.push(a, dest);
      i += 2;
    } else if ((a === '--ro-bind' || a === '--ro-bind-try') && args[i + 1] === '/dev/null') {
      const dest = args[i + 2];
      if (dest && existsSync(dest)) out.push(a, '/dev/null', dest);
      i += 3;
    } else {
      out.push(a);
      i += 1;
    }
  }
  return out;
}
