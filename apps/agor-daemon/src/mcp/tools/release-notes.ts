/**
 * Release notes MCP tools: how agents learn what Agor shipped recently,
 * instead of carrying changing feature text in the static system prompt.
 */

import {
  RELEASE_NOTES_LIMITS,
  RELEASE_NOTES_SERVICE,
  type ReleaseNotesFeed,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { releaseNoteItemsForAgents } from '../../services/release-notes.js';
import { mcpLimit } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerReleaseNotesTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_release_notes_list',
    {
      description:
        "List recent user-facing Agor features and fixes the current user can see, newest first. Each item has an agent_brief (what it does, when to suggest it, how to use it), a docs_url, and seen_by_user (whether the user has opened What's new since it shipped). Use it when a recent feature may fit what the user is doing; mention it briefly rather than listing features unprompted.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        since: z
          .union([z.iso.datetime({ offset: true }), z.iso.date()])
          .optional()
          .describe('Only items published on or after this ISO 8601 date or time'),
        limit: mcpLimit(RELEASE_NOTES_LIMITS.agentListDefault, RELEASE_NOTES_LIMITS.agentListMax),
      }),
    },
    async (args) => {
      const feed = (await ctx.app
        .service(RELEASE_NOTES_SERVICE)
        .find(ctx.baseServiceParams)) as ReleaseNotesFeed;
      return textResult({
        items: releaseNoteItemsForAgents(feed, {
          since: args.since ? new Date(args.since) : undefined,
          limit: args.limit,
        }),
      });
    }
  );
}
