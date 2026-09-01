import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { DrizzleService, type Repository } from '../../adapters/drizzle.js';

let insideTenantDatabaseScope = false;

vi.mock('@agor/core/db', () => ({
  BranchRepository: class BranchRepository {},
}));

vi.mock('../../utils/branch-authorization.js', () => ({
  hasBranchPermission: () => true,
  isSuperAdmin: () => false,
}));

vi.mock('../server.js', () => ({
  coerceString: (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined,
  textResult: (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }),
}));

vi.mock('../tenant-scope.js', () => ({
  runWithMcpTenantDatabaseScope: async (_ctx: unknown, work: () => Promise<unknown>) => {
    insideTenantDatabaseScope = true;
    try {
      return await work();
    } finally {
      insideTenantDatabaseScope = false;
    }
  },
}));

const { registerArtifactTools } = await import('./artifacts.js');

type ToolConfig = {
  inputSchema?: {
    safeParse: (value: unknown) => {
      success: boolean;
      error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
    };
  };
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(
  toolName: string,
  ctx: Parameters<typeof registerArtifactTools>[1]
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: ToolConfig, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;
  registerArtifactTools(fakeServer, ctx);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function captureConfig(toolName: string): ToolConfig {
  let config: ToolConfig | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: ToolConfig) => {
      if (name === toolName) config = cfg;
    },
  } as unknown as McpServer;

  registerArtifactTools(fakeServer, {} as Parameters<typeof registerArtifactTools>[1]);

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

describe('artifact MCP tool input schemas', () => {
  it('rejects missing required artifact IDs with a field-specific message', () => {
    const parsed = captureConfig('agor_artifacts_get').inputSchema?.safeParse({});

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['artifactId'],
    });
    expect(parsed?.error?.issues?.[0]?.message).toMatch(/artifactId is required/);
  });

  it('rejects empty required DOM selectors', () => {
    const parsed = captureConfig('agor_artifacts_query_dom').inputSchema?.safeParse({
      artifactId: 'artifact-1',
      selector: '',
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['selector'],
      message: 'selector cannot be empty.',
    });
  });

  it('validates artifact list limits as positive integers', () => {
    const parsed = captureConfig('agor_artifacts_list').inputSchema?.safeParse({ limit: -1 });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['limit'],
      message: 'limit must be greater than 0.',
    });
  });

  it('rejects empty requiredEnvVars entries', () => {
    const parsed = captureConfig('agor_artifacts_publish').inputSchema?.safeParse({
      branchId: 'branch-1',
      subpath: 'artifact',
      requiredEnvVars: [''],
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['requiredEnvVars', 0],
      message: 'requiredEnvVars[] cannot be empty.',
    });
  });

  it('accepts waitForStatus publish options', () => {
    const parsed = captureConfig('agor_artifacts_publish').inputSchema?.safeParse({
      branchId: 'branch-1',
      subpath: 'artifact',
      waitForStatus: true,
      waitTimeoutMs: 15000,
    });

    expect(parsed?.success).toBe(true);
  });

  it('accepts the static template for HTML-first artifacts', () => {
    const parsed = captureConfig('agor_artifacts_publish').inputSchema?.safeParse({
      branchId: 'branch-1',
      subpath: 'artifact',
      template: 'static',
      sandpackConfig: {
        template: 'static',
        customSetup: { entry: '/index.html' },
      },
    });

    expect(parsed?.success).toBe(true);
  });

  it('registers validate_folder as the clearer build-check alias', () => {
    const parsed = captureConfig('agor_artifacts_validate_folder').inputSchema?.safeParse({
      branchId: 'branch-1',
      subpath: 'artifact',
    });

    expect(parsed?.success).toBe(true);
  });
});

describe('artifact MCP list projection', () => {
  it('requests the legacy list shape without source files', async () => {
    const find = vi.fn(async () => ({
      total: 1,
      limit: 25,
      skip: 0,
      data: [
        {
          artifact_id: 'artifact-1',
          name: 'Artifact',
          dependencies: { react: '18.3.1' },
        },
      ],
    }));
    const ctx = {
      app: {
        service: vi.fn(() => ({ find })),
      },
      baseServiceParams: {
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      },
    } as unknown as Parameters<typeof registerArtifactTools>[1];

    await captureHandler('agor_artifacts_list', ctx)({});

    expect(find).toHaveBeenCalledWith({
      query: expect.objectContaining({
        $limit: 25,
        $skip: 0,
        $select: expect.arrayContaining(['artifact_id', 'dependencies', 'url']),
      }),
      ...ctx.baseServiceParams,
    });
    expect(find.mock.calls[0]?.[0]?.query.$select).not.toContain('files');
  });
});

describe('artifact MCP not-found results', () => {
  it('projects a real DrizzleService miss as the documented tool result', async () => {
    type ArtifactRow = { artifact_id: string; name: string };
    const repository: Repository<ArtifactRow> = {
      create: vi.fn(),
      findById: vi.fn(async () => null),
      findAll: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const service = Object.assign(
      new DrizzleService<ArtifactRow>(repository, {
        id: 'artifact_id',
        resourceType: 'Artifact',
      }),
      { isVisibleTo: vi.fn() }
    );
    const ctx = {
      app: { service: vi.fn(() => service) },
      userId: 'user-1',
      baseServiceParams: {
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      },
    } as unknown as Parameters<typeof registerArtifactTools>[1];

    const result = await captureHandler('agor_artifacts_get', ctx)({ artifactId: 'artifact-1' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'Artifact artifact-1 not found' }, null, 2),
        },
      ],
    });
    expect(service.isVisibleTo).not.toHaveBeenCalled();
  });
});

describe('artifact MCP transaction boundaries', () => {
  it('leaves publish filesystem work and browser waiting outside the DB scope', async () => {
    const publishArtifact = vi.fn(async () => {
      expect(insideTenantDatabaseScope).toBe(false);
      return { artifact_id: 'artifact-1', name: 'Artifact', files: {} };
    });
    const waitForRuntimeStatus = vi.fn(async () => {
      expect(insideTenantDatabaseScope).toBe(false);
      return { ok: true, observed: true };
    });
    const service = {
      publishArtifact,
      waitForRuntimeStatus,
      buildStatusDiagnostic: vi.fn(() => undefined),
    };
    const ctx = {
      app: {
        service: vi.fn((name: string) =>
          name === 'boards'
            ? { get: async () => ({ board_id: 'board-1' }) }
            : name === 'branches'
              ? { get: async () => ({ branch_id: 'branch-1' }) }
              : service
        ),
      },
      db: {},
      userId: 'user-1',
      authenticatedUser: { user_id: 'user-1', role: 'member' },
      baseServiceParams: {
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      },
    } as unknown as Parameters<typeof registerArtifactTools>[1];

    await captureHandler(
      'agor_artifacts_publish',
      ctx
    )({
      branchId: 'branch-1',
      subpath: 'artifact',
      boardId: 'board-1',
      name: 'Artifact',
      waitForStatus: true,
    });

    expect(publishArtifact).toHaveBeenCalledOnce();
    expect(waitForRuntimeStatus).toHaveBeenCalledOnce();
  });
});
