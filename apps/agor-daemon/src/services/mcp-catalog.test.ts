/**
 * MCPCatalogService tests
 *
 * The service maps a validated Feathers query onto catalog filters and applies
 * the page bounds. What it must not do is answer a filter it does not
 * understand as though it had applied it, so these assert on which entries come
 * back rather than on the shape of the response.
 *
 * The ordering and matching rules themselves live in `@agor/core/mcp-catalog`
 * and are tested there.
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
 * marketplace a test edit, and would tie assertions about paging to however
 * many servers happen to be on offer.
 */
const CATALOG = `
entries:
  - name: com.alpha/mcp
    category: dev-tools
    capabilities: [issues, docs]
    benefit: Alpha does issues.
    starter_prompt: Show me my issues.
    permission_disclosure: Reads issues.
    verified: true
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
    verified: true
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
    benefit: Delta runs locally.
    starter_prompt: Query the database.
    permission_disclosure: Reads the database.
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

  it('searches name, title, and description case-insensitively', async () => {
    expect(names((await service().find({ query: { search: 'BRAVO' } })).data)).toEqual([
      'com.bravo/mcp',
    ]);
    expect(names((await service().find({ query: { search: 'searching' } })).data)).toEqual([
      'com.bravo/mcp',
    ]);
  });

  it('narrows by category, capability, and verified', async () => {
    expect(names((await service().find({ query: { category: 'search' } })).data)).toEqual([
      'com.bravo/mcp',
    ]);
    expect(names((await service().find({ query: { capability: 'logs' } })).data)).toEqual([
      'com.charlie/mcp',
    ]);
    expect(names((await service().find({ query: { verified: true } })).data)).toEqual([
      'com.alpha/mcp',
      'com.bravo/mcp',
    ]);
  });

  it('keeps entries that state nothing when hiding account-only ones', async () => {
    const result = await service().find({ query: { auth_types: ['none', 'unknown'] } });

    // Charlie states no auth type and Delta has no endpoint to state one for;
    // both are still offered, and connecting is what checks them.
    expect(names(result.data)).toEqual(['com.alpha/mcp', 'com.charlie/mcp', 'com.delta/mcp']);
    expect(result.total).toBe(3);
  });

  it('distinguishes entries with an endpoint from ones without', async () => {
    expect(names((await service().find({ query: { has_remote: false } })).data)).toEqual([
      'com.delta/mcp',
    ]);
  });

  it('sorts by name when asked', async () => {
    const result = await service().find({ query: { sort: 'name' } });
    expect(names(result.data)).toEqual([
      'com.alpha/mcp',
      'com.bravo/mcp',
      'com.charlie/mcp',
      'com.delta/mcp',
    ]);
  });

  it('reports the total across the whole match, not the page', async () => {
    const result = await service().find({ query: { $limit: 2, $skip: 1 } });

    expect(result.total).toBe(4);
    expect(result.limit).toBe(2);
    expect(result.skip).toBe(1);
    expect(names(result.data)).toEqual(['com.bravo/mcp', 'com.charlie/mcp']);
  });

  it('caps a caller-supplied page size', async () => {
    const result = await service().find({ query: { $limit: 5000 } });
    expect(result.limit).toBe(100);
  });

  it('pages without repeating or skipping an entry', async () => {
    const seen: string[] = [];
    for (let skip = 0; skip < 4; skip += 2) {
      const page = await service().find({ query: { $limit: 2, $skip: skip } });
      seen.push(...names(page.data));
    }
    expect(seen).toEqual(['com.alpha/mcp', 'com.bravo/mcp', 'com.charlie/mcp', 'com.delta/mcp']);
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
