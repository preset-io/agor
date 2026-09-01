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

// Names an endpoint because the loader now refuses an entry that does not:
// see `parseCuratedCatalog — entries nothing could install`.
const VALID_ENTRY = `
entries:
  - name: com.example/mcp
    category: dev-tools
    capabilities: [code-repos, issues]
    benefit: Does a useful thing.
    starter_prompt: Try the useful thing.
    permission_disclosure: Reads your repositories.
    remote_url: https://mcp.example.com/mcp
    popularity_rank: 1
`;

describe('parseCuratedCatalog', () => {
  it('parses a well-formed entry', () => {
    const [entry] = parseCuratedCatalog(`
entries:
  - name: com.example/mcp
    category: search
    capabilities: [web-search]
    benefit: Searches.
    starter_prompt: Search something.
    permission_disclosure: Sends queries to the provider.
    remote_url: https://mcp.example.com/mcp
`);

    expect(entry.name).toBe('com.example/mcp');
    expect(entry.category).toBe('search');
    expect(entry.capabilities).toEqual(['web-search']);
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

  it('enforces name and rank uniqueness across both lists, not within each', () => {
    const withUnpublished = (name: string, rank: number) => `
entries:
  - name: com.published/mcp
    category: dev-tools
    capabilities: [code-repos]
    benefit: Real.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    remote_url: https://mcp.published.com/mcp
    popularity_rank: 1
unpublished:
  - name: ${name}
    category: dev-tools
    capabilities: [code-repos]
    benefit: Guessed.
    starter_prompt: Do it.
    permission_disclosure: Reads repos.
    remote_url: https://mcp.guessed.com/mcp
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

  it.each(['none', 'oauth'] as const)('carries a stated %s', (authType) => {
    expect(withAuth(`auth_type: ${authType}`).auth_type).toBe(authType);
  });

  it('requires a reviewed scheme and acquisition URL for credentials', () => {
    expect(() => withAuth('auth_type: credentials')).toThrow(CuratedCatalogError);
    const entry = parseCuratedCatalog(
      `${VALID_ENTRY}    auth_type: credentials\n    credentials:\n      scheme: bearer\n      acquisition_url: https://example.com/tokens\n`
    )[0];
    expect(entry.credentials).toEqual({
      scheme: 'bearer',
      acquisition_url: 'https://example.com/tokens',
    });
  });

  it('accepts only an explicit true OAuth-challenge bearer exception', () => {
    const entry = parseCuratedCatalog(
      `${VALID_ENTRY}    auth_type: credentials\n    credentials:\n      scheme: bearer\n      acquisition_url: https://example.com/tokens\n      oauth_challenge_compatible: true\n`
    )[0];
    expect(entry.credentials?.oauth_challenge_compatible).toBe(true);
    expect(() =>
      parseCuratedCatalog(
        `${VALID_ENTRY}    auth_type: credentials\n    credentials:\n      scheme: bearer\n      acquisition_url: https://example.com/tokens\n      oauth_challenge_compatible: false\n`
      )
    ).toThrow(CuratedCatalogError);
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
    // Only ever true now — an entry without an endpoint fails the load — so
    // what is left to hold is that it is still *derived*, never authored. A
    // file that could state `has_remote: true` beside no `remote_url` would
    // offer a Connect button with nothing behind it.
    expect(parseCuratedCatalog(VALID_ENTRY)[0].has_remote).toBe(true);
    expect(() =>
      parseCuratedCatalog(VALID_ENTRY.replace('    remote_url: https://mcp.example.com/mcp\n', ''))
    ).toThrow(CuratedCatalogError);
  });
});

describe('loadCuratedCatalog', () => {
  it('surfaces a missing file as a curation error rather than a raw ENOENT', async () => {
    await expect(loadCuratedCatalog('/nonexistent/curated.yaml')).rejects.toThrow(
      CuratedCatalogError
    );
  });

  it('keeps the provenance split recording a real distinction', async () => {
    // Which list an entry sits under is the only record of whether its `name` is
    // one the registry publishes or one Agor inferred, and parsing throws that
    // away. Nothing downstream can catch a curator filing an inferred name under
    // `entries:`, so what is checkable is that the split has not collapsed to a
    // formality every entry falls on one side of.
    const source = await fs.readFile(curatedCatalogPath(), 'utf-8');
    const document = loadYaml(source) as {
      entries: unknown[];
      unpublished: unknown[];
    };

    expect(document.entries.length).toBeGreaterThan(0);
    expect(
      document.unpublished.length / (document.entries.length + document.unpublished.length)
    ).toBeGreaterThan(0.2);
  });

  it('files Tavily under its official Registry identity, not an inferred alias', async () => {
    const source = await fs.readFile(curatedCatalogPath(), 'utf-8');
    const document = loadYaml(source) as {
      entries: Array<{ name?: string }>;
      unpublished: Array<{ name?: string }>;
    };

    expect(document.entries.map((entry) => entry.name)).toContain('io.github.tavily-ai/tavily-mcp');
    expect(document.unpublished.map((entry) => entry.name)).not.toContain(
      'io.github.tavily-ai/tavily-mcp'
    );
    expect([...document.entries, ...document.unpublished].map((entry) => entry.name)).not.toContain(
      'com.tavily/mcp'
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

    // Not "most of it" any more: the catalog is a browse surface for servers
    // users can connect, and an entry nothing can install is a dead card. The
    // loader enforces this; asserting it here keeps the shipped file honest
    // even if that rule is ever loosened.
    expect(entries.filter((entry) => !entry.remote_url)).toEqual([]);
  });

  it('states an auth type for every entry with an endpoint, and none without', async () => {
    const entries = await loadCuratedCatalog();

    for (const entry of entries) {
      // Every entry names an endpoint now, so every entry owes an auth_type.
      // An unstated one still works — connecting checks it — but it makes the
      // marketplace say "not checked yet" about a server somebody could have
      // checked once, for everyone, in a pull request.
      expect(entry.auth_type, `${entry.name} states no auth_type`).not.toBe('unknown');
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

/**
 * The `oauth:` block: what an entry may state about a server's sign-in flow.
 *
 * The block exists for servers that fall short of the MCP authorization spec's
 * discovery chain. Everything a compliant server publishes about itself is
 * fetched at the moment somebody signs in, so the shipped catalog states none
 * of this — an authored fact about a third party's endpoint decays and nothing
 * sweeps this file for rot.
 */
describe('parseCuratedCatalog — oauth settings', () => {
  const withOAuth = (block: string) => `
entries:
  - name: com.example/mcp
    category: dev-tools
    capabilities: [issues]
    benefit: Does a useful thing.
    starter_prompt: Try the useful thing.
    permission_disclosure: Reads your issues.
    remote_url: https://mcp.example.com/mcp
    auth_type: oauth
    oauth:
${block}
`;

  it('accepts the settings a server may need stated', () => {
    const [entry] = parseCuratedCatalog(
      withOAuth(`      scope: read:issues write:issues
      client_id: public-client-123
      dcr_mode: fallback
      compatibility_mode: legacy`)
    );

    expect(entry.oauth).toEqual({
      scope: 'read:issues write:issues',
      client_id: 'public-client-123',
      dcr_mode: 'fallback',
      compatibility_mode: 'legacy',
    });
  });

  it.each([
    ['client_secret', '      client_secret: sh-hunter2'],
    ['token_url', '      token_url: https://example.com/token'],
    ['authorization_url', '      authorization_url: https://example.com/authorize'],
  ])('refuses %s, which does not belong in a public shared file', (_field, block) => {
    // A client secret here is a published secret shared by every tenant. The
    // two URLs are where an authorization code and a client credential get
    // sent, so a stale one delivers a live grant to whatever now answers there
    // — and they are the facts discovery is most reliable about. Failing the
    // load is the point: a dropped key would be a silent leak.
    expect(() => parseCuratedCatalog(withOAuth(block))).toThrow(CuratedCatalogError);
  });

  it('refuses an empty block, so absence is the only way to say "discover it"', () => {
    expect(() => parseCuratedCatalog(withOAuth('      {}'))).toThrow(CuratedCatalogError);
  });

  it('refuses a mode it would silently ignore', () => {
    expect(() => parseCuratedCatalog(withOAuth('      dcr_mode: whatever'))).toThrow(
      CuratedCatalogError
    );
  });

  it('refuses dcr_mode: disabled with no client_id, which can never start a flow', () => {
    // Registration off and no client stated leaves the flow with no client ID
    // to send, and `startOAuthFlow` throws on exactly that pair. Caught here it
    // is a diff a reviewer can fix; caught there it is a per-user dead end.
    expect(() => parseCuratedCatalog(withOAuth('      dcr_mode: disabled'))).toThrow(
      CuratedCatalogError
    );
  });

  it.each(['advertised', 'fallback'] as const)(
    'accepts dcr_mode: %s with no client_id, because registration can supply one',
    (dcrMode) => {
      const [entry] = parseCuratedCatalog(withOAuth(`      dcr_mode: ${dcrMode}`));
      expect(entry.oauth).toEqual({ dcr_mode: dcrMode });
    }
  );

  it('accepts dcr_mode: disabled with the client_id it requires', () => {
    const [entry] = parseCuratedCatalog(
      withOAuth(`      client_id: public-client-123
      dcr_mode: disabled`)
    );
    expect(entry.oauth).toEqual({ client_id: 'public-client-123', dcr_mode: 'disabled' });
  });

  it('leaves the block absent when an entry states nothing', () => {
    const [entry] = parseCuratedCatalog(VALID_ENTRY);
    expect(entry.oauth).toBeUndefined();
  });
});

describe('the shipped catalog', () => {
  it('keeps material destructive, sensitive, and operational authority in disclosures', async () => {
    const entries = await loadCuratedCatalog();
    const disclosure = (name: string): string => {
      const entry = entries.find((candidate) => candidate.name === name);
      expect(entry, `missing catalog entry ${name}`).toBeDefined();
      return entry!.permission_disclosure;
    };

    const expectTerms = (name: string, terms: string[]): void => {
      const copy = disclosure(name).toLowerCase();
      for (const term of terms) expect(copy).toContain(term.toLowerCase());
    };
    expectTerms('io.github.cloudinary/asset-management-mcp', [
      'creates, moves, and deletes folders',
      'recursive folder deletion',
      'all assets',
    ]);
    expectTerms('com.netlify/mcp', [
      'user and team',
      'access controls',
      'install or remove extensions',
      'secrets',
    ]);
    expectTerms('com.klaviyo/mcp', [
      'default unparameterized endpoint',
      'write actions',
      'user-generated-content tools',
      'all non-beta toolsets',
      'send, or clone campaigns',
      'create, update, or delete flows',
      'delete lists and segments',
      'add or remove list members',
      'profile deletion requests',
      'delete webhooks and forms',
      'coupons and coupon codes',
      'tag groups',
      'images',
      'email templates',
      'custom metrics',
    ]);
    expectTerms('io.customer/mcp', [
      'US-region',
      'every scope',
      'sensitive profile',
      'live messages',
      'subscriptions',
      'integrations',
      'webhooks',
    ]);
    expectTerms('io.incident/mcp', [
      'investigation',
      'post-mortem',
      'logs',
      'metrics',
      'traces',
      'dashboards',
      'Allowed redirect domains',
    ]);
    expect(entries.find((entry) => entry.name === 'io.incident/mcp')).toMatchObject({
      website_url: 'https://docs.incident.io/ai/remote-mcp',
    });
  });

  it("uses Firecrawl's documented versioned keyless endpoint", async () => {
    const entries = await loadCuratedCatalog();
    expect(entries).toContainEqual(
      expect.objectContaining({
        name: 'com.firecrawl/mcp',
        remote_url: 'https://mcp.firecrawl.dev/v2/mcp',
        auth_type: 'none',
        capabilities: ['web-search', 'web-scrape'],
      })
    );
  });

  it('keeps the 2026-08-20 boundary-audited expansion on its reviewed endpoints and auth paths', async () => {
    // Live provider metadata evidence and the mocked production service-boundary
    // fixture are documented in the accompanying audit report.
    // Assert identities rather than a whole-catalog count: unrelated additions
    // should not require this audit contract to change.
    const entries = await loadCuratedCatalog();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'com.postman/postman-mcp-server',
          remote_url: 'https://mcp.postman.com/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'io.github.clerk/mcp-server',
          remote_url: 'https://mcp.clerk.com/mcp',
          auth_type: 'none',
        }),
        expect.objectContaining({
          name: 'io.github.cloudinary/asset-management-mcp',
          remote_url: 'https://asset-management.mcp.cloudinary.com/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'io.github.miroapp/mcp-server',
          remote_url: 'https://mcp.miro.com/',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'co.axiom/mcp',
          remote_url: 'https://mcp.axiom.co/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'io.github.algolia/algolia-productivity',
          remote_url: 'https://mcp.algolia.com/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'com.netlify/mcp',
          remote_url: 'https://netlify-mcp.netlify.app/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'com.klaviyo/mcp',
          remote_url: 'https://mcp.klaviyo.com/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'io.customer/mcp',
          remote_url: 'https://mcp.customer.io/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'io.incident/mcp',
          remote_url: 'https://mcp.incident.io/mcp',
          auth_type: 'oauth',
        }),
        expect.objectContaining({
          name: 'io.github.tavily-ai/tavily-mcp',
          remote_url: 'https://mcp.tavily.com/mcp/',
          auth_type: 'oauth',
        }),
      ])
    );
  });

  it('keeps the GitHub PAT and Twilio Public Beta limitations visible on their cards', async () => {
    const entries = await loadCuratedCatalog();
    const github = entries.find((entry) => entry.name === 'io.github.github/github-mcp-server');
    expect(github).toMatchObject({
      website_url:
        'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
      credentials: { label: 'Fine-grained personal access token' },
    });
    expect(github?.permission_disclosure).toMatch(/Enterprise Managed User/i);
    expect(github?.permission_disclosure).toMatch(/Organisation policy/i);
    expect(github?.permission_disclosure).toMatch(/paid GitHub or Copilot feature requirements/i);

    const twilio = entries.find((entry) => entry.name === 'com.twilio/docs-mcp');
    expect(twilio).toMatchObject({ website_url: 'https://www.twilio.com/docs/ai/mcp' });
    expect(twilio?.permission_disclosure).toMatch(/Public Beta/i);
    expect(twilio?.permission_disclosure).toMatch(/Support Terms/i);
    expect(twilio?.permission_disclosure).toMatch(/Service Level Agreement/i);
  });

  it('opts the providers that pass the strict production boundary into strict mode', async () => {
    // Marketplace installs with no statement use the daemon's bounded
    // interoperability profile. These three publish the exact PRM/issuer,
    // S256 and RFC 9207 contracts, so keep the stronger policy explicit and
    // make any later expansion a reviewed curation change.
    const entries = await loadCuratedCatalog();
    expect(
      entries.filter((entry) => entry.oauth !== undefined).map((entry) => [entry.name, entry.oauth])
    ).toEqual([
      ['com.monday/monday.com', { compatibility_mode: 'strict' }],
      ['com.cloudflare/mcp', { compatibility_mode: 'strict' }],
      ['com.clickup/mcp', { compatibility_mode: 'strict' }],
    ]);
  });

  it('keeps Datadog on its validated OAuth path rather than the bearer fallback', async () => {
    const entries = await loadCuratedCatalog();
    const datadog = entries.find((entry) => entry.name === 'com.datadoghq/mcp');

    expect(datadog).toMatchObject({
      remote_url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      auth_type: 'oauth',
    });
    expect(datadog?.credentials).toBeUndefined();
  });

  it('does not advertise OAuth endpoints that cannot reach a safely bound client-registration boundary', async () => {
    const entries = await loadCuratedCatalog();
    const unsupported = [
      'io.prisma/mcp',
      'com.mongodb/mcp',
      'com.box/mcp',
      'com.hubspot/mcp',
      'com.slack/mcp',
      'com.pagerduty/mcp',
      'com.kagi/mcp',
      'com.render/mcp',
      // Explicit 2026-09-01 exclusions: customer OAuth clients, tenant/admin
      // gates, callback allowlisting, preview constraints, or unusable live
      // metadata keep these off the one-click shelf.
      'com.google.gmail/mcp',
      'com.google.drive/mcp',
      'com.google.calendar/mcp',
      'com.google.chat/mcp',
      'com.google.docs/mcp',
      'com.google.sheets/mcp',
      'com.google.slides/mcp',
      'com.google.tasks/mcp',
      'com.microsoft.powerbi/mcp',
      'com.typeform/mcp',
      'com.contentful/mcp',
      'com.mongodb.atlas/mcp',
    ];

    expect(entries.filter((entry) => unsupported.includes(entry.name))).toEqual([]);
    expect(
      entries.find((entry) => entry.name === 'io.github.github/github-mcp-server')
    ).toMatchObject({
      auth_type: 'credentials',
      credentials: { scheme: 'bearer', oauth_challenge_compatible: true },
    });
  });

  it('carries no secret-shaped value anywhere in the file', async () => {
    const source = await fs.readFile(curatedCatalogPath(), 'utf-8');
    expect(source).not.toMatch(/client_secret|token_url|authorization_url|api[_-]?key/i);
  });
});

/**
 * Entries the marketplace could render but never install.
 *
 * Two shipped: metadata-only rows that drew a card, a category and a Connect
 * affordance where every route out was a refusal. Nothing objected — not the
 * schema, not the loader, not a test — which is why the rule is here rather
 * than left to a reviewer noticing.
 */
describe('parseCuratedCatalog — entries nothing could install', () => {
  const base = `
    category: dev-tools
    capabilities: [issues]
    benefit: Does a useful thing.
    starter_prompt: Try the useful thing.
    permission_disclosure: Reads your issues.`;

  it('refuses an entry naming no endpoint', () => {
    expect(() =>
      parseCuratedCatalog(`
entries:
  - name: com.example/mcp${base}
`)
    ).toThrow(CuratedCatalogError);
  });

  it('tells a curator which entry, what is wrong, and how to fix it', () => {
    // This message is the whole point: the next dozen entries are hand-written,
    // and a curator meets this before a user meets a dead card.
    let message = '';
    try {
      parseCuratedCatalog(`
entries:
  - name: com.example/mcp${base}
`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('com.example/mcp');
    expect(message).toMatch(/remote_url/);
    expect(message).toMatch(/or remove the entry/);
  });

  it('refuses a stdio entry, which connect refuses too', () => {
    expect(() =>
      parseCuratedCatalog(`
entries:
  - name: com.example/mcp${base}
    remote_url: https://mcp.example.com/mcp
    transport: stdio
`)
    ).toThrow(/stdio/);
  });

  it('fails the whole file, matching how every other invariant behaves', () => {
    // Not "skip the bad entry": a partially-served catalog is one a reviewer
    // cannot see the shape of, and the file is checked in, so failing it is
    // something CI catches before any user does.
    expect(() =>
      parseCuratedCatalog(`
entries:
  - name: com.good/mcp${base}
    remote_url: https://mcp.good.com/mcp
  - name: com.bad/mcp${base}
`)
    ).toThrow(CuratedCatalogError);
  });

  it('accepts an entry that names an endpoint and no transport', () => {
    // The default is remote; only `stdio` is the uninstallable one.
    const [entry] = parseCuratedCatalog(`
entries:
  - name: com.example/mcp${base}
    remote_url: https://mcp.example.com/mcp
`);
    expect(entry.has_remote).toBe(true);
  });
});

describe('the shipped catalog — everything on the shelf can be taken off it', () => {
  it('names an endpoint for every entry', async () => {
    const entries = await loadCuratedCatalog();
    expect(entries.filter((entry) => !entry.remote_url)).toEqual([]);
    expect(entries.every((entry) => entry.has_remote)).toBe(true);
  });

  it('declares no stdio entry', async () => {
    // Local servers are declined, not deferred: running a packaged server means
    // executing third-party code on the executor host, beside every session.
    const entries = await loadCuratedCatalog();
    expect(entries.filter((entry) => entry.transport === 'stdio')).toEqual([]);
  });
});
