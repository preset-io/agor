import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerAnalyticsTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_analytics_leaderboard
  server.registerTool(
    'agor_analytics_leaderboard',
    {
      description:
        'Get usage analytics leaderboard showing token and cost breakdown. Supports dynamic grouping by user, worktree, or repo (or combinations). Use groupBy parameter to control aggregation level.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        userId: z.string().optional().describe('Filter by user ID (optional)'),
        worktreeId: z.string().optional().describe('Filter by worktree ID (optional)'),
        repoId: z.string().optional().describe('Filter by repository ID (optional)'),
        startDate: z
          .string()
          .optional()
          .describe('Filter by start date (ISO 8601 format, optional)'),
        endDate: z.string().optional().describe('Filter by end date (ISO 8601 format, optional)'),
        groupBy: z
          .enum([
            'user',
            'worktree',
            'repo',
            'user,worktree',
            'user,repo',
            'worktree,repo',
            'user,worktree,repo',
          ])
          .optional()
          .describe(
            'Group by dimension(s). Examples: "user" for per-user totals, "worktree" for per-worktree, "user,worktree" for user+worktree breakdown (default: user,worktree,repo)'
          ),
        sortBy: z
          .enum(['tokens', 'cost'])
          .optional()
          .describe('Sort by tokens or cost (default: cost)'),
        sortOrder: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Sort order ascending or descending (default: desc)'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
        offset: z
          .number()
          .optional()
          .describe('Number of results to skip for pagination (default: 0)'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.userId) query.userId = args.userId;
      if (args.worktreeId) query.worktreeId = args.worktreeId;
      if (args.repoId) query.repoId = args.repoId;
      if (args.startDate) query.startDate = args.startDate;
      if (args.endDate) query.endDate = args.endDate;
      if (args.groupBy) query.groupBy = args.groupBy;
      if (args.sortBy) query.sortBy = args.sortBy;
      if (args.sortOrder) query.sortOrder = args.sortOrder;
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;

      const leaderboard = await ctx.app.service('leaderboard').find({ query });
      return textResult(leaderboard);
    }
  );
}
