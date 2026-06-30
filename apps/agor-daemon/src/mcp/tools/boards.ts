import type {
  Board,
  BoardEntityType,
  BoardObject,
  BoardObjectType,
  BranchID,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BoardsServiceImpl } from '../../declarations.js';
import {
  mcpLimit,
  mcpOptionalNonNegativeInt,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

const BOARD_OBJECT_TYPES = [
  'zone',
  'text',
  'markdown',
  'app',
  'artifact',
] as const satisfies readonly BoardObjectType[];
const BOARD_ENTITY_TYPES = ['branch', 'card'] as const satisfies readonly BoardEntityType[];

function filterBoardCanvasObjects(board: Board, objectTypes?: BoardObjectType[]): Board {
  if (!objectTypes) return board;

  const allowedTypes = new Set<BoardObjectType>(objectTypes);
  const objects = Object.fromEntries(
    Object.entries(board.objects ?? {}).filter(([, object]) =>
      allowedTypes.has((object as BoardObject).type)
    )
  );

  return { ...board, objects };
}

export function registerBoardTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_boards_get
  server.registerTool(
    'agor_boards_get',
    {
      description:
        'Get information about a board, including zones, canvas objects, and optionally positioned entities (branches, cards). ' +
        'The response includes a `url` field with a clickable link to view the board in the UI. ' +
        'By default, returns board metadata and canvas objects only (no positioned branch/card entities). ' +
        'Use objectTypes=["zone"] for a lean board definition with just zones. ' +
        'Set includeEntities=true to include positioned branch/card entities, optionally filtered by entityZoneId/entityType and paginated with entitiesLimit/entitiesSkip.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        objectTypes: z
          .array(z.enum(BOARD_OBJECT_TYPES))
          .optional()
          .describe(
            'Filter board.objects canvas annotations by type. Use ["zone"] to retrieve zone definitions without heavier text/markdown/app/artifact objects. Omit for backward-compatible behavior returning all board.objects.'
          ),
        includeEntities: z
          .boolean()
          .optional()
          .describe(
            'Include positioned entities (branches, cards) with their x/y coordinates and zone assignments (default: false). Enable when you need to know where branches are placed on the canvas.'
          ),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'When includeEntities=true, include archived branch entities. Default false excludes archived branches while preserving card entities.'
          ),
        entityZoneId: mcpOptionalString(
          'entityZoneId',
          'When includeEntities=true, only return positioned entities pinned to this board zone ID.'
        ),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe(
            'When includeEntities=true, only return positioned entities of this type ("branch" or "card").'
          ),
        entitiesLimit: mcpOptionalPositiveInt(
          'entitiesLimit',
          'When includeEntities=true, maximum number of positioned entities to return. Omit to preserve legacy behavior returning all matched entities.'
        )
          .refine(
            (value) => value === undefined || value <= 10000,
            'entitiesLimit must be less than or equal to 10000.'
          )
          .describe(
            'When includeEntities=true, maximum number of positioned entities to return. Omit to preserve legacy behavior returning all matched entities.'
          ),
        entitiesSkip: mcpOptionalNonNegativeInt(
          'entitiesSkip',
          'When includeEntities=true, number of matched positioned entities to skip for pagination (default: 0).'
        )
          .refine(
            (value) => value === undefined || value <= 10000,
            'entitiesSkip must be less than or equal to 10000.'
          )
          .describe(
            'When includeEntities=true, number of matched positioned entities to skip for pagination (default: 0).'
          ),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const board = filterBoardCanvasObjects(
        await ctx.app.service('boards').get(boardId, ctx.baseServiceParams),
        args.objectTypes as BoardObjectType[] | undefined
      );

      const includeEntities = args.includeEntities === true; // default false, opt-in
      if (includeEntities) {
        const entityQuery: Record<string, unknown> = { board_id: board.board_id };
        const entityZoneId = coerceString(args.entityZoneId);
        if (entityZoneId) entityQuery.zone_id = entityZoneId;
        if (args.entityType) entityQuery.entity_type = args.entityType as BoardEntityType;

        const boardObjectsResult = await ctx.app
          .service('board-objects')
          .find({ query: entityQuery, ...ctx.baseServiceParams });
        const matchedEntities = (
          boardObjectsResult as { data: import('@agor/core/types').BoardEntityObject[] }
        ).data;
        let visibleEntities = matchedEntities;

        if (args.includeArchived !== true) {
          const branchIds = matchedEntities
            .map((entity) => entity.branch_id)
            .filter((branchId): branchId is BranchID => typeof branchId === 'string');

          if (branchIds.length > 0) {
            const activeBranchesResult = await ctx.app.service('branches').find({
              query: {
                branch_id: { $in: Array.from(new Set(branchIds)) },
                archived: false,
              },
              paginate: false,
              ...ctx.baseServiceParams,
            });
            const activeBranches = Array.isArray(activeBranchesResult)
              ? activeBranchesResult
              : (activeBranchesResult as { data: Array<{ branch_id: string }> }).data;
            const activeBranchIds = new Set(activeBranches.map((branch) => branch.branch_id));

            visibleEntities = matchedEntities.filter(
              (entity) => !entity.branch_id || activeBranchIds.has(entity.branch_id)
            );
          }
        }

        const total = visibleEntities.length;
        const skip = args.entitiesSkip ?? 0;
        const limit = args.entitiesLimit ?? null;
        const entities =
          args.entitiesLimit !== undefined || args.entitiesSkip !== undefined
            ? visibleEntities.slice(
                skip,
                args.entitiesLimit === undefined ? undefined : skip + args.entitiesLimit
              )
            : visibleEntities;

        return textResult({
          ...board,
          entities,
          entities_pagination: { total, limit, skip },
        });
      }

      return textResult(board);
    }
  );

  // Tool 2: agor_boards_list
  server.registerTool(
    'agor_boards_list',
    {
      description:
        'List all boards accessible to the current user. Each board includes a `url` field with a clickable link to view the board in the UI. By default, archived boards are excluded.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: mcpLimit(50),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived boards in results (default: false). By default, archived boards are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived boards. When true, returns only archived boards. Overrides includeArchived.'
          ),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.limit) query.$limit = args.limit;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const boards = await ctx.app.service('boards').find({ query, ...ctx.baseServiceParams });
      return textResult(boards);
    }
  );

  // Tool 3: agor_boards_update
  server.registerTool(
    'agor_boards_update',
    {
      description:
        'Update board metadata and manage zones/objects. Can update name, icon, background, and create/update zones for organizing branches. Unicode emoji is preferred for icons; common exact shortcodes like ":compass:" are accepted and normalized. Zone objects have: type="zone", x, y, width, height, label, borderColor, backgroundColor, borderStyle (optional), trigger (optional: "always_new" auto-creates sessions, "show_picker" shows agent selection). Text objects have: type="text", x, y, text, fontSize, color. Markdown objects have: type="markdown", x, y, width, height, content.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        name: mcpOptionalString('name', 'Board name (optional)'),
        description: mcpOptionalString('description', 'Board description (optional)'),
        icon: mcpOptionalString(
          'icon',
          'Board icon/emoji (optional). Unicode emoji is preferred; common exact shortcodes like ":compass:" are accepted and normalized.'
        ),
        color: mcpOptionalString('color', 'Board color (hex format, optional)'),
        backgroundColor: mcpOptionalString(
          'backgroundColor',
          'Board background color (hex format, optional)'
        ),
        customCss: mcpOptionalString(
          'customCss',
          'Custom CSS for board canvas animations (@keyframes, animation, background-size, etc.). Rendered in a scoped <style> tag. Dangerous patterns like url(), expression(), @import are blocked.'
        ),
        slug: mcpOptionalString('slug', 'URL-friendly slug (optional)'),
        customContext: z
          .object({})
          .passthrough()
          .optional()
          .describe('Custom context for templates (optional)'),
        upsertObjects: z
          .object({})
          .passthrough()
          .optional()
          .describe(
            'Board objects to upsert (zones, text, markdown). Keys are object IDs, values are object data.'
          ),
        removeObjects: z
          .array(mcpRequiredString('removeObjects[]', 'Board object ID to remove'))
          .optional()
          .describe('Array of object IDs to remove from the board'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;

      const metadataUpdates: Record<string, unknown> = {};
      if (args.name !== undefined) metadataUpdates.name = args.name;
      if (args.description !== undefined) metadataUpdates.description = args.description;
      if (args.icon !== undefined) metadataUpdates.icon = args.icon;
      if (args.color !== undefined) metadataUpdates.color = args.color;
      if (args.backgroundColor !== undefined)
        metadataUpdates.background_color = args.backgroundColor;
      if (args.customCss !== undefined) metadataUpdates.custom_css = args.customCss;
      if (args.slug !== undefined) metadataUpdates.slug = args.slug;
      if (args.customContext !== undefined) metadataUpdates.custom_context = args.customContext;

      if (Object.keys(metadataUpdates).length > 0) {
        await ctx.app.service('boards').patch(boardId, metadataUpdates, ctx.baseServiceParams);
      }

      if (
        args.upsertObjects &&
        typeof args.upsertObjects === 'object' &&
        !Array.isArray(args.upsertObjects)
      ) {
        const updatedBoard = await boardsService.batchUpsertBoardObjects(
          boardId,
          args.upsertObjects as unknown as unknown[],
          ctx.baseServiceParams
        );
        ctx.app.service('boards').emit('patched', updatedBoard);
      }

      if (args.removeObjects && Array.isArray(args.removeObjects)) {
        let finalBoard: Board | undefined;
        for (const objectId of args.removeObjects) {
          finalBoard = await boardsService.removeBoardObject(
            boardId,
            objectId,
            ctx.baseServiceParams
          );
        }
        if (finalBoard) ctx.app.service('boards').emit('patched', finalBoard);
      }

      const board = await ctx.app.service('boards').get(boardId, ctx.baseServiceParams);
      return textResult({ board, note: 'Board updated successfully.' });
    }
  );

  // Tool 4: agor_boards_create
  server.registerTool(
    'agor_boards_create',
    {
      description: 'Create a new board. Returns the created board object with its ID and URL.',
      inputSchema: z.object({
        name: mcpRequiredString('name', 'Board name (required)'),
        slug: mcpOptionalString(
          'slug',
          'URL-friendly slug (optional, auto-derived from name if not provided)'
        ),
        description: mcpOptionalString('description', 'Board description (optional)'),
        icon: mcpOptionalString(
          'icon',
          'Board icon/emoji (optional, e.g. "📋"). Unicode emoji is preferred; common exact shortcodes like ":compass:" are accepted and normalized.'
        ),
        color: mcpOptionalString('color', 'Board color in hex format (optional)'),
        backgroundColor: mcpOptionalString(
          'backgroundColor',
          'Board background color in hex format (optional)'
        ),
        customCss: mcpOptionalString(
          'customCss',
          'Custom CSS for board canvas animations (@keyframes, animation, etc.). Optional.'
        ),
      }),
    },
    async (args) => {
      const boardName = coerceString(args.name);
      if (!boardName) throw new Error('name is required');

      const boardData: Record<string, unknown> = {
        name: boardName,
        created_by: ctx.userId,
      };
      if (args.slug !== undefined) boardData.slug = coerceString(args.slug);
      if (args.description !== undefined) boardData.description = coerceString(args.description);
      if (args.icon !== undefined) boardData.icon = coerceString(args.icon);
      if (args.color !== undefined) boardData.color = coerceString(args.color);
      if (args.backgroundColor !== undefined)
        boardData.background_color = coerceString(args.backgroundColor);
      if (args.customCss !== undefined) boardData.custom_css = coerceString(args.customCss);

      const board = await ctx.app.service('boards').create(boardData, ctx.baseServiceParams);
      return textResult(board);
    }
  );

  // Tool 5: agor_boards_archive
  server.registerTool(
    'agor_boards_archive',
    {
      description:
        'Archive a board (soft delete). Archived boards are hidden from listings by default. Use agor_boards_unarchive to restore.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID to archive (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
      const result = await boardsService.archive(boardId, ctx.baseServiceParams);
      return textResult({
        success: true,
        board: result,
        message: 'Board archived successfully.',
      });
    }
  );

  // Tool 6: agor_boards_unarchive
  server.registerTool(
    'agor_boards_unarchive',
    {
      description: 'Restore a previously archived board. The board will appear in listings again.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID to unarchive (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
      const result = await boardsService.unarchive(boardId, ctx.baseServiceParams);
      return textResult({
        success: true,
        board: result,
        message: 'Board unarchived successfully.',
      });
    }
  );
}
