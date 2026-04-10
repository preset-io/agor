import { BoardObjectRepository } from '@agor/core/db';
import type { Card, ZoneBoardObject } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CardsService } from '../../services/cards.js';
import { resolveBoardId, resolveCardId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerCardTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_cards_create
  server.registerTool(
    'agor_cards_create',
    {
      description:
        'Create a new card on a board. Creates both the card entity and its board placement in one operation. If zoneId is provided, the card is placed directly in that zone with automatic positioning.',
      inputSchema: z.object({
        boardId: z.string().describe('Board ID where the card will be created'),
        title: z.string().describe('Card title'),
        cardTypeId: z.string().optional().describe('Card type ID (optional)'),
        zoneId: z.string().optional().describe('Zone ID to place the card in (optional)'),
        url: z.string().optional().describe('URL associated with the card (optional)'),
        description: z.string().optional().describe('Card description (optional)'),
        note: z.string().optional().describe('Card note (optional)'),
        data: z.object({}).passthrough().optional().describe('Custom data object (optional)'),
        colorOverride: z.string().optional().describe('Color override (optional)'),
        emojiOverride: z.string().optional().describe('Emoji override (optional)'),
      }),
    },
    async (args) => {
      const boardId = await resolveBoardId(ctx, coerceString(args.boardId)!);
      const title = coerceString(args.title)!;
      const board = await ctx.app.service('boards').get(boardId, ctx.baseServiceParams);
      let zoneData: ZoneBoardObject | undefined;
      const zoneId = coerceString(args.zoneId);
      if (zoneId) {
        const zone = board.objects?.[zoneId];
        if (!zone || zone.type !== 'zone')
          throw new Error(`Zone ${zoneId} not found on board ${boardId}`);
        zoneData = zone;
      }

      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const { card, boardObject } = await cardsService.createWithPlacement(
        {
          board_id: board.board_id,
          title,
          card_type_id: coerceString(args.cardTypeId) as never,
          url: coerceString(args.url),
          description: coerceString(args.description),
          note: coerceString(args.note),
          data:
            args.data && typeof args.data === 'object'
              ? (args.data as Record<string, unknown>)
              : undefined,
          color_override: coerceString(args.colorOverride),
          emoji_override: coerceString(args.emojiOverride),
          zoneId,
          zoneData,
        } as never,
        { user: { user_id: ctx.userId } } as never
      );

      ctx.app.service('cards').emit('created', card);
      ctx.app.service('board-objects').emit('created', boardObject);
      return textResult({ card, boardObject });
    }
  );

  // Tool 2: agor_cards_get
  server.registerTool(
    'agor_cards_get',
    {
      description: 'Get detailed information about a specific card, including its card type.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        cardId: z.string().describe('Card ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const cardWithType = await cardsService.getWithType(args.cardId);
      if (!cardWithType) throw new Error(`Card ${args.cardId} not found`);
      return textResult(cardWithType);
    }
  );

  // Tool 3: agor_cards_list
  server.registerTool(
    'agor_cards_list',
    {
      description:
        'List cards with optional filtering by board, card type, zone, search query, or archive status.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: z.string().optional().describe('Filter by board ID'),
        cardTypeId: z.string().optional().describe('Filter by card type ID'),
        zoneId: z.string().optional().describe('Filter by zone ID (requires boardId)'),
        search: z.string().optional().describe('Search query for card titles/descriptions'),
        archived: z.boolean().optional().describe('Filter by archive status'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
        offset: z.number().optional().describe('Number of results to skip (default: 0)'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const boardIdRaw = coerceString(args.boardId);
      const boardId = boardIdRaw ? await resolveBoardId(ctx, boardIdRaw) : undefined;
      const cardTypeId = coerceString(args.cardTypeId);
      const zoneId = coerceString(args.zoneId);
      const search = coerceString(args.search);
      const archived = args.archived === true;
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const offset = typeof args.offset === 'number' ? args.offset : 0;

      let cardsList: Card[];
      if (zoneId && boardId) {
        cardsList = await cardsService.findByZoneId(boardId as never, zoneId);
      } else if (search) {
        cardsList = await cardsService.searchCards(search, {
          boardId: boardId as never,
          archived,
          limit,
          offset,
        });
      } else if (cardTypeId) {
        cardsList = await cardsService.findByCardTypeId(cardTypeId as never, { limit, offset });
      } else if (boardId) {
        cardsList = await cardsService.findByBoardId(boardId as never, {
          archived,
          limit,
          offset,
        });
      } else {
        const result = await cardsService.find({
          query: { $limit: limit, $skip: offset },
        } as never);
        cardsList = 'data' in result ? result.data : result;
      }

      return textResult({
        total: Array.isArray(cardsList) ? cardsList.length : 0,
        data: cardsList,
      });
    }
  );

  // Tool 4: agor_cards_update
  server.registerTool(
    'agor_cards_update',
    {
      description: "Update a card's metadata.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardId: z.string().describe('Card ID to update'),
        title: z.string().optional().describe('New title'),
        url: z.string().nullable().optional().describe('New URL (null to clear)'),
        description: z.string().nullable().optional().describe('New description (null to clear)'),
        note: z.string().nullable().optional().describe('New note (null to clear)'),
        data: z
          .object({})
          .passthrough()
          .nullable()
          .optional()
          .describe('New data object (null to clear)'),
        colorOverride: z
          .string()
          .nullable()
          .optional()
          .describe('New color override (null to clear)'),
        emojiOverride: z
          .string()
          .nullable()
          .optional()
          .describe('New emoji override (null to clear)'),
      }),
    },
    async (args) => {
      const updateData: Record<string, unknown> = {};
      if (args.title !== undefined) updateData.title = args.title;
      if (args.url !== undefined) updateData.url = args.url;
      if (args.description !== undefined) updateData.description = args.description;
      if (args.note !== undefined) updateData.note = args.note;
      if (args.data !== undefined) updateData.data = args.data;
      if (args.colorOverride !== undefined) updateData.color_override = args.colorOverride;
      if (args.emojiOverride !== undefined) updateData.emoji_override = args.emojiOverride;
      const updatedCard = await ctx.app
        .service('cards')
        .patch(args.cardId, updateData, ctx.baseServiceParams);
      return textResult(updatedCard);
    }
  );

  // Tool 5: agor_cards_delete
  server.registerTool(
    'agor_cards_delete',
    {
      description: 'Permanently delete a card and its board placement.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        cardId: z.string().describe('Card ID to delete'),
      }),
    },
    async (args) => {
      await ctx.app.service('cards').remove(args.cardId, ctx.baseServiceParams);
      return textResult({ success: true, cardId: args.cardId });
    }
  );

  // Tool 6: agor_cards_archive
  server.registerTool(
    'agor_cards_archive',
    {
      description: 'Archive a card (soft delete).',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        cardId: z.string().describe('Card ID to archive'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const archivedCard = await cardsService.archive(args.cardId);
      ctx.app.service('cards').emit('patched', archivedCard);
      return textResult(archivedCard);
    }
  );

  // Tool 7: agor_cards_unarchive
  server.registerTool(
    'agor_cards_unarchive',
    {
      description: 'Restore a previously archived card.',
      inputSchema: z.object({
        cardId: z.string().describe('Card ID to unarchive'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const unarchivedCard = await cardsService.unarchive(args.cardId);
      ctx.app.service('cards').emit('patched', unarchivedCard);
      return textResult(unarchivedCard);
    }
  );

  // Tool 8: agor_cards_move
  server.registerTool(
    'agor_cards_move',
    {
      description:
        'Move a card to a different zone (or unpin from zone). Updates board_objects placement.',
      inputSchema: z.object({
        cardId: z.string().describe('Card ID to move'),
        zoneId: z
          .string()
          .nullable()
          .optional()
          .describe('Target zone ID (null to unpin from zone)'),
      }),
    },
    async (args) => {
      const cardId = await resolveCardId(ctx, args.cardId);
      const zoneId = args.zoneId === null ? null : (coerceString(args.zoneId) ?? null);
      const card = await ctx.app.service('cards').get(cardId, ctx.baseServiceParams);
      let zoneData: ZoneBoardObject | undefined;
      if (zoneId) {
        const board = await ctx.app.service('boards').get(card.board_id, ctx.baseServiceParams);
        const zone = board.objects?.[zoneId];
        if (!zone || zone.type !== 'zone')
          throw new Error(`Zone ${zoneId} not found on board ${card.board_id}`);
        zoneData = zone;
      }
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const boardObject = await cardsService.moveToZone(cardId as never, zoneId, zoneData);
      ctx.app.service('board-objects').emit('patched', boardObject);
      return textResult(boardObject);
    }
  );

  // Tool 9: agor_cards_set_position
  server.registerTool(
    'agor_cards_set_position',
    {
      description: 'Set the exact position of a card on its board.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardId: z.string().describe('Card ID to reposition'),
        x: z.number().describe('X coordinate'),
        y: z.number().describe('Y coordinate'),
      }),
    },
    async (args) => {
      const cardId = await resolveCardId(ctx, args.cardId);
      const boardObjectRepo = new BoardObjectRepository(ctx.db);
      const boardObj = await boardObjectRepo.findByCardId(cardId as never);
      if (!boardObj) throw new Error(`Card ${cardId} has no board placement`);
      const boardObjectsService = ctx.app.service(
        'board-objects'
      ) as unknown as import('../../services/board-objects.js').BoardObjectsService;
      const updatedBoardObject = await boardObjectsService.updatePosition(boardObj.object_id, {
        x: args.x,
        y: args.y,
      });
      return textResult(updatedBoardObject);
    }
  );

  // Tool 10: agor_cards_bulk_create
  server.registerTool(
    'agor_cards_bulk_create',
    {
      description:
        'Create multiple cards on a board in one operation. Each card gets its own board placement.',
      inputSchema: z.object({
        boardId: z.string().describe('Board ID where cards will be created'),
        cards: z
          .array(
            z.object({
              title: z.string().describe('Card title'),
              cardTypeId: z.string().optional().describe('Card type ID'),
              zoneId: z.string().optional().describe('Zone ID to place the card in'),
              url: z.string().optional().describe('URL'),
              description: z.string().optional().describe('Description'),
              note: z.string().optional().describe('Note'),
              data: z.object({}).passthrough().optional().describe('Custom data'),
              colorOverride: z.string().optional().describe('Color override'),
              emojiOverride: z.string().optional().describe('Emoji override'),
            })
          )
          .describe('Array of cards to create'),
      }),
    },
    async (args) => {
      const boardId = await resolveBoardId(ctx, coerceString(args.boardId)!);
      const cardsArr = args.cards;
      if (!Array.isArray(cardsArr) || cardsArr.length === 0)
        throw new Error('non-empty cards array is required');

      const board = await ctx.app.service('boards').get(boardId, ctx.baseServiceParams);
      const cardsService = ctx.app.service('cards') as unknown as CardsService;

      const results = [];
      for (const c of cardsArr) {
        let zoneData: ZoneBoardObject | undefined;
        const zoneId = coerceString(c.zoneId);
        if (zoneId) {
          const zone = board.objects?.[zoneId];
          if (zone?.type === 'zone') zoneData = zone;
        }

        const { card, boardObject } = await cardsService.createWithPlacement(
          {
            board_id: board.board_id,
            title: c.title,
            card_type_id: coerceString(c.cardTypeId) as never,
            url: coerceString(c.url),
            description: coerceString(c.description),
            note: coerceString(c.note),
            data: c.data && typeof c.data === 'object' ? c.data : undefined,
            color_override: coerceString(c.colorOverride),
            emoji_override: coerceString(c.emojiOverride),
            zoneId,
            zoneData,
          },
          { user: { user_id: ctx.userId } } as never
        );
        results.push(card);
        ctx.app.service('cards').emit('created', card);
        ctx.app.service('board-objects').emit('created', boardObject);
      }

      return textResult({ created: results.length, cards: results });
    }
  );

  // Tool 11: agor_cards_bulk_update
  server.registerTool(
    'agor_cards_bulk_update',
    {
      description: 'Update multiple cards in one operation.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              cardId: z.string().describe('Card ID to update'),
              title: z.string().optional().describe('New title'),
              url: z.string().nullable().optional().describe('New URL'),
              description: z.string().nullable().optional().describe('New description'),
              note: z.string().nullable().optional().describe('New note'),
              data: z.object({}).passthrough().nullable().optional().describe('New data'),
              colorOverride: z.string().nullable().optional().describe('New color override'),
              emojiOverride: z.string().nullable().optional().describe('New emoji override'),
            })
          )
          .describe('Array of card updates'),
      }),
    },
    async (args) => {
      const updates = args.updates;
      if (!Array.isArray(updates) || updates.length === 0)
        throw new Error('non-empty updates array is required');

      const results = [];
      for (const u of updates) {
        const cardId = coerceString(u.cardId);
        if (!cardId) continue;
        const updateData: Record<string, unknown> = {};
        if (u.title !== undefined) updateData.title = u.title;
        if (u.url !== undefined) updateData.url = u.url;
        if (u.description !== undefined) updateData.description = u.description;
        if (u.note !== undefined) updateData.note = u.note;
        if (u.data !== undefined) updateData.data = u.data;
        if (u.colorOverride !== undefined) updateData.color_override = u.colorOverride;
        if (u.emojiOverride !== undefined) updateData.emoji_override = u.emojiOverride;
        const updated = await ctx.app
          .service('cards')
          .patch(cardId, updateData, ctx.baseServiceParams);
        results.push(updated);
      }

      return textResult({ updated: results.length, cards: results });
    }
  );

  // Tool 12: agor_cards_bulk_move
  server.registerTool(
    'agor_cards_bulk_move',
    {
      description: 'Move multiple cards to different zones in one operation.',
      inputSchema: z.object({
        moves: z
          .array(
            z.object({
              cardId: z.string().describe('Card ID to move'),
              zoneId: z.string().nullable().optional().describe('Target zone ID (null to unpin)'),
            })
          )
          .describe('Array of card moves'),
      }),
    },
    async (args) => {
      const moves = args.moves;
      if (!Array.isArray(moves) || moves.length === 0)
        throw new Error('non-empty moves array is required');

      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const results = [];

      for (const m of moves) {
        const cardIdRaw = coerceString(m.cardId);
        if (!cardIdRaw) continue;
        const cardId = await resolveCardId(ctx, cardIdRaw);
        const zoneId = m.zoneId === null ? null : (coerceString(m.zoneId) ?? null);
        let zoneData: ZoneBoardObject | undefined;
        if (zoneId) {
          const card = await ctx.app.service('cards').get(cardId, ctx.baseServiceParams);
          const board = await ctx.app.service('boards').get(card.board_id, ctx.baseServiceParams);
          const zone = board.objects?.[zoneId];
          if (zone?.type === 'zone') zoneData = zone;
        }
        const boardObject = await cardsService.moveToZone(cardId as never, zoneId, zoneData);
        ctx.app.service('board-objects').emit('patched', boardObject);
        results.push({ cardId, boardObject });
      }

      return textResult({ moved: results.length, results });
    }
  );
}
