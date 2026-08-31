import { describe, expect, it } from 'vitest';
import { CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES } from '../codex/credential-file';
import { resolveBwrapArgs, type SandboxPathContext } from './sandbox-policy';

const CTX: SandboxPathContext = {
  branchPath: '/home/agor/.agor/worktrees/acme/feature-x',
  homeDir: '/home/agor',
  dataHome: '/home/agor/.agor',
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
  it('read-only root; unshares user + PID (default); keeps network shared', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--ro-bind', '/', '/')).toBe(true);
    expect(args).toContain('--unshare-user');
    // PID namespace (default on) closes the /proc process-side route.
    expect(args).toContain('--unshare-pid');
    // …but NOT the network namespace (executor keeps daemon/model loopback).
    expect(args).not.toContain('--unshare-net');
  });

  it('omits --unshare-pid when the host cannot create a PID namespace (containers)', () => {
    const args = resolveBwrapArgs({}, { ...CTX, pidNamespace: false });
    expect(args).toContain('--unshare-user'); // user + mount sandbox still applies
    expect(args).not.toContain('--unshare-pid');
  });

  it('defaults: branch + base-repo git dir writable, task-private tmpfs, chdir branch', () => {
    const args = resolveBwrapArgs({}, CTX);
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(true);
    expect(hasTriple(args, '--bind', BASE_GIT, BASE_GIT)).toBe(true);
    expect(hasPair(args, '--tmpfs', '/tmp')).toBe(true);
    expect(hasPair(args, '--chdir', CTX.branchPath)).toBe(true);
  });

  describe('per-branch SDK home binds (design §7)', () => {
    const BRANCH_HOME = '/home/agor/.agor/branch-homes/0193b1c2-branch';

    it('is INERT by default: no branch SDK home bind when unset (shared mode)', () => {
      const args = resolveBwrapArgs({}, CTX);
      expect(
        args.some(
          (a, i) =>
            a === '--bind' && args[i + 1] === args[i + 2] && args[i + 1]?.includes('branch-homes')
        )
      ).toBe(false);
    });

    it('is INERT by default: no branch SDK home bind when unset (per_user mode)', () => {
      const args = resolveBwrapArgs(
        { home_mode: 'per_user' },
        { ...CTX, ownerHomeStore: '/home/agor/.agor/homes/owner' }
      );
      expect(args.some((a) => a.includes('branch-homes'))).toBe(false);
    });

    it('binds the branch SDK home at its own real path in shared mode', () => {
      const args = resolveBwrapArgs({}, { ...CTX, branchSdkHomeDir: BRANCH_HOME });
      expect(hasTriple(args, '--bind', BRANCH_HOME, BRANCH_HOME)).toBe(true);
    });

    it('binds the branch SDK home in per_user mode AFTER the owner overlay (later wins)', () => {
      const ownerStore = '/home/agor/.agor/homes/owner';
      const args = resolveBwrapArgs(
        { home_mode: 'per_user' },
        { ...CTX, ownerHomeStore: ownerStore, branchSdkHomeDir: BRANCH_HOME }
      );
      expect(hasTriple(args, '--bind', BRANCH_HOME, BRANCH_HOME)).toBe(true);
      const overlayIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === ownerStore);
      const branchIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === BRANCH_HOME);
      expect(overlayIdx).toBeGreaterThanOrEqual(0);
      expect(branchIdx).toBeGreaterThan(overlayIdx);
    });

    it('rejects a non-absolute branch SDK home', () => {
      expect(() => resolveBwrapArgs({}, { ...CTX, branchSdkHomeDir: 'relative/path' })).toThrow();
    });

    it('mounts a pinned credential fd after the writable branch home', () => {
      const destination = `${BRANCH_HOME}/codex/auth.json`;
      const args = resolveBwrapArgs(
        { home_mode: 'per_user', extra_allow_write: [`${BRANCH_HOME}/codex`] },
        {
          ...CTX,
          ownerHomeStore: '/home/agor/.agor/homes/owner',
          branchSdkHomeDir: BRANCH_HOME,
          branchSdkCredentialBinds: [{ fd: 3, destination }],
        }
      );
      expect(hasTriple(args, '--bind-fd', '3', destination)).toBe(true);
      const branchIdx = args.findIndex(
        (value, index) => value === '--bind' && args[index + 1] === BRANCH_HOME
      );
      const credentialIdx = args.findIndex(
        (value, index) => value === '--bind-fd' && args[index + 1] === '3'
      );
      expect(credentialIdx).toBeGreaterThan(branchIdx);
      const extraAllowIdx = args.findIndex(
        (value, index) => value === '--bind' && args[index + 1] === `${BRANCH_HOME}/codex`
      );
      expect(credentialIdx).toBeGreaterThan(extraAllowIdx);
    });

    it('rejects credential fd destinations outside the branch SDK home', () => {
      expect(() =>
        resolveBwrapArgs(
          {},
          {
            ...CTX,
            branchSdkHomeDir: BRANCH_HOME,
            branchSdkCredentialBinds: [{ fd: 3, destination: '/home/agor/.agor/config.yaml' }],
          }
        )
      ).toThrow(/must stay below/);
      expect(() =>
        resolveBwrapArgs(
          {},
          {
            ...CTX,
            branchSdkHomeDir: BRANCH_HOME,
            branchSdkCredentialBinds: [{ fd: 3, destination: BRANCH_HOME }],
          }
        )
      ).toThrow(/must stay below/);
    });
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

  it('read binds the branch AND the shared .git READ-ONLY (no rw bind)', () => {
    const args = resolveBwrapArgs({}, { ...CTX, branchAccess: 'read' });
    expect(hasTriple(args, '--ro-bind', CTX.branchPath, CTX.branchPath)).toBe(true);
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(false);
    // The shared common .git must NOT be writable for a read-only collaborator
    // (else they could mutate shared refs/hooks across sessions).
    expect(hasTriple(args, '--ro-bind', BASE_GIT, BASE_GIT)).toBe(true);
    expect(hasTriple(args, '--bind', BASE_GIT, BASE_GIT)).toBe(false);
  });

  it('none mounts neither the branch nor the shared .git', () => {
    const args = resolveBwrapArgs({}, { ...CTX, branchAccess: 'none' });
    expect(hasTriple(args, '--bind', CTX.branchPath, CTX.branchPath)).toBe(false);
    expect(hasTriple(args, '--ro-bind', CTX.branchPath, CTX.branchPath)).toBe(false);
    expect(args.includes(BASE_GIT)).toBe(false);
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

  it('binds the Claude parent and masks every authority leaf from the shared source of truth', () => {
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, PER_USER_CTX);
    expect(hasTriple(args, '--bind', `${STORE}/.claude`, `${PER_USER_CTX.homeDir}/.claude`)).toBe(
      true
    );
    for (const filename of ['.credentials.json', ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES]) {
      expect(
        hasTriple(args, '--ro-bind', '/dev/null', `${PER_USER_CTX.homeDir}/.claude/${filename}`)
      ).toBe(true);
    }
    expect(
      args.some(
        (arg, index) =>
          arg === '--ro-bind-try' &&
          args[index + 1] === '/dev/null' &&
          args[index + 2]?.includes('/.claude/')
      )
    ).toBe(false);
    expect(args).not.toContain(`${PER_USER_CTX.homeDir}/.codex/auth.json`);
    expect(args).not.toContain(`${PER_USER_CTX.homeDir}/.claude/settings.json`);
    expect(args).not.toContain(`${PER_USER_CTX.homeDir}/.claude/projects`);
  });

  it('applies operator denials after the Claude parent re-bind', () => {
    const denied = `${PER_USER_CTX.homeDir}/.claude/settings.json`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', extra_deny_read: [denied] },
      PER_USER_CTX
    );
    const parentBind = args.findIndex(
      (arg, index) =>
        arg === '--bind' &&
        args[index + 1] === `${STORE}/.claude` &&
        args[index + 2] === `${PER_USER_CTX.homeDir}/.claude`
    );
    const denial = args.findIndex(
      (arg, index) =>
        arg === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === denied
    );
    expect(parentBind).toBeGreaterThanOrEqual(0);
    expect(denial).toBeGreaterThan(parentBind);
  });

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

  it('masks an external data root before re-exposing only the authorized paths', () => {
    const dataHome = '/var/lib/agor/data';
    const externalCtx: SandboxPathContext = {
      ...PER_USER_CTX,
      dataHome,
      branchPath: `${dataHome}/worktrees/acme/feature-x`,
      worktreesRoot: `${dataHome}/worktrees`,
      baseRepoPath: `${dataHome}/repos/acme`,
      agenticToolsPath: `${dataHome}/agentic-tools`,
      agorConfigPath: `${dataHome}/config.yaml`,
      agorDbPath: `${dataHome}/agor.db`,
    };
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, externalCtx);
    const maskIdx = args.findIndex((a, i) => a === '--tmpfs' && args[i + 1] === dataHome);
    const branchIdx = args.findIndex(
      (a, i) => a === '--bind' && args[i + 1] === externalCtx.branchPath
    );
    const toolsIdx = args.findIndex(
      (a, i) => a === '--ro-bind-try' && args[i + 1] === externalCtx.agenticToolsPath
    );

    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(branchIdx).toBeGreaterThan(maskIdx);
    expect(toolsIdx).toBeGreaterThan(maskIdx);
  });

  it('also masks a custom external tenants base', () => {
    const tenantsBase = '/mnt/agor-tenants';
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      {
        ...PER_USER_CTX,
        protectedDataRoots: [tenantsBase],
        branchPath: `${tenantsBase}/tenant-a/worktrees/acme/feature-x`,
        worktreesRoot: `${tenantsBase}/tenant-a/worktrees`,
      }
    );
    expect(hasPair(args, '--tmpfs', tenantsBase)).toBe(true);
  });

  it('hides a physical filesystem_home outside all deployment data roots', () => {
    const ownerHomeStore = '/srv/customer-homes/alice';
    const args = resolveBwrapArgs({ home_mode: 'per_user' }, { ...PER_USER_CTX, ownerHomeStore });
    const physicalParent = args.findIndex(
      (arg, index) =>
        arg === '--bind' &&
        args[index + 1] === `${ownerHomeStore}/.claude` &&
        args[index + 2] === `${ownerHomeStore}/.claude`
    );
    const overlay = args.findIndex(
      (arg, index) =>
        arg === '--bind' &&
        args[index + 1] === ownerHomeStore &&
        args[index + 2] === PER_USER_CTX.homeDir
    );
    expect(physicalParent).toBeGreaterThanOrEqual(0);
    expect(physicalParent).toBeGreaterThan(overlay);
    for (const filename of ['.credentials.json', ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES]) {
      expect(
        hasTriple(args, '--ro-bind', '/dev/null', `${ownerHomeStore}/.claude/${filename}`)
      ).toBe(true);
    }
  });

  it('masks a hidden physical owner store when extra_allow_write re-exposes it', () => {
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', extra_allow_write: [STORE] },
      PER_USER_CTX
    );
    expect(hasTriple(args, '--bind', STORE, STORE)).toBe(true);
    expect(hasTriple(args, '--bind', `${STORE}/.claude`, `${STORE}/.claude`)).toBe(true);
    for (const filename of ['.credentials.json', ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES]) {
      expect(hasTriple(args, '--ro-bind', '/dev/null', `${STORE}/.claude/${filename}`)).toBe(true);
    }
  });

  it('masks an exact physical authority leaf re-exposed by extra_allow_write', () => {
    const credentialPath = `${STORE}/.claude/.credentials.json`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', extra_allow_write: [credentialPath] },
      PER_USER_CTX
    );
    expect(hasTriple(args, '--bind', credentialPath, credentialPath)).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', credentialPath)).toBe(true);
  });

  it('emits only the outermost mask for nested data roots', () => {
    const dataHome = '/var/lib/agor';
    const tenantsBase = `${dataHome}/tenants`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      {
        ...PER_USER_CTX,
        dataHome,
        protectedDataRoots: [tenantsBase],
      }
    );
    expect(hasPair(args, '--tmpfs', dataHome)).toBe(true);
    expect(hasPair(args, '--tmpfs', tenantsBase)).toBe(false);
  });

  it('masks canonical home aliases when the passwd home is a symlink', () => {
    const canonicalHomeDir = '/var/lib/agor/home/agor';
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      {
        ...PER_USER_CTX,
        canonicalHomeDir,
        canonicalDataHome: `${canonicalHomeDir}/.agor`,
      }
    );
    const canonicalMaskIdx = args.findIndex(
      (a, i) => a === '--tmpfs' && args[i + 1] === '/var/lib/agor/home'
    );
    const overlayIdx = args.findIndex((a, i) => a === '--bind' && args[i + 1] === STORE);

    expect(hasPair(args, '--tmpfs', '/home')).toBe(true);
    expect(canonicalMaskIdx).toBeGreaterThanOrEqual(0);
    expect(overlayIdx).toBeGreaterThan(canonicalMaskIdx);
    expect(hasTriple(args, '--bind', STORE, canonicalHomeDir)).toBe(false);
    expect(hasPair(args, '--tmpfs', `${canonicalHomeDir}/.agor`)).toBe(false);
    expect(hasPair(args, '--chdir', CTX.branchPath)).toBe(true);
  });

  it('optionally preserves the canonical home alias for path-keyed SDK state', () => {
    const canonicalHomeDir = '/var/lib/agor/home/agor';
    const canonicalBranch = `${canonicalHomeDir}/.agor/worktrees/acme/feature-x`;
    const canonicalBaseGit = `${canonicalHomeDir}/.agor/repos/acme/.git`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', preserve_canonical_home_alias: true },
      {
        ...PER_USER_CTX,
        canonicalHomeDir,
        canonicalDataHome: `${canonicalHomeDir}/.agor`,
      }
    );

    expect(hasTriple(args, '--bind', STORE, '/home/agor')).toBe(true);
    expect(hasTriple(args, '--bind', STORE, canonicalHomeDir)).toBe(true);
    expect(hasTriple(args, '--bind', CTX.branchPath, canonicalBranch)).toBe(true);
    expect(hasTriple(args, '--bind', BASE_GIT, canonicalBaseGit)).toBe(true);
    expect(hasTriple(args, '--ro-bind', '/dev/null', `${canonicalHomeDir}/.agor/config.yaml`)).toBe(
      true
    );
    for (const home of ['/home/agor', canonicalHomeDir]) {
      expect(hasTriple(args, '--bind', `${STORE}/.claude`, `${home}/.claude`)).toBe(true);
      expect(hasTriple(args, '--ro-bind', '/dev/null', `${home}/.claude/.credentials.json`)).toBe(
        true
      );
      for (const sidecar of CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES) {
        expect(hasTriple(args, '--ro-bind', '/dev/null', `${home}/.claude/${sidecar}`)).toBe(true);
      }
    }
    expect(hasPair(args, '--chdir', canonicalBranch)).toBe(true);
  });

  it('preserves RBAC read-only access at both home aliases', () => {
    const canonicalHomeDir = '/var/lib/agor/home/agor';
    const canonicalBranch = `${canonicalHomeDir}/.agor/worktrees/acme/feature-x`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', preserve_canonical_home_alias: true },
      { ...PER_USER_CTX, canonicalHomeDir, branchAccess: 'read' }
    );

    expect(hasTriple(args, '--ro-bind', CTX.branchPath, CTX.branchPath)).toBe(true);
    expect(hasTriple(args, '--ro-bind', CTX.branchPath, canonicalBranch)).toBe(true);
    expect(hasTriple(args, '--bind', CTX.branchPath, canonicalBranch)).toBe(false);
  });

  it('does not expose either branch alias when RBAC access is none', () => {
    const canonicalHomeDir = '/var/lib/agor/home/agor';
    const canonicalBranch = `${canonicalHomeDir}/.agor/worktrees/acme/feature-x`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user', preserve_canonical_home_alias: true },
      { ...PER_USER_CTX, canonicalHomeDir, branchAccess: 'none' }
    );

    for (const branchPath of [CTX.branchPath, canonicalBranch]) {
      expect(hasTriple(args, '--bind', CTX.branchPath, branchPath)).toBe(false);
      expect(hasTriple(args, '--ro-bind', CTX.branchPath, branchPath)).toBe(false);
    }
    expect(args).not.toContain(BASE_GIT);
    expect(args).not.toContain(`${canonicalHomeDir}/.agor/repos/acme/.git`);
  });

  it('keeps an external data root masked when branch access is none', () => {
    const dataHome = '/var/lib/agor/data';
    const branchPath = `${dataHome}/worktrees/acme/private`;
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      { ...PER_USER_CTX, dataHome, branchPath, branchAccess: 'none' }
    );

    expect(hasPair(args, '--tmpfs', dataHome)).toBe(true);
    expect(hasTriple(args, '--bind', branchPath, branchPath)).toBe(false);
    expect(hasTriple(args, '--ro-bind', branchPath, branchPath)).toBe(false);
  });

  it('fails closed instead of masking the filesystem root as an external data root', () => {
    expect(() =>
      resolveBwrapArgs({ home_mode: 'per_user' }, { ...PER_USER_CTX, dataHome: '/' })
    ).toThrow(/invalid sandbox data root/i);
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

  it('FAILS CLOSED (throws) when per_user is set but no store resolved — no silent shared fallback', () => {
    expect(() => resolveBwrapArgs({ home_mode: 'per_user' }, CTX)).toThrow(/fail closed/i);
  });

  // Contract relied upon by `shouldUseCloneReferencePath`
  // (apps/agor-daemon/src/utils/clone-reference.ts): a clone-mode branch gets
  // NO `baseRepoPath` from the daemon (register-services.ts / terminals.ts skip
  // it for `storage_mode === 'clone'`), so under this overlay nothing under
  // `<data_home>/repos` is reachable. A `git clone --reference` alternates
  // pointer into the base clone is therefore permanently unresolvable here —
  // which is why the daemon must not create one for this deployment shape.
  //
  // If this ever changes (repos re-exposed to clone-mode branches), revisit
  // that gate: the borrow would become safe again.
  it('leaves the base object store unreachable for a clone-mode branch (no baseRepoPath)', () => {
    const args = resolveBwrapArgs(
      { home_mode: 'per_user' },
      { ...PER_USER_CTX, baseRepoPath: undefined }
    );
    // The overlay hides <data_home> wholesale…
    expect(hasTriple(args, '--bind', STORE, '/home/agor')).toBe(true);
    // …and nothing re-exposes the base clone or its object store.
    expect(args.some((arg) => arg.startsWith('/home/agor/.agor/repos'))).toBe(false);
  });
});
