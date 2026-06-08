import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/db', () => ({
  BoardObjectRepository: class BoardObjectRepository {},
}));

vi.mock('../server.js', () => ({
  coerceString: (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined,
  textResult: (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }),
}));

const { registerCardTools } = await import('./cards.js');

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

  registerCardTools(fakeServer, {} as Parameters<typeof registerCardTools>[1]);

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

describe('card MCP tool input schemas', () => {
  it('rejects an empty required title with a field-specific message', () => {
    const parsed = captureConfig('agor_cards_create').inputSchema?.safeParse({
      boardId: 'board-1',
      title: '',
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['title'],
      message: 'title cannot be empty.',
    });
  });

  it('validates list pagination as positive/non-negative integers', () => {
    const schema = captureConfig('agor_cards_list').inputSchema;

    const badLimit = schema?.safeParse({ limit: 0 });
    expect(badLimit?.success).toBe(false);
    expect(badLimit?.error?.issues?.[0]).toMatchObject({
      path: ['limit'],
      message: 'limit must be greater than 0.',
    });

    const badOffset = schema?.safeParse({ offset: -1 });
    expect(badOffset?.success).toBe(false);
    expect(badOffset?.error?.issues?.[0]).toMatchObject({
      path: ['offset'],
      message: 'offset must be greater than or equal to 0.',
    });
  });

  it('rejects empty bulk operation arrays in schema before the handler runs', () => {
    const parsed = captureConfig('agor_cards_bulk_create').inputSchema?.safeParse({
      boardId: 'board-1',
      cards: [],
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['cards'],
      message: 'cards must contain at least one card.',
    });
  });

  it('rejects empty nested card IDs in bulk updates', () => {
    const parsed = captureConfig('agor_cards_bulk_update').inputSchema?.safeParse({
      updates: [{ cardId: '' }],
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['updates', 0, 'cardId'],
      message: 'updates[].cardId cannot be empty. Example: { "updates[].cardId": "01abcdef" }',
    });
  });
});
