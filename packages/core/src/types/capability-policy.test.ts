import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_POLICY_SCHEMA_VERSION,
  normalizeCapabilityPolicyCapabilities,
  removeCapabilityPolicyCapability,
  validateCapabilityPolicyDraft,
} from './capability-policy';
import type { CapabilityPolicyDraft, GroupID, UUID } from './index';

const groupId = '00000000-0000-0000-0000-000000000101' as GroupID;
const entryId = '00000000-0000-0000-0000-000000000201' as UUID;

function branchPolicy(overrides: Partial<CapabilityPolicyDraft> = {}): CapabilityPolicyDraft {
  return {
    schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
    policy_kind: 'branch_access',
    sharing_mode: 'shared',
    entries: [],
    others: { preset: 'none', capabilities: [], fs_access: 'none' },
    ...overrides,
  };
}

describe('capability policy proposal contract', () => {
  it('adds prerequisites without making Manager imply prompt or execute', () => {
    expect(
      normalizeCapabilityPolicyCapabilities('branch_access', [
        'branch.policy.manage',
        'sessions.manage_others',
      ])
    ).toEqual(['branch.view', 'sessions.manage_others', 'branch.manage', 'branch.policy.manage']);
  });

  it('removes dependents when a prerequisite is removed', () => {
    expect(
      removeCapabilityPolicyCapability(
        'branch_access',
        ['branch.view', 'branch.manage', 'environment.control', 'branch.policy.manage'],
        'branch.manage'
      )
    ).toEqual(['branch.view']);
  });

  it('rejects active ACL data in a private draft', () => {
    const issues = validateCapabilityPolicyDraft(
      branchPolicy({
        sharing_mode: 'private',
        entries: [
          {
            entry_id: entryId,
            principal: { principal_type: 'group', group_id: groupId },
            preset: 'viewer',
            capabilities: ['branch.view'],
            fs_access: 'read',
          },
        ],
        others: {
          preset: 'discover',
          capabilities: ['branch.view'],
          fs_access: 'none',
        },
      })
    );

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['private_has_entries', 'private_has_fallback'])
    );
  });

  it('rejects branch capabilities and filesystem access in a board policy', () => {
    const issues = validateCapabilityPolicyDraft({
      ...branchPolicy(),
      policy_kind: 'board_access',
      others: {
        preset: 'custom',
        capabilities: ['sessions.create'],
        fs_access: 'read',
      },
    });

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['kind_capability_mismatch', 'board_has_filesystem_access'])
    );
  });

  it('requires terminal to stay inside own-session and filesystem boundaries', () => {
    expect(normalizeCapabilityPolicyCapabilities('branch_access', ['terminal.open'])).toEqual([
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
      'terminal.open',
    ]);

    const issues = validateCapabilityPolicyDraft(
      branchPolicy({
        others: {
          preset: 'custom',
          capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
          fs_access: 'none',
        },
      })
    );
    expect(issues.map((issue) => issue.code)).toContain('terminal_requires_filesystem_access');
  });
});
