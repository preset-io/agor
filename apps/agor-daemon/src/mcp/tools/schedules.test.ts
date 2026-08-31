import { PAGINATION } from '@agor/core/config';
import {
  AGENTIC_TOOL_NAMES,
  type ScheduleCreateData,
  type SchedulePatchData,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerScheduleTools } from './schedules.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

describe('schedule MCP input schemas', () => {
  it('accepts every active tool and rejects historical tools', () => {
    const configs = new Map<string, { inputSchema: { safeParse: (args: unknown) => any } }>();
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { inputSchema: { safeParse: (args: unknown) => any } },
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

    const createSchema = configs.get('agor_schedules_create')!.inputSchema;
    const patchSchema = configs.get('agor_schedules_patch')!.inputSchema;
    for (const agenticTool of AGENTIC_TOOL_NAMES) {
      expect(
        createSchema.safeParse({
          branchId: 'branch-1',
          name: 'Heartbeat',
          cron_expression: '0 9 * * *',
          timezone_mode: 'utc',
          prompt: 'Run',
          agentic_tool_config: { agentic_tool: agenticTool },
        }).success
      ).toBe(true);
      expect(
        patchSchema.safeParse({
          scheduleId: 'schedule-1',
          agentic_tool_config: { agentic_tool: agenticTool },
        }).success
      ).toBe(true);
    }

    expect(
      createSchema.safeParse({
        branchId: 'branch-1',
        name: 'Heartbeat',
        cron_expression: '0 9 * * *',
        timezone_mode: 'utc',
        prompt: 'Run',
        agentic_tool_config: { agentic_tool: 'claude-code-cli' },
      }).success
    ).toBe(false);
    expect(
      patchSchema.safeParse({
        scheduleId: 'schedule-1',
        agentic_tool_config: { agentic_tool: 'claude-code-cli' },
      }).success
    ).toBe(false);
  });

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

    const localWithoutTimezone = createSchema?.safeParse({
      branchId: 'branch-1',
      name: 'Heartbeat',
      cron_expression: '0 9 * * *',
      timezone_mode: 'local',
      prompt: 'Run',
      agentic_tool_config: { agentic_tool: 'codex' },
    });
    expect(localWithoutTimezone).toMatchObject({ success: false });
    expect(JSON.stringify(localWithoutTimezone)).toContain('timezone');

    const utcWithTimezone = createSchema?.safeParse({
      branchId: 'branch-1',
      name: 'Heartbeat',
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      timezone: 'America/Los_Angeles',
      prompt: 'Run',
      agentic_tool_config: { agentic_tool: 'codex' },
    });
    expect(utcWithTimezone).toMatchObject({ success: false });
    expect(JSON.stringify(utcWithTimezone)).toContain('must be omitted');

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
    const create = vi.fn(async (payload: ScheduleCreateData) => ({
      schedule_id: 'schedule-1',
      ...payload,
    }));
    const patch = vi.fn(async (_id: string, payload: SchedulePatchData) => ({
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

  it('bulk-loads unique branches when filtering schedules by board', async () => {
    const handlers = new Map<string, ToolHandler>();
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => handlers.set(name, cb),
    } as unknown as McpServer;
    const schedules = [
      { schedule_id: 'schedule-1', branch_id: 'branch-a' },
      { schedule_id: 'schedule-2', branch_id: 'branch-a' },
      { schedule_id: 'schedule-3', branch_id: 'branch-b' },
    ];
    const branchesFind = vi.fn(async () => [
      { branch_id: 'branch-a', board_id: 'board-target' },
      { branch_id: 'branch-b', board_id: 'board-other' },
    ]);
    const branchesGet = vi.fn();
    const boardsGet = vi.fn(async () => ({ board_id: 'board-target' }));

    registerScheduleTools(fakeServer, {
      app: {
        service(path: string) {
          if (path === 'schedules') return { find: vi.fn(async () => schedules) };
          if (path === 'branches') return { find: branchesFind, get: branchesGet };
          if (path === 'boards') return { get: boardsGet };
          throw new Error(`Unexpected service: ${path}`);
        },
      } as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'user-1', email: 'user@example.com', role: 'member' } as any,
      baseServiceParams: { provider: 'mcp' },
    });

    const response = (await handlers.get('agor_schedules_list')?.({
      boardId: 'board-target',
      limit: 25,
      offset: 0,
    })) as { content: Array<{ text: string }> };

    expect(boardsGet).toHaveBeenCalledOnce();
    expect(branchesGet).not.toHaveBeenCalled();
    expect(branchesFind).toHaveBeenCalledWith({
      query: {
        branch_id: { $in: ['branch-a', 'branch-b'] },
        $limit: 2,
      },
      paginate: false,
      provider: 'mcp',
    });
    expect(JSON.parse(response.content[0].text).data).toHaveLength(2);
  });

  it('chunks branch authorization at the service pagination cap', async () => {
    const handlers = new Map<string, ToolHandler>();
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => handlers.set(name, cb),
    } as unknown as McpServer;
    const schedules = Array.from({ length: PAGINATION.MAX_LIMIT + 1 }, (_, index) => ({
      schedule_id: `schedule-${index}`,
      branch_id: `branch-${index}`,
    }));
    const branchesFind = vi.fn(async (params: { query: { branch_id: { $in: string[] } } }) =>
      params.query.branch_id.$in.map((branch_id) => ({
        branch_id,
        board_id: 'board-target',
      }))
    );
    const boardsGet = vi.fn(async () => ({ board_id: 'board-target' }));

    registerScheduleTools(fakeServer, {
      app: {
        service(path: string) {
          if (path === 'schedules') return { find: vi.fn(async () => schedules) };
          if (path === 'branches') return { find: branchesFind };
          if (path === 'boards') return { get: boardsGet };
          throw new Error(`Unexpected service: ${path}`);
        },
      } as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'user-1', email: 'user@example.com', role: 'member' } as any,
      baseServiceParams: { provider: 'mcp' },
    });

    const response = (await handlers.get('agor_schedules_list')?.({
      boardId: 'board-target',
      limit: 25,
      offset: 0,
    })) as { content: Array<{ text: string }> };
    const body = JSON.parse(response.content[0].text) as {
      total: number;
      data: unknown[];
    };

    expect(boardsGet).toHaveBeenCalledOnce();
    expect(branchesFind).toHaveBeenCalledTimes(2);
    expect(branchesFind.mock.calls.map(([params]) => params.query.branch_id.$in.length)).toEqual([
      PAGINATION.MAX_LIMIT,
      1,
    ]);
    expect(body.total).toBe(PAGINATION.MAX_LIMIT + 1);
    expect(body.data).toHaveLength(25);
  });
});
