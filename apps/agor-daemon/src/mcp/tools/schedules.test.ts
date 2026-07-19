import type { Schedule } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerScheduleTools } from './schedules.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

describe('schedule MCP input schemas', () => {
  it('rejects non-canonical keys and empty required schedule fields', () => {
    const configs = new Map<string, { inputSchema: { safeParse: (args: unknown) => unknown } }>();
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { inputSchema: { safeParse: (args: unknown) => unknown } },
        _cb: ToolHandler
      ) => {
        configs.set(name, cfg);
      },
    } as unknown as McpServer;

    registerScheduleTools(fakeServer, {
      app: { service: () => ({}) } as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'user-1', email: 'user@example.com', role: 'member' } as any,
      baseServiceParams: {},
    });

    const createSchema = configs.get('agor_schedules_create')?.inputSchema;
    const nonCanonicalBranchId = createSchema?.safeParse({
      branch_id: 'branch-1',
      name: 'Heartbeat',
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      prompt: 'Run',
      agentic_tool_config: { agentic_tool: 'codex' },
    });
    expect(nonCanonicalBranchId).toMatchObject({ success: false });
    expect(JSON.stringify(nonCanonicalBranchId)).toContain('branch_id');

    const emptyName = createSchema?.safeParse({
      branchId: 'branch-1',
      name: '',
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      prompt: 'Run',
      agentic_tool_config: { agentic_tool: 'codex' },
    });
    expect(emptyName).toMatchObject({ success: false });
    expect(JSON.stringify(emptyName)).toContain('name cannot be empty');

    const negativeRetention = createSchema?.safeParse({
      branchId: 'branch-1',
      name: 'Heartbeat',
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      prompt: 'Run',
      agentic_tool_config: { agentic_tool: 'codex' },
      retention: -1,
    });
    expect(negativeRetention).toMatchObject({ success: false });
    expect(JSON.stringify(negativeRetention)).toContain(
      'retention must be greater than or equal to 0'
    );

    const mixedSources = createSchema?.safeParse({
      branchId: 'branch-1',
      name: 'Heartbeat',
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      prompt: 'Run',
      agentic_tool_config: {
        agentic_tool: 'codex',
        preset_id: 'preset-1',
        configuration_reference: '__user_default__',
      },
    });
    expect(mixedSources).toMatchObject({ success: false });
    expect(JSON.stringify(mixedSources)).toContain('must use exactly one source');
  });

  it('preserves default and preset sources through create and patch handlers', async () => {
    const configs = new Map<string, { inputSchema: { parse: (args: unknown) => unknown } }>();
    const handlers = new Map<string, ToolHandler>();
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { inputSchema: { parse: (args: unknown) => unknown } },
        cb: ToolHandler
      ) => {
        configs.set(name, cfg);
        handlers.set(name, cb);
      },
    } as unknown as McpServer;
    const create = vi.fn(async (payload: Partial<Schedule>) => ({
      schedule_id: 'schedule-1',
      ...payload,
    }));
    const patch = vi.fn(async (_id: string, payload: Partial<Schedule>) => ({
      schedule_id: 'schedule-1',
      ...payload,
    }));
    const schedules = {
      get: vi.fn(async () => ({ schedule_id: 'schedule-1' })),
      create,
      patch,
    };
    const branches = { get: vi.fn(async () => ({ branch_id: 'branch-1' })) };

    registerScheduleTools(fakeServer, {
      app: {
        service: (path: string) => (path === 'branches' ? branches : schedules),
      } as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'user-1', email: 'user@example.com', role: 'member' } as any,
      baseServiceParams: {},
    });

    const createArgs = configs.get('agor_schedules_create')?.inputSchema.parse({
      branchId: 'branch-1',
      name: 'Heartbeat',
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      prompt: 'Run',
      agentic_tool_config: {
        agentic_tool: 'codex',
        configuration_reference: '__user_default__',
      },
    }) as Record<string, unknown>;
    await handlers.get('agor_schedules_create')?.(createArgs);
    expect(create.mock.calls[0][0].agentic_tool_config).toEqual({
      agentic_tool: 'codex',
      configuration_reference: '__user_default__',
    });

    const patchArgs = configs.get('agor_schedules_patch')?.inputSchema.parse({
      scheduleId: 'schedule-1',
      agentic_tool_config: { agentic_tool: 'codex', preset_id: 'preset-1' },
    }) as Record<string, unknown>;
    await handlers.get('agor_schedules_patch')?.(patchArgs);
    expect(patch).toHaveBeenCalledWith(
      'schedule-1',
      { agentic_tool_config: { agentic_tool: 'codex', preset_id: 'preset-1' } },
      {}
    );
  });
});
