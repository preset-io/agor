import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

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

const { registerArtifactTools } = await import('./artifacts.js');

type ToolConfig = {
  inputSchema?: {
    safeParse: (value: unknown) => {
      success: boolean;
      error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
    };
  };
};

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
