/**
 * `agor_mcp_catalog_list` — MCP tool handler tests.
 *
 * The tool exists so an agent turns "Notion" into `com.notion/mcp` instead of
 * inventing a URL. What it must get right:
 *
 *   - narrowing is the SAME `filterCatalog` the Catalog UI runs, so "what
 *     search matches" cannot come to mean two different things
 *   - paging is over the filtered set, with an honest `total`/`hasMore`
 *   - each result is a shortlist entry, not the whole catalog record
 *   - it is read-only: connecting is a separate, consented action
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { registerMcpServerTools } from './mcp-servers.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const ENTRIES = [
  {
    hidden: true,
    name: 'com.hidden/mcp',
    category: 'productivity',
    capabilities: ['issues'],
    auth_type: 'oauth',
    popularity_rank: 0,
  },
  {
    hidden: false,
    name: 'com.notion/mcp',
    has_remote: true,
    remote_url: 'https://mcp.notion.com/mcp',
    website_url: 'https://notion.so',
    auth_type: 'oauth',
    category: 'productivity',
    capabilities: ['notes', 'docs'],
    benefit: 'Read and write Notion pages.',
    starter_prompt: 'Summarize my roadmap page.',
    permission_disclosure: 'Agor can read and write pages you share.',
    popularity_rank: 2,
  },
  {
    name: 'com.linear/mcp',
    has_remote: true,
    remote_url: 'https://mcp.linear.app/mcp',
    auth_type: 'oauth',
    category: 'productivity',
    capabilities: ['issues'],
    benefit: 'Read and update Linear issues.',
    starter_prompt: 'What is assigned to me?',
    permission_disclosure: 'Agor can read and update your Linear issues.',
    popularity_rank: 1,
  },
  {
    name: 'io.github.github/github-mcp-server',
    has_remote: true,
    remote_url: 'https://api.githubcopilot.com/mcp/',
    auth_type: 'credentials',
    category: 'dev-tools',
    capabilities: ['code-repos', 'issues'],
    benefit: 'Work with GitHub repositories.',
    description: 'Only this fixture entry has prose stated in the description field.',
    starter_prompt: 'List my open PRs.',
    permission_disclosure: 'Agor can act on repositories your token reaches.',
    popularity_rank: 3,
  },
];

function captureTool(toolName: string): ToolHandler {
  const app = {
    service: (name: string) => {
      if (name !== 'mcp-catalog') throw new Error(`Unexpected service call: ${name}`);
      return { find: async () => ({ total: ENTRIES.length, limit: 3, skip: 0, data: ENTRIES }) };
    },
  };
  let handler: ToolHandler | null = null;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;
  registerMcpServerTools(fakeServer, {
    app: app as never,
    db: {} as never,
    userId: 'user-1' as never,
    sessionId: 'sess-1' as never,
    authenticatedUser: { user_id: 'user-1', role: 'member' } as never,
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    } as never,
  });
  if (!handler) throw new Error(`Tool ${toolName} not registered`);
  return handler;
}

async function run(args: Record<string, unknown> = {}) {
  const handler = captureTool('agor_mcp_catalog_list');
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

describe('agor_mcp_catalog_list', () => {
  it('returns the whole catalog in popularity order by default', async () => {
    const payload = await run();
    expect(payload.catalog_entries.map((e: { name: string }) => e.name)).toEqual([
      'com.linear/mcp',
      'com.notion/mcp',
      'io.github.github/github-mcp-server',
    ]);
    expect(payload.pagination).toMatchObject({ total: 3, hasMore: false, nextOffset: null });
  });

  it('never discovers hidden definitions even with search or a bypass parameter', async () => {
    const result = await run({ search: 'hidden', includeHidden: true });
    expect(result.catalog_entries).toEqual([]);
    expect(result.pagination).toMatchObject({ total: 0, hasMore: false, nextOffset: null });
  });

  it('resolves a product name to its reverse-DNS catalog identity', async () => {
    const payload = await run({ search: 'notion' });
    expect(payload.catalog_entries).toHaveLength(1);
    expect(payload.catalog_entries[0]).toMatchObject({
      name: 'com.notion/mcp',
      display_name: 'Notion',
      auth_type: 'oauth',
      has_remote: true,
    });
  });

  it('matches the shared filter exactly — name, title, benefit, description', async () => {
    // `filterCatalog` is the Catalog UI's filter, so this asserts the tool's
    // description is honest about what `search` reaches. `benefit` is the field
    // every shipped entry states, which is what makes a phrase describing the
    // job — rather than only a product name — resolve to an entry.
    expect((await run({ search: 'stated in the description' })).catalog_entries).toHaveLength(1);

    const prose = await run({ search: 'repositories' });
    expect(prose.catalog_entries.map((e: { name: string }) => e.name)).toEqual([
      'io.github.github/github-mcp-server',
    ]);

    // Still not the starter prompt or the consent text.
    expect((await run({ search: 'List my open PRs' })).catalog_entries).toEqual([]);
    expect((await run({ search: 'Agor can act on' })).catalog_entries).toEqual([]);
  });

  it('narrows by category, capability, and auth type', async () => {
    expect((await run({ category: 'dev-tools' })).catalog_entries).toHaveLength(1);
    expect((await run({ capability: 'issues' })).catalog_entries).toHaveLength(2);
    expect((await run({ authTypes: ['oauth'] })).catalog_entries).toHaveLength(2);
  });

  it('sorts by display name when asked, not by the reverse-DNS name', async () => {
    const payload = await run({ sort: 'name' });
    // Sorting by `name` would put "com.linear" before "com.notion" before
    // "io.github…"; by display name, Github sorts first.
    expect(payload.catalog_entries.map((e: { display_name: string }) => e.display_name)).toEqual([
      'Github',
      'Linear',
      'Notion',
    ]);
  });

  it('pages over the FILTERED set and reports an honest total', async () => {
    const page = await run({ authTypes: ['oauth'], limit: 1 });
    expect(page.catalog_entries).toHaveLength(1);
    expect(page.pagination).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });

    const next = await run({ authTypes: ['oauth'], limit: 1, offset: 1 });
    expect(next.catalog_entries[0].name).toBe('com.notion/mcp');
    expect(next.pagination).toMatchObject({ hasMore: false, nextOffset: null });
  });

  it('returns an empty page rather than a fallback when nothing matches', async () => {
    const payload = await run({ search: 'definitely-not-in-the-catalog' });
    expect(payload.catalog_entries).toEqual([]);
    expect(payload.pagination.total).toBe(0);
  });

  it('keeps human-facing long copy out of the shortlist', async () => {
    const [entry] = (await run({ search: 'notion' })).catalog_entries;
    expect(Object.keys(entry).sort()).toEqual([
      'auth_type',
      'benefit',
      'capabilities',
      'category',
      'display_name',
      'has_remote',
      'name',
      'website_url',
    ]);
    expect(JSON.stringify(entry)).not.toContain('Agor can read and write');
  });

  it('points the agent at the connect tool without connecting anything itself', async () => {
    const payload = await run();
    expect(JSON.stringify(payload.next_steps)).toContain('agor_widgets_request_oauth');
    expect(JSON.stringify(payload.next_steps)).toContain('credentials');
  });
});
