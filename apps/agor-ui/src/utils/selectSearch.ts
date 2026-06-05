import type { Group, User } from '@agor-live/client';
import type { ReactNode } from 'react';

export interface SearchableSelectOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  searchText: string;
}

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const compactSearchText = (parts: Array<string | null | undefined>): string =>
  parts.filter(Boolean).join(' ').toLowerCase();

export const userSelectSearchText = (user: Pick<User, 'email' | 'name' | 'unix_username'>) =>
  compactSearchText([user.name, user.email, user.unix_username]);

export const groupSelectSearchText = (group: Pick<Group, 'name' | 'slug' | 'description'>) =>
  compactSearchText([group.name, group.slug, group.description]);

/**
 * Ant Design Select's default filtering can search `value` instead of the
 * human-readable option label when `options` are used, and JSX labels stringify
 * poorly. Search a dedicated text field first, with string fallbacks for older
 * options.
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
  return compactSearchText([option?.searchText, labelText, String(option?.value ?? '')]).includes(
    needle
  );
};
