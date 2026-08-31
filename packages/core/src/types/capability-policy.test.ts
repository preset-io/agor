import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_POLICY_SCHEMA_VERSION,
  normalizeCapabilityPolicyCapabilities,
  removeCapabilityPolicyCapability,
  resolveCapabilityPolicyAccess,
  validateCapabilityPolicyDraft,
} from './capability-policy';
import type { CapabilityPolicyDraft, GroupID, UserID, UUID } from './index';

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
          preset: 'viewer',
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
        preset: 'collaborator',
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
          preset: 'manager',
          capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
          fs_access: 'none',
        },
      })
    );
    expect(issues.map((issue) => issue.code)).toContain('terminal_requires_filesystem_access');
  });
});

describe('resolveCapabilityPolicyAccess', () => {
  const owner = '00000000-0000-7000-8000-000000000001' as UserID;
  const user = '00000000-0000-7000-8000-000000000002' as UserID;
  const groupA = '00000000-0000-7000-8000-000000000011' as GroupID;
  const groupB = '00000000-0000-7000-8000-000000000012' as GroupID;
  const policy: CapabilityPolicyDraft = {
    schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
    policy_kind: 'branch_access',
    sharing_mode: 'shared',
    entries: [
      {
        entry_id: '00000000-0000-7000-8000-000000000101' as UUID,
        principal: { principal_type: 'group', group_id: groupA },
        preset: 'viewer',
        capabilities: ['branch.view'],
        fs_access: 'read',
      },
      {
        entry_id: '00000000-0000-7000-8000-000000000102' as UUID,
        principal: { principal_type: 'group', group_id: groupB },
        preset: 'collaborator',
        capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own'],
        fs_access: 'write',
      },
    ],
    others: { preset: 'viewer', capabilities: ['branch.view'], fs_access: 'none' },
  };

  it('combines every matching group and takes the highest filesystem access', () => {
    expect(
      resolveCapabilityPolicyAccess({
        policy,
        primary_owner_user_id: owner,
        user_id: user,
        user_status: 'active',
        active_group_ids: [groupA, groupB],
      })
    ).toMatchObject({
      source: 'group',
      fs_access: 'write',
      group_ids: [groupA, groupB],
      capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
    });
  });

  it('derives terminal when role and filesystem access come from different groups', () => {
    const splitDimensions = structuredClone(policy);
    splitDimensions.entries[0] = {
      ...splitDimensions.entries[0],
      preset: 'viewer',
      capabilities: ['branch.view'],
      fs_access: 'read',
    };
    splitDimensions.entries[1] = {
      ...splitDimensions.entries[1],
      preset: 'collaborator',
      capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own'],
      fs_access: 'none',
    };
    expect(
      resolveCapabilityPolicyAccess({
        policy: splitDimensions,
        primary_owner_user_id: owner,
        user_id: user,
        user_status: 'active',
        active_group_ids: [groupA, groupB],
      })
    ).toMatchObject({
      source: 'group',
      fs_access: 'read',
      capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
    });
  });

  it('lets an explicit user entry shadow every group, including No access', () => {
    const directDenied = {
      ...policy,
      entries: [
        ...policy.entries,
        {
          entry_id: '00000000-0000-7000-8000-000000000103' as UUID,
          principal: { principal_type: 'user' as const, user_id: user },
          preset: 'none' as const,
          capabilities: [],
          fs_access: 'none' as const,
        },
      ],
    };
    expect(
      resolveCapabilityPolicyAccess({
        policy: directDenied,
        primary_owner_user_id: owner,
        user_id: user,
        user_status: 'active',
        active_group_ids: [groupB],
      })
    ).toMatchObject({ source: 'direct_user', capabilities: [], fs_access: 'none' });
  });

  it('uses Others only for an unmatched active member', () => {
    expect(
      resolveCapabilityPolicyAccess({
        policy,
        primary_owner_user_id: owner,
        user_id: user,
        user_status: 'active',
      })
    ).toMatchObject({ source: 'others', capabilities: ['branch.view'] });
    expect(
      resolveCapabilityPolicyAccess({
        policy,
        primary_owner_user_id: owner,
        user_id: user,
        user_status: 'inactive',
      }).capabilities
    ).toEqual([]);
  });

  it('always grants the immutable primary owner the complete policy kind', () => {
    const access = resolveCapabilityPolicyAccess({
      policy: {
        ...policy,
        sharing_mode: 'private',
        entries: [],
        others: { preset: 'none', capabilities: [], fs_access: 'none' },
      },
      primary_owner_user_id: owner,
      user_id: owner,
      user_status: 'active',
    });
    expect(access.source).toBe('primary_owner');
    expect(access.fs_access).toBe('write');
    expect(access.capabilities).toContain('branch.policy.manage');
  });
});
