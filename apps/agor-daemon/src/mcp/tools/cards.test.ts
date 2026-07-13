import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/db', () => ({
  BoardObjectRepository: class BoardObjectRepository {},
  enqueueAfterTenantDatabaseCommit: () => false,
  getCurrentTenantId: () => undefined,
  runWithTenantDatabaseScope: vi.fn((_db, _tenantId, work) => work()),
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

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(
  toolName: string,
  ctx: Parameters<typeof registerCardTools>[1]
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: ToolConfig, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;

  registerCardTools(fakeServer, ctx);
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

describe('card MCP realtime events', () => {
  it('passes actor params only where needed and emits correctly-shaped events', async () => {
    const params = {
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      user: { user_id: 'user-1', role: 'member' },
    };
    const card = { card_id: 'card-1', board_id: 'board-1', title: 'Card' };
    const boardObject = {
      object_id: 'object-1',
      board_id: 'board-1',
      card_id: 'card-1',
      entity_type: 'card',
    };
    const cardsEmit = vi.fn();
    const boardObjectsEmit = vi.fn();
    const createWithPlacement = vi.fn(async () => ({ card, boardObject }));
    const moveToZone = vi.fn(async () => boardObject);
    const archive = vi.fn(async () => ({ ...card, archived: true }));
    const cardsGet = vi.fn(async () => card);
    const boardsGet = vi.fn(async () => ({ board_id: 'board-1', objects: {} }));
    const app = {
      service(name: string) {
        if (name === 'cards') {
          return { createWithPlacement, moveToZone, archive, get: cardsGet, emit: cardsEmit };
        }
        if (name === 'boards') return { get: boardsGet };
        if (name === 'board-objects') return { emit: boardObjectsEmit };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const ctx = {
      app,
      db: {},
      userId: 'user-1',
      authenticatedUser: params.user,
      baseServiceParams: params,
    } as unknown as Parameters<typeof registerCardTools>[1];

    await captureHandler('agor_cards_create', ctx)({ boardId: 'board-1', title: 'Card' });
    await captureHandler('agor_cards_move', ctx)({ cardId: 'card-1', zoneId: null });
    await captureHandler('agor_cards_archive', ctx)({ cardId: 'card-1' });

    expect(createWithPlacement).toHaveBeenCalledWith(expect.any(Object), params);
    expect(moveToZone).toHaveBeenCalledWith('card-1', null, undefined);
    expect(archive).toHaveBeenCalledWith('card-1');
    expect(cardsEmit).toHaveBeenCalledWith(
      'created',
      card,
      expect.objectContaining({ path: 'cards', method: 'create', params: {}, result: card })
    );
    expect(cardsEmit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ archived: true }),
      expect.objectContaining({ path: 'cards', method: 'patch', params: {} })
    );
    expect(boardObjectsEmit).toHaveBeenCalledWith(
      'patched',
      boardObject,
      expect.objectContaining({ path: 'board-objects', method: 'patch', params: {} })
    );
  });
});
