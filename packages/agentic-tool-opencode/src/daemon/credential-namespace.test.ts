import { describe, expect, it } from 'vitest';
import {
  assertOpenCodeNativeAuthSupported,
  resolveOpenCodeBranchCredentialNamespace,
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './credential-namespace';
import { OPENCODE_DAEMON_CONTRIBUTION } from './index.js';

describe('OpenCode credential namespace routing', () => {
  it('is stable for one tenant and subject without exposing either identifier in the path', () => {
    const first = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'user-1',
      homeDir: '/home/alice',
    });
    const second = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'user-1',
      homeDir: '/home/alice',
    });

    expect(first).toEqual(second);
    expect(first.namespaceKey).toBe(
      'e8d27b8337cc8452e28a74a7afdae72daa6bf9b3a66c68037b24cc545c094e1c'
    );
    expect(first.dataHome).toBe(
      '/home/alice/.local/share/agor/opencode/e8d27b8337cc8452e28a74a7afdae72daa6bf9b3a66c68037b24cc545c094e1c'
    );
    expect(first.dataHome).not.toContain('tenant-a');
    expect(first.dataHome).not.toContain('user-1');
  });

  it('separates identical user IDs across tenants', () => {
    const tenantA = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'same-user',
      homeDir: '/home/shared',
    });
    const tenantB = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-b',
      subjectUserId: 'same-user',
      homeDir: '/home/shared',
    });

    expect(tenantA.namespaceKey).not.toBe(tenantB.namespaceKey);
    expect(tenantA.dataHome).not.toBe(tenantB.dataHome);
  });

  it('routes tasks by immutable session owner rather than a prompt actor', () => {
    const owner = resolveOpenCodeTaskCredentialNamespace({
      tenantId: 'tenant-a',
      session: {
        created_by: 'session-owner',
        unix_username: 'alice',
      },
      homeDir: '/home/alice',
    });
    const expected = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'session-owner',
      homeDir: '/home/alice',
    });
    const promptActor = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'latest-prompt-actor',
      homeDir: '/home/alice',
    });

    expect(owner).toEqual(expected);
    expect(owner).not.toEqual(promptActor);
  });

  it('uses the credential namespace as the primary writer coordination key', () => {
    const input = {
      tenantId: 'tenant-a',
      session: { created_by: 'owner', unix_username: 'alice' },
      homeDir: '/home/alice',
    };
    const namespace = resolveOpenCodeTaskCredentialNamespace(input);

    expect(OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch(input)).toEqual({
      namespaceKey: namespace.namespaceKey,
      executorPayload: { agenticToolContext: { dataHome: namespace.dataHome } },
    });
  });

  describe('per-branch SDK home re-keying (design §7/§13.1)', () => {
    it('routes native state under the branch SDK home, reusing the XDG dataHome derivation', () => {
      const branchSdkHomeDir = '/data/branch-homes/branch-123';
      const ns = resolveOpenCodeBranchCredentialNamespace({ branchSdkHomeDir });
      // dataHome is the branch home's opencode/ subdir; the runtime derives the
      // four XDG roots from it (source of truth for values stays in the runtime).
      expect(ns.dataHome).toBe('/data/branch-homes/branch-123/opencode');
      expect(ns.namespaceKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is stable per branch and distinct across branches', () => {
      const a = resolveOpenCodeBranchCredentialNamespace({ branchSdkHomeDir: '/d/branch-homes/a' });
      const a2 = resolveOpenCodeBranchCredentialNamespace({
        branchSdkHomeDir: '/d/branch-homes/a',
      });
      const b = resolveOpenCodeBranchCredentialNamespace({ branchSdkHomeDir: '/d/branch-homes/b' });
      expect(a).toEqual(a2);
      expect(a.namespaceKey).not.toBe(b.namespaceKey);
      expect(a.dataHome).not.toBe(b.dataHome);
    });

    it('getExecutorLaunch honors branchSdkHomeDir over the (tenant,user) namespace', () => {
      const branchSdkHomeDir = '/data/branch-homes/branch-123';
      const branchNs = resolveOpenCodeBranchCredentialNamespace({ branchSdkHomeDir });
      const launch = OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch({
        tenantId: 'tenant-a',
        session: { created_by: 'owner', unix_username: 'alice' },
        homeDir: '/home/alice',
        branchSdkHomeDir,
      });
      expect(launch).toEqual({
        namespaceKey: branchNs.namespaceKey,
        executorPayload: { agenticToolContext: { dataHome: branchNs.dataHome } },
      });
    });

    it('rejects a non-absolute branch SDK home', () => {
      expect(() =>
        resolveOpenCodeBranchCredentialNamespace({ branchSdkHomeDir: 'relative/path' })
      ).toThrow();
    });
  });

  it('rejects hosted auth-resolved tenancy before native OpenCode work', () => {
    expect(() =>
      assertOpenCodeNativeAuthSupported({
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      })
    ).toThrow(/unavailable in hosted multi-tenant mode/i);
  });

  it('rejects delegated execution before deriving native OpenCode paths', () => {
    expect(() =>
      assertOpenCodeNativeAuthSupported({
        execution: { unix_user_mode: 'delegated' },
      })
    ).toThrow(/unavailable in delegated execution mode/i);
  });

  it.each(['simple', 'sandbox'] as const)(
    'returns supported %s execution mode for downstream path resolution',
    (mode) => {
      expect(
        assertOpenCodeNativeAuthSupported({
          execution: { unix_user_mode: mode },
        })
      ).toBe(mode);
    }
  );
});
