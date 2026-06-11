import { matchSearchTokens, tokenizeSearchQuery } from '@agor-live/client';

export type SearchableValue = string | number | boolean | null | undefined | SearchableValue[];

export type SearchAccessor<T> = (item: T) => SearchableValue;

export function getSettingsSearchTokens(query: string): string[] {
  return tokenizeSearchQuery(query)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

export function flattenSearchableValue(value: SearchableValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(flattenSearchableValue);
  return [String(value)];
}

export function matchesSettingsSearch<T>(
  item: T,
  query: string,
  accessors: Array<SearchAccessor<T>>
): boolean {
  const tokens = getSettingsSearchTokens(query);
  if (tokens.length === 0) return true;

  const fields = accessors.flatMap((accessor) => flattenSearchableValue(accessor(item)));
  return matchSearchTokens(tokens, fields);
}

export function filterBySettingsSearch<T>(
  items: T[],
  query: string,
  accessors: Array<SearchAccessor<T>>
): T[] {
  if (getSettingsSearchTokens(query).length === 0) return items;
  return items.filter((item) => matchesSettingsSearch(item, query, accessors));
}
