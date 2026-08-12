import { describe, expect, it } from 'vitest';
import {
  canConfigureMCPServers,
  isAtLeastMemberRole,
  mayMemberManageMCPServer,
  mayMemberUseMCPScope,
  mayMemberUseMCPTransport,
} from './member-policy';

const OWNER = 'user-owner';
const OTHER = 'user-other';

describe('isAtLeastMemberRole', () => {
  it('admits member and everything above it', () => {
    expect(isAtLeastMemberRole('member')).toBe(true);
    expect(isAtLeastMemberRole('admin')).toBe(true);
    expect(isAtLeastMemberRole('superadmin')).toBe(true);
    // The legacy alias `normalizeRole` maps to superadmin.
    expect(isAtLeastMemberRole('owner')).toBe(true);
  });

  it('refuses a read-only account', () => {
    expect(isAtLeastMemberRole('viewer')).toBe(false);
  });

  it('refuses a caller carrying no role rather than reading it as a member', () => {
    // `normalizeRole` answers MEMBER for an absent or empty value, so a check
    // written on the normalized role would admit exactly these.
    expect(isAtLeastMemberRole(undefined)).toBe(false);
    expect(isAtLeastMemberRole(null)).toBe(false);
    expect(isAtLeastMemberRole('')).toBe(false);
  });

  it('refuses a role it does not recognize rather than assuming it privileged', () => {
    expect(isAtLeastMemberRole('robot')).toBe(false);
    expect(isAtLeastMemberRole(7)).toBe(false);
    expect(isAtLeastMemberRole({ role: 'admin' })).toBe(false);
  });
});

describe('canConfigureMCPServers', () => {
  it('lets an admin configure under every policy value', () => {
    expect(canConfigureMCPServers('admin', 'use_existing_only')).toBe(true);
    expect(canConfigureMCPServers('superadmin', 'use_existing_only')).toBe(true);
  });

  it('reads the policy for a member', () => {
    expect(canConfigureMCPServers('member', 'use_existing_only')).toBe(false);
    expect(canConfigureMCPServers('member', 'allow_private_only')).toBe(true);
    expect(canConfigureMCPServers('member', 'allow_crud')).toBe(true);
  });

  it('refuses below member whatever the policy grants', () => {
    for (const policy of ['use_existing_only', 'allow_private_only', 'allow_crud'] as const) {
      expect(canConfigureMCPServers('viewer', policy)).toBe(false);
      expect(canConfigureMCPServers(undefined, policy)).toBe(false);
      expect(canConfigureMCPServers('', policy)).toBe(false);
      expect(canConfigureMCPServers('robot', policy)).toBe(false);
    }
  });
});

describe('mayMemberManageMCPServer', () => {
  it('refuses every server under use_existing_only', () => {
    expect(mayMemberManageMCPServer({}, 'use_existing_only', OWNER)).toBe(false);
    expect(mayMemberManageMCPServer({ owner_user_id: OWNER }, 'use_existing_only', OWNER)).toBe(
      false
    );
  });

  it('gives a member their own private server under either permissive value', () => {
    expect(mayMemberManageMCPServer({ owner_user_id: OWNER }, 'allow_private_only', OWNER)).toBe(
      true
    );
    expect(mayMemberManageMCPServer({ owner_user_id: OWNER }, 'allow_crud', OWNER)).toBe(true);
  });

  it("keeps another member's private server out of reach", () => {
    expect(mayMemberManageMCPServer({ owner_user_id: OTHER }, 'allow_crud', OWNER)).toBe(false);
  });

  it('opens the shared, unowned servers only at allow_crud', () => {
    expect(mayMemberManageMCPServer({}, 'allow_private_only', OWNER)).toBe(false);
    expect(mayMemberManageMCPServer({}, 'allow_crud', OWNER)).toBe(true);
  });

  it('refuses an unauthenticated caller a private server', () => {
    expect(mayMemberManageMCPServer({ owner_user_id: OWNER }, 'allow_crud', undefined)).toBe(false);
  });
});

describe('mayMemberUseMCPScope', () => {
  it('holds a member to servers they attach per session under allow_private_only', () => {
    expect(mayMemberUseMCPScope('allow_private_only', 'session')).toBe(true);
    expect(mayMemberUseMCPScope('allow_private_only', 'global')).toBe(false);
  });

  it('leaves the unstated scope to the caller to supply', () => {
    expect(mayMemberUseMCPScope('allow_private_only', undefined)).toBe(true);
  });

  it('does not constrain the value that grants workspace-wide reach', () => {
    expect(mayMemberUseMCPScope('allow_crud', 'global')).toBe(true);
    expect(mayMemberUseMCPScope('allow_crud', 'session')).toBe(true);
  });

  it('leaves use_existing_only to the write refusal rather than answering here', () => {
    expect(mayMemberUseMCPScope('use_existing_only', 'global')).toBe(true);
  });
});

describe('mayMemberUseMCPTransport', () => {
  it('holds members to remote transports', () => {
    expect(mayMemberUseMCPTransport('http')).toBe(true);
    expect(mayMemberUseMCPTransport('sse')).toBe(true);
    expect(mayMemberUseMCPTransport('stdio')).toBe(false);
  });

  it('leaves an unstated transport to whoever defaults it', () => {
    expect(mayMemberUseMCPTransport(undefined)).toBe(true);
  });
});
