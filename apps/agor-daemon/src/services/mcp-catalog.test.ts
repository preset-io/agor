/**
 * MCPCatalogService tests
 *
 * The service has two jobs: hand over the whole catalog, and resolve one entry
 * by name for the connect flow. It takes no query, so what these assert is that
 * a query cannot change the answer — a filter that appeared to be honoured here
 * would be a second, divergent implementation of the browser's filtering.
 *
 * The ordering and matching rules themselves live in `@agor/core/mcp-catalog`
 * and are tested there, by `query.test.ts`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPCatalogService } from './mcp-catalog';

/**
 * A fixture catalog rather than the shipped one.
 *
 * Asserting against `curated.yaml` would make every entry added to the
 * marketplace a test edit, and would tie assertions about the response to
 * however many servers happen to be on offer.
 */
const CATALOG = `
entries:
  - name: com.alpha/mcp
    category: dev-tools
    capabilities: [issues, docs]
    benefit: Alpha does issues.
    starter_prompt: Show me my issues.
    permission_disclosure: Reads issues.
    popularity_rank: 1
    remote_url: https://mcp.alpha.example/mcp
    transport: streamable-http
    auth_type: none
  - name: com.bravo/mcp
    title: Bravo
    description: A searching thing.
    category: search
    capabilities: [web-search]
    benefit: Bravo searches.
    starter_prompt: Search for something.
    permission_disclosure: Reads the public web.
    popularity_rank: 2
    remote_url: https://mcp.bravo.example/mcp
    transport: streamable-http
    auth_type: oauth
unpublished:
  - name: com.charlie/mcp
    category: observability
    capabilities: [logs]
    benefit: Charlie reads logs.
    starter_prompt: Show me the errors.
    permission_disclosure: Reads logs.
    remote_url: https://mcp.charlie.example/mcp
    transport: streamable-http
  - name: com.delta/mcp
    category: data-storage
    capabilities: [databases]
    benefit: Delta reads a database.
    starter_prompt: Query the database.
    permission_disclosure: Reads the database.
    remote_url: https://mcp.delta.example/mcp
`;

let catalogPath: string;
let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-catalog-service-'));
  catalogPath = path.join(tempDir, 'curated.yaml');
  await fs.writeFile(catalogPath, CATALOG, 'utf-8');
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const service = () => new MCPCatalogService(catalogPath);

const names = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name);

describe('MCPCatalogService find', () => {
  it('returns every entry from both lists, most popular first', async () => {
    const result = await service().find();

    expect(result.total).toBe(4);
    // Ranked entries lead; the unranked pair falls back to name order.
    expect(names(result.data)).toEqual([
      'com.alpha/mcp',
      'com.bravo/mcp',
      'com.charlie/mcp',
      'com.delta/mcp',
    ]);
  });

  it('describes the response as the whole catalog, unpaged', async () => {
    const result = await service().find();

    // The envelope stays, because it is the shape every client parses. It says
    // "one page, containing everything" rather than describing a window.
    expect(result.limit).toBe(4);
    expect(result.skip).toBe(0);
    expect(result.data).toHaveLength(result.total);
  });

  it('ignores every filter and page bound a stale client might still send', async () => {
    // The query validator strips these before they arrive; this is the second
    // line, so that a filter reaching the method cannot half-work. Answering a
    // narrowed list here would mean two implementations of "search" that have to
    // agree forever.
    const unchanged = names((await service().find()).data);

    for (const query of [
      { search: 'BRAVO' },
      { category: 'search' },
      { capability: 'logs' },
      { auth_types: ['none', 'unknown'] },
      { auth_type: 'oauth' },
      { has_remote: false },
      { sort: 'name' },
      { name: 'com.alpha/mcp' },
      { $limit: 2, $skip: 1 },
      { $limit: 5000 },
    ] as const) {
      const result = await service().find({ query } as never);

      expect(result.total, `query ${JSON.stringify(query)} changed the total`).toBe(4);
      expect(names(result.data), `query ${JSON.stringify(query)} changed the entries`).toEqual(
        unchanged
      );
    }
  });
});

describe('MCPCatalogService get', () => {
  it('fetches an entry by its catalog name', async () => {
    const entry = await service().get('com.charlie/mcp');
    expect(entry.benefit).toBe('Charlie reads logs.');
    // Absent from the file, so read as "not stated" rather than as open.
    expect(entry.auth_type).toBe('unknown');
  });

  it('reports a name the catalog does not carry as not found', async () => {
    await expect(service().get('com.nope/mcp')).rejects.toThrow(/com\.nope\/mcp/);
  });
});

describe('MCPCatalogService write surface', () => {
  it('exposes no mutation methods', async () => {
    const instance = service() as unknown as Record<string, unknown>;

    // The catalog is a file in this repository. A mutation method here would be
    // a way to change what the marketplace offers without a pull request.
    for (const method of ['create', 'update', 'patch', 'remove']) {
      expect(instance[method]).toBeUndefined();
    }
  });

  it('hands each caller its own array, so one cannot disturb another', async () => {
    const first = await service().find();
    first.data.length = 0;

    expect((await service().find()).data).toHaveLength(4);
  });
});
