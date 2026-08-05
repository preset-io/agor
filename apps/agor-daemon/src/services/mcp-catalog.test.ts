/**
 * MCPCatalogService tests
 *
 * The service's whole reason for bypassing the generic Drizzle adapter is that
 * it resolves filters, ordering, page bounds, and the total in SQL. Asserting
 * on the returned rows alone would pass just as well against an implementation
 * that read the entire table and filtered in JS, so these tests assert on the
 * statements the database actually executed and the rows it emitted.
 */

import type { Database, TenantScopeAwareDatabase } from '@agor/core/db';
import {
  createTenantScopedDatabaseProxy,
  MCPCatalogRepository,
  MissingTenantDatabaseScopeError,
  runWithTenantContext,
} from '@agor/core/db';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { MCPCatalogService } from './mcp-catalog';

interface ExecutedStatement {
  sql: string;
  rows: number;
}

/** Record every statement Drizzle issues, with the row count it returned. */
function recordStatements(db: Database): ExecutedStatement[] {
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

  return statements;
}

/** Seed enough rows that a full-table scan would be obvious in the counts. */
async function seedCatalog(db: Database, count = 150): Promise<MCPCatalogRepository> {
  const repository = new MCPCatalogRepository(db);
  for (let index = 0; index < count; index += 1) {
    await repository.upsertRegistryEntry({
      name: `io.filler${String(index).padStart(3, '0')}/server`,
      title: `Filler ${index}`,
      description: 'An ordinary registry entry',
      transport: 'streamable-http',
      remote_url: `https://filler${index}.example.com/mcp`,
    });
  }
  return repository;
}

function service(db: Database): MCPCatalogService {
  return new MCPCatalogService(db as unknown as TenantScopeAwareDatabase);
}

describe('MCPCatalogService find', () => {
  dbTest('reads only the requested page, not the whole catalog', async ({ db }) => {
    await seedCatalog(db);

    const statements = recordStatements(db);
    const result = await service(db).find({ query: { $limit: 24, $skip: 24 } });

    expect(result.total).toBe(150);
    expect(result.data).toHaveLength(24);
    expect(result.limit).toBe(24);
    expect(result.skip).toBe(24);

    // Exactly two statements: the bounded page read and the count. The page
    // read emitted 24 rows and the count emitted one aggregate row — an
    // adapter that paginated in memory would have emitted 150.
    expect(statements).toHaveLength(2);
    const listed = statements.find(
      (statement) => !statement.sql.toLowerCase().includes('count(*)')
    );
    const counted = statements.find((statement) =>
      statement.sql.toLowerCase().includes('count(*)')
    );
    expect(listed?.rows).toBe(24);
    expect(counted?.rows).toBe(1);
    expect(listed?.sql.toLowerCase()).toContain('limit');
    expect(listed?.sql.toLowerCase()).toContain('offset');
  });

  dbTest('pushes the search filter into SQL', async ({ db }) => {
    const repository = await seedCatalog(db);
    await repository.upsertRegistryEntry({
      name: 'com.needle/mcp',
      title: 'Needle',
      description: 'The one entry mentioning haystackneedle',
    });

    const statements = recordStatements(db);
    const result = await service(db).find({ query: { search: 'haystackneedle' } });

    expect(result.total).toBe(1);
    expect(result.data.map((entry) => entry.name)).toEqual(['com.needle/mcp']);
    for (const statement of statements) {
      expect(statement.sql.toLowerCase()).toContain('like');
    }
    const listed = statements.find(
      (statement) => !statement.sql.toLowerCase().includes('count(*)')
    );
    expect(listed?.rows).toBe(1);
  });

  dbTest('pushes category, capability, and verified filters into SQL together', async ({ db }) => {
    const repository = await seedCatalog(db);
    await repository.upsertCuration({
      name: 'com.match/mcp',
      category: 'observability',
      capabilities: ['traces'],
      benefit: 'Traces things',
      starter_prompt: 'Trace something',
      permission_disclosure: 'Reads traces',
      verified: true,
    });
    await repository.upsertCuration({
      name: 'com.unverified/mcp',
      category: 'observability',
      capabilities: ['traces'],
      benefit: 'Also traces things',
      starter_prompt: 'Trace something else',
      permission_disclosure: 'Reads traces',
      verified: false,
    });

    const statements = recordStatements(db);
    const result = await service(db).find({
      query: { category: 'observability', capability: 'traces', verified: true },
    });

    expect(result.data.map((entry) => entry.name)).toEqual(['com.match/mcp']);
    expect(result.total).toBe(1);
    const listed = statements.find(
      (statement) => !statement.sql.toLowerCase().includes('count(*)')
    );
    expect(listed?.rows).toBe(1);
    expect(listed?.sql).toContain('"category"');
    expect(listed?.sql).toContain('"capability_tags"');
    expect(listed?.sql).toContain('"verified"');
  });

  dbTest('reports a total that reflects the filter, not the table size', async ({ db }) => {
    const repository = await seedCatalog(db);
    for (const suffix of ['a', 'b', 'c']) {
      await repository.upsertRegistryEntry({
        name: `com.distinctive-${suffix}/mcp`,
        description: 'contains uniquetoken',
      });
    }

    const result = await service(db).find({ query: { search: 'uniquetoken', $limit: 2 } });

    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(2);
  });

  dbTest('sorts curated entries first without a JS sort pass', async ({ db }) => {
    const repository = await seedCatalog(db, 10);
    await repository.upsertCuration({
      name: 'com.top/mcp',
      category: 'dev-tools',
      capabilities: ['repos'],
      benefit: 'Top entry',
      starter_prompt: 'Do the thing',
      permission_disclosure: 'Reads repos',
      verified: true,
      popularity_rank: 1,
    });

    const statements = recordStatements(db);
    const result = await service(db).find({ query: { sort: 'popularity', $limit: 1 } });

    expect(result.data.map((entry) => entry.name)).toEqual(['com.top/mcp']);
    const listed = statements.find(
      (statement) => !statement.sql.toLowerCase().includes('count(*)')
    );
    expect(listed?.sql.toLowerCase()).toContain('order by');
    // The database returned the single row the caller asked for, already ordered.
    expect(listed?.rows).toBe(1);
  });
});

describe('MCPCatalogService get', () => {
  dbTest('resolves by catalog entry id and by registry name', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'com.example/mcp', title: 'Example' });
    const seeded = await repository.findByName('com.example/mcp');

    const byName = await service(db).get('com.example/mcp');
    const byId = await service(db).get(seeded?.catalog_entry_id ?? '');

    expect(byName.name).toBe('com.example/mcp');
    expect(byId.catalog_entry_id).toBe(seeded?.catalog_entry_id);
  });

  dbTest('throws NotFound for an unknown entry', async ({ db }) => {
    await expect(service(db).get('com.missing/mcp')).rejects.toThrow(/MCPCatalogEntry/);
  });
});

describe('MCPCatalogService under a scope-requiring database proxy', () => {
  /**
   * `required_from_auth` builds the daemon database with `requireScope: true`,
   * so any read taken outside a tenant or system scope throws. The catalog is
   * registered tenant-identity-only, which opens no scope — without the
   * service's own `withTenantDatabase`, every browse would fail in cloud mode
   * while passing in single-tenant tests.
   */
  dbTest('serves reads that the guard would otherwise refuse', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({ name: 'com.example/mcp', title: 'Example' });

    const guarded = createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'daemon database',
    });
    const guardedService = new MCPCatalogService(guarded);

    await runWithTenantContext('tenant-a', async () => {
      const result = await guardedService.find({ query: {} });
      expect(result.total).toBe(1);
      expect((await guardedService.get('com.example/mcp')).name).toBe('com.example/mcp');
    });
  });

  dbTest(
    'reads the guard would refuse without the service opening its own scope',
    async ({ db }) => {
      const guarded = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'daemon database',
      });

      // The counterfactual: a repository handed the guarded proxy directly, which
      // is what the service does if `withTenantDatabase` is removed. It throws, so
      // the test above is not passing by accident.
      await runWithTenantContext('tenant-a', async () => {
        // The repository wraps driver failures in RepositoryError, so assert on
        // the cause rather than the wrapper.
        const rejection = await new MCPCatalogRepository(guarded)
          .count()
          .then(() => null)
          .catch((error: { cause?: unknown }) => error);
        expect(rejection?.cause).toBeInstanceOf(MissingTenantDatabaseScopeError);
      });
    }
  );
});

describe('MCPCatalogService write surface', () => {
  dbTest('exposes no mutation methods', async ({ db }) => {
    const instance = service(db) as unknown as Record<string, unknown>;

    // The catalog is written only by the ingestion worker under the
    // `mcp_catalog_ingestion` system capability. A mutation method here would
    // be reachable from a tenant-scoped request.
    for (const method of ['create', 'update', 'patch', 'remove']) {
      expect(instance[method]).toBeUndefined();
    }
  });

  dbTest('narrows on catalog_entry_id rather than ignoring it', async ({ db }) => {
    const repository = await seedCatalog(db);
    await repository.upsertCuration({
      name: 'com.target/mcp',
      category: 'observability',
      capabilities: ['traces'],
      benefit: 'Traces things',
      starter_prompt: 'Trace something',
      permission_disclosure: 'Reads traces',
      verified: true,
    });
    const target = await repository.findByName('com.target/mcp');

    const found = await service(db).find({
      query: { catalog_entry_id: target?.catalog_entry_id },
    });

    // A filter the service accepted but ignored would return every row, which
    // is a worse answer than refusing the query.
    expect(found.data).toHaveLength(1);
    expect(found.data[0]?.name).toBe('com.target/mcp');
  });
});
