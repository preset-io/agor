import { describe, expect, it } from 'vitest';
import {
  explainAddRestriction,
  type MCPServerCapabilityContext,
  MEMBER_ADD_RESTRICTION,
} from './memberPolicy';

const MEMBER: MCPServerCapabilityContext = {
  connectionReady: true,
  role: 'member',
  isAdmin: false,
  policy: 'use_existing_only',
  userId: 'user-member',
  canConfigure: false,
};

describe('explainAddRestriction', () => {
  it('tells a member the policy holds back to ask an administrator', () => {
    expect(explainAddRestriction(MEMBER)).toBe(MEMBER_ADD_RESTRICTION);
    expect(MEMBER_ADD_RESTRICTION).toBe(
      "Your workspace's MCP policy doesn't let you add servers. Ask an administrator to add one or change the policy."
    );
  });

  it('tells a viewer about their role, not the policy', () => {
    expect(explainAddRestriction({ ...MEMBER, role: 'viewer' })).toMatch(/read-only access/);
  });
});
