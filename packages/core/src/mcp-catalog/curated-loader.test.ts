import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { catalogServerSlug } from '../types/mcp-catalog';
import { load as loadYaml } from '../yaml';
import {
  CuratedCatalogError,
  curatedCatalogPath,
  loadCuratedCatalog,
  parseCuratedCatalog,
} from './curated-loader';

const VALID_ENTRY = `
entries:
  - name: com.example/mcp
    category: dev-tools
    capabilities: [code-repos, issues]
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

  it('rejects a capability outside the curated vocabulary', () => {
    // An open string field lets a typo create a facet with one member that no
    // filter will ever surface.
    expect(() =>
      parseCuratedCatalog(
        VALID_ENTRY.replace('capabilities: [code-repos, issues]', 'capabilities: [isues]')
      )
    ).toThrow(CuratedCatalogError);
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

  it('rejects verified: true on an unpublished entry', () => {
    // `verified` backs a user-facing trust badge and the "verified only"
    // filter. Under `unpublished:` the name is Agor's inference from a domain,
    // so nothing has confirmed it identifies that vendor's server.
    const source = `
entries:
  - name: com.published/mcp
    category: dev-tools
    capabilities: [code-repos]
    benefit: Real.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    verified: true
    popularity_rank: 1
unpublished:
  - name: com.guessed/mcp
    category: dev-tools
    capabilities: [code-repos]
    benefit: Guessed.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    verified: true
    popularity_rank: 2
`;

    // The message must name the entry, so a failing daemon start is actionable.
    expect(() => parseCuratedCatalog(source)).toThrow(/com\.guessed\/mcp/);
    expect(() => parseCuratedCatalog(source)).toThrow(CuratedCatalogError);
  });

  it('accepts an unpublished entry that does not claim to be verified', () => {
    const [published, guessed] = parseCuratedCatalog(`
entries:
  - name: com.published/mcp
    category: dev-tools
    capabilities: [code-repos]
    benefit: Real.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    verified: true
    popularity_rank: 1
unpublished:
  - name: com.guessed/mcp
    category: dev-tools
    capabilities: [code-repos]
    benefit: Guessed.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    verified: false
    popularity_rank: 2
`);

    // Both lists flow downstream as one catalog; only the badge differs.
    expect(published).toMatchObject({ name: 'com.published/mcp', verified: true });
    expect(guessed).toMatchObject({ name: 'com.guessed/mcp', verified: false });
  });

  it('enforces name and rank uniqueness across both lists, not within each', () => {
    const withUnpublished = (name: string, rank: number) => `
entries:
  - name: com.published/mcp
    category: dev-tools
    capabilities: [code-repos]
    benefit: Real.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    verified: true
    popularity_rank: 1
unpublished:
  - name: ${name}
    category: dev-tools
    capabilities: [code-repos]
    benefit: Guessed.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    verified: false
    popularity_rank: ${rank}
`;

    expect(() => parseCuratedCatalog(withUnpublished('com.published/mcp', 2))).toThrow(
      /duplicate entry name/
    );
    expect(() => parseCuratedCatalog(withUnpublished('com.other/mcp', 1))).toThrow(
      /duplicate popularity_rank/
    );
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

describe('auth_type', () => {
  const withAuth = (line: string) =>
    parseCuratedCatalog(`${VALID_ENTRY}${line ? `    ${line}\n` : ''}`)[0];

  it('reads an omitted auth_type as unstated rather than as open', () => {
    expect(withAuth('').auth_type).toBe('unknown');
  });

  it.each(['none', 'oauth', 'credentials'] as const)('carries a stated %s', (authType) => {
    expect(withAuth(`auth_type: ${authType}`).auth_type).toBe(authType);
  });

  it('refuses a verdict only a live check could produce', () => {
    // `unreachable` describes one moment, so a checked-in file cannot claim it.
    expect(() => withAuth('auth_type: unreachable')).toThrow(CuratedCatalogError);
  });

  it('refuses an entry that spells its own absence', () => {
    // Omitting the key is how an entry says nothing; a second spelling for it
    // would let a reviewer read "unknown" as a decision somebody made.
    expect(() => withAuth('auth_type: unknown')).toThrow(CuratedCatalogError);
  });
});

describe('has_remote', () => {
  it('is derived from the endpoint rather than stated alongside it', () => {
    expect(parseCuratedCatalog(VALID_ENTRY)[0].has_remote).toBe(false);
    const withRemote = parseCuratedCatalog(
      `${VALID_ENTRY}    remote_url: https://mcp.example.com/mcp\n    transport: streamable-http\n`
    );
    expect(withRemote[0].has_remote).toBe(true);
  });
});

describe('loadCuratedCatalog', () => {
  it('surfaces a missing file as a curation error rather than a raw ENOENT', async () => {
    await expect(loadCuratedCatalog('/nonexistent/curated.yaml')).rejects.toThrow(
      CuratedCatalogError
    );
  });

  it('never claims verified on an entry the registry does not publish', async () => {
    // The invariant that makes the badge mean something.
    // `parseCuratedCatalog` enforces it, so loading the real file at all proves
    // it holds — this pins the split so a future edit that moved every entry
    // into `entries:` to dodge the rule would be visible.
    const source = await fs.readFile(curatedCatalogPath(), 'utf-8');
    const document = loadYaml(source) as {
      entries: Array<{ verified?: boolean }>;
      unpublished: Array<{ verified?: boolean }>;
    };

    expect(document.unpublished.length).toBeGreaterThan(0);
    expect(document.unpublished.every((entry) => entry.verified !== true)).toBe(true);
    expect(document.entries.every((entry) => entry.verified === true)).toBe(true);
    // A badge that is true on every row is a filter that matches everything.
    expect(
      document.unpublished.length / (document.entries.length + document.unpublished.length)
    ).toBeGreaterThan(0.2);
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

  it('gives every curated entry a distinct server name', async () => {
    const entries = await loadCuratedCatalog();

    // `catalogServerSlug` is the `<name>` in every `mcp__<name>__<tool>`, and
    // the executor builds its config as an object keyed on it
    // (`query-builder.ts`, `mcpConfig[server.name] = …`) with no unique index
    // behind it. Two curated entries sharing a slug means the second install in
    // a session silently replaces the first and one server never loads.
    //
    // Uniqueness is a property of the whole file, not of the derivation: a
    // second entry under a publisher already present — `com.atlassian/jira`
    // beside `com.atlassian/atlassian-mcp-server` — reintroduces it without
    // touching a line of code.
    const bySlug = new Map<string, string[]>();
    for (const entry of entries) {
      const slug = catalogServerSlug(entry.name);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), entry.name]);
    }
    const collisions = [...bySlug.entries()].filter(([, names]) => names.length > 1);

    expect(collisions).toEqual([]);
  });

  it('pairs every curated remote with a transport so the connect flow need not guess', async () => {
    const entries = await loadCuratedCatalog();

    for (const entry of entries.filter((candidate) => candidate.remote_url)) {
      expect(entry.transport).toBeDefined();
      expect(entry.remote_url).toMatch(/^https:\/\//);
    }

    // The catalog is a browse surface for servers users can connect, so most of
    // it has to name an endpoint. The remainder are package-only servers with
    // no remote to record, which the marketplace shows as running locally.
    const withRemote = entries.filter((entry) => entry.remote_url).length;
    expect(withRemote / entries.length).toBeGreaterThan(0.8);
  });

  it('states an auth type for every entry with an endpoint, and none without', async () => {
    const entries = await loadCuratedCatalog();

    for (const entry of entries) {
      if (entry.remote_url) {
        // An unstated endpoint still works — connecting checks it — but it
        // makes the marketplace say "not checked yet" about a server somebody
        // could have checked once, for everyone, in a pull request.
        expect(entry.auth_type, `${entry.name} states no auth_type`).not.toBe('unknown');
      } else {
        // Nothing to dial, so there is nothing to state.
        expect(entry.auth_type, `${entry.name} has no endpoint`).toBe('unknown');
      }
    }
  });

  it('offers at least a few servers that need no account at all', async () => {
    const entries = await loadCuratedCatalog();

    // Only the no-auth branch of connect is wired. A catalog where every
    // endpoint needed an account would render a Connect button that could never
    // succeed, so this is what keeps the marketplace demonstrably usable.
    const open = entries.filter((entry) => entry.auth_type === 'none');
    expect(open.length).toBeGreaterThanOrEqual(3);
  });
});
