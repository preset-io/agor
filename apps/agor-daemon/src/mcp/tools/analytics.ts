import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveBranchId, resolveRepoId, resolveUserId } from '../resolve-ids.js';
import { mcpLimit, mcpOffset, mcpOptionalString } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

const optionalStringOrStringArray = (fieldName: string, description: string) =>
  z
    .union([
      z.string().min(1, `${fieldName} cannot be empty when provided.`),
      z.array(z.string().min(1, `${fieldName} values cannot be empty.`)).min(1),
    ])
    .optional()
    .describe(description);

type StringOrStringArray = string | string[] | undefined;

async function resolveOneOrMany(
  value: StringOrStringArray,
  resolver: (value: string) => Promise<string>
): Promise<StringOrStringArray> {
  if (!value) return undefined;
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolver(item)));
  return resolver(value);
}

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
        userId: optionalStringOrStringArray(
          'userId',
          'Filter by one or more user IDs (UUIDv7 or short IDs). Accepts a string or array.'
        ),
        branchId: optionalStringOrStringArray(
          'branchId',
          'Filter by one or more branch IDs (UUIDv7 or short IDs). Accepts a string or array.'
        ),
        repoId: optionalStringOrStringArray(
          'repoId',
          'Filter by one or more repository IDs (UUIDv7 or short IDs). Accepts a string or array.'
        ),
        model: optionalStringOrStringArray(
          'model',
          'Filter by one or more model names. Accepts a string or array.'
        ),
        tool: optionalStringOrStringArray(
          'tool',
          'Filter by one or more agentic tools. Accepts a string or array.'
        ),
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
      const userId = await resolveOneOrMany(args.userId, (value) => resolveUserId(ctx, value));
      if (userId) query.userId = userId;
      const branchId = await resolveOneOrMany(args.branchId, (value) =>
        resolveBranchId(ctx, value)
      );
      if (branchId) query.branchId = branchId;
      const repoId = await resolveOneOrMany(args.repoId, (value) => resolveRepoId(ctx, value));
      if (repoId) query.repoId = repoId;
      if (args.model) query.model = args.model;
      if (args.tool) query.tool = args.tool;
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
