import type { MCPCatalogEntry, MCPCatalogRegistryUpsert } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { MCPCatalogRepository } from '../db/repositories/mcp-catalog';
import { dbTest } from '../db/test-helpers';
import { runCatalogIngestion } from './ingestion';
import { MCPRegistryClient, normalizeRegistryServer } from './registry-client';

/** Build a registry envelope in the shape the live API returns. */
function registryRecord(
  name: string,
  overrides: {
    updatedAt?: string;
    version?: string;
    remoteUrl?: string;
    description?: string;
    packages?: unknown[];
  } = {}
) {
  return {
    server: {
      name,
      description: overrides.description ?? `Description for ${name}`,
      title: `Title for ${name}`,
      version: overrides.version ?? '1.0.0',
      websiteUrl: 'https://example.com',
      repository: { url: 'https://github.com/example/repo', source: 'github' },
      ...(overrides.remoteUrl === undefined
        ? { remotes: [{ type: 'streamable-http', url: `https://${name}.example.com/mcp` }] }
        : overrides.remoteUrl
          ? { remotes: [{ type: 'streamable-http', url: overrides.remoteUrl }] }
          : {}),
      ...(overrides.packages ? { packages: overrides.packages } : {}),
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
        isLatest: true,
      },
    },
  };
}

/** A registry client backed by fixed pages rather than the network. */
function stubRegistry(pages: Array<{ records: unknown[]; nextCursor?: string }>) {
  let call = 0;
  return {
    fetchPage: vi.fn(async () => {
      const page = pages[call] ?? { records: [], nextCursor: undefined };
      call += 1;
      const entries: MCPCatalogRegistryUpsert[] = [];
      let skipped = 0;
      for (const record of page.records) {
        const normalized = normalizeRegistryServer(record);
        if (normalized) entries.push(normalized);
        else skipped += 1;
      }
      return { entries, skipped, nextCursor: page.nextCursor };
    }),
  } as unknown as MCPRegistryClient;
}

const noSleep = async () => {};
const silent = () => {};

describe('normalizeRegistryServer', () => {
  it('maps the registry envelope onto catalog columns', () => {
    const normalized = normalizeRegistryServer(registryRecord('com.example/mcp'));

    expect(normalized).toMatchObject({
      name: 'com.example/mcp',
      version: '1.0.0',
      title: 'Title for com.example/mcp',
      website_url: 'https://example.com',
      repository_url: 'https://github.com/example/repo',
      repository_source: 'github',
      transport: 'streamable-http',
      remote_url: 'https://com.example/mcp.example.com/mcp',
      registry_status: 'active',
    });
    expect(normalized?.registry_updated_at?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects a record with no name, which the catalog could not key', () => {
    expect(normalizeRegistryServer({ server: { description: 'anonymous' }, _meta: {} })).toBeNull();
    expect(normalizeRegistryServer({})).toBeNull();
    expect(normalizeRegistryServer(null)).toBeNull();
  });

  it('drops remotes whose scheme the probe must never fetch', () => {
    const normalized = normalizeRegistryServer({
      server: {
        name: 'com.example/mcp',
        version: '1',
        remotes: [
          { type: 'streamable-http', url: 'file:///etc/passwd' },
          { type: 'streamable-http', url: 'https://good.example.com/mcp' },
        ],
      },
      _meta: {},
    });

    expect(normalized?.remotes).toEqual([
      { type: 'streamable-http', url: 'https://good.example.com/mcp' },
    ]);
    expect(normalized?.remote_url).toBe('https://good.example.com/mcp');
  });

  it('derives transport from the first package when there is no remote', () => {
    const normalized = normalizeRegistryServer(
      registryRecord('com.example/pkg', {
        remoteUrl: '',
        packages: [
          { registryType: 'npm', identifier: 'example-mcp', transport: { type: 'stdio' } },
        ],
      })
    );

    expect(normalized?.transport).toBe('stdio');
    expect(normalized?.remote_url).toBeUndefined();
    expect(normalized?.packages).toEqual([
      { registry_type: 'npm', identifier: 'example-mcp', transport_type: 'stdio' },
    ]);
  });
});

describe('runCatalogIngestion', () => {
  dbTest('walks every page and creates a row per server', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const registry = stubRegistry([
      {
        records: [registryRecord('a.example/one'), registryRecord('b.example/two')],
        nextCursor: 'c1',
      },
      { records: [registryRecord('c.example/three')] },
    ]);

    const result = await runCatalogIngestion(repository, {
      registry,
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ created: 3, updated: 0, unchanged: 0, pagesFetched: 2 });
    expect(await repository.count()).toBe(3);
  });

  dbTest('skips a re-ingested server whose registry timestamp has not moved', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const page = [registryRecord('a.example/one', { updatedAt: '2026-01-01T00:00:00.000Z' })];

    await runCatalogIngestion(repository, {
      registry: stubRegistry([{ records: page }]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });
    const second = await runCatalogIngestion(repository, {
      registry: stubRegistry([{ records: page }]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  dbTest('updates a server whose registry timestamp moved forward', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);

    await runCatalogIngestion(repository, {
      registry: stubRegistry([
        {
          records: [
            registryRecord('a.example/one', {
              updatedAt: '2026-01-01T00:00:00.000Z',
              version: '1.0.0',
              description: 'Old description',
            }),
          ],
        },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    const second = await runCatalogIngestion(repository, {
      registry: stubRegistry([
        {
          records: [
            registryRecord('a.example/one', {
              updatedAt: '2026-06-01T00:00:00.000Z',
              version: '2.0.0',
              description: 'New description',
            }),
          ],
        },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(second).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    const entry = await repository.findByName('a.example/one');
    expect(entry?.version).toBe('2.0.0');
    expect(entry?.description).toBe('New description');
    expect(entry?.registry_updated_at?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  dbTest('ignores a republication that moves the timestamp backwards', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const opts = { probeBudget: 0, sleep: noSleep, log: silent };

    await runCatalogIngestion(repository, {
      ...opts,
      registry: stubRegistry([
        {
          records: [
            registryRecord('a.example/one', {
              updatedAt: '2026-06-01T00:00:00.000Z',
              version: '2.0.0',
            }),
          ],
        },
      ]),
    });
    const second = await runCatalogIngestion(repository, {
      ...opts,
      registry: stubRegistry([
        {
          records: [
            registryRecord('a.example/one', {
              updatedAt: '2026-01-01T00:00:00.000Z',
              version: '1.0.0',
            }),
          ],
        },
      ]),
    });

    expect(second).toMatchObject({ unchanged: 1, updated: 0 });
    expect((await repository.findByName('a.example/one'))?.version).toBe('2.0.0');
  });

  dbTest('preserves the curation overlay across a registry update', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertCuration({
      name: 'a.example/one',
      category: 'dev-tools',
      capabilities: ['repos'],
      benefit: 'Curated benefit',
      starter_prompt: 'Curated prompt',
      permission_disclosure: 'Curated disclosure',
      title: 'Curated title',
      verified: true,
      popularity_rank: 1,
    });

    await runCatalogIngestion(repository, {
      registry: stubRegistry([
        { records: [registryRecord('a.example/one', { updatedAt: '2026-06-01T00:00:00.000Z' })] },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    const entry = await repository.findByName('a.example/one');
    expect(entry).toMatchObject({
      curated: true,
      category: 'dev-tools',
      benefit: 'Curated benefit',
      verified: true,
      popularity_rank: 1,
      // Curation keeps the title it supplied; the registry fills what it left.
      title: 'Curated title',
      version: '1.0.0',
    });
    expect(entry?.capabilities).toEqual(['repos']);
  });

  dbTest('counts an unnormalizable record as skipped without losing the page', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);

    const result = await runCatalogIngestion(repository, {
      registry: stubRegistry([
        { records: [{ server: { description: 'no name' } }, registryRecord('a.example/one')] },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ created: 1, skipped: 1 });
  });

  dbTest('keeps earlier pages when a later page fails repeatedly', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    let call = 0;
    const registry = {
      fetchPage: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            entries: [normalizeRegistryServer(registryRecord('a.example/one'))].filter(
              (entry): entry is MCPCatalogRegistryUpsert => Boolean(entry)
            ),
            skipped: 0,
            nextCursor: 'c1',
          };
        }
        throw new Error('registry 503');
      }),
    } as unknown as MCPRegistryClient;

    const result = await runCatalogIngestion(repository, {
      registry,
      probeBudget: 0,
      maxConsecutivePageFailures: 2,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ created: 1, pageFailures: 2, truncated: true });
    expect(await repository.count()).toBe(1);
  });

  dbTest('reports zero work and touches nothing when the registry is down', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'existing.example/one', version: '1.0.0' });

    const registry = {
      fetchPage: vi.fn(async () => {
        throw new Error('ENOTFOUND registry.modelcontextprotocol.io');
      }),
    } as unknown as MCPRegistryClient;

    const result = await runCatalogIngestion(repository, {
      registry,
      probeBudget: 0,
      maxConsecutivePageFailures: 1,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ created: 0, pagesFetched: 0, truncated: true });
    expect((await repository.findByName('existing.example/one'))?.version).toBe('1.0.0');
  });

  dbTest('keeps the rest of the page when one row write throws', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const original = repository.upsertRegistryEntry.bind(repository);
    vi.spyOn(repository, 'upsertRegistryEntry').mockImplementation(async (entry) => {
      if (entry.name === 'poison.example/one') throw new Error('value too long for column');
      return original(entry);
    });

    const result = await runCatalogIngestion(repository, {
      registry: stubRegistry([
        {
          records: [
            registryRecord('poison.example/one'),
            registryRecord('good.example/two'),
            registryRecord('good.example/three'),
          ],
        },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ created: 2, skipped: 1 });
  });

  dbTest('stops paginating at the page cap and reports truncation', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    let call = 0;
    const registry = {
      fetchPage: vi.fn(async () => {
        call += 1;
        return {
          entries: [normalizeRegistryServer(registryRecord(`a.example/${call}`))].filter(
            (entry): entry is MCPCatalogRegistryUpsert => Boolean(entry)
          ),
          skipped: 0,
          nextCursor: `cursor-${call}`,
        };
      }),
    } as unknown as MCPCatalogRepository & MCPRegistryClient;

    const result = await runCatalogIngestion(repository, {
      registry: registry as unknown as MCPRegistryClient,
      maxPages: 3,
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ pagesFetched: 3, created: 3, truncated: true });
  });

  dbTest('abandons the run once the wall-clock deadline passes', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    let clock = 0;
    const registry = {
      fetchPage: vi.fn(async () => {
        clock += 5_000;
        return {
          entries: [normalizeRegistryServer(registryRecord(`a.example/${clock}`))].filter(
            (entry): entry is MCPCatalogRegistryUpsert => Boolean(entry)
          ),
          skipped: 0,
          nextCursor: `cursor-${clock}`,
        };
      }),
    } as unknown as MCPRegistryClient;

    const result = await runCatalogIngestion(repository, {
      registry,
      deadlineMs: 12_000,
      probeBudget: 0,
      sleep: noSleep,
      now: () => clock,
      log: silent,
    });

    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBeLessThanOrEqual(3);
  });

  dbTest('probes entries with a remote and caches the verdict on the row', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const probedAt = new Date('2026-07-28T00:00:00.000Z');
    const probe = vi.fn(async (remoteUrl: string) => ({
      probed_auth_type: remoteUrl.includes('one') ? ('oauth' as const) : ('none' as const),
      probed_at: probedAt,
      ...(remoteUrl.includes('one') ? { auth_server_origin: 'https://auth.example.com' } : {}),
    }));

    const result = await runCatalogIngestion(repository, {
      registry: stubRegistry([
        { records: [registryRecord('a.example/one'), registryRecord('b.example/two')] },
      ]),
      probe,
      probeBudget: 10,
      sleep: noSleep,
      log: silent,
    });

    expect(result.probed).toBe(2);
    const one = (await repository.findByName('a.example/one')) as MCPCatalogEntry;
    expect(one.probed_auth_type).toBe('oauth');
    expect(one.auth_server_origin).toBe('https://auth.example.com');
    expect(one.probed_at).toEqual(probedAt);
  });

  dbTest('respects the probe budget instead of probing the whole catalog', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const probe = vi.fn(async () => ({
      probed_auth_type: 'none' as const,
      probed_at: new Date('2026-07-28T00:00:00.000Z'),
    }));

    const result = await runCatalogIngestion(repository, {
      registry: stubRegistry([
        {
          records: [
            registryRecord('a.example/one'),
            registryRecord('b.example/two'),
            registryRecord('c.example/three'),
          ],
        },
      ]),
      probe,
      probeBudget: 2,
      sleep: noSleep,
      log: silent,
    });

    expect(result.probed).toBe(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  dbTest('records a probe failure without aborting the sweep', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const probe = vi.fn(async (remoteUrl: string) => {
      if (remoteUrl.includes('one')) throw new Error('probe exploded');
      return { probed_auth_type: 'none' as const, probed_at: new Date() };
    });

    const result = await runCatalogIngestion(repository, {
      registry: stubRegistry([
        { records: [registryRecord('a.example/one'), registryRecord('b.example/two')] },
      ]),
      probe,
      probeBudget: 10,
      sleep: noSleep,
      log: silent,
    });

    expect(result.probeFailures).toBe(1);
    expect(result.probed).toBe(1);
  });

  dbTest('does not re-probe an entry whose cached verdict is still fresh', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const probe = vi.fn(async () => ({
      probed_auth_type: 'none' as const,
      probed_at: new Date('2026-07-28T00:00:00.000Z'),
    }));
    const opts = {
      registry: stubRegistry([{ records: [registryRecord('a.example/one')] }]),
      probe,
      probeBudget: 10,
      sleep: noSleep,
      log: silent,
    };

    await runCatalogIngestion(repository, opts);
    const second = await runCatalogIngestion(repository, {
      ...opts,
      registry: stubRegistry([{ records: [registryRecord('a.example/one')] }]),
      now: () => new Date('2026-07-28T01:00:00.000Z').getTime(),
    });

    expect(second.probed).toBe(0);
  });

  dbTest('never probes an entry the registry published without a remote', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const probe = vi.fn(async () => ({
      probed_auth_type: 'none' as const,
      probed_at: new Date(),
    }));

    await runCatalogIngestion(repository, {
      registry: stubRegistry([
        {
          records: [
            registryRecord('a.example/pkg', {
              remoteUrl: '',
              packages: [{ registryType: 'npm', identifier: 'x', transport: { type: 'stdio' } }],
            }),
          ],
        },
      ]),
      probe,
      probeBudget: 10,
      sleep: noSleep,
      log: silent,
    });

    expect(probe).not.toHaveBeenCalled();
  });
});

describe('MCPRegistryClient', () => {
  it('requests latest versions and threads the cursor through', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            servers: [registryRecord('a.example/one')],
            metadata: { nextCursor: 'next-cursor' },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const client = new MCPRegistryClient({ baseUrl: 'https://registry.test', fetchImpl });
    const page = await client.fetchPage('prev-cursor');

    const requested = new URL(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
    );
    expect(requested.pathname).toBe('/v0/servers');
    expect(requested.searchParams.get('version')).toBe('latest');
    expect(requested.searchParams.get('cursor')).toBe('prev-cursor');
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBe('next-cursor');
  });

  it('throws on a non-2xx response so the run can count the page as failed', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 })
    ) as unknown as typeof fetch;
    const client = new MCPRegistryClient({ baseUrl: 'https://registry.test', fetchImpl });

    await expect(client.fetchPage()).rejects.toThrow(/429/);
  });
});
