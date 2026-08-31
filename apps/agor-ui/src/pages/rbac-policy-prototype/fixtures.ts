import type {
  BoardCapabilityPoliciesDraft,
  BoardID,
  BranchCapabilityPolicyDraft,
  CapabilityPolicyDraft,
  CapabilityPolicyPrincipalDescriptor,
  GroupID,
  UserID,
  UUID,
} from '@agor/core/types';
import { CAPABILITY_POLICY_SCHEMA_VERSION } from '@agor/core/types';
import type { EffectiveAccessSubject } from '@/components/permissions/CapabilityPolicyEditor/effectiveAccessPreviewModel';

const userId = (suffix: string) => `10000000-0000-0000-0000-${suffix.padStart(12, '0')}` as UserID;
const groupId = (suffix: string) =>
  `20000000-0000-0000-0000-${suffix.padStart(12, '0')}` as GroupID;
const entryId = (suffix: string) => `30000000-0000-0000-0000-${suffix.padStart(12, '0')}` as UUID;

export const PROTOTYPE_USERS = {
  max: userId('1'),
  kasia: userId('2'),
  leo: userId('3'),
  mia: userId('4'),
  omar: userId('5'),
  deleted: userId('6'),
  nina: userId('7'),
  seb: userId('8'),
} as const;

export const PROTOTYPE_GROUPS = {
  design: groupId('1'),
  release: groupId('2'),
  security: groupId('3'),
  gtm: groupId('4'),
} as const;

export const PROTOTYPE_PRINCIPALS: CapabilityPolicyPrincipalDescriptor[] = [
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.max },
    display_name: 'Max M.',
    secondary_label: 'max@preset.io',
    status: 'active',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.kasia },
    display_name: 'Kasia D.',
    secondary_label: 'kasia@preset.io',
    status: 'active',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.leo },
    display_name: 'Leo R.',
    secondary_label: 'leo@preset.io',
    status: 'active',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.mia },
    display_name: 'Mia S.',
    secondary_label: 'Deactivated teammate',
    status: 'inactive',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.omar },
    display_name: 'Omar N.',
    secondary_label: 'omar@preset.io',
    status: 'active',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.deleted },
    display_name: 'Deleted user',
    secondary_label: 'Identity no longer available',
    status: 'deleted',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.nina },
    display_name: 'Nina P.',
    secondary_label: 'nina@preset.io',
    status: 'active',
  },
  {
    principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.seb },
    display_name: 'Seb V.',
    secondary_label: 'seb@preset.io',
    status: 'active',
  },
  {
    principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.design },
    display_name: 'Product Design',
    secondary_label: '12 active members',
    status: 'active',
  },
  {
    principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.release },
    display_name: 'Release Engineers',
    secondary_label: '8 active members',
    status: 'active',
  },
  {
    principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.security },
    display_name: 'Security',
    secondary_label: '5 active members',
    status: 'active',
  },
  {
    principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.gtm },
    display_name: 'GTM',
    secondary_label: '9 active members',
    status: 'active',
  },
];

const descriptorForUser = (id: UserID) => {
  const descriptor = PROTOTYPE_PRINCIPALS.find(
    (candidate) =>
      candidate.principal.principal_type === 'user' && candidate.principal.user_id === id
  );
  if (descriptor?.principal.principal_type !== 'user') {
    throw new Error(`Missing prototype user ${id}`);
  }
  return descriptor as EffectiveAccessSubject['user'];
};

export const EFFECTIVE_ACCESS_SUBJECTS: EffectiveAccessSubject[] = [
  { user: descriptorForUser(PROTOTYPE_USERS.max), groupIds: [] },
  {
    user: descriptorForUser(PROTOTYPE_USERS.kasia),
    groupIds: [PROTOTYPE_GROUPS.design, PROTOTYPE_GROUPS.release, PROTOTYPE_GROUPS.security],
  },
  {
    user: descriptorForUser(PROTOTYPE_USERS.leo),
    groupIds: [PROTOTYPE_GROUPS.release],
  },
  {
    user: descriptorForUser(PROTOTYPE_USERS.mia),
    groupIds: [PROTOTYPE_GROUPS.design],
  },
  { user: descriptorForUser(PROTOTYPE_USERS.omar), groupIds: [PROTOTYPE_GROUPS.gtm] },
  { user: descriptorForUser(PROTOTYPE_USERS.deleted), groupIds: [] },
  {
    user: descriptorForUser(PROTOTYPE_USERS.nina),
    groupIds: [PROTOTYPE_GROUPS.security],
  },
  {
    user: descriptorForUser(PROTOTYPE_USERS.seb),
    groupIds: [],
  },
];

const closedOthers = () => ({
  preset: 'none' as const,
  capabilities: [],
  fs_access: 'none' as const,
});

const privatePolicy = (
  policyKind: CapabilityPolicyDraft['policy_kind']
): CapabilityPolicyDraft => ({
  schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
  policy_kind: policyKind,
  sharing_mode: 'private',
  entries: [],
  others: closedOthers(),
});

export const PRIVATE_BOARD_FIXTURE: BoardCapabilityPoliciesDraft = {
  primary_owner_user_id: PROTOTYPE_USERS.max,
  board_access: privatePolicy('board_access'),
  branch_template: {
    access: privatePolicy('branch_access'),
    allow_shared_session_prompts: false,
  },
};

export const SHARED_BOARD_FIXTURE: BoardCapabilityPoliciesDraft = {
  primary_owner_user_id: PROTOTYPE_USERS.max,
  board_access: {
    schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
    policy_kind: 'board_access',
    sharing_mode: 'shared',
    entries: [
      {
        entry_id: entryId('1'),
        principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.design },
        preset: 'editor',
        capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
        fs_access: 'none',
      },
      {
        entry_id: entryId('2'),
        principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.kasia },
        preset: 'manager',
        capabilities: ['board.view', 'board.edit', 'board.attach_branch', 'board.policy.manage'],
        fs_access: 'none',
      },
      {
        entry_id: entryId('3'),
        principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.mia },
        preset: 'viewer',
        capabilities: ['board.view'],
        fs_access: 'none',
      },
      {
        entry_id: entryId('4'),
        principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.deleted },
        preset: 'viewer',
        capabilities: ['board.view'],
        fs_access: 'none',
      },
    ],
    others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
  },
  branch_template: {
    access: {
      schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
      policy_kind: 'branch_access',
      sharing_mode: 'shared',
      entries: [
        {
          entry_id: entryId('5'),
          principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.design },
          preset: 'viewer',
          capabilities: ['branch.view'],
          fs_access: 'read',
        },
        {
          entry_id: entryId('6'),
          principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.release },
          preset: 'collaborator',
          capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
          fs_access: 'read',
        },
        {
          entry_id: entryId('7'),
          principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.kasia },
          preset: 'manager',
          capabilities: [
            'branch.view',
            'sessions.create',
            'sessions.prompt_own',
            'sessions.manage_others',
            'branch.manage',
            'environment.control',
            'terminal.open',
            'branch.policy.manage',
          ],
          fs_access: 'write',
        },
        {
          entry_id: entryId('8'),
          principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.mia },
          preset: 'manager',
          capabilities: [
            'branch.view',
            'sessions.create',
            'sessions.prompt_own',
            'sessions.manage_others',
            'branch.manage',
            'environment.control',
            'terminal.open',
            'branch.policy.manage',
          ],
          fs_access: 'write',
        },
        {
          entry_id: entryId('9'),
          principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.deleted },
          preset: 'viewer',
          capabilities: ['branch.view'],
          fs_access: 'read',
        },
      ],
      others: { preset: 'viewer', capabilities: ['branch.view'], fs_access: 'none' },
    },
    allow_shared_session_prompts: true,
  },
};

export const INHERITED_BRANCH_FIXTURE: BranchCapabilityPolicyDraft = {
  primary_owner_user_id: PROTOTYPE_USERS.leo,
  binding_mode: 'inherit',
  inherited_from_board_id: '40000000-0000-0000-0000-000000000001' as BoardID,
  inherited_config: structuredClone(SHARED_BOARD_FIXTURE.branch_template),
};

export const OVERRIDDEN_BRANCH_FIXTURE: BranchCapabilityPolicyDraft = {
  primary_owner_user_id: PROTOTYPE_USERS.leo,
  binding_mode: 'override',
  inherited_from_board_id: '40000000-0000-0000-0000-000000000001' as BoardID,
  inherited_config: structuredClone(SHARED_BOARD_FIXTURE.branch_template),
  override_config: {
    access: {
      schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
      policy_kind: 'branch_access',
      sharing_mode: 'shared',
      entries: [
        {
          entry_id: entryId('10'),
          principal: { principal_type: 'group', group_id: PROTOTYPE_GROUPS.security },
          preset: 'manager',
          capabilities: [
            'branch.view',
            'sessions.create',
            'sessions.prompt_own',
            'sessions.manage_others',
            'branch.manage',
            'environment.control',
            'terminal.open',
            'branch.policy.manage',
          ],
          fs_access: 'write',
        },
        {
          entry_id: entryId('11'),
          principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.kasia },
          preset: 'collaborator',
          capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
          fs_access: 'read',
        },
        {
          entry_id: entryId('12'),
          principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.mia },
          preset: 'viewer',
          capabilities: ['branch.view'],
          fs_access: 'read',
        },
        {
          entry_id: entryId('13'),
          principal: { principal_type: 'user', user_id: PROTOTYPE_USERS.deleted },
          preset: 'viewer',
          capabilities: ['branch.view'],
          fs_access: 'read',
        },
      ],
      others: closedOthers(),
    },
    allow_shared_session_prompts: true,
  },
};

export type BoardPrototypeFixtureId = 'private-board' | 'shared-board';
export type BranchPrototypeFixtureId = 'inherited-branch' | 'overridden-branch';

export const BOARD_PROTOTYPE_FIXTURES: Record<
  BoardPrototypeFixtureId,
  { label: string; description: string; value: BoardCapabilityPoliciesDraft }
> = {
  'private-board': {
    label: 'Private board',
    description: 'Owner-only board and owner-only live branch defaults.',
    value: PRIVATE_BOARD_FIXTURE,
  },
  'shared-board': {
    label: 'Shared board + groups',
    description: 'Overlapping direct/group entries plus inactive and deleted principals.',
    value: SHARED_BOARD_FIXTURE,
  },
};

export const BRANCH_PROTOTYPE_FIXTURES: Record<
  BranchPrototypeFixtureId,
  { label: string; description: string; value: BranchCapabilityPolicyDraft }
> = {
  'inherited-branch': {
    label: 'Inherited branch',
    description: 'Uses the board’s access and personal session-sharing defaults.',
    value: INHERITED_BRANCH_FIXTURE,
  },
  'overridden-branch': {
    label: 'Overridden branch',
    description:
      'Complete local role/file policy plus an example of Seb sharing his sessions with GTM.',
    value: OVERRIDDEN_BRANCH_FIXTURE,
  },
};

export function cloneBoardPrototypeFixture(
  id: BoardPrototypeFixtureId
): BoardCapabilityPoliciesDraft {
  return structuredClone(BOARD_PROTOTYPE_FIXTURES[id].value);
}

export function cloneBranchPrototypeFixture(
  id: BranchPrototypeFixtureId
): BranchCapabilityPolicyDraft {
  return structuredClone(BRANCH_PROTOTYPE_FIXTURES[id].value);
}
