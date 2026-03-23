/**
 * Cards Service
 *
 * Provides REST + WebSocket API for card management.
 * Cards are visual work items on boards, managed by agents via MCP tools.
 *
 * Key behavior: Card creation also creates a board_objects record for placement.
 */

import { PAGINATION } from '@agor/core/config';
import { BoardObjectRepository, CardRepository, type Database } from '@agor/core/db';
import type {
  BoardEntityObject,
  BoardID,
  Card,
  CardID,
  CardTypeID,
  CardWithType,
  QueryParams,
  ZoneBoardObject,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type CardParams = QueryParams<{
  board_id?: BoardID;
  card_type_id?: CardTypeID;
  archived?: boolean;
  search?: string;
}>;

export class CardsService extends DrizzleService<Card, Partial<Card>, CardParams> {
  private cardRepo: CardRepository;
  private boardObjectRepo: BoardObjectRepository;

  constructor(db: Database) {
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
      const zone = data.zoneData;
      // Jitter positioning (same as worktrees_set_zone)
      const CARD_WIDTH = 400;
      const CARD_HEIGHT = 150;
      const DESIRED_PADDING = 60;

      const maxPaddingX = Math.max(0, (zone.width - CARD_WIDTH) / 2);
      const maxPaddingY = Math.max(0, (zone.height - CARD_HEIGHT) / 2);
      const paddingX = Math.min(DESIRED_PADDING, maxPaddingX);
      const paddingY = Math.min(DESIRED_PADDING, maxPaddingY);

      const jitterRangeX = Math.max(0, zone.width - CARD_WIDTH - 2 * paddingX);
      const jitterRangeY = Math.max(0, zone.height - CARD_HEIGHT - 2 * paddingY);

      position = {
        x: paddingX + Math.random() * jitterRangeX,
        y: paddingY + Math.random() * jitterRangeY,
      };
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
  async getWithType(id: string): Promise<CardWithType | null> {
    return this.cardRepo.findByIdWithType(id);
  }

  /**
   * Find cards by board ID
   */
  async findByBoardId(
    boardId: BoardID,
    options?: { archived?: boolean; limit?: number; offset?: number }
  ): Promise<Card[]> {
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
  async archive(id: string): Promise<Card> {
    return this.cardRepo.archive(id);
  }

  /**
   * Unarchive a card
   */
  async unarchive(id: string): Promise<Card> {
    return this.cardRepo.unarchive(id);
  }

  /**
   * Move a card to a zone (update board_objects placement)
   */
  async moveToZone(
    cardId: CardID,
    zoneId: string | null,
    zoneData?: ZoneBoardObject
  ): Promise<BoardEntityObject> {
    const boardObj = await this.boardObjectRepo.findByCardId(cardId);
    if (!boardObj) {
      throw new Error(`Card ${cardId} has no board placement`);
    }

    // If moving to a zone with zone data, calculate position
    if (zoneId && zoneData) {
      const CARD_WIDTH = 400;
      const CARD_HEIGHT = 150;
      const DESIRED_PADDING = 60;

      const maxPaddingX = Math.max(0, (zoneData.width - CARD_WIDTH) / 2);
      const maxPaddingY = Math.max(0, (zoneData.height - CARD_HEIGHT) / 2);
      const paddingX = Math.min(DESIRED_PADDING, maxPaddingX);
      const paddingY = Math.min(DESIRED_PADDING, maxPaddingY);

      const jitterRangeX = Math.max(0, zoneData.width - CARD_WIDTH - 2 * paddingX);
      const jitterRangeY = Math.max(0, zoneData.height - CARD_HEIGHT - 2 * paddingY);

      const position = {
        x: paddingX + Math.random() * jitterRangeX,
        y: paddingY + Math.random() * jitterRangeY,
      };

      await this.boardObjectRepo.updatePosition(boardObj.object_id, position);
    }

    return this.boardObjectRepo.updateZone(
      boardObj.object_id,
      zoneId === null ? undefined : zoneId
    );
  }
}

export function createCardsService(db: Database): CardsService {
  return new CardsService(db);
}
