import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/db', () => ({
  BranchRepository: class FakeBranchRepository {},
}));

vi.mock('@agor/core/feathers', () => ({
  NotFound: class NotFound extends Error {},
}));

vi.mock('../../utils/branch-workspace-path.js', () => ({
  resolveBranchWorkspacePath: vi.fn(),
}));

vi.mock('../resolve-ids.js', () => ({
  resolveBranchId: vi.fn(),
}));

vi.mock('../server.js', () => ({
  coerceJsonRecord: (value: unknown) => value,
  coerceString: (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  textResult: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
}));

vi.mock('@agor/core/types', () => ({
  buildKnowledgeDocumentUri: (id: string) => `agor://kb/document/${id}`,
  getTeammateConfig: (branch: { teammate?: unknown; assistant?: unknown }) =>
    branch.teammate ?? branch.assistant,
  isTeammate: (branch: { teammate?: unknown; assistant?: unknown }) =>
    Boolean(branch.teammate ?? branch.assistant),
  KNOWLEDGE_DOCUMENT_KINDS: ['doc', 'note'],
  KNOWLEDGE_DOCUMENT_STATUSES: ['draft', 'published'],
  KNOWLEDGE_DOCUMENT_URI_PREFIX: 'agor://kb/document/',
  KNOWLEDGE_EDIT_POLICIES: ['owner', 'namespace'],
  KNOWLEDGE_GRAPH_EDGE_TYPES: ['references', 'relates_to'],
  KNOWLEDGE_GRAPH_NODE_TYPES: ['document', 'external'],
  KNOWLEDGE_VISIBILITIES: ['public', 'private'],
  normalizeKnowledgeFolderPath: (folder?: string | null) =>
    (folder ?? '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/'),
  normalizeKnowledgeDocumentIconEmoji: (icon: string | null | undefined) =>
    typeof icon === 'string' && icon.trim() ? icon.trim() : null,
  parseKnowledgeUri: () => undefined,
}));

type CapturedTool = {
  cfg: { inputSchema?: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } };
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
};

async function captureKnowledgeTools(
  services: Record<string, unknown> = {},
  ctxOverrides: Record<string, unknown> = {}
): Promise<Record<string, CapturedTool>> {
  const { registerKnowledgeTools } = await import('./knowledge.js');
  const captured: Record<string, CapturedTool> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, handler: CapturedTool['handler']) => {
      captured[name] = { cfg: cfg as CapturedTool['cfg'], handler };
    },
  } as unknown as McpServer;

  registerKnowledgeTools(fakeServer, {
    app: { services, service: (path: string) => services[path] ?? {} } as any,
    db: {} as any,
    userId: 'user-1' as any,
    authenticatedUser: { user_id: 'user-1', role: 'member' } as any,
    baseServiceParams: {},
    ...ctxOverrides,
  });

  return captured;
}

function issueMessages(error: unknown): string[] {
  if (!error || typeof error !== 'object' || !('issues' in error)) return [];
  return ((error as { issues: Array<{ message: string }> }).issues ?? []).map(
    (issue) => issue.message
  );
}

function textResultJson(result: unknown): unknown {
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Expected text result');
  return JSON.parse(text);
}

describe('Knowledge MCP input schemas', () => {
  it('rejects renamed branch_id instead of accepting it as an alias', async () => {
    const tools = await captureKnowledgeTools();

    const parsed = tools.agor_kb_materialize.cfg.inputSchema?.safeParse({
      branch_id: 'branch-1',
      namespace: 'global',
      path: 'foo.md',
    });

    expect(parsed?.success).toBe(false);
    expect(issueMessages(parsed?.error)).toContain(
      'branchId is required and must be a string. Example: { "branchId": "01abcdef" }'
    );
  });

  it('requires namespace slugs to be non-empty strings', async () => {
    const tools = await captureKnowledgeTools();

    const missing = tools.agor_kb_namespace_put.cfg.inputSchema?.safeParse({});
    const empty = tools.agor_kb_namespace_put.cfg.inputSchema?.safeParse({ slug: '' });

    expect(missing?.success).toBe(false);
    expect(issueMessages(missing?.error)).toContain('slug is required and must be a string.');
    expect(empty?.success).toBe(false);
    expect(issueMessages(empty?.error)).toContain('slug cannot be empty.');
  });

  it('requires agor_kb_tree namespace to be non-blank', async () => {
    const tools = await captureKnowledgeTools();

    const missing = tools.agor_kb_tree.cfg.inputSchema?.safeParse({});
    const blank = tools.agor_kb_tree.cfg.inputSchema?.safeParse({ namespace: '   ' });

    expect(missing?.success).toBe(false);
    expect(issueMessages(missing?.error)).toContain('namespace is required and must be a string.');
    expect(blank?.success).toBe(false);
    expect(issueMessages(blank?.error)).toContain('namespace cannot be blank.');
  });

  it('allows metadata-only document put payloads for existing documents', async () => {
    const tools = await captureKnowledgeTools();

    const parsed = tools.agor_kb_put.cfg.inputSchema?.safeParse({
      documentId: 'doc-1',
      iconEmoji: '📘',
    });

    expect(parsed?.success).toBe(true);
  });

  it('omits kind and content fields for metadata-only document put handlers', async () => {
    const putDocument = vi.fn().mockResolvedValue({ document_id: 'doc-1' });
    const tools = await captureKnowledgeTools({
      'kb/documents': { putDocument },
    });

    await tools.agor_kb_put.handler?.({
      documentId: 'doc-1',
      iconEmoji: '📘',
    });

    expect(putDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        document_id: 'doc-1',
        icon_emoji: '📘',
      }),
      expect.any(Object)
    );
    const data = putDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(data).not.toHaveProperty('kind');
    expect(data).not.toHaveProperty('content_text');
    expect(data).not.toHaveProperty('first_line_is_title');
  });

  it('requires document content to be a string when provided', async () => {
    const tools = await captureKnowledgeTools();

    const parsed = tools.agor_kb_put.cfg.inputSchema?.safeParse({
      namespace: 'global',
      path: 'foo.md',
      content: 123,
    });

    expect(parsed?.success).toBe(false);
    expect(issueMessages(parsed?.error)).toContain('content must be a string when provided.');
  });

  it('enforces positive/non-negative integer pagination and range controls', async () => {
    const tools = await captureKnowledgeTools();

    const badSearchLimit = tools.agor_kb_search.cfg.inputSchema?.safeParse({
      query: '',
      limit: 0,
    });
    const badRangeControls = tools.agor_kb_get_range.cfg.inputSchema?.safeParse({
      documentId: 'doc-1',
      startLine: 1.5,
      contextLines: -1,
    });

    expect(badSearchLimit?.success).toBe(false);
    expect(issueMessages(badSearchLimit?.error)).toContain('limit must be greater than 0.');
    expect(badRangeControls?.success).toBe(false);
    expect(issueMessages(badRangeControls?.error)).toEqual(
      expect.arrayContaining([
        'startLine must be an integer.',
        'contextLines must be greater than or equal to 0.',
      ])
    );
  });

  it('returns structural section refs from Knowledge outlines', async () => {
    const get = vi.fn().mockResolvedValue({
      document: {
        document_id: 'doc-1',
        path: 'guide.md',
        uri: 'agor://kb/global/guide.md',
      },
      current_version: {
        version_id: 'ver-1',
        document_id: 'doc-1',
        version_number: 1,
      },
      content: ['# Guide', 'intro', '## Setup', 'steps', '## Setup', 'more steps'].join('\n'),
    });
    const tools = await captureKnowledgeTools({ 'kb/documents': { get } });

    const result = textResultJson(
      await tools.agor_kb_outline.handler?.({ documentId: 'doc-1' })
    ) as Record<string, any>;

    expect(result.headings).toMatchObject([
      {
        headingPath: 'Guide',
        sectionRef: 'root.h1[1]',
        startLine: 1,
        endLine: 6,
        chars: '# Guide\nintro\n## Setup\nsteps\n## Setup\nmore steps'.length,
      },
      {
        headingPath: 'Guide > Setup',
        occurrence: 1,
        sectionRef: 'root.h1[1].h2[1]',
        startLine: 3,
        endLine: 4,
      },
      {
        headingPath: 'Guide > Setup',
        occurrence: 2,
        sectionRef: 'root.h1[1].h2[2]',
        startLine: 5,
        endLine: 6,
      },
    ]);
    expect(result.version).toEqual({
      version_id: 'ver-1',
      version_number: 1,
      content_sha256: null,
      etag: 'kbv:ver-1',
    });
  });

  it('reads Knowledge sections by sectionRef from the outline', async () => {
    const get = vi.fn().mockResolvedValue({
      document: {
        document_id: 'doc-1',
        path: 'guide.md',
        uri: 'agor://kb/global/guide.md',
      },
      current_version: {
        version_id: 'ver-1',
        document_id: 'doc-1',
        version_number: 1,
      },
      content: ['# Guide', 'intro', '## Setup', 'steps', '## Setup', 'more steps'].join('\n'),
    });
    const tools = await captureKnowledgeTools({ 'kb/documents': { get } });

    const result = textResultJson(
      await tools.agor_kb_get_range.handler?.({
        documentId: 'doc-1',
        sectionRef: 'root.h1[1].h2[2]',
        contextLines: 0,
      })
    ) as Record<string, any>;

    expect(result.range).toMatchObject({
      startLine: 5,
      endLine: 6,
      contextStartLine: 5,
      contextEndLine: 6,
      content: '## Setup\nmore steps',
      numberedContent: '5: ## Setup\n6: more steps',
    });
    expect(result.range).not.toHaveProperty('sourceRange');
  });

  it('pages within a Knowledge section using offsetLines and maxLines', async () => {
    const get = vi.fn().mockResolvedValue({
      document: {
        document_id: 'doc-1',
        path: 'guide.md',
        uri: 'agor://kb/global/guide.md',
      },
      current_version: {
        version_id: 'ver-1',
        document_id: 'doc-1',
        version_number: 1,
      },
      content: ['# Guide', 'intro', '## Large', 'a', 'b', 'c', 'd', 'e'].join('\n'),
    });
    const tools = await captureKnowledgeTools({ 'kb/documents': { get } });

    const result = textResultJson(
      await tools.agor_kb_get_range.handler?.({
        documentId: 'doc-1',
        sectionRef: 'root.h1[1].h2[1]',
        offsetLines: 2,
        maxLines: 2,
        contextLines: 0,
      })
    ) as Record<string, any>;

    expect(result.range).toMatchObject({
      startLine: 5,
      endLine: 6,
      sourceRange: {
        startLine: 3,
        endLine: 8,
        omittedBefore: 2,
        omittedAfter: 2,
      },
      content: 'b\nc',
      numberedContent: '5: b\n6: c',
    });
  });

  it('omits full Knowledge search content by default while returning snippets for text search', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'runbooks/deploy.md',
          uri: 'agor://kb/global/runbooks/deploy.md',
          url: 'http://localhost/ui/kb/global/runbooks/deploy.md',
          title: 'Deploy',
          icon_emoji: '📘',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: 'line 1\nline 2\nline 3\nline 4',
        },
        snippet: 'matched line 1\nmatched line 2\nmatched line 3\nmatched line 4',
        score: 10,
        mode: 'text',
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(
      await tools.agor_kb_search.handler?.({ query: 'deploy', snippetLines: 2 })
    ) as Array<Record<string, any>>;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ q: 'deploy' }),
      })
    );
    expect(result[0].document).toEqual(
      expect.objectContaining({
        document_id: 'doc-1',
        path: 'runbooks/deploy.md',
        title: 'Deploy',
        icon_emoji: '📘',
        reference_uri: 'agor://kb/document/doc-1',
      })
    );
    expect(result[0].current_version).not.toHaveProperty('content_text');
    expect(result[0].snippet).toBe('matched line 1\nmatched line 2\n…');
  });

  it('caps Knowledge search snippets by characters even for single-line snippets', async () => {
    const longSnippet = 'x'.repeat(1300);
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'long.md',
          uri: 'agor://kb/global/long.md',
          title: 'Long',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: longSnippet,
        },
        snippet: longSnippet,
        score: 10,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(await tools.agor_kb_search.handler?.({ query: 'long' })) as Array<
      Record<string, any>
    >;

    expect(result[0].snippet).toHaveLength(1201);
    expect(result[0].snippet.endsWith('…')).toBe(true);
    expect(result[0].current_version).not.toHaveProperty('content_text');
  });

  it('returns metadata-only Knowledge browse results by default for query empty string', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'notes/private.md',
          uri: 'agor://kb/global/notes/private.md',
          title: 'Private note',
          kind: 'doc',
          visibility: 'private',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: 'sensitive body',
        },
        snippet: 'sensitive body',
        score: 0,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(await tools.agor_kb_search.handler?.({ query: '' })) as Array<
      Record<string, any>
    >;

    expect(result[0]).not.toHaveProperty('snippet');
    expect(result[0].current_version).not.toHaveProperty('content_text');
    expect(result[0].document.reference_uri).toBe('agor://kb/document/doc-1');
  });

  it('returns a compact Knowledge namespace tree without content or version metadata', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'runbooks/deploy.md',
          uri: 'agor://kb/global/runbooks/deploy.md',
          title: 'Deploy',
          icon_emoji: '📘',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
          metadata: { noisy: true },
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: 'sensitive body',
        },
        snippet: 'sensitive body',
        score: 0,
      },
      {
        document: {
          document_id: 'doc-2',
          namespace_id: 'ns-1',
          path: 'notes/today.md',
          uri: 'agor://kb/global/notes/today.md',
          title: 'Today',
          kind: 'note',
          visibility: 'private',
          status: 'draft',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-2',
          document_id: 'doc-2',
          version_number: 1,
          content_text: 'draft body',
        },
        snippet: 'draft body',
        score: 0,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(
      await tools.agor_kb_tree.handler?.({ namespace: 'global', depth: 2 })
    ) as Record<string, any>;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          q: '',
          namespace_slug: 'global',
          include_my_drafts: true,
          include_other_user_drafts: false,
          limit: 100,
        }),
      })
    );
    expect(result).toEqual({
      namespace: 'global',
      path_prefix: null,
      depth: 2,
      count: 2,
      truncated: false,
      tree: [
        {
          type: 'folder',
          name: 'notes',
          path: 'notes',
          document_count: 1,
          children: [
            {
              type: 'doc',
              title: 'Today',
              kind: 'note',
              path: 'notes/today.md',
              uri: 'agor://kb/global/notes/today.md',
              reference_uri: 'agor://kb/document/doc-2',
              status: 'draft',
            },
          ],
        },
        {
          type: 'folder',
          name: 'runbooks',
          path: 'runbooks',
          document_count: 1,
          children: [
            {
              type: 'doc',
              icon: '📘',
              title: 'Deploy',
              kind: 'doc',
              path: 'runbooks/deploy.md',
              uri: 'agor://kb/global/runbooks/deploy.md',
              reference_uri: 'agor://kb/document/doc-1',
              status: 'published',
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive body');
    expect(JSON.stringify(result)).not.toContain('current_version');
    expect(JSON.stringify(result)).not.toContain('metadata');
  });

  it('places an exact pathPrefix document at the tree root', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'runbooks/deploy.md',
          uri: 'agor://kb/global/runbooks/deploy.md',
          title: 'Deploy',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: null,
        score: 0,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(
      await tools.agor_kb_tree.handler?.({
        namespace: 'global',
        pathPrefix: 'runbooks/deploy.md',
      })
    ) as Record<string, any>;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          path_prefix: 'runbooks/deploy.md',
        }),
      })
    );
    expect(result.tree).toEqual([
      {
        type: 'doc',
        title: 'Deploy',
        kind: 'doc',
        path: 'runbooks/deploy.md',
        uri: 'agor://kb/global/runbooks/deploy.md',
        reference_uri: 'agor://kb/document/doc-1',
        status: 'published',
      },
    ]);
  });

  it('normalizes pathPrefix before querying and shaping the tree', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'guides/a.md',
          uri: 'agor://kb/global/guides/a.md',
          title: 'A',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: null,
        score: 0,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(
      await tools.agor_kb_tree.handler?.({
        namespace: 'global',
        pathPrefix: '/guides//',
      })
    ) as Record<string, any>;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          path_prefix: 'guides',
        }),
      })
    );
    expect(result.path_prefix).toBe('guides');
    expect(result.tree).toEqual([
      {
        type: 'doc',
        title: 'A',
        kind: 'doc',
        path: 'guides/a.md',
        uri: 'agor://kb/global/guides/a.md',
        reference_uri: 'agor://kb/document/doc-1',
        status: 'published',
      },
    ]);
  });

  it('expands depth as folder levels below the prefix and groups deeper docs', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'guides/a.md',
          uri: 'agor://kb/global/guides/a.md',
          title: 'A',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: null,
        score: 0,
      },
      {
        document: {
          document_id: 'doc-2',
          namespace_id: 'ns-1',
          path: 'guides/nested/b.md',
          uri: 'agor://kb/global/guides/nested/b.md',
          title: 'B',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: null,
        score: 0,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const result = textResultJson(
      await tools.agor_kb_tree.handler?.({ namespace: 'global', depth: 1 })
    ) as Record<string, any>;

    expect(result.tree).toEqual([
      {
        type: 'folder',
        name: 'guides',
        path: 'guides',
        document_count: 2,
        children: [
          {
            type: 'folder',
            name: '…',
            path: 'guides/…',
            document_count: 1,
            children: [
              {
                type: 'doc',
                title: 'B',
                kind: 'doc',
                path: 'guides/nested/b.md',
                uri: 'agor://kb/global/guides/nested/b.md',
                reference_uri: 'agor://kb/document/doc-2',
                status: 'published',
              },
            ],
          },
          {
            type: 'doc',
            title: 'A',
            kind: 'doc',
            path: 'guides/a.md',
            uri: 'agor://kb/global/guides/a.md',
            reference_uri: 'agor://kb/document/doc-1',
            status: 'published',
          },
        ],
      },
    ]);
  });

  it('includes full Knowledge search content only when explicitly requested', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'runbooks/deploy.md',
          uri: 'agor://kb/global/runbooks/deploy.md',
          title: 'Deploy',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: 'full body',
        },
        snippet: 'full body',
        score: 10,
      },
    ]);
    const tools = await captureKnowledgeTools({ 'kb/search': { find } });

    const contentModeResult = textResultJson(
      await tools.agor_kb_search.handler?.({ query: 'deploy', contentMode: 'full' })
    ) as Array<Record<string, any>>;
    const includeContentResult = textResultJson(
      await tools.agor_kb_search.handler?.({ query: 'deploy', includeContent: true })
    ) as Array<Record<string, any>>;

    expect(contentModeResult[0].current_version.content_text).toBe('full body');
    expect(includeContentResult[0].current_version.content_text).toBe('full body');
    expect(find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ include_chunks: true }),
      })
    );
  });

  it('applies Knowledge search content shaping to teammate memory search', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'memory/today.md',
          uri: 'agor://kb/teammate/memory/today.md',
          title: 'Today',
          kind: 'doc',
          visibility: 'private',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'teammate', display_name: 'Teammate' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: 'memory body',
        },
        snippet: 'memory body',
        score: 10,
      },
    ]);
    const tools = await captureKnowledgeTools(
      {
        sessions: { get: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) },
        branches: {
          get: vi.fn().mockResolvedValue({
            branch_id: 'branch-1',
            teammate: {
              kb: {
                primary_namespace_id: 'ns-1',
                primary_namespace_slug: 'teammate',
                global_access: 'write',
              },
            },
          }),
        },
        'kb/namespaces': {
          get: vi.fn().mockResolvedValue({
            namespace_id: 'ns-1',
            slug: 'teammate',
            archived: false,
          }),
        },
        'kb/search': { find },
      },
      { sessionId: 'session-1' }
    );

    const result = textResultJson(
      await tools.agor_teammate_memory_search.handler?.({ query: 'memory' })
    ) as Array<Record<string, any>>;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          q: 'memory',
          namespace_slug: 'teammate',
          path_prefix: 'memory/',
        }),
      })
    );
    expect(result[0].current_version).not.toHaveProperty('content_text');
    expect(result[0].snippet).toBe('memory body');
  });

  it('applies Knowledge search content shaping to teammate knowledge search', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        document: {
          document_id: 'doc-1',
          namespace_id: 'ns-1',
          path: 'docs/context.md',
          uri: 'agor://kb/global/docs/context.md',
          title: 'Context',
          kind: 'doc',
          visibility: 'public',
          status: 'published',
          edit_policy: 'namespace',
        },
        namespace: { namespace_id: 'ns-1', slug: 'global', display_name: 'Global' },
        current_version: {
          version_id: 'ver-1',
          document_id: 'doc-1',
          version_number: 1,
          content_text: 'knowledge body',
        },
        snippet: 'knowledge body',
        score: 10,
      },
    ]);
    const tools = await captureKnowledgeTools(
      {
        sessions: { get: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) },
        branches: {
          get: vi.fn().mockResolvedValue({
            branch_id: 'branch-1',
            teammate: {
              kb: {
                primary_namespace_id: 'ns-1',
                primary_namespace_slug: 'teammate',
                global_access: 'write',
              },
            },
          }),
        },
        'kb/namespaces': {
          get: vi.fn().mockResolvedValue({
            namespace_id: 'ns-1',
            slug: 'teammate',
            archived: false,
          }),
        },
        'kb/search': { find },
      },
      { sessionId: 'session-1' }
    );

    const result = textResultJson(
      await tools.agor_teammate_knowledge_search.handler?.({ query: 'knowledge' })
    ) as Array<Record<string, any>>;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ q: 'knowledge' }),
      })
    );
    expect(result[0].current_version).not.toHaveProperty('content_text');
    expect(result[0].snippet).toBe('knowledge body');
  });
});
