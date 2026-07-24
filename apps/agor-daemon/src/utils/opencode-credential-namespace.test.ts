import { describe, expect, it } from 'vitest';
import {
  assertOpenCodeNativeAuthSupported,
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './opencode-credential-namespace';

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

  it('rejects hosted auth-resolved tenancy before native OpenCode work', () => {
    expect(() =>
      assertOpenCodeNativeAuthSupported({
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      })
    ).toThrow(/unavailable in hosted multi-tenant mode/i);
  });
});
