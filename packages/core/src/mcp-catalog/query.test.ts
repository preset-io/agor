/**
 * The catalog's search and filter contract.
 *
 * This is the only implementation of it, and the Marketplace calls it directly,
 * so these assertions are what stops "search" quietly starting to match
 * differently. They are deliberately about observable behaviour — which fields a
 * term looks at, how case is handled, whether a partial capability counts, how
 * two active filters combine — rather than about how the function is written.
 */

import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { filterCatalog } from './query';

function entry(overrides: Partial<MCPCatalogEntry> & { name: string }): MCPCatalogEntry {
  return {
    category: 'dev-tools',
    capabilities: ['issues'],
    benefit: 'Does a thing.',
    starter_prompt: 'Do the thing.',
    permission_disclosure: 'Reads a thing.',
    has_remote: true,
    auth_type: 'unknown',
    ...overrides,
  };
}

const ENTRIES: MCPCatalogEntry[] = [
  entry({ name: 'com.zulu/mcp', title: 'Zulu', popularity_rank: 1, auth_type: 'none' }),
  entry({ name: 'com.alpha/mcp', title: 'Alpha', popularity_rank: 2, auth_type: 'oauth' }),
  entry({
    name: 'com.mike/mcp',
    description: 'Reads the logs.',
    category: 'observability',
    capabilities: ['logs', 'metrics'],
  }),
  entry({ name: 'com.bravo/mcp', has_remote: false, auth_type: 'unknown' }),
];

const names = (filters: Parameters<typeof filterCatalog>[1]) =>
  filterCatalog(ENTRIES, filters).map((e) => e.name);

describe('filterCatalog ordering', () => {
  it('leads with hand-assigned rank and falls back to name', () => {
    // An entry nobody ranked has to sort after every ranked one. Compared as a
    // number, an absent rank would land ahead of rank 1.
    expect(names(undefined)).toEqual([
      'com.zulu/mcp',
      'com.alpha/mcp',
      'com.bravo/mcp',
      'com.mike/mcp',
    ]);
  });

  it('orders by name case-insensitively when asked', () => {
    expect(names({ sort: 'name' })).toEqual([
      'com.alpha/mcp',
      'com.bravo/mcp',
      'com.mike/mcp',
      'com.zulu/mcp',
    ]);
  });

  it('is a total order, so a page boundary cannot repeat or skip an entry', () => {
    // The grid slices pages out of this array. Two entries that compared equal
    // on every key before the tie-break would let one page repeat what another
    // skipped, depending on how the sort happened to settle.
    const tied = [entry({ name: 'com.b/mcp' }), entry({ name: 'com.a/mcp' })];
    const sorted = filterCatalog(tied).map((e) => e.name);

    expect(sorted).toEqual(['com.a/mcp', 'com.b/mcp']);
    // Stable across calls, which is what makes slicing it safe.
    expect(filterCatalog(tied).map((e) => e.name)).toEqual(sorted);
  });
});

describe('filterCatalog search', () => {
  it('searches name, title, and description, and nothing else', () => {
    expect(names({ search: 'zulu' })).toEqual(['com.zulu/mcp']); // name
    expect(names({ search: 'Alpha' })).toEqual(['com.alpha/mcp']); // title
    expect(names({ search: 'the logs' })).toEqual(['com.mike/mcp']); // description

    // `benefit`, `starter_prompt` and `permission_disclosure` are on every
    // fixture entry, so a term from one of them matching would return all four.
    expect(names({ search: 'Does a thing' })).toEqual([]);
    expect(names({ search: 'Do the thing' })).toEqual([]);
    expect(names({ search: 'Reads a thing' })).toEqual([]);
  });

  it('ignores case in both the term and the field', () => {
    expect(names({ search: 'ZULU' })).toEqual(['com.zulu/mcp']);
    expect(names({ search: 'zULu' })).toEqual(['com.zulu/mcp']);
    expect(names({ search: 'ALPHA' })).toEqual(['com.alpha/mcp']);
  });

  it('matches a partial term anywhere in the field, not just at the start', () => {
    expect(names({ search: 'ulu' })).toEqual(['com.zulu/mcp']);
    expect(names({ search: 'lph' })).toEqual(['com.alpha/mcp']);
  });

  it('trims the term, and treats a blank one as no search at all', () => {
    expect(names({ search: '  zulu  ' })).toEqual(['com.zulu/mcp']);
    expect(names({ search: '' })).toHaveLength(ENTRIES.length);
    expect(names({ search: '   ' })).toHaveLength(ENTRIES.length);
  });

  it('matches nothing when the term is in no searched field', () => {
    expect(names({ search: 'nothing-matches-this' })).toEqual([]);
  });
});

describe('filterCatalog filters', () => {
  it('matches a capability exactly rather than as a substring', () => {
    // `log` must not match `logs`, or a filter nobody clicked would narrow the
    // grid to something that looks like a real answer.
    expect(names({ capability: 'logs' })).toEqual(['com.mike/mcp']);
    expect(names({ capability: 'log' })).toEqual([]);
  });

  it('ignores case and surrounding space in a capability', () => {
    expect(names({ capability: 'LOGS' })).toEqual(['com.mike/mcp']);
    expect(names({ capability: ' logs ' })).toEqual(['com.mike/mcp']);
  });

  it('narrows by category exactly', () => {
    expect(names({ category: 'observability' })).toEqual(['com.mike/mcp']);
    expect(names({ category: 'dev-tools' })).toEqual([
      'com.zulu/mcp',
      'com.alpha/mcp',
      'com.bravo/mcp',
    ]);
  });

  it('matches a set of auth types, which the one auth control genuinely needs', () => {
    // "Not known to need an account" spans stated-open and not-stated, so the
    // toolbar's switch passes both values rather than one.
    expect(names({ auth_types: ['none', 'unknown'] })).toEqual([
      'com.zulu/mcp',
      'com.bravo/mcp',
      'com.mike/mcp',
    ]);
    expect(names({ auth_types: ['oauth'] })).toEqual(['com.alpha/mcp']);
  });

  it('reads an empty set as matching nothing, not as no filter at all', () => {
    expect(names({ auth_types: [] })).toEqual([]);
  });

  it('combines active filters conjunctively', () => {
    expect(names({ category: 'dev-tools', auth_types: ['none'] })).toEqual(['com.zulu/mcp']);
    expect(names({ search: 'zulu', category: 'observability' })).toEqual([]);
    expect(names({ search: 'com', capability: 'logs', auth_types: ['unknown'] })).toEqual([
      'com.mike/mcp',
    ]);
  });

  it('treats an absent filter as no constraint', () => {
    expect(names({})).toHaveLength(ENTRIES.length);
    expect(names({ search: undefined, category: undefined })).toHaveLength(ENTRIES.length);
  });
});

describe('filterCatalog isolation', () => {
  it('gives each call its own array to reorder or splice', () => {
    const first = filterCatalog(ENTRIES);
    const expected = first.map((e) => e.name);
    first.reverse();

    expect(filterCatalog(ENTRIES).map((e) => e.name)).toEqual(expected);
  });

  it('does not reorder the array it was given', () => {
    const input = [...ENTRIES];
    const before = input.map((e) => e.name);
    filterCatalog(input, { sort: 'name' });

    expect(input.map((e) => e.name)).toEqual(before);
  });
});
