import type { Group, GroupMembership, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildCapabilityPolicyDirectory } from './principalDirectory';

const user = (user_id: string, name: string): User =>
  ({ user_id, name, email: `${user_id}@example.com`, role: 'member' }) as User;
const owner = user('00000000-0000-0000-0000-000000000001', 'Owner');
const member = user('00000000-0000-0000-0000-000000000003', 'Member');
const design = {
  group_id: '10000000-0000-0000-0000-000000000001',
  name: 'Product Design',
  archived: false,
} as Group;

describe('capability-policy principal directory', () => {
  it('keeps groups as live pointers and preserves unavailable identities', () => {
    const memberships = [{ group_id: design.group_id, user_id: member.user_id } as GroupMembership];
    const directory = buildCapabilityPolicyDirectory({
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

  it('marks archived groups inactive without expanding them into synthetic entries', () => {
    const directory = buildCapabilityPolicyDirectory({
      users: [owner],
      groups: [{ ...design, archived: true }],
    });
    expect(directory.principals).toContainEqual(
      expect.objectContaining({ display_name: 'Product Design', status: 'inactive' })
    );
  });
});
