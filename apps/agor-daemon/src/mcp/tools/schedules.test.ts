import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
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
  });
});
