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
  parseKnowledgeUri: () => undefined,
}));

type CapturedTool = {
  cfg: { inputSchema?: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } };
};

async function captureKnowledgeTools(): Promise<Record<string, CapturedTool>> {
  const { registerKnowledgeTools } = await import('./knowledge.js');
  const captured: Record<string, CapturedTool> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: unknown) => {
      captured[name] = { cfg: cfg as CapturedTool['cfg'] };
    },
  } as unknown as McpServer;

  registerKnowledgeTools(fakeServer, {
    app: { services: {}, service: () => ({}) } as any,
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

  it('reports required document content clearly without handler fallback errors', async () => {
    const tools = await captureKnowledgeTools();

    const parsed = tools.agor_kb_put.cfg.inputSchema?.safeParse({
      namespace: 'global',
      path: 'foo.md',
    });

    expect(parsed?.success).toBe(false);
    expect(issueMessages(parsed?.error)).toContain('content is required and must be a string.');
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
