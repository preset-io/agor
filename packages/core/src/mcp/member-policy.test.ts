import { describe, expect, it } from 'vitest';
import { mayMemberManageMCPServer, mayMemberUseMCPTransport } from './member-policy';

const OWNER = 'user-owner';
const OTHER = 'user-other';

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
