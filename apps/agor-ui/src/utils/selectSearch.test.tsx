import type { Group, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  filterSelectOptionBySearchText,
  groupSelectSearchText,
  userSelectSearchText,
} from './selectSearch';

const makeUser = (overrides: Partial<User>): User =>
  ({
    user_id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    role: 'member',
    unix_username: 'ada_l',
    onboarding_completed: true,
    must_change_password: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as User;

const makeGroup = (overrides: Partial<Group>): Group =>
  ({
    group_id: 'group-1',
    name: 'Platform Engineers',
    slug: 'platform-eng',
    description: 'People who maintain the platform',
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }) as Group;

describe('Select search helpers', () => {
  it('Settings → Groups user select filters by name and email', () => {
    const searchText = userSelectSearchText(
      makeUser({ name: 'Grace Hopper', email: 'grace@example.com', unix_username: 'ghopper' })
    );

    expect(
      filterSelectOptionBySearchText('grace', { value: 'user-1', label: 'JSX', searchText })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('example.com', {
        value: 'user-1',
        label: 'JSX',
        searchText,
      })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('ghopper', { value: 'user-1', label: 'JSX', searchText })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('unrelated', {
        value: 'user-1',
        label: 'JSX',
        searchText,
      })
    ).toBe(false);
  });

  it('Settings → Groups group select filters by group name', () => {
    const searchText = groupSelectSearchText(makeGroup({ name: 'Design Systems' }));

    expect(
      filterSelectOptionBySearchText('design', { value: 'group-1', label: 'JSX', searchText })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('systems', { value: 'group-1', label: 'JSX', searchText })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('finance', { value: 'group-1', label: 'JSX', searchText })
    ).toBe(false);
  });

  it('BranchModal Permissions group select filters by group name when labels are JSX', () => {
    const searchText = groupSelectSearchText(makeGroup({ name: 'Release Managers' }));

    expect(
      filterSelectOptionBySearchText('release', {
        value: 'group-1',
        label: <span>Release Managers</span>,
        searchText,
      })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('security', {
        value: 'group-1',
        label: <span>Release Managers</span>,
        searchText,
      })
    ).toBe(false);
  });
});
