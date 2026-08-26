import type { Board, Branch, Group, GroupMembership, Session, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildBoardModalPrototypeDraft,
  buildBranchModalPrototypeDraft,
  buildModalPrototypeDirectory,
} from './modalPrototypeModel';

const user = (user_id: string, name: string): User =>
  ({ user_id, name, email: `${user_id}@example.com`, role: 'member' }) as User;
const owner = user('00000000-0000-0000-0000-000000000001', 'Owner');
const manager = user('00000000-0000-0000-0000-000000000002', 'Legacy co-owner');
const member = user('00000000-0000-0000-0000-000000000003', 'Member');
const design = {
  group_id: '10000000-0000-0000-0000-000000000001',
  name: 'Product Design',
  archived: false,
} as Group;

describe('modal capability-policy prototype adapters', () => {
  it('separates private board access from its live branch template', () => {
    const board = {
      board_id: '20000000-0000-0000-0000-000000000001',
      created_by: owner.user_id,
      access_mode: 'private',
      default_others_can: 'prompt',
      default_others_fs_access: 'write',
    } as Board;
    const draft = buildBoardModalPrototypeDraft({
      board,
      owners: [owner, manager],
      groupGrants: [{ group_id: design.group_id, can: 'session', fs_access: 'read' }],
    });

    expect(draft.primary_owner_user_id).toBe(owner.user_id);
    expect(draft.board_access).toMatchObject({ sharing_mode: 'private', entries: [] });
    expect(draft.branch_template.access.sharing_mode).toBe('shared');
    expect(draft.branch_template.access.others).toMatchObject({
      preset: 'collaborator',
      fs_access: 'write',
    });
    expect(draft.branch_template.access.others.capabilities).not.toContain(
      'sessions.manage_others'
    );
    expect(draft.branch_template.session_sharing.owner_rules).toEqual([
      { session_owner_user_id: owner.user_id, enabled: false, grantees: [] },
    ]);
  });

  it('narrows legacy prompt and all while refusing to synthesize personal consent', () => {
    const board = {
      board_id: '20000000-0000-0000-0000-000000000001',
      created_by: owner.user_id,
      default_others_can: 'view',
      default_others_fs_access: 'none',
    } as Board;
    const branch = {
      branch_id: '30000000-0000-0000-0000-000000000001',
      created_by: owner.user_id,
      permission_source: 'override',
      others_can: 'prompt',
      others_fs_access: 'read',
      dangerously_allow_session_sharing: true,
    } as Branch;
    const sessions = [{ created_by: manager.user_id }] as Session[];
    const draft = buildBranchModalPrototypeDraft({
      branch,
      board,
      owners: [owner, manager],
      groupGrants: [{ group_id: design.group_id, can: 'all', fs_access: 'write' }],
      boardGroupGrants: [],
      currentUserId: member.user_id,
      sessions,
    });

    expect(draft.override_config?.access.others.preset).toBe('collaborator');
    expect(draft.override_config?.access.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principal: { principal_type: 'user', user_id: manager.user_id },
          preset: 'manager',
        }),
        expect.objectContaining({
          principal: { principal_type: 'group', group_id: design.group_id },
          preset: 'manager',
        }),
      ])
    );
    expect(draft.override_config?.session_sharing.owner_rules).toEqual(
      expect.arrayContaining([
        { session_owner_user_id: member.user_id, enabled: false, grantees: [] },
        { session_owner_user_id: manager.user_id, enabled: false, grantees: [] },
      ])
    );
  });

  it('keeps groups as live pointers in the preview directory', () => {
    const memberships = [{ group_id: design.group_id, user_id: member.user_id } as GroupMembership];
    const directory = buildModalPrototypeDirectory({
      users: [owner, member],
      groups: [design],
      memberships,
      requiredUserIds: ['00000000-0000-0000-0000-000000000099'],
    });

    expect(
      directory.subjects.find((subject) => subject.user.principal.user_id === member.user_id)
    ).toMatchObject({ groupIds: [design.group_id] });
    expect(directory.principals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          display_name: 'Product Design',
          secondary_label: '1 current member',
        }),
        expect.objectContaining({ status: 'deleted' }),
      ])
    );
  });
});
