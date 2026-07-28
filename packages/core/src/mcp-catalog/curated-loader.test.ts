import { describe, expect, it } from 'vitest';
import { CuratedCatalogError, loadCuratedCatalog, parseCuratedCatalog } from './curated-loader';

const VALID_ENTRY = `
entries:
  - name: com.example/mcp
    category: dev-tools
    capabilities: [repos, issues]
    benefit: Does a useful thing.
    starter_prompt: Try the useful thing.
    permission_disclosure: Reads your repositories.
    verified: true
    popularity_rank: 1
`;

describe('parseCuratedCatalog', () => {
  it('parses a well-formed entry and defaults verified to false', () => {
    const [entry] = parseCuratedCatalog(`
entries:
  - name: com.example/mcp
    category: search
    capabilities: [web-search]
    benefit: Searches.
    starter_prompt: Search something.
    permission_disclosure: Sends queries to the provider.
`);

    expect(entry.name).toBe('com.example/mcp');
    expect(entry.category).toBe('search');
    expect(entry.capabilities).toEqual(['web-search']);
    expect(entry.verified).toBe(false);
    expect(entry.popularity_rank).toBeUndefined();
  });

  it('rejects an unknown category', () => {
    expect(() =>
      parseCuratedCatalog(VALID_ENTRY.replace('category: dev-tools', 'category: wizardry'))
    ).toThrow(CuratedCatalogError);
  });

  it('rejects an entry missing required curation copy', () => {
    expect(() =>
      parseCuratedCatalog(VALID_ENTRY.replace(/\s+permission_disclosure:.*\n/, '\n'))
    ).toThrow(/permission_disclosure/);
  });

  it('rejects unknown keys rather than silently dropping curation', () => {
    expect(() => parseCuratedCatalog(`${VALID_ENTRY}    tagline: sneaky\n`)).toThrow(
      CuratedCatalogError
    );
  });

  it('rejects a non-http icon url', () => {
    expect(() =>
      parseCuratedCatalog(`${VALID_ENTRY}    icon_url: "javascript:alert(1)"\n`)
    ).toThrow(CuratedCatalogError);
  });

  it('rejects duplicate names', () => {
    expect(() => parseCuratedCatalog(VALID_ENTRY + VALID_ENTRY.replace('entries:', ''))).toThrow(
      /duplicate entry name/
    );
  });

  it('rejects duplicate popularity ranks, which would make ordering depend on file order', () => {
    const second = VALID_ENTRY.replace('entries:', '').replace('com.example/mcp', 'com.other/mcp');
    expect(() => parseCuratedCatalog(VALID_ENTRY + second)).toThrow(/duplicate popularity_rank 1/);
  });

  it('rejects invalid YAML', () => {
    expect(() => parseCuratedCatalog('entries:\n  - name: "unterminated')).toThrow(
      /not valid YAML/
    );
  });

  it('rejects a file with no entries', () => {
    expect(() => parseCuratedCatalog('entries: []')).toThrow(CuratedCatalogError);
  });
});

describe('loadCuratedCatalog', () => {
  it('surfaces a missing file as a curation error rather than a raw ENOENT', async () => {
    await expect(loadCuratedCatalog('/nonexistent/curated.yaml')).rejects.toThrow(
      CuratedCatalogError
    );
  });

  it('loads the checked-in catalog with complete, unique curation', async () => {
    const entries = await loadCuratedCatalog();

    // The launch catalog is meant to cover the obvious shelves, not be a stub.
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(new Set(entries.map((entry) => entry.category)).size).toBe(6);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);

    for (const entry of entries) {
      expect(entry.capabilities.length).toBeGreaterThan(0);
      expect(entry.benefit.length).toBeGreaterThan(0);
      expect(entry.starter_prompt.length).toBeGreaterThan(0);
      expect(entry.permission_disclosure.length).toBeGreaterThan(0);
    }
  });

  it('pairs every curated remote with a transport so the connect flow need not guess', async () => {
    const entries = await loadCuratedCatalog();

    for (const entry of entries.filter((candidate) => candidate.remote_url)) {
      expect(entry.transport).toBeDefined();
      expect(entry.remote_url).toMatch(/^https:\/\//);
    }

    // Most of the launch catalog must be connectable straight from the file, so
    // a fresh install is usable before the first registry sync completes. The
    // remainder are package-only servers with no remote to record.
    const withRemote = entries.filter((entry) => entry.remote_url).length;
    expect(withRemote / entries.length).toBeGreaterThan(0.8);
  });
});
