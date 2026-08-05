import type { MCPCatalogEntry, MCPCatalogRegistryUpsert } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { MCPCatalogRepository } from '../db/repositories/mcp-catalog';
import { dbTest } from '../db/test-helpers';
import { runCatalogIngestion } from './ingestion';
import {
  MCPRegistryClient,
  normalizeRegistryServer,
  normalizeRegistryWithdrawal,
} from './registry-client';

/**
 * A pass-through, so these tests exercise the production signature without a
 * real scope.
 *
 * It proves nothing about scoping, and the type cannot: `WithCatalogRepository`
 * is `<T>(work) => Promise<T>`, which a caller satisfies just as well by
 * holding one scope open for the entire run. `runWithSystemDatabaseScope`
 * reuses an existing scope rather than opening a second transaction, so that
 * caller silently reinstates the run-long transaction this signature exists to
 * prevent. What actually enforces it is the worker calling
 * `runWithoutTenantDatabaseScope` before each unit; see
 * `mcp-catalog-ingestion.ts`.
 */
function withRepository(repository: MCPCatalogRepository) {
  return <T>(work: (repo: MCPCatalogRepository) => Promise<T>): Promise<T> => work(repository);
}

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

/** A registry envelope the registry has withdrawn. */
function withdrawnRecord(name: string, status: 'deleted' | 'deprecated') {
  return {
    ...registryRecord(name),
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status,
        updatedAt: '2026-06-01T00:00:00.000Z',
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
      const withdrawn: string[] = [];
      let skipped = 0;
      for (const record of page.records) {
        const normalized = normalizeRegistryServer(record);
        if (normalized) {
          entries.push(normalized);
          continue;
        }
        const retired = normalizeRegistryWithdrawal(record);
        if (retired) withdrawn.push(retired);
        else skipped += 1;
      }
      return { entries, withdrawn, skipped, nextCursor: page.nextCursor };
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

  it('drops a remote whose transport cannot be normalized', () => {
    const normalized = normalizeRegistryServer({
      server: {
        name: 'com.example/mcp',
        version: '1',
        remotes: [
          { type: 'websocket-experimental', url: 'https://weird.example.com/mcp' },
          { type: 'streamable-http', url: 'https://good.example.com/mcp' },
        ],
      },
      _meta: {},
    });

    // Keeping it would set `remote_url` and present the row as connectable over
    // a transport nothing can dial — and point the probe at it.
    expect(normalized?.remotes).toEqual([
      { type: 'streamable-http', url: 'https://good.example.com/mcp' },
    ]);
    expect(normalized?.remote_url).toBe('https://good.example.com/mcp');
    expect(normalized?.transport).toBe('streamable-http');
  });

  it('leaves a server with no usable remote unconnectable rather than guessing', () => {
    const normalized = normalizeRegistryServer({
      server: {
        name: 'com.example/mcp',
        version: '1',
        remotes: [{ type: 'carrier-pigeon', url: 'https://weird.example.com/mcp' }],
      },
      _meta: {},
    });

    expect(normalized?.remotes).toBeUndefined();
    expect(normalized?.remote_url).toBeUndefined();
    expect(normalized?.transport).toBeUndefined();
  });

  it('rejects a remote claiming stdio, which describes nothing dialable', () => {
    const normalized = normalizeRegistryServer({
      server: {
        name: 'com.example/mcp',
        version: '1',
        remotes: [{ type: 'stdio', url: 'https://weird.example.com/mcp' }],
      },
      _meta: {},
    });

    expect(normalized?.remote_url).toBeUndefined();
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

    const result = await runCatalogIngestion(withRepository(repository), {
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

    await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([{ records: page }]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });
    const second = await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([{ records: page }]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  dbTest('updates a server whose registry timestamp moved forward', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);

    await runCatalogIngestion(withRepository(repository), {
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

    const second = await runCatalogIngestion(withRepository(repository), {
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

    await runCatalogIngestion(withRepository(repository), {
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
    const second = await runCatalogIngestion(withRepository(repository), {
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
      capabilities: ['code-repos'],
      benefit: 'Curated benefit',
      starter_prompt: 'Curated prompt',
      permission_disclosure: 'Curated disclosure',
      title: 'Curated title',
      verified: true,
      popularity_rank: 1,
    });

    await runCatalogIngestion(withRepository(repository), {
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
    expect(entry?.capabilities).toEqual(['code-repos']);
  });

  dbTest('never nulls a curated connect surface the registry has no opinion on', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertCuration({
      name: 'io.sentry/mcp',
      category: 'dev-tools',
      capabilities: ['logs'],
      benefit: 'Reads errors',
      starter_prompt: 'Find the loudest error',
      permission_disclosure: 'Reads issues',
      website_url: 'https://sentry.io',
      verified: true,
      remote_url: 'https://mcp.sentry.dev/mcp',
      transport: 'streamable-http',
    });

    // The vendor publishes a package-only release under the curated name. The
    // registry has no remote to offer, which must not remove the one curation
    // supplied — that is the entry's only connect surface.
    await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([
        {
          records: [
            registryRecord('io.sentry/mcp', {
              remoteUrl: '',
              packages: [
                { registryType: 'npm', identifier: 'sentry-mcp', transport: { type: 'stdio' } },
              ],
            }),
          ],
        },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(await repository.findByName('io.sentry/mcp')).toMatchObject({
      remote_url: 'https://mcp.sentry.dev/mcp',
      // `transport` follows the remote that won, so the row stays coherent.
      transport: 'streamable-http',
      has_remote: true,
      // Editorial copy the overlay supplied stays the overlay's. A curator who
      // writes `website_url` into the file means it; letting the registry win
      // there would make the field unusable for any server the registry also
      // publishes, which is every server worth curating.
      website_url: 'https://sentry.io',
      has_package: true,
    });
  });

  dbTest('still lets the registry update the connect surface it does publish', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertCuration({
      name: 'com.example/mcp',
      category: 'dev-tools',
      capabilities: ['logs'],
      benefit: 'b',
      starter_prompt: 'p',
      permission_disclosure: 'd',
      verified: true,
      remote_url: 'https://guessed.example.com/mcp',
      transport: 'streamable-http',
    });

    await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([
        {
          records: [
            registryRecord('com.example/mcp', { remoteUrl: 'https://real.example.com/mcp' }),
          ],
        },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    // The registry is authoritative wherever it has an opinion.
    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      remote_url: 'https://real.example.com/mcp',
    });
  });

  dbTest(
    'drops a server the registry has withdrawn instead of leaving it connectable',
    async ({ db }) => {
      const repository = new MCPCatalogRepository(db);

      const result = await runCatalogIngestion(withRepository(repository), {
        registry: stubRegistry([
          {
            records: [
              {
                ...registryRecord('a.example/gone'),
                _meta: {
                  'io.modelcontextprotocol.registry/official': {
                    status: 'deleted',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  },
                },
              },
              {
                ...registryRecord('b.example/deprecated'),
                _meta: {
                  'io.modelcontextprotocol.registry/official': {
                    status: 'deprecated',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  },
                },
              },
              registryRecord('c.example/active'),
            ],
          },
        ]),
        probeBudget: 0,
        sleep: noSleep,
        log: silent,
      });

      expect(result).toMatchObject({ created: 1, withdrawn: 0 });
      expect(await repository.findByName('a.example/gone')).toBeNull();
      expect(await repository.findByName('c.example/active')).not.toBeNull();
    }
  );

  dbTest('removes an already-mirrored row once the registry withdraws it', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const opts = { probeBudget: 0, sleep: noSleep, log: silent };

    // Mirrored while active...
    await runCatalogIngestion(withRepository(repository), {
      ...opts,
      registry: stubRegistry([{ records: [registryRecord('a.example/one')] }]),
    });
    expect(await repository.findByName('a.example/one')).not.toBeNull();

    // ...then withdrawn. Declining it at parse alone would leave the row.
    const second = await runCatalogIngestion(withRepository(repository), {
      ...opts,
      registry: stubRegistry([{ records: [withdrawnRecord('a.example/one', 'deleted')] }]),
    });

    expect(second.withdrawn).toBe(1);
    expect(await repository.findByName('a.example/one')).toBeNull();
  });

  dbTest('retires a withdrawn curated entry without destroying its curation', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertCuration({
      name: 'io.sentry/mcp',
      category: 'dev-tools',
      capabilities: ['logs'],
      benefit: 'Hand-written benefit',
      starter_prompt: 'Prompt',
      permission_disclosure: 'Disclosure',
      verified: true,
      remote_url: 'https://mcp.sentry.dev/mcp',
      transport: 'streamable-http',
    });

    const result = await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([{ records: [withdrawnRecord('io.sentry/mcp', 'deprecated')] }]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result.withdrawn).toBe(1);
    // The card survives with its curation; only the connect surface is gone.
    expect(await repository.findByName('io.sentry/mcp')).toMatchObject({
      benefit: 'Hand-written benefit',
      curated: true,
      has_remote: false,
      remote_url: undefined,
      transport: undefined,
    });
  });

  dbTest('stops when the registry hands back a cursor it already gave out', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    let calls = 0;
    const registry = {
      fetchPage: vi.fn(async () => {
        calls += 1;
        return {
          entries: [normalizeRegistryServer(registryRecord(`a.example/${calls}`))].filter(
            (entry): entry is MCPCatalogRegistryUpsert => Boolean(entry)
          ),
          withdrawn: [],
          skipped: 0,
          // Always the same cursor: a naive loop would burn the whole page cap.
          nextCursor: 'stuck-cursor',
        };
      }),
    } as unknown as MCPRegistryClient;

    const result = await runCatalogIngestion(withRepository(repository), {
      registry,
      maxPages: 50,
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  dbTest('counts an unnormalizable record as skipped without losing the page', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);

    const result = await runCatalogIngestion(withRepository(repository), {
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
            withdrawn: [],
            skipped: 0,
            nextCursor: 'c1',
          };
        }
        throw new Error('registry 503');
      }),
    } as unknown as MCPRegistryClient;

    const result = await runCatalogIngestion(withRepository(repository), {
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

    const result = await runCatalogIngestion(withRepository(repository), {
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

    const result = await runCatalogIngestion(withRepository(repository), {
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

    // `skipped` counts parse misses and moves during healthy runs, so a rejected
    // write reported there would be invisible.
    expect(result).toMatchObject({ created: 2, entryFailures: 1, skipped: 0 });
  });

  dbTest('counts a failed retirement instead of reporting a clean run', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'a.example/one',
      remote_url: 'https://a.example.com/mcp',
    });
    vi.spyOn(repository, 'retireWithdrawnEntry').mockRejectedValue(new Error('write rejected'));

    const result = await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([{ records: [withdrawnRecord('a.example/one', 'deleted')] }]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    // Without the counter this run is indistinguishable from one where nothing
    // was withdrawn — while the row stays connectable.
    expect(result).toMatchObject({ withdrawn: 0, retirementFailures: 1 });
    expect(await repository.findByName('a.example/one')).not.toBeNull();
  });

  dbTest('keeps parse skips and write failures in separate counters', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const original = repository.upsertRegistryEntry.bind(repository);
    vi.spyOn(repository, 'upsertRegistryEntry').mockImplementation(async (entry) => {
      if (entry.name === 'poison.example/one') throw new Error('constraint violation');
      return original(entry);
    });

    const result = await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([
        {
          records: [
            { server: { description: 'no name' } },
            registryRecord('poison.example/one'),
            registryRecord('good.example/two'),
          ],
        },
      ]),
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result).toMatchObject({ created: 1, skipped: 1, entryFailures: 1 });
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
          withdrawn: [],
          skipped: 0,
          nextCursor: `cursor-${call}`,
        };
      }),
    } as unknown as MCPCatalogRepository & MCPRegistryClient;

    const result = await runCatalogIngestion(withRepository(repository), {
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
          withdrawn: [],
          skipped: 0,
          nextCursor: `cursor-${clock}`,
        };
      }),
    } as unknown as MCPRegistryClient;

    const result = await runCatalogIngestion(withRepository(repository), {
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
      probed_url: remoteUrl,
      ...(remoteUrl.includes('one') ? { auth_server_origin: 'https://auth.example.com' } : {}),
    }));

    const result = await runCatalogIngestion(withRepository(repository), {
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
    const probe = vi.fn(async (remoteUrl: string) => ({
      probed_auth_type: 'none' as const,
      probed_at: new Date('2026-07-28T00:00:00.000Z'),
      probed_url: remoteUrl,
    }));

    const result = await runCatalogIngestion(withRepository(repository), {
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
      return { probed_auth_type: 'none' as const, probed_at: new Date(), probed_url: remoteUrl };
    });

    const result = await runCatalogIngestion(withRepository(repository), {
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
    const probe = vi.fn(async (remoteUrl: string) => ({
      probed_auth_type: 'none' as const,
      probed_at: new Date('2026-07-28T00:00:00.000Z'),
      probed_url: remoteUrl,
    }));
    const opts = {
      registry: stubRegistry([{ records: [registryRecord('a.example/one')] }]),
      probe,
      probeBudget: 10,
      sleep: noSleep,
      log: silent,
    };

    await runCatalogIngestion(withRepository(repository), opts);
    const second = await runCatalogIngestion(withRepository(repository), {
      ...opts,
      registry: stubRegistry([{ records: [registryRecord('a.example/one')] }]),
      now: () => new Date('2026-07-28T01:00:00.000Z').getTime(),
    });

    expect(second.probed).toBe(0);
  });

  dbTest('never probes an entry the registry published without a remote', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const probe = vi.fn(async (remoteUrl: string) => ({
      probed_auth_type: 'none' as const,
      probed_at: new Date(),
      probed_url: remoteUrl,
    }));

    await runCatalogIngestion(withRepository(repository), {
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

describe('resuming a walk the deadline cut short', () => {
  dbTest('reports where to resume when the pagination budget runs out', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    let clock = 0;
    const result = await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([
        { records: [registryRecord('a.example/one')], nextCursor: 'cursor-2' },
        { records: [registryRecord('b.example/two')], nextCursor: 'cursor-3' },
      ]),
      // Enough for one page, not two.
      paginationDeadlineMs: 100,
      now: () => {
        clock += 60;
        return clock;
      },
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(1);
    expect(result.nextCursor).toBe('cursor-2');
  });

  dbTest('continues from the cursor instead of re-reading the head', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const registry = stubRegistry([{ records: [registryRecord('b.example/two')] }]) as unknown as {
      fetchPage: (cursor?: string) => Promise<unknown>;
    };
    const seen: (string | undefined)[] = [];
    const original = registry.fetchPage.bind(registry);
    registry.fetchPage = (cursor?: string) => {
      seen.push(cursor);
      return original(cursor);
    };

    await runCatalogIngestion(withRepository(repository), {
      registry: registry as never,
      startCursor: 'cursor-2',
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    // Without this the same first pages are re-read every run and the tail of
    // the registry is never reached at all.
    expect(seen[0]).toBe('cursor-2');
  });

  dbTest('clears the cursor once the walk reaches the end', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const result = await runCatalogIngestion(withRepository(repository), {
      registry: stubRegistry([{ records: [registryRecord('a.example/one')] }]),
      startCursor: 'cursor-2',
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    // The next run starts over, which is how republished entries are noticed.
    expect(result.nextCursor).toBeUndefined();
  });

  dbTest('restarts from the beginning when the registry rejects the cursor', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const seen: (string | undefined)[] = [];
    const registry = {
      fetchPage: async (cursor?: string) => {
        seen.push(cursor);
        if (cursor === 'stale-cursor') throw new Error('unknown cursor');
        return {
          entries: [registryRecord('a.example/one')].map(
            (record) => normalizeRegistryServer(record) as never
          ),
          withdrawn: [],
          skipped: 0,
        };
      },
    };

    const result = await runCatalogIngestion(withRepository(repository), {
      registry: registry as never,
      startCursor: 'stale-cursor',
      probeBudget: 0,
      sleep: noSleep,
      log: silent,
    });

    // A cursor the registry has forgotten must not cost the whole run.
    expect(seen).toEqual(['stale-cursor', undefined]);
    expect(result.created).toBe(1);
    expect(result.pageFailures).toBe(1);
  });

  dbTest('leaves the probe sweep time even when pagination fills its budget', async ({ db }) => {
    // A registry with more pages than any deadline can walk, which is what the
    // live one is: a page takes seconds and there are hundreds of them.
    const endlessPages = Array.from({ length: 200 }, (_, index) => ({
      records: [registryRecord(`e${index}.example/mcp`)],
      nextCursor: `cursor-${index + 1}`,
    }));
    const probedWith = async (paginationDeadlineMs: number) => {
      const repository = new MCPCatalogRepository(db);
      let clock = 0;
      return runCatalogIngestion(withRepository(repository), {
        registry: stubRegistry(endlessPages),
        deadlineMs: 1_000,
        paginationDeadlineMs,
        now: () => {
          clock += 10;
          return clock;
        },
        probe: async (remoteUrl: string) => ({
          probed_auth_type: 'none' as const,
          probed_at: new Date('2026-07-28T00:00:00.000Z'),
          probed_url: remoteUrl,
        }),
        probeBudget: 5,
        sleep: noSleep,
        log: silent,
      });
    };

    // The counterfactual: one shared deadline lets pagination — which can never
    // finish — spend all of it, and the probe sweep, gated on time remaining,
    // does not run at all.
    expect((await probedWith(1_000)).probed).toBe(0);
    expect((await probedWith(400)).probed).toBeGreaterThan(0);
  });
});
