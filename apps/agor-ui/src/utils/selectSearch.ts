import type { Group, User } from '@agor-live/client';
import type { ReactNode } from 'react';

export interface SearchableSelectOption<Value extends string = string> {
  value: Value;
  label: string;
  searchText: string;
}

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const compactSearchText = (parts: Array<string | null | undefined>): string =>
  parts.filter(Boolean).join(' ').toLowerCase();

export const userSelectLabel = (user: Pick<User, 'email' | 'name'>): string => {
  const name = user.name?.trim();
  return name && name !== user.email ? `${name} (${user.email})` : user.email;
};

export const groupSelectLabel = (group: Pick<Group, 'name' | 'slug'>): string => {
  const slug = group.slug?.trim();
  return slug && slug !== group.name ? `${group.name} (${slug})` : group.name;
};

export const userSelectSearchText = (user: Pick<User, 'email' | 'name'>) =>
  normalizeSearchText(userSelectLabel(user));

export const groupSelectSearchText = (group: Pick<Group, 'name' | 'slug'>) =>
  normalizeSearchText(groupSelectLabel(group));

export const selectSearchTextFromLabel = (label: string) => normalizeSearchText(label);

export const toUserSelectOption = (
  user: Pick<User, 'user_id' | 'email' | 'name'>
): SearchableSelectOption<User['user_id']> => {
  const label = userSelectLabel(user);
  return {
    value: user.user_id,
    label,
    searchText: selectSearchTextFromLabel(label),
  };
};

export const toGroupSelectOption = (
  group: Pick<Group, 'group_id' | 'name' | 'slug'>
): SearchableSelectOption<Group['group_id']> => {
  const label = groupSelectLabel(group);
  return {
    value: group.group_id,
    label,
    searchText: selectSearchTextFromLabel(label),
  };
};

/**
 * Ant Design Select's default filtering can search `value` instead of the
 * human-readable option label when `options` are used, and JSX labels stringify
 * poorly. Search a dedicated text field that should match visible option text,
 * with a string-label fallback for older options.
 */
export const filterSelectOptionBySearchText = (
  input: string,
  option?: {
    searchText?: string;
    label?: ReactNode;
    value?: unknown;
  } | null
): boolean => {
  const needle = normalizeSearchText(input);
  if (!needle) return true;

  const labelText = typeof option?.label === 'string' ? option.label : '';
  return compactSearchText([option?.searchText, labelText]).includes(needle);
};

export const searchableSelectProps = {
  showSearch: true,
  optionFilterProp: 'searchText',
  optionLabelProp: 'label',
  filterOption: filterSelectOptionBySearchText,
} as const;
