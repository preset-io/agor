import { describe, expect, it } from 'vitest';
import { resolveBwrapArgs, type SandboxPathContext } from './sandbox-policy';

const CTX: SandboxPathContext = {
  branchPath: '/home/agor/.agor/worktrees/acme/feature-x',
  homeDir: '/home/agor',
  worktreesRoot: '/home/agor/.agor/worktrees',
  // repo working-copy ROOT (repo.local_path); the resolver binds <root>/.git.
  baseRepoPath: '/home/agor/.agor/repos/acme',
  agorConfigPath: '/home/agor/.agor/config.yaml',
  agorDbPath: '/home/agor/.agor/agor.db',
};
const BASE_GIT = '/home/agor/.agor/repos/acme/.git';

/** True if `flag a b` appears as a contiguous triple in the arg list. */
function hasTriple(args: string[], flag: string, a: string, b: string): boolean {
  for (let i = 0; i + 2 < args.length; i++) {
    if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return true;
  }
  return false;
}
/** True if `flag a` appears as a contiguous pair. */
function hasPair(args: string[], flag: string, a: string): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === flag && args[i + 1] === a) return true;
  }
  return false;
}

describe('resolveBwrapArgs', () => {
  it('is filesystem-only: read-only root, NO network namespace unshare', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--ro-bind', '/', '/')).toBe(true);
    expect(args).not.toContain('--unshare-net');
  });

  it('defaults: branch + base-repo git dir writable, task-private tmpfs, chdir branch', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(true);
    expect(hasTriple(args, '--bind', BASE_GIT, BASE_GIT)).toBe(true);
    expect(hasPair(args, '--tmpfs', '/tmp')).toBe(true);
    expect(hasPair(args, '--chdir', CTX.branchPath)).toBe(true);
  });

  it('protect_secrets masks daemon secrets + credential dirs', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--ro-bind', '/dev/null', '/home/agor/.agor/config.yaml')).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', '/home/agor/.agor/agor.db')).toBe(true);
    expect(hasPair(args, '--tmpfs', '/home/agor/.ssh')).toBe(true);
    expect(hasPair(args, '--tmpfs', '/home/agor/.config/gcloud')).toBe(true);
  });

  it('isolate_branches hides the worktrees root but re-exposes the current branch', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasPair(args, '--tmpfs', CTX.worktreesRoot!)).toBe(true);
    // branch bind must come AFTER the worktrees tmpfs so it is re-exposed
    const tmpfsIdx = args.findIndex((a, i) => a === '--tmpfs' && args[i + 1] === CTX.worktreesRoot);
    const bindIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === CTX.branchPath);
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThan(tmpfsIdx);
  });

  it('protect_secrets:false / isolate_branches:false drop those denials', () => {
    const noSecrets = resolveBwrapArgs({ protect_secrets: false }, CTX);
    expect(hasTriple(noSecrets, '--ro-bind', '/dev/null', '/home/agor/.agor/config.yaml')).toBe(
      false
    );
    const noIso = resolveBwrapArgs({ isolate_branches: false }, CTX);
    expect(hasPair(noIso, '--tmpfs', CTX.worktreesRoot!)).toBe(false);
  });

  it('include.home true binds all of home; false keeps tool dirs writable', () => {
    expect(
      hasTriple(
        resolveBwrapArgs({ include: { home: true } }, CTX),
        '--bind',
        '/home/agor',
        '/home/agor'
      )
    ).toBe(true);
    const closed = resolveBwrapArgs({}, CTX);
    expect(hasTriple(closed, '--bind-try', '/home/agor/.cache', '/home/agor/.cache')).toBe(true);
    expect(hasTriple(closed, '--bind', '/home/agor', '/home/agor')).toBe(false);
  });

  it('omits base-repo bind when unknown (clone mode); honors extra paths', () => {
    const clone = resolveBwrapArgs({}, { ...CTX, baseRepoPath: undefined });
    expect(clone.some((a) => a === BASE_GIT)).toBe(false);
    const extra = resolveBwrapArgs(
      { extra_allow_write: ['/opt/cache'], extra_deny_read: ['/etc/secret'] },
      CTX
    );
    expect(hasTriple(extra, '--bind', '/opt/cache', '/opt/cache')).toBe(true);
    expect(hasTriple(extra, '--ro-bind', '/dev/null', '/etc/secret')).toBe(true);
  });
});

describe('resolveBwrapArgs — RBAC-aware branch mount', () => {
  it('write (default) binds the branch rw', () => {
    expect(hasTriple(resolveBwrapArgs({}, CTX), '--bind', CTX.branchPath, CTX.branchPath)).toBe(
      true
    );
    expect(
      hasTriple(
        resolveBwrapArgs({}, { ...CTX, branchAccess: 'write' }),
        '--bind',
        CTX.branchPath,
        CTX.branchPath
      )
    ).toBe(true);
  });

  it('read binds the branch READ-ONLY (no rw bind)', () => {
    const args = resolveBwrapArgs({}, { ...CTX, branchAccess: 'read' });
    expect(hasTriple(args, '--ro-bind', CTX.branchPath, CTX.branchPath)).toBe(true);
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(false);
  });

  it('none does not mount the branch at all', () => {
    const args = resolveBwrapArgs({}, { ...CTX, branchAccess: 'none' });
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(false);
    expect(hasTriple(args, '--ro-bind', CTX.branchPath, CTX.branchPath)).toBe(false);
  });

  it('applies in per_user mode too (read → ro on top of the overlay)', () => {
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      {
        ...CTX,
        branchAccess: 'read',
        ownerHomeStore: '/home/agor/.agor/tenants/default/homes/o',
      }
    );
    expect(hasTriple(args, '--ro-bind', CTX.branchPath, CTX.branchPath)).toBe(true);
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(false);
  });
});

describe('resolveBwrapArgs — home_mode: per_user', () => {
  const STORE = '/home/agor/.agor/tenants/default/homes/owner-123';
  const PER_USER_CTX: SandboxPathContext = {
    ...CTX,
    ownerHomeStore: STORE,
    agenticToolsPath: '/home/agor/.agor/agentic-tools',
  };

  it('overlays the owner store at the passwd home and sets HOME', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    expect(hasTriple(args, '--bind', STORE, '/home/agor')).toBe(true);
    expect(hasTriple(args, '--setenv', 'HOME', '/home/agor')).toBe(true);
  });

  it('re-exposes branch, base repo, and (ro) managed tools on top of the overlay', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    // overlay must precede the re-exposed binds
    const overlayIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === STORE);
    const branchIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === CTX.branchPath);
    expect(overlayIdx).toBeGreaterThanOrEqual(0);
    expect(branchIdx).toBeGreaterThan(overlayIdx);
    expect(hasTriple(args, '--bind', BASE_GIT, BASE_GIT)).toBe(true);
    expect(
      hasTriple(
        args,
        '--ro-bind-try',
        PER_USER_CTX.agenticToolsPath!,
        PER_USER_CTX.agenticToolsPath!
      )
    ).toBe(true);
  });

  it('does not need the worktrees tmpfs (overlay hides it) but ALWAYS masks the daemon trust root', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    // No worktrees-root tmpfs: the overlay already hides the whole .agor tree.
    expect(hasPair(args, '--tmpfs', CTX.worktreesRoot!)).toBe(false);
    // config.yaml / agor.db masked UNCONDITIONALLY (belt-and-suspenders for a
    // data_home that lives OUTSIDE the overlaid home).
    expect(hasTriple(args, '--ro-bind', '/dev/null', CTX.agorConfigPath!)).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', CTX.agorDbPath!)).toBe(true);
  });

  it('binds /tmp to <store>/tmp (on-disk, per-user), keeps /var/tmp ephemeral, pins TMPDIR', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    expect(hasTriple(args, '--bind', `${STORE}/tmp`, '/tmp')).toBe(true);
    expect(hasPair(args, '--tmpfs', '/var/tmp')).toBe(true);
    expect(hasPair(args, '--tmpfs', '/tmp')).toBe(false); // NOT a RAM tmpfs
    expect(hasTriple(args, '--setenv', 'TMPDIR', '/tmp')).toBe(true);
  });

  it('wipes the homes-parent (sibling-home leak fix) BEFORE overlaying the owner store', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    // /home is tmpfs'd so sibling /home/<other> homes are not readable via ro-bind / /
    expect(hasPair(args, '--tmpfs', '/home')).toBe(true);
    const wipeIdx = args.findIndex((a, i) => a === '--tmpfs' && args[i + 1] === '/home');
    const overlayIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === STORE);
    expect(wipeIdx).toBeGreaterThanOrEqual(0);
    expect(overlayIdx).toBeGreaterThan(wipeIdx); // overlay re-binds our home on top of the wipe
  });

  it('does not tmpfs `/` when the home has no homes-parent (e.g. /root)', () => {
    const rootCtx: SandboxPathContext = { ...PER_USER_CTX, homeDir: '/root' };
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, rootCtx);
    expect(hasPair(args, '--tmpfs', '/')).toBe(false);
  });

  it('falls back to shared-home logic when per_user is set but no store resolved', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, CTX); // no ownerHomeStore
    expect(args.some((a) => a === '--setenv')).toBe(false);
    expect(hasPair(args, '--tmpfs', CTX.worktreesRoot!)).toBe(true); // shared path active
  });
});
