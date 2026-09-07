import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/db', () => ({
  BranchRepository: class FakeBranchRepository {},
  KnowledgeNamespaceRepository: class FakeKnowledgeNamespaceRepository {
    resolveNamespacePermission = vi.fn().mockResolvedValue('own');
  },
}));

vi.mock('@agor/core/feathers', () => ({
  BadRequest: class BadRequest extends Error {},
  Forbidden: class Forbidden extends Error {},
  NotFound: class NotFound extends Error {},
}));

vi.mock('../../utils/branch-workspace-path.js', () => ({
  resolveBranchWorkspacePath: vi.fn(),
}));
vi.mock('../../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: vi.fn(async () => undefined),
}));
vi.mock('../../utils/spawn-executor.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  requestExecutor: vi.fn(),
}));
vi.mock('../../services/session-token-service.js', () => ({
  issueExecutorCommandToken: vi.fn(async () => 'delegated-user-token'),
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
  getTeammateConfig: (branch: {
    teammate?: unknown;
    assistant?: unknown;
    custom_context?: { teammate?: unknown; assistant?: unknown };
  }) =>
    branch.custom_context?.teammate ??
    branch.custom_context?.assistant ??
    branch.teammate ??
    branch.assistant,
  hasMinimumRole: (actual: string | undefined, required: string) => actual === required,
  isTeammate: (branch: { teammate?: unknown; assistant?: unknown }) =>
    Boolean(branch.teammate ?? branch.assistant),
  KNOWLEDGE_DOCUMENT_KINDS: ['doc', 'note'],
  KNOWLEDGE_DOCUMENT_STATUSES: ['draft', 'published'],
  KNOWLEDGE_DOCUMENT_URI_PREFIX: 'agor://kb/document/',
  KNOWLEDGE_EDIT_POLICIES: ['owner', 'public', 'admins'],
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
  ROLES: { ADMIN: 'admin' },
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

function teammateMemoryServices(options: {
  namespaceVisibility: unknown;
  teammateVisibility: unknown;
  getDocument: ReturnType<typeof vi.fn>;
  putDocument: ReturnType<typeof vi.fn>;
}) {
  return {
    sessions: { get: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) },
    branches: {
      get: vi.fn().mockResolvedValue({
        branch_id: 'branch-1',
        teammate: {
          kb: {
            primary_namespace_id: 'ns-1',
            primary_namespace_slug: 'teammate',
            memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
            default_visibility: options.teammateVisibility,
          },
        },
      }),
    },
    'kb/namespaces': {
      get: vi.fn().mockResolvedValue({
        namespace_id: 'ns-1',
        slug: 'teammate',
        visibility_default: options.namespaceVisibility,
        archived: false,
      }),
    },
    'kb/documents': {
      getDocument: options.getDocument,
      putDocument: options.putDocument,
    },
  };
}

describe('Knowledge MCP collection pagination', () => {
  it('pages namespaces only after the service returns the authorized set', async () => {
    const find = vi.fn(async () =>
      Array.from({ length: 4 }, (_, index) => ({
        namespace_id: `ns-${index}`,
        slug: `space-${index}`,
        display_name: `Space ${index}`,
        kind: 'global',
        archived: false,
      }))
    );
    const tools = await captureKnowledgeTools({ 'kb/namespaces': { find } });

    const result = textResultJson(
      await tools.agor_kb_namespaces_list.handler?.({ limit: 2, offset: 2 })
    ) as { total: number; data: Array<{ namespace_id: string }>; nextOffset: number | null };

    expect(find).toHaveBeenCalledWith(expect.objectContaining({ query: { archived: false } }));
    expect(result.total).toBe(4);
    expect(result.data.map((namespace) => namespace.namespace_id)).toEqual(['ns-2', 'ns-3']);
    expect(result.nextOffset).toBeNull();
  });

  it('applies history offset after document authorization', async () => {
    const find = vi.fn(async () =>
      Array.from({ length: 5 }, (_, index) => ({ version_id: `version-${index}` }))
    );
    const tools = await captureKnowledgeTools({ 'kb/versions': { find } });

    const result = textResultJson(
      await tools.agor_kb_history.handler?.({ documentId: 'doc-1', limit: 2, offset: 2 })
    ) as { total: number; data: Array<{ version_id: string }>; nextOffset: number | null };

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ document_id: 'doc-1' }) })
    );
    expect(result.total).toBe(5);
    expect(result.data.map((version) => version.version_id)).toEqual(['version-2', 'version-3']);
    expect(result.nextOffset).toBe(4);
  });
});

describe('teammate memory append access policy', () => {
  it.each([
    ['private', 'owner'],
    ['public', 'public'],
    ['public', 'admins'],
  ])('preserves an existing %s/%s document policy', async (visibility, editPolicy) => {
    const getDocument = vi.fn().mockResolvedValue({
      document: { visibility, edit_policy: editPolicy },
      current_version: { version_id: 'version-1', version_number: 1 },
      content: '# 2026-09-03\n\nExisting memory.\n',
    });
    const putDocument = vi.fn().mockResolvedValue({
      document_id: 'doc-1',
      visibility,
      edit_policy: editPolicy,
    });
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'public',
        teammateVisibility: 'public',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await tools.agor_teammate_memory_append.handler?.({
      date: '2026-09-03',
      bullets: 'New memory',
    });

    const write = putDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(write).toMatchObject({
      namespace_slug: 'teammate',
      path: 'memory/2026-09-03.md',
      expected_version: 'version-1',
    });
    expect(write.content_text).toContain('Existing memory.');
    expect(write.content_text).toContain('New memory');
    expect(write).not.toHaveProperty('visibility');
    expect(write).not.toHaveProperty('edit_policy');
    expect(write).not.toHaveProperty('status');
    expect(write).not.toHaveProperty('kind');
  });

  it.each([
    ['private', 'public', 'private'],
    ['public', 'private', 'private'],
    ['public', 'public', 'public'],
  ])(
    'creates with the narrower namespace=%s and teammate=%s visibility (%s)',
    async (namespaceVisibility, teammateVisibility, expectedVisibility) => {
      const getDocument = vi.fn().mockResolvedValue(undefined);
      const putDocument = vi.fn().mockResolvedValue({ document_id: 'doc-1' });
      const tools = await captureKnowledgeTools(
        teammateMemoryServices({
          namespaceVisibility,
          teammateVisibility,
          getDocument,
          putDocument,
        }),
        { sessionId: 'session-1' }
      );

      await tools.agor_teammate_memory_append.handler?.({
        date: '2026-09-03',
        bullets: 'New memory',
      });

      expect(putDocument.mock.calls[0][0]).toMatchObject({
        namespace_slug: 'teammate',
        path: 'memory/2026-09-03.md',
        visibility: expectedVisibility,
        edit_policy: 'owner',
        expected_version: 0,
      });
    }
  );

  it.each([
    ['namespace', 'shared', 'public'],
    ['teammate', 'private', 'shared'],
  ])(
    'fails closed before creation for an invalid %s visibility',
    async (_, namespace, teammate) => {
      const getDocument = vi.fn().mockResolvedValue(undefined);
      const putDocument = vi.fn();
      const tools = await captureKnowledgeTools(
        teammateMemoryServices({
          namespaceVisibility: namespace,
          teammateVisibility: teammate,
          getDocument,
          putDocument,
        }),
        { sessionId: 'session-1' }
      );

      await expect(
        tools.agor_teammate_memory_append.handler?.({
          date: '2026-09-03',
          bullets: 'New memory',
        })
      ).rejects.toThrow(/visibility is invalid/);
      expect(putDocument).not.toHaveBeenCalled();
    }
  );

  it('fails closed before updating when existing governance cannot be validated', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      document: { visibility: 'private' },
      current_version: { version_id: 'version-1', version_number: 1 },
      content: '# 2026-09-03\n',
    });
    const putDocument = vi.fn();
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'public',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await expect(
      tools.agor_teammate_memory_append.handler?.({
        date: '2026-09-03',
        bullets: 'New memory',
      })
    ).rejects.toThrow(/existing document access policy is invalid/);
    expect(putDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['missing current version', undefined],
    ['missing current version fields', {}],
    ['invalid zero version number', { version_number: 0 }],
  ])('fails closed before updating with %s', async (_, currentVersion) => {
    const getDocument = vi.fn().mockResolvedValue({
      document: { visibility: 'private', edit_policy: 'owner' },
      current_version: currentVersion,
      content: '# 2026-09-03\n',
    });
    const putDocument = vi.fn();
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'private',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await expect(
      tools.agor_teammate_memory_append.handler?.({
        date: '2026-09-03',
        bullets: 'New memory',
      })
    ).rejects.toThrow(/without an existing document version/);
    expect(putDocument).not.toHaveBeenCalled();
  });

  it('fails closed before updating when existing content is not a string', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      document: { visibility: 'private', edit_policy: 'owner' },
      current_version: { version_id: 'version-1', version_number: 1 },
      content: null,
    });
    const putDocument = vi.fn();
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'private',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await expect(
      tools.agor_teammate_memory_append.handler?.({
        date: '2026-09-03',
        bullets: 'New memory',
      })
    ).rejects.toThrow(/without the existing document content/);
    expect(putDocument).not.toHaveBeenCalled();
  });

  it('retries a typed optimistic conflict even when its user-facing wording changes', async () => {
    const { KnowledgeDocumentVersionMismatchError } = await import(
      '../../services/knowledge-errors.js'
    );
    const getDocument = vi
      .fn()
      .mockResolvedValueOnce({
        document: { visibility: 'private', edit_policy: 'owner' },
        current_version: { version_id: 'version-1', version_number: 1 },
        content: '# 2026-09-03\n\nOriginal.\n',
      })
      .mockResolvedValueOnce({
        document: { visibility: 'private', edit_policy: 'owner' },
        current_version: { version_id: 'version-2', version_number: 2 },
        content: '# 2026-09-03\n\nOriginal.\n\nConcurrent memory.\n',
      });
    const conflict = new KnowledgeDocumentVersionMismatchError('version-1', 2);
    conflict.message = 'Optimistic concurrency wording changed';
    const putDocument = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({
      document_id: 'doc-1',
    });
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'public',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await tools.agor_teammate_memory_append.handler?.({
      date: '2026-09-03',
      bullets: 'New memory',
    });

    expect(putDocument).toHaveBeenCalledTimes(2);
    const retry = putDocument.mock.calls[1][0] as Record<string, unknown>;
    expect(retry).toMatchObject({ expected_version: 'version-2' });
    expect(retry.content_text).toContain('Concurrent memory.');
    expect(retry.content_text).toContain('New memory');
    expect(retry).not.toHaveProperty('visibility');
    expect(retry).not.toHaveProperty('edit_policy');
  });

  it('turns a create/upsert race into a policy-preserving retry', async () => {
    const { KnowledgeDocumentVersionMismatchError } = await import(
      '../../services/knowledge-errors.js'
    );
    const getDocument = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        document: { visibility: 'private', edit_policy: 'owner' },
        current_version: { version_id: 'version-1', version_number: 1 },
        content: '# 2026-09-03\n\nConcurrent private memory.\n',
      });
    const putDocument = vi
      .fn()
      .mockRejectedValueOnce(new KnowledgeDocumentVersionMismatchError(0, 1))
      .mockResolvedValueOnce({ document_id: 'doc-1' });
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'public',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await tools.agor_teammate_memory_append.handler?.({
      date: '2026-09-03',
      bullets: 'New memory',
    });

    const createAttempt = putDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(createAttempt).toMatchObject({
      visibility: 'private',
      edit_policy: 'owner',
      expected_version: 0,
    });
    const retry = putDocument.mock.calls[1][0] as Record<string, unknown>;
    expect(retry).toMatchObject({ expected_version: 'version-1' });
    expect(retry.content_text).toContain('Concurrent private memory.');
    expect(retry).not.toHaveProperty('visibility');
    expect(retry).not.toHaveProperty('edit_policy');
  });

  it('stops after the bounded optimistic retry budget is exhausted', async () => {
    const { KnowledgeDocumentVersionMismatchError } = await import(
      '../../services/knowledge-errors.js'
    );
    const getDocument = vi.fn().mockResolvedValue({
      document: { visibility: 'private', edit_policy: 'owner' },
      current_version: { version_id: 'version-1', version_number: 1 },
      content: '# 2026-09-03\n\nExisting.\n',
    });
    const putDocument = vi
      .fn()
      .mockRejectedValue(new KnowledgeDocumentVersionMismatchError('version-1', 2));
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'private',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await expect(
      tools.agor_teammate_memory_append.handler?.({
        date: '2026-09-03',
        bullets: 'New memory',
      })
    ).rejects.toThrow(/document changed concurrently/);
    expect(getDocument).toHaveBeenCalledTimes(3);
    expect(putDocument).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-version failures', async () => {
    const failure = new Error('Synthetic storage failure');
    const getDocument = vi.fn().mockResolvedValue({
      document: { visibility: 'private', edit_policy: 'owner' },
      current_version: { version_id: 'version-1', version_number: 1 },
      content: '# 2026-09-03\n\nExisting.\n',
    });
    const putDocument = vi.fn().mockRejectedValue(failure);
    const tools = await captureKnowledgeTools(
      teammateMemoryServices({
        namespaceVisibility: 'private',
        teammateVisibility: 'private',
        getDocument,
        putDocument,
      }),
      { sessionId: 'session-1' }
    );

    await expect(
      tools.agor_teammate_memory_append.handler?.({
        date: '2026-09-03',
        bullets: 'New memory',
      })
    ).rejects.toBe(failure);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(putDocument).toHaveBeenCalledTimes(1);
  });
});

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

  it('passes trusted current-Session assistant attribution to Knowledge writes', async () => {
    const putDocument = vi.fn().mockResolvedValue({ document_id: 'doc-1' });
    const tools = await captureKnowledgeTools(
      {
        branches: {
          get: vi.fn().mockResolvedValue({
            custom_context: { teammate: { kind: 'teammate', displayName: 'Scout' } },
          }),
        },
        'kb/documents': { putDocument },
      },
      {
        authenticatedSession: {
          session_id: 'session-1',
          agentic_tool: 'codex',
          branch_id: 'branch-1',
        },
      }
    );

    await tools.agor_kb_put.handler?.({
      namespace: 'global',
      path: 'page.md',
      content: '# Page',
    });

    expect(putDocument.mock.calls[0][1]).toMatchObject({
      knowledgeWriteAttribution: {
        sessionId: 'session-1',
        agenticTool: 'codex',
        teammateName: 'Scout',
      },
    });
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
          limit: 26,
          offset: 0,
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
      pagination: { limit: 25, offset: 0, hasMore: false, nextOffset: null },
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
