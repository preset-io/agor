import { BoardObjectRepository } from '@agor/core/db';
import type { Card, ZoneBoardObject } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CardsService } from '../../services/cards.js';
import { emitServiceEvent } from '../../utils/emit-service-event.js';
import { resolveBoardId, resolveCardId } from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOffset,
  mcpOptionalId,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredNumber,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

export function registerCardTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_cards_create
  server.registerTool(
    'agor_cards_create',
    {
      description:
        'Create a new card on a board. Creates both the card entity and its board placement in one operation. If zoneId is provided, the card is placed directly in that zone with automatic positioning.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID where the card will be created'),
        title: mcpRequiredString('title', 'Card title'),
        cardTypeId: mcpOptionalId('cardTypeId', 'Card type', 'Card type ID (optional)'),
        zoneId: mcpOptionalId('zoneId', 'Zone', 'Zone ID to place the card in (optional)'),
        url: mcpOptionalString('url', 'URL associated with the card (optional)'),
        description: mcpOptionalString('description', 'Card description (optional)'),
        note: mcpOptionalString('note', 'Card note (optional)'),
        data: z.object({}).passthrough().optional().describe('Custom data object (optional)'),
        colorOverride: mcpOptionalString('colorOverride', 'Color override (optional)'),
        emojiOverride: mcpOptionalString('emojiOverride', 'Emoji override (optional)'),
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
        if (zone?.type !== 'zone') throw new Error(`Zone ${zoneId} not found on board ${boardId}`);
        zoneData = zone;
      }

      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const { card, boardObject } = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.createWithPlacement(
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
          ctx.baseServiceParams
        )
      );

      emitServiceEvent(ctx.app, {
        path: 'cards',
        event: 'created',
        data: card,
      });
      emitServiceEvent(ctx.app, {
        path: 'board-objects',
        event: 'created',
        data: boardObject,
      });
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
        cardId: mcpRequiredId('cardId', 'Card'),
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
        boardId: mcpOptionalId('boardId', 'Board', 'Filter by board ID'),
        cardTypeId: mcpOptionalId('cardTypeId', 'Card type', 'Filter by card type ID'),
        zoneId: mcpOptionalId('zoneId', 'Zone', 'Filter by zone ID (requires boardId)'),
        search: mcpOptionalString('search', 'Search query for card titles/descriptions'),
        archived: z.boolean().optional().describe('Filter by archive status'),
        limit: mcpLimit(50),
        offset: mcpOffset(0),
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
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to update'),
        title: mcpOptionalString('title', 'New title'),
        url: mcpOptionalString('url', 'New URL (null to clear)').nullable(),
        description: mcpOptionalString('description', 'New description (null to clear)').nullable(),
        note: mcpOptionalString('note', 'New note (null to clear)').nullable(),
        data: z
          .object({})
          .passthrough()
          .nullable()
          .optional()
          .describe('New data object (null to clear)'),
        colorOverride: mcpOptionalString(
          'colorOverride',
          'New color override (null to clear)'
        ).nullable(),
        emojiOverride: mcpOptionalString(
          'emojiOverride',
          'New emoji override (null to clear)'
        ).nullable(),
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
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to delete'),
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
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to archive'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const archivedCard = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.archive(args.cardId)
      );
      emitServiceEvent(ctx.app, {
        path: 'cards',
        event: 'patched',
        data: archivedCard,
        id: args.cardId,
      });
      return textResult(archivedCard);
    }
  );

  // Tool 7: agor_cards_unarchive
  server.registerTool(
    'agor_cards_unarchive',
    {
      description: 'Restore a previously archived card.',
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to unarchive'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const unarchivedCard = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.unarchive(args.cardId)
      );
      emitServiceEvent(ctx.app, {
        path: 'cards',
        event: 'patched',
        data: unarchivedCard,
        id: args.cardId,
      });
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
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to move'),
        zoneId: mcpOptionalId(
          'zoneId',
          'Zone',
          'Target zone ID (null to unpin from zone)'
        ).nullable(),
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
        if (zone?.type !== 'zone')
          throw new Error(`Zone ${zoneId} not found on board ${card.board_id}`);
        zoneData = zone;
      }
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const boardObject = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.moveToZone(cardId as never, zoneId, zoneData)
      );
      emitServiceEvent(ctx.app, {
        path: 'board-objects',
        event: 'patched',
        data: boardObject,
      });
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
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to reposition'),
        x: mcpRequiredNumber('x', 'X coordinate'),
        y: mcpRequiredNumber('y', 'Y coordinate'),
      }),
    },
    async (args) => {
      const cardId = await resolveCardId(ctx, args.cardId);
      const updatedBoardObject = await runWithMcpTenantDatabaseScope(ctx, async (db) => {
        const boardObjectRepo = new BoardObjectRepository(db);
        const boardObj = await boardObjectRepo.findByCardId(cardId as never);
        if (!boardObj) throw new Error(`Card ${cardId} has no board placement`);
        const boardObjectsService = ctx.app.service(
          'board-objects'
        ) as unknown as import('../../services/board-objects.js').BoardObjectsService;
        return boardObjectsService.updatePosition(boardObj.object_id, {
          x: args.x,
          y: args.y,
        });
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
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID where cards will be created'),
        cards: z
          .array(
            z.object({
              title: mcpRequiredString('cards[].title', 'Card title'),
              cardTypeId: mcpOptionalId('cards[].cardTypeId', 'Card type', 'Card type ID'),
              zoneId: mcpOptionalId('cards[].zoneId', 'Zone', 'Zone ID to place the card in'),
              url: mcpOptionalString('cards[].url', 'URL'),
              description: mcpOptionalString('cards[].description', 'Description'),
              note: mcpOptionalString('cards[].note', 'Note'),
              data: z.object({}).passthrough().optional().describe('Custom data'),
              colorOverride: mcpOptionalString('cards[].colorOverride', 'Color override'),
              emojiOverride: mcpOptionalString('cards[].emojiOverride', 'Emoji override'),
            })
          )
          .min(1, 'cards must contain at least one card.')
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

        const { card, boardObject } = await runWithMcpTenantDatabaseScope(ctx, () =>
          cardsService.createWithPlacement(
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
            ctx.baseServiceParams
          )
        );
        results.push(card);
        emitServiceEvent(ctx.app, {
          path: 'cards',
          event: 'created',
          data: card,
        });
        emitServiceEvent(ctx.app, {
          path: 'board-objects',
          event: 'created',
          data: boardObject,
        });
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
              cardId: mcpRequiredId('updates[].cardId', 'Card', 'Card ID to update'),
              title: mcpOptionalString('updates[].title', 'New title'),
              url: mcpOptionalString('updates[].url', 'New URL').nullable(),
              description: mcpOptionalString('updates[].description', 'New description').nullable(),
              note: mcpOptionalString('updates[].note', 'New note').nullable(),
              data: z.object({}).passthrough().nullable().optional().describe('New data'),
              colorOverride: mcpOptionalString(
                'updates[].colorOverride',
                'New color override'
              ).nullable(),
              emojiOverride: mcpOptionalString(
                'updates[].emojiOverride',
                'New emoji override'
              ).nullable(),
            })
          )
          .min(1, 'updates must contain at least one update.')
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
              cardId: mcpRequiredId('moves[].cardId', 'Card', 'Card ID to move'),
              zoneId: mcpOptionalId(
                'moves[].zoneId',
                'Zone',
                'Target zone ID (null to unpin)'
              ).nullable(),
            })
          )
          .min(1, 'moves must contain at least one move.')
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
        const boardObject = await runWithMcpTenantDatabaseScope(ctx, () =>
          cardsService.moveToZone(cardId as never, zoneId, zoneData)
        );
        emitServiceEvent(ctx.app, {
          path: 'board-objects',
          event: 'patched',
          data: boardObject,
        });
        results.push({ cardId, boardObject });
      }

      return textResult({ moved: results.length, results });
    }
  );
}
