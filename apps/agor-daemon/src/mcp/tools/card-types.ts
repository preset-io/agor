import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerCardTypeTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_card_types_create
  server.registerTool(
    'agor_card_types_create',
    {
      description:
        'Create a new card type (global, usable on any board). Card types define default emoji, color, and optional JSON Schema for data validation.',
      inputSchema: z.object({
        name: z.string().describe('Card type name'),
        emoji: z.string().optional().describe('Default emoji for cards of this type'),
        color: z.string().optional().describe('Default color for cards of this type (hex format)'),
        jsonSchema: z
          .object({})
          .passthrough()
          .optional()
          .describe('JSON Schema for data validation (optional)'),
      }),
    },
    async (args) => {
      const cardType = await ctx.app.service('card-types').create(
        {
          name: coerceString(args.name),
          emoji: coerceString(args.emoji),
          color: coerceString(args.color),
          json_schema:
            args.jsonSchema && typeof args.jsonSchema === 'object' ? args.jsonSchema : undefined,
          created_by: ctx.userId,
        },
        ctx.baseServiceParams
      );
      return textResult(cardType);
    }
  );

  // Tool 2: agor_card_types_get
  server.registerTool(
    'agor_card_types_get',
    {
      description: 'Get detailed information about a specific card type.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        cardTypeId: z.string().describe('Card type ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const cardType = await ctx.app
        .service('card-types')
        .get(args.cardTypeId, ctx.baseServiceParams);
      return textResult(cardType);
    }
  );

  // Tool 3: agor_card_types_list
  server.registerTool(
    'agor_card_types_list',
    {
      description: 'List all available card types.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
      }),
    },
    async (args) => {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const result = await ctx.app
        .service('card-types')
        .find({ query: { $limit: limit }, ...ctx.baseServiceParams } as never);
      const data = 'data' in result ? result.data : result;
      return textResult({ total: Array.isArray(data) ? data.length : 0, data });
    }
  );

  // Tool 4: agor_card_types_update
  server.registerTool(
    'agor_card_types_update',
    {
      description: "Update a card type's metadata.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardTypeId: z.string().describe('Card type ID to update'),
        name: z.string().optional().describe('New name'),
        emoji: z.string().nullable().optional().describe('New emoji (null to clear)'),
        color: z.string().nullable().optional().describe('New color (null to clear)'),
        jsonSchema: z
          .object({})
          .passthrough()
          .nullable()
          .optional()
          .describe('New JSON Schema (null to clear)'),
      }),
    },
    async (args) => {
      const updateData: Record<string, unknown> = {};
      if (args.name !== undefined) updateData.name = args.name;
      if (args.emoji !== undefined) updateData.emoji = args.emoji;
      if (args.color !== undefined) updateData.color = args.color;
      if (args.jsonSchema !== undefined) updateData.json_schema = args.jsonSchema;

      const updated = await ctx.app
        .service('card-types')
        .patch(args.cardTypeId, updateData, ctx.baseServiceParams);
      return textResult(updated);
    }
  );

  // Tool 5: agor_card_types_delete
  server.registerTool(
    'agor_card_types_delete',
    {
      description: 'Permanently delete a card type.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        cardTypeId: z.string().describe('Card type ID to delete'),
      }),
    },
    async (args) => {
      await ctx.app.service('card-types').remove(args.cardTypeId, ctx.baseServiceParams);
      return textResult({ success: true, cardTypeId: args.cardTypeId });
    }
  );
}
