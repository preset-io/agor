/**
 * Wrap an AGENT executor spawn in an OS sandbox (`bubblewrap`: user + mount
 * namespaces, plus a PID namespace where the host allows it). Applied by the
 * local executor spawn chokepoints for agent workloads and branch-scoped
 * request commands, across all agentic tools (tool-agnostic).
 *
 * Branch-scoped request executors are wrapped when their server-authoritative
 * payload includes a branch cwd. Other daemon-internal commands remain
 * unwrapped because they have no branch filesystem projection.
 *
 * The network namespace stays shared (no `--unshare-net`), so the executor
 * keeps its daemon/model connectivity. Network egress control, if wanted, is
 * left to each tool's own config.
 *
 * Daemon-side + synchronous: takes the concrete paths the daemon already knows
 * from its own DB state (branch dir, base repo `local_path`, per-owner home
 * store) — it does NOT parse on-disk git pointers — resolves the policy via the
 * pure `@agor/core` resolver, and returns the `bwrap` command that replaces the
 * bare executor launch.
 *
 * See `context/explorations/executor-sandboxing.md`.
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES } from '@agor/core/codex/credential-file';
import {
  type AgorSandboxSettings,
  resolveBwrapArgs,
  type SandboxPathContext,
} from '@agor/core/config';
import { probeBwrapPidNamespace, probeBwrapSecurityBaseline } from '@agor/core/unix';

export interface SandboxWrap {
  cmd: string;
  args: string[];
  extraEnv: Record<string, string>;
}

/** Deployment paths resolved once from the daemon's immutable startup state. */
export interface SandboxRuntimePaths {
  homeDir: string;
  dataHome: string;
  protectedDataRoots: string[];
  worktreesRoot: string;
  agenticToolsPath: string;
  agorConfigPath: string;
  agorDbPath?: string;
}

function canonicalizeExistingPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

// SECURITY + FUNCTIONAL availability: bwrap must be 0.12.0+ (safe sandbox
// setup path resolution), support descriptor binds, and be able to create an
// unprivileged user namespace on this host (installed-but-blocked is common on
// hardened kernels). Cached once because the probes spawn processes.
let bwrapAvailableCache: boolean | undefined;
function bwrapAvailable(): boolean {
  if (bwrapAvailableCache === undefined) {
    // Descriptor binds are part of Agor's sandbox baseline, not an optional
    // Codex-only enhancement. They are the only race-safe way to project an
    // actor-writable credential file into a branch SDK home without resolving
    // its pathname again during mount setup.
    bwrapAvailableCache = probeBwrapSecurityBaseline();
  }
  return bwrapAvailableCache;
}

// Best-effort PID-namespace hardening: available on bare-metal hosts, commonly
// blocked in containers (can't mount proc in a nested PID ns). Cached; warned
// once so operators know the /proc process-side vector isn't closed on this
// host (in a container the container itself is the isolation boundary).
let pidNsCache: boolean | undefined;
function pidNamespaceAvailable(): boolean {
  if (pidNsCache === undefined) {
    pidNsCache = probeBwrapPidNamespace();
    if (!pidNsCache) {
      console.warn(
        '[Sandbox] This host cannot create a PID namespace for the executor sandbox ' +
          '(common in containers). Falling back to a user + mount sandbox WITHOUT ' +
          '--unshare-pid: filesystem masks still apply, but same-uid /proc process ' +
          'inspection is governed by the host (ptrace_scope) or the surrounding container boundary.'
      );
    }
  }
  return pidNsCache;
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
  /** The branch working directory (task cwd) — NOT the executor process cwd. */
  branchPath: string;
  cmd: string;
  args: string[];
  baseRepoPath?: string;
  ownerHomeStore?: string;
  /** Tenant-scoped worktrees root resolved from the immutable config. */
  worktreesRoot?: string;
  /** RBAC-resolved fs access of the current prompt actor. Default 'write'. */
  branchAccess?: 'write' | 'read' | 'none';
  /**
   * Per-branch SDK home to bind into the sandbox (design §7). Absolute host
   * path of `branch-homes/<branchId>`; unset for an execution-home Session.
   */
  branchSdkHomeDir?: string;
  /** Child fd numbers pinned to credential files mounted inside the branch SDK home. */
  branchSdkCredentialBinds?: Array<{ fd: number; destination: string }>;
  /** Immutable deployment paths injected by configureExecutor at startup. */
  runtimePaths: SandboxRuntimePaths;
}): SandboxWrap | null {
  const {
    sandbox,
    branchPath,
    cmd,
    args,
    baseRepoPath,
    ownerHomeStore,
    worktreesRoot,
    branchAccess,
    branchSdkHomeDir,
    branchSdkCredentialBinds,
    runtimePaths,
  } = params;
  if (!sandbox?.enabled) return null;

  const unavailableReason =
    process.platform !== 'linux'
      ? `filesystem sandbox requires Linux (bubblewrap); platform is ${process.platform}`
      : !bwrapAvailable()
        ? '`bwrap` 0.12.0+ is missing, cannot create an unprivileged user namespace, or lacks functional --bind-fd support'
        : null;
  if (unavailableReason) {
    if (sandbox.fail_if_unavailable) {
      throw new Error(
        `execution.sandbox.enabled but ${unavailableReason}. ` +
          'Install bubblewrap or, outside unix_user_mode: sandbox, explicitly allow an unsandboxed fallback.'
      );
    }
    console.warn(`[Sandbox] ${unavailableReason} — spawning executor UNSANDBOXED.`);
    return null;
  }

  const home = runtimePaths.homeDir;
  const dataHome = runtimePaths.dataHome;

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

  if (branchSdkHomeDir) {
    // The branch home is `--bind`ed at its own real path; bwrap aborts on a
    // missing --bind source and dropMasksForMissingTargets never drops a --bind
    // (design §7.2), so guarantee the source exists here — same precedent as the
    // owner home store above.
    try {
      mkdirSync(branchSdkHomeDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `Per-branch SDK home ${branchSdkHomeDir} could not be created: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const ctx: SandboxPathContext = {
    branchPath,
    branchAccess,
    branchSdkHomeDir,
    branchSdkCredentialBinds,
    pidNamespace: pidNamespaceAvailable(),
    homeDir: home,
    canonicalHomeDir: canonicalizeExistingPath(home),
    dataHome,
    canonicalDataHome: canonicalizeExistingPath(dataHome),
    protectedDataRoots: [...new Set(runtimePaths.protectedDataRoots.map(canonicalizeExistingPath))],
    worktreesRoot: worktreesRoot ?? runtimePaths.worktreesRoot,
    baseRepoPath,
    ownerHomeStore: perUser ? ownerHomeStore : undefined,
    canonicalOwnerHomeStore: perUser
      ? canonicalizeExistingPath(ownerHomeStore as string)
      : undefined,
    canonicalExtraAllowWritePaths: (sandbox.extra_allow_write ?? []).map(canonicalizeExistingPath),
    agenticToolsPath: perUser ? runtimePaths.agenticToolsPath : undefined,
    agorConfigPath: runtimePaths.agorConfigPath,
    agorDbPath: runtimePaths.agorDbPath,
  };

  // These destinations are created inside the writable per-user overlay even
  // when they do not exist in the daemon's host home. They must survive the
  // generic missing-host-target filter or an absent host-side file would
  // silently remove the Claude credential containment boundary.
  const materializedFileMasks = new Set<string>();
  if (perUser) {
    const authorityFilenames = [
      '.credentials.json',
      ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES,
    ] as const;
    const authorityDirectories = [
      join(home, '.claude'),
      join(ownerHomeStore as string, '.claude'),
      ...(ctx.canonicalOwnerHomeStore && ctx.canonicalOwnerHomeStore !== ownerHomeStore
        ? [join(ctx.canonicalOwnerHomeStore, '.claude')]
        : []),
    ];
    if (sandbox.preserve_canonical_home_alias === true && ctx.canonicalHomeDir) {
      authorityDirectories.push(join(ctx.canonicalHomeDir, '.claude'));
    }
    for (const directory of authorityDirectories) {
      for (const filename of authorityFilenames) {
        materializedFileMasks.add(join(directory, filename));
      }
    }
  }
  const bwrapArgs = dropMasksForMissingTargets(
    resolveBwrapArgs(sandbox, ctx),
    materializedFileMasks
  );
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
function dropMasksForMissingTargets(
  args: string[],
  materializedFileMasks: ReadonlySet<string> = new Set()
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    const a = args[i];
    if (a === '--tmpfs') {
      const dest = args[i + 1];
      if (dest && existsSync(dest)) out.push(a, dest);
      i += 2;
    } else if ((a === '--ro-bind' || a === '--ro-bind-try') && args[i + 1] === '/dev/null') {
      const dest = args[i + 2];
      if (dest && (existsSync(dest) || materializedFileMasks.has(dest))) {
        out.push(a, '/dev/null', dest);
      }
      i += 3;
    } else {
      out.push(a);
      i += 1;
    }
  }
  return out;
}
