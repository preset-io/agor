import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agor_teammate_memory_append` must never restate document governance.
 *
 * Appending a memory bullet is a content operation. Re-sending creation
 * defaults (visibility / edit_policy / status / title / kind) on every append
 * silently republished a document its owner had made private.
 *
 * These tests drive the real MCP handler against a fake `kb/documents` service
 * whose `putDocument` reproduces the production write semantics:
 *   - update: `deepMerge(current, updates)` skips `undefined`, so an omitted
 *     field is preserved (packages/core/src/db/repositories/merge-utils.ts)
 *   - create: `documentToInsert` supplies the column defaults
 *     (packages/core/src/db/repositories/knowledge.ts)
 *
 * Asserting on stored document state — not just on the call payload — is what
 * makes these bite: a regression has to survive the same merge production uses.
 */

vi.mock('@agor/core/db', () => ({
  BranchRepository: class FakeBranchRepository {},
  KnowledgeNamespaceRepository: class FakeKnowledgeNamespaceRepository {},
  shortId: (value: string) => value.slice(0, 8),
}));

vi.mock('@agor/core/feathers', () => ({
  NotFound: class NotFound extends Error {},
}));

vi.mock('../../utils/branch-workspace-path.js', () => ({
  resolveBranchWorkspacePath: vi.fn(),
  ensureBranchWorkspaceAccess: vi.fn(),
}));
vi.mock('../../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: vi.fn(async () => undefined),
}));
vi.mock('../../utils/spawn-executor.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  requestExecutor: vi.fn(),
}));
vi.mock('../../services/session-token-service.js', () => ({
  issueExecutorCommandToken: vi.fn(async () => 'token'),
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
  sessionContextRequiredResult: () => ({
    content: [{ type: 'text', text: '{"error":"session required"}' }],
  }),
  textResult: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
}));

vi.mock('../tenant-scope.js', () => ({
  runWithMcpTenantDatabaseScope: async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

vi.mock('../../services/knowledge-access.js', () => ({
  resolveKnowledgeNamespacePermission: vi.fn(async () => 'write'),
  hasKnowledgeNamespacePermission: vi.fn(() => true),
}));

const MEMORY_PATH = 'memory/2026-03-04.md';
const MEMORY_DATE = '2026-03-04';

type StoredDocument = {
  document_id: string;
  path: string;
  title: string;
  kind: string;
  visibility: string;
  status: string;
  edit_policy: string;
  content: string;
  version_id: string;
  metadata: Record<string, unknown>;
};

class NotFoundLikeError extends Error {
  readonly code = 404;
}

/** Mirrors KnowledgeDocumentRepository.documentToInsert's column defaults. */
const CREATE_DEFAULTS = {
  kind: 'doc',
  visibility: 'public',
  status: 'published',
  edit_policy: 'owner',
} as const;

const GOVERNANCE_FIELDS = ['title', 'kind', 'visibility', 'status', 'edit_policy'] as const;

function createFakeDocumentsService(seed?: Partial<StoredDocument>) {
  const store = new Map<string, StoredDocument>();
  let versionCounter = 0;

  if (seed) {
    versionCounter += 1;
    store.set(MEMORY_PATH, {
      document_id: 'doc-fixture',
      path: MEMORY_PATH,
      title: 'Seeded title',
      kind: 'memory',
      visibility: 'public',
      status: 'published',
      edit_policy: 'public',
      content: `# ${MEMORY_DATE}\n`,
      version_id: `version-${versionCounter}`,
      metadata: {},
      ...seed,
    });
  }

  const getDocument = vi.fn(async (data: Record<string, unknown>) => {
    const doc = store.get(String(data.path));
    if (!doc) throw new NotFoundLikeError('Knowledge document not found');
    return { ...doc, current_version: { version_id: doc.version_id } };
  });

  const putDocument = vi.fn(async (data: Record<string, unknown>) => {
    const docPath = String(data.path);
    const existing = store.get(docPath);
    versionCounter += 1;

    if (existing) {
      // deepMerge(current, updates): a key whose value is `undefined` (or that
      // is absent entirely) leaves the current value untouched.
      const next: StoredDocument = { ...existing };
      for (const field of GOVERNANCE_FIELDS) {
        const value = data[field];
        if (value !== undefined) next[field] = String(value);
      }
      if (typeof data.content_text === 'string') {
        next.content = data.content_text;
        next.version_id = `version-${versionCounter}`;
      }
      next.metadata = {
        ...existing.metadata,
        ...((data.metadata as Record<string, unknown> | undefined) ?? {}),
      };
      store.set(docPath, next);
      return next;
    }

    const created: StoredDocument = {
      document_id: 'doc-created',
      path: docPath,
      title: (data.title as string | undefined) ?? 'Untitled',
      kind: (data.kind as string | undefined) ?? CREATE_DEFAULTS.kind,
      visibility: (data.visibility as string | undefined) ?? CREATE_DEFAULTS.visibility,
      status: (data.status as string | undefined) ?? CREATE_DEFAULTS.status,
      edit_policy: (data.edit_policy as string | undefined) ?? CREATE_DEFAULTS.edit_policy,
      content: typeof data.content_text === 'string' ? data.content_text : '',
      version_id: `version-${versionCounter}`,
      metadata: (data.metadata as Record<string, unknown> | undefined) ?? {},
    };
    store.set(docPath, created);
    return created;
  });

  return {
    service: { getDocument, putDocument },
    getDocument,
    putDocument,
    read: () => store.get(MEMORY_PATH),
  };
}

async function captureAppendHandler(options: {
  documents: { getDocument: unknown; putDocument: unknown };
  defaultVisibility?: string;
  namespaceVisibilityDefault?: string;
}) {
  const { registerKnowledgeTools } = await import('./knowledge.js');

  const branch = {
    branch_id: 'branch-fixture',
    custom_context: {
      teammate: {
        kind: 'teammate',
        displayName: 'Fixture Teammate',
        kb: {
          primary_namespace_id: 'namespace-fixture',
          primary_namespace_slug: 'fixture-space',
          ...(options.defaultVisibility ? { default_visibility: options.defaultVisibility } : {}),
        },
      },
    },
  };

  const services: Record<string, unknown> = {
    sessions: { get: vi.fn(async () => ({ branch_id: 'branch-fixture' })) },
    branches: { get: vi.fn(async () => branch) },
    'kb/namespaces': {
      get: vi.fn(async () => ({
        namespace_id: 'namespace-fixture',
        slug: 'fixture-space',
        archived: false,
        visibility_default: options.namespaceVisibilityDefault ?? 'public',
      })),
    },
    'kb/documents': options.documents,
  };

  const captured: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  const fakeServer = {
    registerTool: (
      name: string,
      _cfg: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      captured[name] = handler;
    },
  } as unknown as McpServer;

  registerKnowledgeTools(fakeServer, {
    app: { services, service: (path: string) => services[path] ?? {} },
    db: {},
    userId: 'user-fixture',
    sessionId: 'session-fixture',
    authenticatedUser: { user_id: 'user-fixture', role: 'member' },
    baseServiceParams: {},
  } as never);

  const handler = captured.agor_teammate_memory_append;
  if (!handler) throw new Error('agor_teammate_memory_append was not registered');
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agor_teammate_memory_append governance preservation', () => {
  it('keeps an owner-restricted document private and owner-edited across an append', async () => {
    const documents = createFakeDocumentsService({
      visibility: 'private',
      edit_policy: 'owner',
    });
    // Defaults deliberately differ from the stored values: if the handler
    // recomputes them, the document flips to public/public.
    const append = await captureAppendHandler({
      documents: documents.service,
      defaultVisibility: 'public',
      namespaceVisibilityDefault: 'public',
    });

    await append({ bullets: 'Prefers fixture data in tests', date: MEMORY_DATE });

    const stored = documents.read();
    expect(stored?.visibility).toBe('private');
    expect(stored?.edit_policy).toBe('owner');

    // The append must not even attempt a governance change.
    const payload = documents.putDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('visibility');
    expect(payload).not.toHaveProperty('edit_policy');

    // ...and the bullet still landed.
    expect(stored?.content).toContain('Prefers fixture data in tests');
  });

  it('keeps an owner-chosen title, kind and draft status across an append', async () => {
    const documents = createFakeDocumentsService({
      title: 'Renamed by owner',
      kind: 'doc',
      status: 'draft',
    });
    const append = await captureAppendHandler({ documents: documents.service });

    await append({ bullets: 'Second fixture bullet', date: MEMORY_DATE });

    const stored = documents.read();
    expect(stored?.title).toBe('Renamed by owner');
    expect(stored?.kind).toBe('doc');
    expect(stored?.status).toBe('draft');

    const payload = documents.putDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('title');
    expect(payload).not.toHaveProperty('kind');
    expect(payload).not.toHaveProperty('status');
  });

  it('still applies creation defaults when the memory document does not exist yet', async () => {
    const documents = createFakeDocumentsService();
    const append = await captureAppendHandler({
      documents: documents.service,
      defaultVisibility: 'private',
      namespaceVisibilityDefault: 'public',
    });

    await append({ bullets: 'First bullet of a brand new day', date: MEMORY_DATE });

    const stored = documents.read();
    // Teammate default wins over the namespace default on first write.
    expect(stored?.visibility).toBe('private');
    expect(stored?.kind).toBe('memory');
    expect(stored?.status).toBe('published');
    expect(stored?.edit_policy).toBe('public');
    expect(stored?.title).toBe(MEMORY_DATE);
    // Guards against the fields being dropped and silently falling back to the
    // repository column defaults rather than the memory-document defaults.
    expect(stored?.kind).not.toBe(CREATE_DEFAULTS.kind);
    expect(stored?.edit_policy).not.toBe(CREATE_DEFAULTS.edit_policy);
    expect(stored?.content).toContain('First bullet of a brand new day');
  });

  it('falls back to the namespace default visibility when the teammate sets none', async () => {
    const documents = createFakeDocumentsService();
    const append = await captureAppendHandler({
      documents: documents.service,
      namespaceVisibilityDefault: 'private',
    });

    await append({ bullets: 'Namespace-defaulted bullet', date: MEMORY_DATE });

    expect(documents.read()?.visibility).toBe('private');
  });

  it('does not drift over repeated appends to a private document', async () => {
    const documents = createFakeDocumentsService({
      visibility: 'private',
      edit_policy: 'owner',
      title: 'Renamed by owner',
      status: 'draft',
    });
    const append = await captureAppendHandler({
      documents: documents.service,
      defaultVisibility: 'public',
      namespaceVisibilityDefault: 'public',
    });

    for (const bullet of ['bullet alpha', 'bullet beta', 'bullet gamma', 'bullet delta']) {
      await append({ bullets: bullet, date: MEMORY_DATE });
      const snapshot = documents.read();
      expect(snapshot?.visibility).toBe('private');
      expect(snapshot?.edit_policy).toBe('owner');
      expect(snapshot?.title).toBe('Renamed by owner');
      expect(snapshot?.status).toBe('draft');
    }

    expect(documents.putDocument).toHaveBeenCalledTimes(4);
    const final = documents.read();
    for (const bullet of ['bullet alpha', 'bullet beta', 'bullet gamma', 'bullet delta']) {
      expect(final?.content).toContain(bullet);
    }
  });

  it('still passes the optimistic-concurrency token and memory metadata', async () => {
    const documents = createFakeDocumentsService({
      visibility: 'private',
      edit_policy: 'owner',
      version_id: 'version-seeded',
    });
    const append = await captureAppendHandler({ documents: documents.service });

    await append({ bullets: 'Concurrency-checked bullet', date: MEMORY_DATE });

    const payload = documents.putDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.expected_version).toBe('version-seeded');
    expect(payload.metadata).toMatchObject({
      teammate_memory: true,
      teammate_branch_id: 'branch-fixture',
      memory_date: MEMORY_DATE,
    });
  });

  it('does not write at all when every bullet is already recorded', async () => {
    const documents = createFakeDocumentsService({
      visibility: 'private',
      edit_policy: 'owner',
    });
    const append = await captureAppendHandler({ documents: documents.service });

    await append({ bullets: 'Deduped bullet', date: MEMORY_DATE, idempotencyKey: 'fixture-key' });
    expect(documents.putDocument).toHaveBeenCalledTimes(1);

    await append({ bullets: 'Deduped bullet', date: MEMORY_DATE, idempotencyKey: 'fixture-key' });
    expect(documents.putDocument).toHaveBeenCalledTimes(1);
    expect(documents.read()?.visibility).toBe('private');
  });
});
