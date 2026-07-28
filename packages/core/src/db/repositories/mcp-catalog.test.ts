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
    });
    await repository.recordProbeResult('b.example/stale', {
      probed_auth_type: 'none',
      probed_at: new Date('2026-01-01T00:00:00.000Z'),
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
