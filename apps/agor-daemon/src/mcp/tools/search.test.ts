import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../tool-registry.js';
import { registerSearchTools } from './search.js';

vi.mock('../server.js', () => ({
  coerceJsonRecord: (value: unknown) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  textResult: (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }),
}));

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

type ToolConfig = {
  inputSchema?: {
    safeParse: (value: unknown) => {
      success: boolean;
      data?: unknown;
      error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
    };
  };
};

function captureExecuteTool(targetHandler = vi.fn(async (args: unknown) => textResult({ args }))) {
  let config: ToolConfig | undefined;
  let handler: ToolHandler | undefined;

  const fakeServer = {
    _registeredTools: {
      agor_sessions_list: {
        enabled: true,
        inputSchema: z.object({
          branchId: z.string().optional(),
          limit: z.number().optional(),
        }),
        handler: targetHandler,
      },
    },
    registerTool: (name: string, cfg: ToolConfig, cb: ToolHandler) => {
      if (name === 'agor_execute_tool') {
        config = cfg;
        handler = cb;
      }
    },
  } as unknown as McpServer;

  registerSearchTools(fakeServer, new ToolRegistry());

  if (!config || !handler) throw new Error('agor_execute_tool was not registered');
  return { config, handler, targetHandler };
}

function captureSearchTools(registry = new ToolRegistry()) {
  const captured: Record<string, { config: ToolConfig; handler: ToolHandler }> = {};
  const fakeServer = {
    _registeredTools: {},
    registerTool: (name: string, cfg: ToolConfig, cb: ToolHandler) => {
      captured[name] = { config: cfg, handler: cb };
    },
  } as unknown as McpServer;

  registerSearchTools(fakeServer, registry);
  return captured;
}

describe('agor_execute_tool', () => {
  it('accepts the canonical tool_name field and forwards nested arguments', async () => {
    const { handler, targetHandler } = captureExecuteTool();

    const result = await handler({
      tool_name: 'agor_sessions_list',
      arguments: { branchId: 'branch-1' },
    });

    expect(result.isError).toBeUndefined();
    expect(targetHandler).toHaveBeenCalledWith({ branchId: 'branch-1' }, {});
  });

  it('rejects camelCase toolName with a clear schema error', () => {
    const { config } = captureExecuteTool();

    const parsed = config.inputSchema?.safeParse({
      toolName: 'agor_sessions_list',
      arguments: { branchId: 'branch-1' },
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]?.path).toEqual(['tool_name']);
    expect(parsed?.error?.issues?.[0]?.message).toMatch(/tool_name is required/);
    expect(parsed?.error?.issues?.[0]?.message).toMatch(/"arguments"/);
  });

  it('returns an actionable schema error when the tool name is omitted', () => {
    const { config } = captureExecuteTool();

    const parsed = config.inputSchema?.safeParse({
      arguments: { branchId: 'branch-1' },
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]?.path).toEqual(['tool_name']);
    expect(parsed?.error?.issues?.[0]?.message).toMatch(/tool_name is required/);
    expect(parsed?.error?.issues?.[0]?.message).toMatch(/"tool_name"/);
  });

  it('does not leak proxy-only fields into flattened target-tool arguments', async () => {
    const { handler, targetHandler } = captureExecuteTool();

    const result = await handler({
      tool_name: 'agor_sessions_list',
      branchId: 'branch-1',
      limit: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(targetHandler).toHaveBeenCalledWith({ branchId: 'branch-1', limit: 5 }, {});
  });

  it('points invalid tool names to search and details discovery flow', async () => {
    const { handler } = captureExecuteTool();

    const result = await handler({
      tool_name: 'agor_missing_tool',
      arguments: {},
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/not found/);
    expect(parsed.how_to_find_tools).toMatch(/agor_search_tools/);
    expect(parsed.how_to_find_tools).toMatch(/agor_get_tool_details/);
  });

  it('rejects unknown target-tool arguments instead of silently stripping them', async () => {
    const { handler, targetHandler } = captureExecuteTool();

    const result = await handler({
      tool_name: 'agor_sessions_list',
      arguments: {
        limit: 1,
        definitelyNotAParam: 'typo',
      },
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/unknown argument "definitelyNotAParam"/);
    expect(parsed.error).toMatch(/agor_get_tool_details/);
    expect(targetHandler).not.toHaveBeenCalled();
  });
});

describe('agor_get_tool_details', () => {
  it('returns one exact schema at a time', async () => {
    const registry = new ToolRegistry();
    registry.setCurrentDomain('sessions');
    registry.register({
      name: 'agor_sessions_list',
      description: 'List sessions',
      inputSchema: {
        type: 'object',
        properties: { branchId: { type: 'string' } },
      },
      annotations: { readOnlyHint: true },
    });
    const tools = captureSearchTools(registry);

    const result = await tools.agor_get_tool_details.handler({
      tool_name: 'agor_sessions_list',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tool.name).toBe('agor_sessions_list');
    expect(parsed.tool.inputSchema.properties.branchId.type).toBe('string');
    expect(parsed.usage.execute_with.tool_name).toBe('agor_sessions_list');
  });
});

describe('agor_search_tools', () => {
  it('keeps full detail responses concise until search narrows to one tool', async () => {
    const registry = new ToolRegistry();
    registry.setCurrentDomain('sessions');
    registry.register({
      name: 'agor_sessions_list',
      description: 'List sessions',
      inputSchema: { type: 'object', properties: { branchId: { type: 'string' } } },
    });
    registry.register({
      name: 'agor_sessions_get',
      description: 'Get a session',
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
    });
    const tools = captureSearchTools(registry);

    const broad = await tools.agor_search_tools.handler({
      domain: 'sessions',
      detail: 'full',
      max_results: 10,
    });
    const broadParsed = JSON.parse(broad.content[0].text);
    expect(broadParsed.tools[0].inputSchema).toBeUndefined();
    expect(broadParsed.hint).toMatch(/narrowed to one tool/);

    const narrow = await tools.agor_search_tools.handler({
      query: 'agor_sessions_get',
      detail: 'full',
      max_results: 1,
    });
    const narrowParsed = JSON.parse(narrow.content[0].text);
    expect(narrowParsed.tools[0].inputSchema.properties.sessionId.type).toBe('string');
  });
});
