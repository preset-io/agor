import { MCP_MEMBER_POLICY_REFUSED_CODE } from '@agor/core/mcp/member-policy';
import type { User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  askAdminIfPolicyRefused,
  askAdminToAddMcpServer,
  explainAddRestriction,
  type MCPServerCapabilityContext,
  workspaceAdminNames,
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
  it('names the server, or the one the reader needs', () => {
    expect(askAdminToAddMcpServer({ serverName: 'Linear' })).toBe(
      'Ask an administrator to add Linear to this workspace.'
    );
    expect(askAdminToAddMcpServer()).toBe(
      'Ask an administrator to add the server you need to this workspace.'
    );
  });

  it('names up to three administrators, and none beyond that', () => {
    expect(askAdminToAddMcpServer({ serverName: 'Linear', adminNames: ['Ana'] })).toBe(
      'Ask an administrator (Ana) to add Linear to this workspace.'
    );
    expect(askAdminToAddMcpServer({ adminNames: ['Ana', 'Ben', 'Cai'] })).toBe(
      'Ask an administrator (Ana, Ben, or Cai) to add the server you need to this workspace.'
    );
    expect(askAdminToAddMcpServer({ adminNames: ['Ana', 'Ben', 'Cai', 'Dee'] })).toBe(
      'Ask an administrator to add the server you need to this workspace.'
    );
  });
});

describe('workspaceAdminNames', () => {
  it('lists admins and superadmins by name, falling back to email, sorted', () => {
    const users = [
      { name: 'Zoe', email: 'zoe@x.dev', role: 'admin' },
      { email: 'ana@x.dev', role: 'superadmin' },
      { name: 'Mo', email: 'mo@x.dev', role: 'member' },
      { name: 'Vi', email: 'vi@x.dev', role: 'viewer' },
    ] as User[];
    expect(workspaceAdminNames(users)).toEqual(['ana@x.dev', 'Zoe']);
  });
});

describe('askAdminIfPolicyRefused', () => {
  it('answers only the daemon refusal that carries the policy code', () => {
    const refusal = Object.assign(new Error('raw daemon text'), {
      data: { code: MCP_MEMBER_POLICY_REFUSED_CODE },
    });
    expect(askAdminIfPolicyRefused(refusal, { serverName: 'Linear' })).toBe(
      'Ask an administrator to add Linear to this workspace.'
    );
    expect(askAdminIfPolicyRefused(new Error('Forbidden'), {})).toBeNull();
  });
});

describe('explainAddRestriction', () => {
  it('asks an administrator for a member the policy holds back', () => {
    expect(explainAddRestriction(MEMBER, { serverName: 'Linear' })).toBe(
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
