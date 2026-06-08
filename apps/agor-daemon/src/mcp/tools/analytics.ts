import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveBranchId, resolveRepoId, resolveUserId } from '../resolve-ids.js';
import { mcpLimit, mcpOffset, mcpOptionalId, mcpOptionalString } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerAnalyticsTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_analytics_leaderboard
  //
  // groupBy accepts a comma-separated combination of the supported dimensions:
  //   user | branch | repo | model | tool
  // The service itself owns the list of valid dimensions; we keep the schema
  // loose (a string) so new dimensions flow through without a second edit here.
  server.registerTool(
    'agor_analytics_leaderboard',
    {
      description:
        'Get usage analytics leaderboard showing token, cost, session, and duration breakdown. Supports dynamic grouping by user, branch, repo, model, and/or tool (freely combined), plus optional time bucketing (hour/day/week/month) for time-series reports.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        userId: mcpOptionalId('userId', 'User', 'Filter by user ID (optional)'),
        branchId: mcpOptionalId('branchId', 'Branch', 'Filter by branch ID (optional)'),
        repoId: mcpOptionalId('repoId', 'Repository', 'Filter by repository ID (optional)'),
        startDate: mcpOptionalString(
          'startDate',
          'Filter by start date (ISO 8601 format, optional)'
        ),
        endDate: mcpOptionalString('endDate', 'Filter by end date (ISO 8601 format, optional)'),
        groupBy: mcpOptionalString(
          'groupBy',
          'Comma-separated list of dimensions to group by. Supported: user, branch, repo, model, tool. Examples: "user", "user,model", "tool,branch". Default: "user,branch,repo".'
        ),
        bucket: z
          .enum(['hour', 'day', 'week', 'month'])
          .optional()
          .describe(
            'Optional time bucket. When set, adds a UTC ISO-8601 timestamp field per row, truncated to the given granularity, for time-series reporting.'
          ),
        sortBy: z
          .enum(['tokens', 'cost'])
          .optional()
          .describe('Sort by tokens or cost (default: cost)'),
        sortOrder: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Sort order ascending or descending (default: desc)'),
        limit: mcpLimit(50),
        offset: mcpOffset(0).describe('Number of results to skip for pagination (default: 0)'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.userId) query.userId = await resolveUserId(ctx, args.userId);
      if (args.branchId) query.branchId = await resolveBranchId(ctx, args.branchId);
      if (args.repoId) query.repoId = await resolveRepoId(ctx, args.repoId);
      if (args.startDate) query.startDate = args.startDate;
      if (args.endDate) query.endDate = args.endDate;
      if (args.groupBy) query.groupBy = args.groupBy;
      if (args.bucket) query.bucket = args.bucket;
      if (args.sortBy) query.sortBy = args.sortBy;
      if (args.sortOrder) query.sortOrder = args.sortOrder;
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;

      const leaderboard = await ctx.app
        .service('leaderboard')
        .find({ query, ...ctx.baseServiceParams });
      return textResult(leaderboard);
    }
  );
}
