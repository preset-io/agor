import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { findCatalogEntry, loadCatalog } from './catalog';
import { curatedCatalogPath } from './curated-loader';

// Narrowing and ordering live in `query.ts`, and are covered by `query.test.ts`.

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
  entry({ name: 'com.zulu/mcp', title: 'Zulu' }),
  entry({ name: 'com.mike/mcp', description: 'Reads the logs.' }),
];

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
    const oauthEntry = entries.find((candidate) => candidate.oauth);
    const credentialEntry = entries.find((candidate) => candidate.credentials);

    // Every caller shares these objects, so a mutation would outlive the
    // request that made it and nothing would point back here.
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.capabilities)).toBe(true);
    expect(oauthEntry?.oauth).toBeDefined();
    expect(credentialEntry?.credentials).toBeDefined();
    expect(Object.isFrozen(oauthEntry?.oauth)).toBe(true);
    expect(Object.isFrozen(credentialEntry?.credentials)).toBe(true);

    expect(() => {
      (oauthEntry?.oauth as { compatibility_mode?: string }).compatibility_mode = 'marketplace';
    }).toThrow(TypeError);
    expect(() => {
      (credentialEntry?.credentials as { scheme: string }).scheme = 'basic';
    }).toThrow(TypeError);
    expect(oauthEntry?.oauth?.compatibility_mode).not.toBe('marketplace');
    expect(credentialEntry?.credentials?.scheme).toBe('bearer');
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
