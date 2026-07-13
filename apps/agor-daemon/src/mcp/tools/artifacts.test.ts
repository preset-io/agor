import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

let insideTenantDatabaseScope = false;

vi.mock('@agor/core/db', () => ({
  BranchRepository: class BranchRepository {},
}));

vi.mock('@agor/core/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('../../utils/branch-authorization.js', () => ({
  hasBranchPermission: () => true,
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
      folderPath: '/tmp/artifact',
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
      folderPath: '/tmp/artifact',
      waitForStatus: true,
      waitTimeoutMs: 15000,
    });

    expect(parsed?.success).toBe(true);
  });

  it('registers validate_folder as the clearer build-check alias', () => {
    const parsed = captureConfig('agor_artifacts_validate_folder').inputSchema?.safeParse({
      folderPath: '/tmp/artifact',
    });

    expect(parsed?.success).toBe(true);
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
          name === 'boards' ? { get: async () => ({ board_id: 'board-1' }) } : service
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
      folderPath: '/tmp/artifact',
      boardId: 'board-1',
      name: 'Artifact',
      waitForStatus: true,
    });

    expect(publishArtifact).toHaveBeenCalledOnce();
    expect(waitForRuntimeStatus).toHaveBeenCalledOnce();
  });
});
