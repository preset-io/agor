import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
        sessionId: z.string().optional().describe('Session ID to get tasks from'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.sessionId) query.session_id = args.sessionId;
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
        taskId: z.string().describe('Task ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const task = await ctx.app.service('tasks').get(args.taskId, ctx.baseServiceParams);
      return textResult(task);
    }
  );
}
