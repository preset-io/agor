import { describe, expect, it } from 'vitest';
import {
  askAdminToAddMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
} from './memberPolicy';

const MEMBER: MCPServerCapabilityContext = {
  connectionReady: true,
  role: 'member',
  isAdmin: false,
  policy: 'use_existing_only',
  userId: 'user-member',
  canConfigure: false,
};

describe('askAdminToAddMcpServer', () => {
  it('names the server, or the one the reader needs, and never a person', () => {
    expect(askAdminToAddMcpServer('Linear')).toBe(
      'Ask an administrator to add Linear to this workspace.'
    );
    expect(askAdminToAddMcpServer()).toBe(
      'Ask an administrator to add the server you need to this workspace.'
    );
  });
});

describe('explainAddRestriction', () => {
  it('asks an administrator for a member the policy holds back', () => {
    expect(explainAddRestriction(MEMBER, 'Linear')).toBe(
      'Ask an administrator to add Linear to this workspace.'
    );
  });

  it('does not send a disconnected reader, admins included, to an administrator', () => {
    expect(explainAddRestriction({ ...MEMBER, connectionReady: false })).toBe(
      'Lost connection to Agor.'
    );
    expect(
      explainAddRestriction({ ...MEMBER, role: 'admin', isAdmin: true, connectionReady: false })
    ).toBe('Lost connection to Agor.');
  });

  it('tells a viewer about their role, not the policy', () => {
    expect(explainAddRestriction({ ...MEMBER, role: 'viewer' })).toMatch(/read-only access/);
  });
});
