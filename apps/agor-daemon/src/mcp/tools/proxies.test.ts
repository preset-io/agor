import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/config', () => ({
  getBaseUrl: async () => 'http://localhost:3030',
  loadConfig: async () => ({}),
  resolveProxies: () => [],
}));

vi.mock('../server.js', () => ({
  coerceString: (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined,
  textResult: (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }),
}));

const { registerProxyTools } = await import('./proxies.js');

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

  registerProxyTools(fakeServer, {} as Parameters<typeof registerProxyTools>[1]);

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

describe('proxy MCP tool input schemas', () => {
  it('rejects empty required vendor slugs before the handler runs', () => {
    const parsed = captureConfig('agor_proxies_get').inputSchema?.safeParse({ vendor: '' });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['vendor'],
      message: 'vendor cannot be empty.',
    });
  });
});
