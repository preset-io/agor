import type { Group, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  filterSelectOptionBySearchText,
  groupSelectLabel,
  groupSelectSearchText,
  searchableSelectProps,
  toGroupSelectOption,
  toUserSelectOption,
  userSelectLabel,
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
  it('Settings → Groups user select filters by visible name/email label', () => {
    const user = makeUser({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      unix_username: 'ghopper',
    });
    const label = userSelectLabel(user);
    const searchText = userSelectSearchText(user);

    expect(label).toBe('Grace Hopper (grace@example.com)');
    expect(filterSelectOptionBySearchText('grace', { value: 'user-1', label, searchText })).toBe(
      true
    );
    expect(
      filterSelectOptionBySearchText('example.com', {
        value: 'user-1',
        label,
        searchText,
      })
    ).toBe(true);
    expect(filterSelectOptionBySearchText('ghopper', { value: 'user-1', label, searchText })).toBe(
      false
    );
    expect(
      filterSelectOptionBySearchText('unrelated', {
        value: 'user-1',
        label,
        searchText,
      })
    ).toBe(false);
  });

  it('builds user options with email-only fallback labels', () => {
    const user = makeUser({ name: undefined, email: 'solo@example.com' });

    expect(toUserSelectOption(user)).toEqual({
      value: 'user-1',
      label: 'solo@example.com',
      searchText: 'solo@example.com',
    });
  });

  it('does not duplicate user name when it matches email', () => {
    const user = makeUser({ name: 'same@example.com', email: 'same@example.com' });

    expect(userSelectLabel(user)).toBe('same@example.com');
    expect(userSelectSearchText(user)).toBe('same@example.com');
  });

  it('Settings → Groups group select filters by visible name/slug label', () => {
    const group = makeGroup({ name: 'Design Systems', slug: 'design-systems' });
    const label = groupSelectLabel(group);
    const searchText = groupSelectSearchText(group);

    expect(label).toBe('Design Systems (design-systems)');
    expect(filterSelectOptionBySearchText('design', { value: 'group-1', label, searchText })).toBe(
      true
    );
    expect(filterSelectOptionBySearchText('systems', { value: 'group-1', label, searchText })).toBe(
      true
    );
    expect(filterSelectOptionBySearchText('finance', { value: 'group-1', label, searchText })).toBe(
      false
    );
  });

  it('builds group options from the visible name/slug label', () => {
    const group = makeGroup({ name: 'Platform Engineers', slug: 'platform-eng' });

    expect(toGroupSelectOption(group)).toEqual({
      value: 'group-1',
      label: 'Platform Engineers (platform-eng)',
      searchText: 'platform engineers (platform-eng)',
    });
  });

  it('BranchModal Permissions group select filters by visible group label when labels are JSX', () => {
    const group = makeGroup({ name: 'Release Managers', slug: 'release-managers' });
    const searchText = groupSelectSearchText(group);

    expect(
      filterSelectOptionBySearchText('release', {
        value: 'group-1',
        label: <span>{groupSelectLabel(group)}</span>,
        searchText,
      })
    ).toBe(true);
    expect(
      filterSelectOptionBySearchText('security', {
        value: 'group-1',
        label: <span>{groupSelectLabel(group)}</span>,
        searchText,
      })
    ).toBe(false);
  });

  it('does not match hidden option values that are not in the visible label', () => {
    expect(
      filterSelectOptionBySearchText('hidden-id', {
        value: 'hidden-id',
        label: 'Visible Label',
        searchText: 'visible label',
      })
    ).toBe(false);
  });

  it('exports shared Ant Design Select search props', () => {
    expect(searchableSelectProps).toMatchObject({
      showSearch: true,
      optionFilterProp: 'searchText',
      optionLabelProp: 'label',
    });
    expect(searchableSelectProps.filterOption).toBe(filterSelectOptionBySearchText);
  });
});
