import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveSessionId } from '../resolve-ids.js';
import { mcpLimit, mcpOptionalId, mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerTaskTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_tasks_list
  server.registerTool(
    'agor_tasks_list',
    {
      description: 'List tasks (user prompts) in a session',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpOptionalId('sessionId', 'Session', 'Session ID to get tasks from'),
        limit: mcpLimit(50),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.sessionId) query.session_id = await resolveSessionId(ctx, args.sessionId);
      if (args.limit) query.$limit = args.limit;
      const tasks = await ctx.app.service('tasks').find({ query, ...ctx.baseServiceParams });
      return textResult(tasks);
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
