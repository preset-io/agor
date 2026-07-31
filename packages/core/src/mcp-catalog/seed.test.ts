import { describe, expect, vi } from 'vitest';
import { MCPCatalogRepository } from '../db/repositories/mcp-catalog';
import { dbTest } from '../db/test-helpers';
import type { CuratedCatalogEntry } from './curated-loader';
import { seedCuratedCatalog } from './seed';

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

function entry(name: string, overrides: Partial<CuratedCatalogEntry> = {}): CuratedCatalogEntry {
  return {
    name,
    category: 'dev-tools',
    capabilities: ['code-repos'],
    benefit: `Benefit for ${name}`,
    starter_prompt: `Prompt for ${name}`,
    permission_disclosure: `Discloses things for ${name}`,
    verified: true,
    ...overrides,
  };
}

describe('seedCuratedCatalog', () => {
  dbTest(
    'creates a connectable row for a server the registry has not published',
    async ({ db }) => {
      const repository = new MCPCatalogRepository(db);

      const result = await seedCuratedCatalog(withRepository(repository), {
        entries: [
          entry('io.sentry/mcp', {
            remote_url: 'https://mcp.sentry.dev/mcp',
            transport: 'streamable-http',
            popularity_rank: 3,
          }),
        ],
      });

      expect(result).toEqual({ created: 1, updated: 0, failed: 0 });
      const seeded = await repository.findByName('io.sentry/mcp');
      expect(seeded).toMatchObject({
        curated: true,
        has_remote: true,
        remote_url: 'https://mcp.sentry.dev/mcp',
        transport: 'streamable-http',
        popularity_rank: 3,
      });
    }
  );

  dbTest('lands the overlay on an already-mirrored registry row', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.notion/mcp',
      version: '1.2.3',
      description: 'Registry description',
      transport: 'streamable-http',
      remote_url: 'https://mcp.notion.com/mcp',
    });

    const result = await seedCuratedCatalog(withRepository(repository), {
      entries: [entry('com.notion/mcp', { category: 'productivity', benefit: 'Curated benefit' })],
    });

    expect(result).toEqual({ created: 0, updated: 1, failed: 0 });
    expect(await repository.findByName('com.notion/mcp')).toMatchObject({
      curated: true,
      category: 'productivity',
      benefit: 'Curated benefit',
      // The registry stays authoritative for identity and the connect surface.
      version: '1.2.3',
      remote_url: 'https://mcp.notion.com/mcp',
      description: 'Registry description',
    });
  });

  dbTest('never mixes a registry transport with a curated remote URL', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    // The registry knows this server but publishes only a package: stdio, no
    // remote. Curation then supplies an HTTPS remote.
    await repository.upsertRegistryEntry({
      name: 'com.example/mcp',
      transport: 'stdio',
    });

    await seedCuratedCatalog(withRepository(repository), {
      entries: [
        entry('com.example/mcp', {
          remote_url: 'https://mcp.example.com/mcp',
          transport: 'streamable-http',
        }),
      ],
    });

    // Keeping `stdio` beside an HTTPS remote would describe the row as
    // unconnectable over HTTP when it is not.
    expect(await repository.findByName('com.example/mcp')).toMatchObject({
      remote_url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      has_remote: true,
    });
  });

  dbTest('lets curation correct a remote URL it supplied earlier', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCuratedCatalog(withRepository(repository), {
      entries: [
        entry('io.sentry/mcp', {
          remote_url: 'https://old.sentry.dev/mcp',
          transport: 'streamable-http',
        }),
      ],
    });

    await seedCuratedCatalog(withRepository(repository), {
      entries: [
        entry('io.sentry/mcp', {
          remote_url: 'https://mcp.sentry.dev/mcp',
          transport: 'streamable-http',
        }),
      ],
    });

    // Deferring to whatever is already stored would pin the first curated URL
    // forever, because curation would be deferring to its own earlier value.
    expect(await repository.findByName('io.sentry/mcp')).toMatchObject({
      remote_url: 'https://mcp.sentry.dev/mcp',
    });
  });

  dbTest('still defers to a registry-published remote over a curated one', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await repository.upsertRegistryEntry({
      name: 'com.notion/mcp',
      remote_url: 'https://mcp.notion.com/mcp',
      transport: 'streamable-http',
    });

    await seedCuratedCatalog(withRepository(repository), {
      entries: [
        entry('com.notion/mcp', {
          remote_url: 'https://guessed.example.com/mcp',
          transport: 'sse',
        }),
      ],
    });

    expect(await repository.findByName('com.notion/mcp')).toMatchObject({
      remote_url: 'https://mcp.notion.com/mcp',
      transport: 'streamable-http',
    });
  });

  dbTest('is idempotent across restarts', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const entries = [entry('a.example/one'), entry('b.example/two')];

    await seedCuratedCatalog(withRepository(repository), { entries });
    const second = await seedCuratedCatalog(withRepository(repository), { entries });

    expect(second).toEqual({ created: 0, updated: 2, failed: 0 });
    expect(await repository.count()).toBe(2);
  });

  dbTest('reapplies edited curation copy', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    await seedCuratedCatalog(withRepository(repository), {
      entries: [entry('a.example/one', { benefit: 'Old benefit', popularity_rank: 9 })],
    });

    await seedCuratedCatalog(withRepository(repository), {
      entries: [entry('a.example/one', { benefit: 'New benefit', popularity_rank: 1 })],
    });

    expect(await repository.findByName('a.example/one')).toMatchObject({
      benefit: 'New benefit',
      popularity_rank: 1,
    });
  });

  dbTest('keeps seeding after one entry fails to write', async ({ db }) => {
    const repository = new MCPCatalogRepository(db);
    const original = repository.upsertCuration.bind(repository);
    vi.spyOn(repository, 'upsertCuration').mockImplementation(async (candidate) => {
      if (candidate.name === 'bad.example/one') throw new Error('write rejected');
      return original(candidate);
    });

    const result = await seedCuratedCatalog(withRepository(repository), {
      entries: [entry('bad.example/one'), entry('good.example/two'), entry('good.example/three')],
      log: () => {},
    });

    expect(result).toEqual({ created: 2, updated: 0, failed: 1 });
  });
});
