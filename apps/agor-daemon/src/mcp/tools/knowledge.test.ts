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
  KNOWLEDGE_DOCUMENT_KINDS: ['doc', 'note'],
  KNOWLEDGE_DOCUMENT_STATUSES: ['draft', 'published'],
  KNOWLEDGE_DOCUMENT_URI_PREFIX: 'agor://kb/document/',
  KNOWLEDGE_EDIT_POLICIES: ['owner', 'namespace'],
  KNOWLEDGE_GRAPH_EDGE_TYPES: ['references', 'relates_to'],
  KNOWLEDGE_GRAPH_NODE_TYPES: ['document', 'external'],
  KNOWLEDGE_VISIBILITIES: ['public', 'private'],
  normalizeKnowledgeDocumentIconEmoji: (icon: string | null | undefined) =>
    typeof icon === 'string' && icon.trim() ? icon.trim() : null,
  parseKnowledgeUri: () => undefined,
}));

type CapturedTool = {
  cfg: { inputSchema?: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } };
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
};

async function captureKnowledgeTools(
  services: Record<string, unknown> = {}
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
  });

  return captured;
}

function issueMessages(error: unknown): string[] {
  if (!error || typeof error !== 'object' || !('issues' in error)) return [];
  return ((error as { issues: Array<{ message: string }> }).issues ?? []).map(
    (issue) => issue.message
  );
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
});
