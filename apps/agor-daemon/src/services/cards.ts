/**
 * Cards Service
 *
 * Provides REST + WebSocket API for card management.
 * Cards are visual work items on boards, managed by agents via MCP tools.
 *
 * Key behavior: Card creation also creates a board_objects record for placement.
 */

import { PAGINATION } from '@agor/core/config';
import {
  BoardObjectRepository,
  CardRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  AuthenticatedParams,
  BoardEntityObject,
  BoardID,
  Card,
  CardID,
  CardTypeID,
  CardWithType,
  QueryParams,
  ZoneBoardObject,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import type { CollaborationAuthorization } from '../utils/collaboration-authorization.js';

export type CardParams = QueryParams<{
  board_id?: BoardID;
  card_type_id?: CardTypeID;
  archived?: boolean;
  search?: string;
}> &
  AuthenticatedParams;

export class CardsService extends DrizzleService<Card, Partial<Card>, CardParams> {
  private cardRepo: CardRepository;
  private boardObjectRepo: BoardObjectRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private authorization?: CollaborationAuthorization
  ) {
    const cardRepo = new CardRepository(db);
    super(cardRepo, {
      id: 'card_id',
      resourceType: 'Card',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.cardRepo = cardRepo;
    this.boardObjectRepo = new BoardObjectRepository(db);
  }

  /**
   * Push the list read's high-selectivity predicates into SQL.
   *
   * The generic adapter would read the entire cards table and filter in memory.
   * The board bootstrap fetches cards both board-scoped and as a global
   * fallback, so narrowing the read to a board (and archived state) before rows
   * leave the database is the win. `find` still re-applies every query filter in
   * memory, so this only ever returns a superset of the matching rows.
   *
   * Cards are not query-validated, so values arrive uncoerced: only push when
   * the value already has the column's type (string `board_id`, boolean
   * `archived`). Anything else falls through to the unchanged in-memory filter,
   * preserving current behavior exactly.
   */
  protected async fetchData(query: Query, params?: CardParams): Promise<Card[]> {
    const filter: { board_id?: BoardID; archived?: boolean } = {};

    if (typeof query.board_id === 'string') filter.board_id = query.board_id as BoardID;
    if (typeof query.archived === 'boolean') filter.archived = query.archived;

    const cards = await this.cardRepo.findAll(filter);
    if (!this.authorization || !params?.provider) return cards;
    const visible = await Promise.all(
      cards.map(async (card) =>
        (await this.authorization!.canViewBoard(params, card.board_id)) ? card : null
      )
    );
    return visible.filter((card): card is Card => card !== null);
  }

  override async get(id: string, params?: CardParams): Promise<Card> {
    const card = await this.cardRepo.findById(id);
    if (!card) throw new Error(`Card ${id} not found`);
    await this.authorization?.requireBoard(params, card.board_id, 'view');
    return card;
  }

  override async patch(id: string, data: Partial<Card>, params?: CardParams): Promise<Card> {
    const immutable = ['card_id', 'board_id', 'created_by', 'created_at', 'updated_at'] as const;
    if (immutable.some((field) => field in data)) {
      throw new Error('Card identity, ownership, and board cannot be changed');
    }
    const card = await this.cardRepo.findById(id);
    if (!card) throw new Error(`Card ${id} not found`);
    await this.authorization?.requireBoard(params, card.board_id, 'mutate');
    const result = await super.patch(id, data, params);
    if (Array.isArray(result)) throw new Error('Unexpected multi-card patch result');
    return result;
  }

  override async remove(id: string, params?: CardParams): Promise<Card> {
    const card = await this.cardRepo.findById(id);
    if (!card) throw new Error(`Card ${id} not found`);
    await this.authorization?.requireBoard(params, card.board_id, 'mutate');
    const result = await super.remove(id, params);
    if (Array.isArray(result)) throw new Error('Unexpected multi-card remove result');
    return result;
  }

  /**
   * Override default REST create to prevent orphan cards without board placement.
   * Use createWithPlacement() instead.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Override base class signature
  override async create(_data: any, _params?: any): Promise<any> {
    throw new Error('Use createWithPlacement() to create cards with board placement');
  }

  /**
   * Create a card AND its board_objects placement in one operation.
   *
   * If zoneId is provided, the card is placed in that zone with jitter positioning.
   * Otherwise, the card gets default position (0, 0).
   */
  async createWithPlacement(
    data: Partial<Card> & {
      zoneId?: string;
      zoneData?: ZoneBoardObject;
    },
    params?: CardParams
  ): Promise<{ card: Card; boardObject: BoardEntityObject }> {
    if (!data.board_id) throw new Error('board_id is required');
    await this.authorization?.requireBoard(params, data.board_id, 'mutate');
    // Create the card
    const card = await this.cardRepo.create({
      ...data,
      created_by:
        (params as Partial<{ user: { user_id: string } }>)?.user?.user_id ?? data.created_by,
    });

    // Calculate position
    let position = { x: 0, y: 0 };
    const zoneId = data.zoneId;

    if (zoneId && data.zoneData) {
      const { computeZoneRelativePosition, CARD_WIDTH, CARD_HEIGHT } = await import(
        '@agor/core/utils/board-placement'
      );
      position = computeZoneRelativePosition(data.zoneData, {
        entityWidth: CARD_WIDTH,
        entityHeight: CARD_HEIGHT,
        desiredPadding: 60,
      });
    }

    // Create board object placement — compensate on failure to avoid orphan cards
    let boardObject: BoardEntityObject;
    try {
      boardObject = await this.boardObjectRepo.create({
        board_id: card.board_id as BoardID,
        card_id: card.card_id as CardID,
        position,
        zone_id: zoneId,
      });
    } catch (error) {
      // Clean up the card to prevent orphan
      await this.cardRepo.delete(card.card_id).catch(() => {});
      throw error;
    }

    return { card, boardObject };
  }

  /**
   * Get card with resolved CardType info
   */
  async getWithType(id: string, params?: CardParams): Promise<CardWithType | null> {
    const card = await this.cardRepo.findById(id);
    if (card) await this.authorization?.requireBoard(params, card.board_id, 'view');
    return this.cardRepo.findByIdWithType(id);
  }

  /**
   * Find cards by board ID
   */
  async findByBoardId(
    boardId: BoardID,
    options?: { archived?: boolean; limit?: number; offset?: number },
    params?: CardParams
  ): Promise<Card[]> {
    await this.authorization?.requireBoard(params, boardId, 'view');
    return this.cardRepo.findByBoardId(boardId, options);
  }

  /**
   * Find cards by card type ID
   */
  async findByCardTypeId(
    cardTypeId: CardTypeID,
    options?: { limit?: number; offset?: number }
  ): Promise<Card[]> {
    return this.cardRepo.findByCardTypeId(cardTypeId, options);
  }

  /**
   * Find cards by zone ID
   */
  async findByZoneId(boardId: BoardID, zoneId: string): Promise<Card[]> {
    return this.cardRepo.findByZoneId(boardId, zoneId);
  }

  /**
   * Search cards by title
   */
  async searchCards(
    query: string,
    options?: { boardId?: BoardID; archived?: boolean; limit?: number; offset?: number }
  ): Promise<Card[]> {
    return this.cardRepo.search(query, options);
  }

  /**
   * Archive a card
   */
  async archive(id: string, params?: CardParams): Promise<Card> {
    const card = await this.get(id, params);
    await this.authorization?.requireBoard(params, card.board_id, 'mutate');
    return this.cardRepo.archive(id);
  }

  /**
   * Unarchive a card
   */
  async unarchive(id: string, params?: CardParams): Promise<Card> {
    const card = await this.get(id, params);
    await this.authorization?.requireBoard(params, card.board_id, 'mutate');
    return this.cardRepo.unarchive(id);
  }

  /**
   * Move a card to a zone (update board_objects placement)
   */
  async moveToZone(
    cardId: CardID,
    zoneId: string | null,
    zoneData?: ZoneBoardObject,
    params?: CardParams
  ): Promise<BoardEntityObject> {
    const card = await this.get(cardId, params);
    await this.authorization?.requireBoard(params, card.board_id, 'mutate');
    const boardObj = await this.boardObjectRepo.findByCardId(cardId);
    if (!boardObj) {
      throw new Error(`Card ${cardId} has no board placement`);
    }

    // If moving to a zone with zone data, calculate position
    if (zoneId && zoneData) {
      const { computeZoneRelativePosition, CARD_WIDTH, CARD_HEIGHT } = await import(
        '@agor/core/utils/board-placement'
      );
      const position = computeZoneRelativePosition(zoneData, {
        entityWidth: CARD_WIDTH,
        entityHeight: CARD_HEIGHT,
        desiredPadding: 60,
      });

      await this.boardObjectRepo.updatePosition(boardObj.object_id, position);
    }

    return this.boardObjectRepo.updateZone(
      boardObj.object_id,
      zoneId === null ? undefined : zoneId
    );
  }
}

export function createCardsService(
  db: TenantScopeAwareDatabase,
  authorization?: CollaborationAuthorization
): CardsService {
  return new CardsService(db, authorization);
}
