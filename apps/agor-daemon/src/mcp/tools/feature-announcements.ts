/**
 * Feature announcements MCP tools: how agents learn what Agor shipped recently,
 * instead of carrying changing feature text in the static system prompt.
 */

import {
  FEATURE_ANNOUNCEMENTS_LIMITS,
  FEATURE_ANNOUNCEMENTS_SERVICE,
  type FeatureAnnouncementsFeed,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { featureAnnouncementItemsForAgents } from '../../services/feature-announcements.js';
import { mcpLimit } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerFeatureAnnouncementsTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_feature_announcements_list',
    {
      description:
        "List recent user-facing Agor features and fixes the current user can see, newest first. Each item has an agent_brief (what it does, when to suggest it, how to use it), a docs_url, and seen_by_user (whether the user has opened What's new since it shipped). Use it when a recent feature may fit what the user is doing; mention it briefly rather than listing features unprompted.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        since: z
          .union([z.iso.datetime({ offset: true }), z.iso.date()])
          .optional()
          .describe('Only items published on or after this ISO 8601 date or time'),
        limit: mcpLimit(
          FEATURE_ANNOUNCEMENTS_LIMITS.agentListDefault,
          FEATURE_ANNOUNCEMENTS_LIMITS.agentListMax
        ),
      }),
    },
    async (args) => {
      const feed = (await ctx.app
        .service(FEATURE_ANNOUNCEMENTS_SERVICE)
        .find(ctx.baseServiceParams)) as FeatureAnnouncementsFeed;
      return textResult({
        items: featureAnnouncementItemsForAgents(feed, {
          since: args.since ? new Date(args.since) : undefined,
          limit: args.limit,
        }),
      });
    }
  );
}
