/**
 * The point of these tests is not that the filters return the right rows — a
 * JS-filtered implementation returns identical rows while reading the whole
 * table. What is asserted here is the SQL the database actually executed and
 * the number of rows it actually emitted.
 */

import type { Database } from '@agor/core/db';
import type { MCPCatalogCurationUpsert } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { MCPCatalogRepository, serializeCapabilityTags } from './mcp-catalog';

interface ExecutedStatement {
  sql: string;
  rows: number;
}

/**
 * Wrap the libsql client so every statement Drizzle issues is recorded along
 * with the row count the database returned for it.
 */
function recordStatements(db: Database): {
  statements: ExecutedStatement[];
  reset: () => void;
} {
  const client = (
    db as unknown as { $client: { execute: (...args: unknown[]) => Promise<unknown> } }
  ).$client;
  const statements: ExecutedStatement[] = [];
  const original = client.execute.bind(client);

  client.execute = async (...args: unknown[]) => {
    const result = (await original(...args)) as { rows?: unknown[] };
    const first = args[0] as { sql?: string } | string;
    statements.push({
      sql: typeof first === 'string' ? first : (first?.sql ?? ''),
      rows: Array.isArray(result?.rows) ? result.rows.length : 0,
    });
    return result as never;
  };

  return {
    statements,
    reset: () => {
      statements.length = 0;
    },
  };
}

function curation(
  name: string,
  overrides: Partial<MCPCatalogCurationUpsert> = {}
): MCPCatalogCurationUpsert {
  return {
    name,
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: `Benefit for ${name}`,
    starter_prompt: `Prompt for ${name}`,
    permission_disclosure: `Discloses things for ${name}`,
    verified: false,
    ...overrides,
  };
}

/** Seed a catalog large enough that a full-table scan is unmistakable. */
async function seedCatalog(repository: MCPCatalogRepository, count = 200): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await repository.upsertRegistryEntry({
      name: `io.filler${String(index).padStart(3, '0')}/server`,
      version: '1.0.0',
      title: `Filler server ${index}`,
      description: 'A generic registry entry with nothing distinctive about it',
      transport: 'streamable-http',
      remote_url: `https://filler${index}.example.com/mcp`,
      registry_updated_at: new Date(2026, 0, 1 + (index % 28)),
    });
  }
}

describe('MCPCatalogRepository SQL pushdown', () => {
  dbTest('resolves a search to one row read, not a full-table scan', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);
    await repository.upsertRegistryEntry({
      name: 'com.needle/mcp',
      title: 'Needle',
      description: 'The only entry mentioning haystackneedle',
    });

    const recorder = recordStatements(db);
    const results = await repository.findAll({ search: 'haystackneedle' });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('com.needle/mcp');
    // One SELECT, and it emitted exactly the matching row. A JS-filtered
    // implementation would have emitted 201.
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0].rows).toBe(1);
    expect(recorder.statements[0].sql.toLowerCase()).toContain('like');
    expect(recorder.statements[0].sql.toLowerCase()).toContain('lower(');
  });

  dbTest('resolves a category filter in SQL', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);
    await repository.upsertCuration(curation('com.search/mcp', { category: 'search' }));
    await repository.upsertCuration(curation('com.dev/mcp', { category: 'dev-tools' }));

    const recorder = recordStatements(db);
    const results = await repository.findAll({ category: 'search' });

    expect(results.map((entry) => entry.name)).toEqual(['com.search/mcp']);
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0].rows).toBe(1);
    expect(recorder.statements[0].sql).toContain('"category"');
  });

  dbTest('resolves a capability filter in SQL', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);
    await repository.upsertCuration(
      curation('com.traces/mcp', { capabilities: ['traces', 'metrics'] })
    );
    await repository.upsertCuration(curation('com.repos/mcp', { capabilities: ['code-repos'] }));

    const recorder = recordStatements(db);
    const results = await repository.findAll({ capability: 'traces' });

    expect(results.map((entry) => entry.name)).toEqual(['com.traces/mcp']);
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0].rows).toBe(1);
    expect(recorder.statements[0].sql).toContain('"capability_tags"');
  });

  dbTest('resolves a verified filter in SQL', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);
    await repository.upsertCuration(curation('com.trusted/mcp', { verified: true }));

    const recorder = recordStatements(db);
    const results = await repository.findAll({ verified: true });

    expect(results.map((entry) => entry.name)).toEqual(['com.trusted/mcp']);
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0].rows).toBe(1);
    expect(recorder.statements[0].sql).toContain('"verified"');
  });

  dbTest('bounds an unfiltered browse page in SQL rather than slicing in JS', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);

    const recorder = recordStatements(db);
    const results = await repository.findAll({ limit: 24, offset: 48 });

    expect(results).toHaveLength(24);
    // 200 rows exist; the database emitted 24.
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0].rows).toBe(24);
    expect(recorder.statements[0].sql.toLowerCase()).toContain('limit');
    expect(recorder.statements[0].sql.toLowerCase()).toContain('offset');
  });

  dbTest('counts without reading the rows it counts', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);

    const recorder = recordStatements(db);
    const total = await repository.count();

    expect(total).toBe(200);
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0].rows).toBe(1);
    expect(recorder.statements[0].sql.toLowerCase()).toContain('count(*)');
  });

  dbTest('applies the count query the same filters as the list query', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository);
    await repository.upsertCuration(curation('com.search-a/mcp', { category: 'search' }));
    await repository.upsertCuration(curation('com.search-b/mcp', { category: 'search' }));

    expect(await repository.count({ category: 'search' })).toBe(2);
    expect(await repository.count({ search: 'nothing matches this' })).toBe(0);
  });

  dbTest('orders curated entries before uncurated ones inside SQL', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCatalog(repository, 5);
    await repository.upsertCuration(curation('com.second/mcp', { popularity_rank: 2 }));
    await repository.upsertCuration(curation('com.first/mcp', { popularity_rank: 1 }));

    const recorder = recordStatements(db);
    const results = await repository.findAll({ sort: 'popularity', limit: 3 });

    expect(results.map((entry) => entry.name).slice(0, 2)).toEqual([
      'com.first/mcp',
      'com.second/mcp',
    ]);
    expect(recorder.statements[0].sql.toLowerCase()).toContain('order by');
    expect(recorder.statements[0].rows).toBe(3);
  });

  dbTest('sorts by registry recency with unpublished entries last', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'a.example/old',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertRegistryEntry({
      name: 'b.example/new',
      registry_updated_at: new Date('2026-06-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(curation('c.example/undated'));

    const results = await repository.findAll({ sort: 'recently_updated' });

    expect(results.map((entry) => entry.name)).toEqual([
      'b.example/new',
      'a.example/old',
      'c.example/undated',
    ]);
  });
});

describe('MCPCatalogRepository filter semantics', () => {
  dbTest('treats a LIKE wildcard in the search term literally', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'a.example/one', description: 'plain text' });
    await repository.upsertRegistryEntry({
      name: 'b.example/two',
      description: 'literally 100% sure',
    });

    // '%' must match a literal percent sign, not act as a wildcard — as a
    // wildcard it would match both rows.
    expect((await repository.findAll({ search: '%' })).map((entry) => entry.name)).toEqual([
      'b.example/two',
    ]);
    expect((await repository.findAll({ search: '100%' })).map((entry) => entry.name)).toEqual([
      'b.example/two',
    ]);
    // '_' would match any single character as a wildcard; nothing here has one.
    expect((await repository.findAll({ search: '_' })).map((entry) => entry.name)).toEqual([]);
  });

  dbTest(
    'matches search case-insensitively across name, title, and description',
    async ({ db }) => {
      const repository = new MCPCatalogRepository(db);
      await repository.upsertRegistryEntry({ name: 'com.Zebra/mcp', title: 'Something Else' });
      await repository.upsertRegistryEntry({ name: 'a.example/one', title: 'ZEBRA in the title' });
      await repository.upsertRegistryEntry({
        name: 'b.example/two',
        description: 'a zebra in the description',
      });
      await repository.upsertRegistryEntry({ name: 'c.example/three', title: 'unrelated' });

      const results = await repository.findAll({ search: 'zebra' });

      expect(results.map((entry) => entry.name).sort()).toEqual([
        'a.example/one',
        'b.example/two',
        'com.Zebra/mcp',
      ]);
    }
  );

  dbTest('does not match a capability tag that is a prefix of another', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    // The curated vocabulary has no prefix pair today, but `capability_tags` is
    // a delimited string and the guard against `|ci|` matching `cicd` has to
    // hold for whatever the vocabulary grows into. Cast past the enum to state
    // that invariant directly.
    const rawTags = (tags: string[]) => tags as never as MCPCatalogCurationUpsert['capabilities'];
    await repository.upsertCuration(curation('a.example/one', { capabilities: rawTags(['cicd']) }));
    await repository.upsertCuration(curation('b.example/two', { capabilities: rawTags(['ci']) }));

    expect((await repository.findAll({ capability: 'ci' })).map((entry) => entry.name)).toEqual([
      'b.example/two',
    ]);
  });

  dbTest('returns nothing for an empty name allowlist', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'a.example/one' });

    expect(await repository.findAll({ names: [] })).toEqual([]);
    expect(await repository.count({ names: [] })).toBe(0);
  });

  dbTest('only returns entries whose probe is missing or stale', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'a.example/fresh',
      remote_url: 'https://fresh.example.com/mcp',
    });
    await repository.upsertRegistryEntry({
      name: 'b.example/stale',
      remote_url: 'https://stale.example.com/mcp',
    });
    await repository.upsertRegistryEntry({ name: 'c.example/no-remote' });

    await repository.recordProbeResult('a.example/fresh', {
      probed_auth_type: 'none',
      probed_at: new Date('2026-07-28T00:00:00.000Z'),
      probed_url: 'https://fresh.example.com/mcp',
    });
    await repository.recordProbeResult('b.example/stale', {
      probed_auth_type: 'none',
      probed_at: new Date('2026-01-01T00:00:00.000Z'),
      probed_url: 'https://stale.example.com/mcp',
    });

    const due = await repository.findEntriesNeedingProbe(new Date('2026-07-01T00:00:00.000Z'), 10);

    // Never-probed entries come first, then the stale one. The entry with no
    // remote has nothing to probe and is excluded entirely.
    expect(due.map((entry) => entry.name)).toEqual(['b.example/stale']);
  });
});

describe('serializeCapabilityTags', () => {
  dbTest('normalizes, deduplicates, and delimits tags', async () => {
    expect(serializeCapabilityTags(['Repos', ' issues ', 'repos'])).toBe('|repos|issues|');
    expect(serializeCapabilityTags([])).toBeNull();
    expect(serializeCapabilityTags(undefined)).toBeNull();
    expect(serializeCapabilityTags(['  '])).toBeNull();
  });
});

describe('field ownership across writers', () => {
  const curation = (
    overrides: Partial<MCPCatalogCurationUpsert> = {}
  ): MCPCatalogCurationUpsert => ({
    name: 'com.example/mcp',
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: 'Benefit',
    starter_prompt: 'Prompt',
    permission_disclosure: 'Discloses things',
    verified: true,
    ...overrides,
  });

  dbTest('lets the registry keep correcting copy the overlay never claimed', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'First title',
      description: 'First description',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    // `curated.yaml` supplies no title or description for most entries, so the
    // row is curated while these two fields still belong to the registry.
    await repository.upsertCuration(curation());

    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Corrected title',
      description: 'Corrected description',
      registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      curated: true,
      title: 'Corrected title',
      description: 'Corrected description',
    });
  });

  dbTest('keeps a title the overlay did claim', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Registry title',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(curation({ title: 'Curated title' }));

    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Registry title again',
      registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      title: 'Curated title',
    });
  });

  dbTest('hands a field back when the overlay stops claiming it', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Registry title',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(curation({ title: 'Curated title' }));
    // The curator deletes the `title:` line from the entry.
    await repository.upsertCuration(curation());

    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Registry title again',
      registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      title: 'Registry title again',
    });
  });

  dbTest(
    'drops a registry remote when a later release publishes only a package',
    async ({ db }) => {
      const repository = new MCPCatalogRepository(db);
      await repository.upsertRegistryEntry({
        name: 'com.example/mcp',
        remote_url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
        registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      await repository.upsertCuration(curation());

      await repository.upsertRegistryEntry({
        name: 'com.example/mcp',
        transport: 'stdio',
        packages: [{ registry_type: 'npm', identifier: 'example-mcp' }],
        registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
      });

      // The endpoint is no longer published. Continuing to offer it would send
      // users at a URL its own publisher withdrew.
      expect(await repository.findByName('com.example/mcp')).toMatchObject({
        curated: true,
        has_remote: false,
        remote_url: undefined,
        transport: 'stdio',
      });
    }
  );

  dbTest('keeps a curated remote through a package-only release', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    // The registry knows the server but publishes no endpoint; curation supplies
    // the only way to connect, and nulling it would remove the entry's purpose.
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(
      curation({ remote_url: 'https://curated.example.com/mcp', transport: 'streamable-http' })
    );

    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      packages: [{ registry_type: 'npm', identifier: 'example-mcp' }],
      registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      remote_url: 'https://curated.example.com/mcp',
      transport: 'streamable-http',
      has_remote: true,
    });
  });
});

describe('probe verdicts and the endpoint they describe', () => {
  const probedNone = (url: string) => ({
    probed_auth_type: 'none' as const,
    probed_at: new Date('2026-07-28T00:00:00.000Z'),
    probed_url: url,
  });

  dbTest('discards the verdict when the registry moves the endpoint', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      remote_url: 'https://old.example.com/mcp',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.recordProbeResult(
      'com.example/mcp',
      probedNone('https://old.example.com/mcp')
    );

    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      remote_url: 'https://new.example.com/mcp',
      registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });

    // Inheriting `none` would render a connect-directly button for an endpoint
    // nothing has ever contacted.
    const entry = await repository.findByName('com.example/mcp');
    expect(entry).toMatchObject({ remote_url: 'https://new.example.com/mcp' });
    expect(entry?.probed_auth_type).toBe('unknown');
    expect(entry?.probed_at).toBeUndefined();
  });

  dbTest('keeps the verdict when a republication leaves the endpoint alone', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      remote_url: 'https://same.example.com/mcp',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.recordProbeResult(
      'com.example/mcp',
      probedNone('https://same.example.com/mcp')
    );

    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      remote_url: 'https://same.example.com/mcp',
      description: 'New description',
      registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      probed_auth_type: 'none',
    });
  });

  dbTest('discards a verdict for a URL the row no longer carries', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      remote_url: 'https://current.example.com/mcp',
    });

    // Probing happens outside any database unit, so a verdict can land after the
    // row moved on. Writing it would recreate exactly the staleness the
    // invalidation removes.
    await repository.recordProbeResult(
      'com.example/mcp',
      probedNone('https://stale.example.com/mcp')
    );

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      probed_auth_type: 'unknown',
    });
  });
});

describe('retireCuration', () => {
  const curation = (name: string): MCPCatalogCurationUpsert => ({
    name,
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: 'Benefit',
    starter_prompt: 'Prompt',
    permission_disclosure: 'Discloses things',
    verified: true,
    popularity_rank: 1,
  });

  dbTest('deletes a row that existed only because the file named it', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertCuration(curation('invented.example/mcp'));

    expect(await repository.retireCuration('invented.example/mcp')).toBe('deleted');
    expect(await repository.findByName('invented.example/mcp')).toBeNull();
  });

  dbTest('leaves the registry half of a mirrored row intact', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      version: '1.2.3',
      description: 'Registry description',
      remote_url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
    });
    await repository.upsertCuration(curation('com.example/mcp'));

    expect(await repository.retireCuration('com.example/mcp')).toBe('uncurated');
    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      curated: false,
      // `verified` is a claim curation made; nobody is left making it.
      verified: false,
      category: undefined,
      benefit: undefined,
      popularity_rank: undefined,
      // The registry still publishes this, so it stays connectable.
      version: '1.2.3',
      remote_url: 'https://mcp.example.com/mcp',
    });
  });

  dbTest('withdraws a connect surface only curation supplied', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'com.example/mcp', version: '1.0.0' });
    await repository.upsertCuration({
      ...curation('com.example/mcp'),
      remote_url: 'https://curated.example.com/mcp',
      transport: 'streamable-http',
    });
    await repository.recordProbeResult('com.example/mcp', {
      probed_auth_type: 'none',
      probed_at: new Date('2026-07-28T00:00:00.000Z'),
      probed_url: 'https://curated.example.com/mcp',
    });

    expect(await repository.retireCuration('com.example/mcp')).toBe('uncurated');
    const entry = await repository.findByName('com.example/mcp');
    expect(entry).toMatchObject({ has_remote: false, probed_auth_type: 'unknown' });
    expect(entry?.remote_url).toBeUndefined();
  });

  dbTest('is inert for a name that is not curated', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'com.example/mcp' });

    expect(await repository.retireCuration('com.example/mcp')).toBe('absent');
    expect(await repository.retireCuration('nobody.example/mcp')).toBe('absent');
    expect(await repository.findByName('com.example/mcp')).not.toBeNull();
  });

  dbTest('lists exactly the curated names', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'plain.example/mcp' });
    await repository.upsertCuration(curation('a.example/mcp'));
    await repository.upsertCuration(curation('b.example/mcp'));

    expect((await repository.listCuratedNames()).sort()).toEqual([
      'a.example/mcp',
      'b.example/mcp',
    ]);
  });
});

describe('handing a field back to the registry', () => {
  const curation = (
    overrides: Partial<MCPCatalogCurationUpsert> = {}
  ): MCPCatalogCurationUpsert => ({
    name: 'com.example/mcp',
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: 'Benefit',
    starter_prompt: 'Prompt',
    permission_disclosure: 'Discloses things',
    verified: true,
    ...overrides,
  });

  dbTest('restores the registry value when the overlay drops a field', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Registry title',
      description: 'Registry description',
      website_url: 'https://registry.example.com',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(
      curation({
        title: 'Curated title',
        description: 'Curated description',
        website_url: 'https://curated.example.com',
      })
    );

    // The curator deletes all three lines. No republication follows, so nothing
    // else will ever rewrite these columns.
    await repository.upsertCuration(curation());

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      title: 'Registry title',
      description: 'Registry description',
      website_url: 'https://registry.example.com',
    });
  });

  dbTest('restores registry copy when the whole overlay is withdrawn', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      title: 'Registry title',
      description: 'Registry description',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(
      curation({ title: 'Curated title', description: 'Curated description' })
    );

    expect(await repository.retireCuration('com.example/mcp')).toBe('uncurated');

    // Leaving curated copy on an uncurated row attributes hand-written text to
    // the registry, which never published it.
    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      curated: false,
      title: 'Registry title',
      description: 'Registry description',
    });
  });

  dbTest(
    'falls back to the curated remote the moment the registry drops its own',
    async ({ db }) => {
      const repository = new MCPCatalogRepository(db);
      await repository.upsertRegistryEntry({
        name: 'com.example/mcp',
        remote_url: 'https://registry.example.com/mcp',
        transport: 'streamable-http',
        registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      // Curation supplies a remote too; the registry's takes precedence while it
      // is published.
      await repository.upsertCuration(
        curation({ remote_url: 'https://curated.example.com/mcp', transport: 'sse' })
      );
      expect(await repository.findByName('com.example/mcp')).toMatchObject({
        remote_url: 'https://registry.example.com/mcp',
      });

      // A package-only release withdraws the registry endpoint.
      await repository.upsertRegistryEntry({
        name: 'com.example/mcp',
        packages: [{ registry_type: 'npm', identifier: 'example-mcp' }],
        registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
      });

      // The curated endpoint is still the file's answer, so the row should offer
      // it immediately rather than going unconnectable until the next seed.
      expect(await repository.findByName('com.example/mcp')).toMatchObject({
        remote_url: 'https://curated.example.com/mcp',
        transport: 'sse',
        has_remote: true,
      });
    }
  );
});

describe('a registry withdrawal followed by a curation change', () => {
  const curation = (
    name: string,
    overrides: Partial<MCPCatalogCurationUpsert> = {}
  ): MCPCatalogCurationUpsert => ({
    name,
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: 'Benefit',
    starter_prompt: 'Prompt',
    permission_disclosure: 'Discloses things',
    verified: true,
    ...overrides,
  });

  const withdrawnRow = async (repository: MCPCatalogRepository) => {
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      version: '1.2.3',
      remote_url: 'https://registry.example.com/mcp',
      transport: 'streamable-http',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(
      curation('com.example/mcp', {
        remote_url: 'https://curated.example.com/mcp',
        transport: 'sse',
      })
    );
    expect(await repository.retireWithdrawnEntry('com.example/mcp')).toBe('retired-curated');
  };

  dbTest('keeps offering the endpoint curation still supplies', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await withdrawnRow(repository);

    // Only the registry withdrew. The curated endpoint is still the file's
    // answer, so wiping it leaves the row unconnectable until a later seed
    // happens to put it back.
    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      remote_url: 'https://curated.example.com/mcp',
      transport: 'sse',
      has_remote: true,
    });
  });

  dbTest('deletes rather than uncurates when the overlay is then removed', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await withdrawnRow(repository);

    // Nothing publishes this server any more, so there is no registry half to
    // fall back to. Leaving a row behind puts a withdrawn server back on offer
    // with no curation behind it.
    expect(await repository.retireCuration('com.example/mcp')).toBe('deleted');
    expect(await repository.findByName('com.example/mcp')).toBeNull();
  });

  dbTest('does not leave the old name behind when the entry is renamed', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await withdrawnRow(repository);

    // A rename is a delete plus an add against the natural key.
    await repository.upsertCuration(curation('com.example/renamed-mcp'));
    expect(await repository.retireCuration('com.example/mcp')).toBe('deleted');

    expect(await repository.findByName('com.example/mcp')).toBeNull();
    expect(await repository.findByName('com.example/renamed-mcp')).toMatchObject({
      curated: true,
    });
  });

  dbTest('still uncurates a row the registry continues to publish', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.live/mcp',
      version: '1.2.3',
      description: 'Registry description',
      registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repository.upsertCuration(curation('com.live/mcp'));

    // The counterfactual: no withdrawal, so the registry half survives.
    expect(await repository.retireCuration('com.live/mcp')).toBe('uncurated');
    expect(await repository.findByName('com.live/mcp')).toMatchObject({
      curated: false,
      description: 'Registry description',
    });
  });
});

describe('withdrawn servers and the browse read', () => {
  const curation = (name: string): MCPCatalogCurationUpsert => ({
    name,
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: 'Benefit',
    starter_prompt: 'Prompt',
    permission_disclosure: 'Discloses things',
    verified: true,
    popularity_rank: 1,
  });

  dbTest('excludes a withdrawn row from the default browse read in SQL', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'com.live/mcp', version: '1' });
    await repository.upsertCuration(curation('com.live/mcp'));
    await repository.upsertRegistryEntry({ name: 'com.gone/mcp', version: '1' });
    await repository.upsertCuration(curation('com.gone/mcp'));
    await repository.retireWithdrawnEntry('com.gone/mcp');

    const listed = await repository.findAll({ exclude_registry_status: 'deleted' });

    // A curated row sorts first, so a withdrawn one left in the result set is
    // not merely present — it is the first thing the marketplace shows.
    expect(listed.map((entry) => entry.name)).toEqual(['com.live/mcp']);
    expect(await repository.count({ exclude_registry_status: 'deleted' })).toBe(1);
  });

  dbTest('keeps rows the registry never described a state for', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    // A curation-only row has no registry state at all. `<>` against NULL is
    // NULL, so a bare inequality would silently drop every one of them.
    await repository.upsertCuration(curation('invented.example/mcp'));

    const listed = await repository.findAll({ exclude_registry_status: 'deleted' });
    expect(listed.map((entry) => entry.name)).toEqual(['invented.example/mcp']);
  });

  dbTest('surfaces the state as a column rather than a blob key', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      version: '1',
      registry_status: 'active',
    });

    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      registry_status: 'active',
    });
    expect(await repository.findAll({ registry_status: 'active' })).toHaveLength(1);
    expect(await repository.findAll({ registry_status: 'deleted' })).toHaveLength(0);
  });

  dbTest('omits the data blob from a list read but keeps it on get', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      version: '1',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      packages: [{ registry_type: 'npm', identifier: 'example-mcp' }],
    });

    // The blob is the bulk of a row and nothing in a listing renders it.
    const [listed] = await repository.findAll({});
    expect(listed.remotes).toBeUndefined();
    expect(listed.packages).toBeUndefined();
    expect(listed.name).toBe('com.example/mcp');

    const hydrated = await repository.findByName('com.example/mcp');
    expect(hydrated?.remotes).toHaveLength(1);
    expect(hydrated?.packages).toHaveLength(1);
  });
});
