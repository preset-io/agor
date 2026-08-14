import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { findCatalogEntry, loadCatalog, queryCatalog } from './catalog';
import { curatedCatalogPath } from './curated-loader';

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

describe('queryCatalog ordering', () => {
  it('leads with hand-assigned rank and falls back to name', () => {
    // An entry nobody ranked has to sort after every ranked one. Compared as a
    // number, an absent rank would land ahead of rank 1.
    expect(queryCatalog(ENTRIES).data.map((e) => e.name)).toEqual([
      'com.zulu/mcp',
      'com.alpha/mcp',
      'com.bravo/mcp',
      'com.mike/mcp',
    ]);
  });

  it('orders by name case-insensitively when asked', () => {
    expect(queryCatalog(ENTRIES, { sort: 'name' }).data.map((e) => e.name)).toEqual([
      'com.alpha/mcp',
      'com.bravo/mcp',
      'com.mike/mcp',
      'com.zulu/mcp',
    ]);
  });

  it('is a total order, so paging cannot repeat or skip an entry', () => {
    // Two entries that compare equal on every key before the tie-break would
    // let one page repeat what another skipped.
    const tied = [entry({ name: 'com.b/mcp' }), entry({ name: 'com.a/mcp' })];
    const seen = [
      ...queryCatalog(tied, { limit: 1, offset: 0 }).data,
      ...queryCatalog(tied, { limit: 1, offset: 1 }).data,
    ].map((e) => e.name);

    expect(seen).toEqual(['com.a/mcp', 'com.b/mcp']);
  });
});

describe('queryCatalog filters', () => {
  const names = (filters: Parameters<typeof queryCatalog>[1]) =>
    queryCatalog(ENTRIES, filters).data.map((e) => e.name);

  it('searches name, title, and description case-insensitively', () => {
    expect(names({ search: 'ZULU' })).toEqual(['com.zulu/mcp']);
    expect(names({ search: 'the logs' })).toEqual(['com.mike/mcp']);
  });

  it('matches a capability exactly rather than as a substring', () => {
    // `log` must not match `logs`, or a filter nobody clicked would narrow the
    // grid to something that looks like a real answer.
    expect(names({ capability: 'logs' })).toEqual(['com.mike/mcp']);
    expect(names({ capability: 'log' })).toEqual([]);
  });

  it('narrows by category and endpoint presence', () => {
    expect(names({ category: 'observability' })).toEqual(['com.mike/mcp']);
    expect(names({ has_remote: false })).toEqual(['com.bravo/mcp']);
  });

  it('matches a set of auth types, which one filter genuinely needs', () => {
    expect(names({ auth_types: ['none', 'unknown'] })).toEqual([
      'com.zulu/mcp',
      'com.bravo/mcp',
      'com.mike/mcp',
    ]);
    expect(names({ auth_type: 'oauth' })).toEqual(['com.alpha/mcp']);
  });

  it('reads an empty set as matching nothing, not as no filter at all', () => {
    expect(names({ auth_types: [] })).toEqual([]);
    expect(names({ names: [] })).toEqual([]);
  });

  it('combines filters conjunctively', () => {
    expect(names({ category: 'dev-tools', auth_type: 'none' })).toEqual(['com.zulu/mcp']);
  });
});

describe('queryCatalog paging', () => {
  it('counts the whole match rather than the page', () => {
    const page = queryCatalog(ENTRIES, { limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it('returns an empty page past the end rather than wrapping', () => {
    expect(queryCatalog(ENTRIES, { limit: 2, offset: 99 }).data).toEqual([]);
  });

  it('returns everything from the offset when no limit is given', () => {
    expect(queryCatalog(ENTRIES, { offset: 3 }).data).toHaveLength(1);
  });
});

describe('findCatalogEntry', () => {
  it('finds by exact name and does not fall back to a near match', () => {
    expect(findCatalogEntry(ENTRIES, 'com.mike/mcp')?.name).toBe('com.mike/mcp');
    expect(findCatalogEntry(ENTRIES, 'com.mike')).toBeUndefined();
    expect(findCatalogEntry(ENTRIES, 'COM.MIKE/MCP')).toBeUndefined();
  });
});

describe('loadCatalog', () => {
  it('parses the checked-in file once and holds it', async () => {
    const first = await loadCatalog();
    const second = await loadCatalog();

    // The same objects, not equal copies: re-reading and re-parsing per request
    // is the cost this exists to avoid.
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it('hands out entries nothing can corrupt for the next reader', async () => {
    const entries = await loadCatalog();
    const [first] = entries;

    // Every caller shares these objects, so a mutation would outlive the
    // request that made it and nothing would point back here.
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.capabilities)).toBe(true);
  });

  it('gives each query its own array to reorder or splice', async () => {
    const entries = await loadCatalog();
    const first = queryCatalog(entries, {});
    const expected = first.data.map((e) => e.name);
    first.data.reverse();

    expect(queryCatalog(entries, {}).data.map((e) => e.name)).toEqual(expected);
  });

  it('does not serve the held catalog to a caller that named its own file', async () => {
    // Tests pass a fixture path. Answering those from the cache — in either
    // direction — would have a test assert against the shipped catalog, or
    // leave a fixture behind as the process's answer.
    const shipped = await loadCatalog();
    const fixture = await loadCatalog(curatedCatalogPath());

    expect(fixture).not.toBe(shipped);
    expect(await loadCatalog()).toBe(shipped);
  });
});
