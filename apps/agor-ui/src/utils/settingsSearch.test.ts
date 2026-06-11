import { describe, expect, it } from 'vitest';
import {
  filterBySettingsSearch,
  matchesSettingsSearch,
  type SearchAccessor,
} from './settingsSearch';

interface Row {
  name: string;
  email: string;
  groups: string[];
  role: string;
}

describe('settingsSearch', () => {
  const rows: Row[] = [
    { name: 'Alice Admin', email: 'alice@example.com', groups: ['Platform'], role: 'admin' },
    { name: 'Bob Builder', email: 'bob@example.com', groups: ['Design Systems'], role: 'member' },
  ];
  const accessors: Array<SearchAccessor<Row>> = [
    (row) => row.name,
    (row) => row.email,
    (row) => row.groups,
    (row) => row.role,
  ];

  it('matches all query tokens across searchable fields', () => {
    expect(matchesSettingsSearch(rows[0], 'alice platform', accessors)).toBe(true);
    expect(matchesSettingsSearch(rows[0], 'alice design', accessors)).toBe(false);
  });

  it('filters case-insensitively and supports array fields', () => {
    expect(filterBySettingsSearch(rows, 'DESIGN', accessors).map((row) => row.name)).toEqual([
      'Bob Builder',
    ]);
  });

  it('returns original items for blank queries', () => {
    expect(filterBySettingsSearch(rows, '   ', accessors)).toBe(rows);
  });
});
