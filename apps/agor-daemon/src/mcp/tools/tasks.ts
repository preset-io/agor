import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveSessionId } from '../resolve-ids.js';
import { mcpListLimit, mcpOffset, mcpOptionalId, mcpPageResult, mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerTaskTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_tasks_list
  server.registerTool(
    'agor_tasks_list',
    {
      description:
        'List a page of tasks (user prompts), optionally in one session. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpOptionalId('sessionId', 'Session', 'Session ID to get tasks from'),
        limit: mcpListLimit(),
        offset: mcpOffset(),
      }),
    },
    async (args) => {
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const query: Record<string, unknown> = {};
      if (args.sessionId) query.session_id = await resolveSessionId(ctx, args.sessionId);
      query.$limit = limit;
      query.$skip = offset;
      query.$sort = { created_at: -1, task_id: 1 };
      const tasks = await ctx.app.service('tasks').find({ query, ...ctx.baseServiceParams });
      return textResult(mcpPageResult(tasks, limit, offset));
    }
  );

  // Tool 2: agor_tasks_get
  server.registerTool(
    'agor_tasks_get',
    {
      description: 'Get detailed information about a specific task',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        taskId: mcpRequiredId('taskId', 'Task'),
      }),
    },
    async (args) => {
      const task = await ctx.app.service('tasks').get(args.taskId, ctx.baseServiceParams);
      return textResult(task);
    }
  );
}
