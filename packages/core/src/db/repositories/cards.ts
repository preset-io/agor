/**
 * Card Repository
 *
 * Type-safe CRUD operations for cards with short ID support.
 * Cards live on boards alongside worktrees and can be placed in zones.
 */

import type { BoardID, Card, CardType, CardTypeID, CardWithType, UUID } from '@agor/core/types';
import { prefixToLikePattern } from '@agor/core/types';
import { and, eq, like } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { boardObjects, type CardInsert, type CardRow, cards, cardTypes } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

const ALLOWED_URL_PROTOCOLS = ['http:', 'https:', 'mailto:'];

function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return url;
}

export class CardRepository implements BaseRepository<Card, Partial<Card>> {
  constructor(private db: Database) {}

  private rowToCard(row: CardRow): Card {
    return {
      card_id: row.card_id as UUID,
      board_id: row.board_id as UUID,
      card_type_id: (row.card_type_id as UUID) ?? undefined,
      title: row.title,
      url: row.url ?? undefined,
      description: row.description ?? undefined,
      note: row.note ?? undefined,
      data: row.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : undefined,
      color_override: row.color_override ?? undefined,
      emoji_override: row.emoji_override ?? undefined,
      created_by: row.created_by ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      archived: Boolean(row.archived),
      archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
    };
  }

  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) return id;

    const pattern = prefixToLikePattern(id);
    const results = await select(this.db).from(cards).where(like(cards.card_id, pattern)).all();

    if (results.length === 0) throw new EntityNotFoundError('Card', id);
    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Card',
        id,
        results.map((r: { card_id: string }) => r.card_id)
      );
    }
    return results[0].card_id;
  }

  async create(data: Partial<Card>): Promise<Card> {
    try {
      const now = new Date();
      const cardId = data.card_id ?? generateId();

      const insertData: CardInsert = {
        card_id: cardId,
        board_id: data.board_id ?? '',
        card_type_id: data.card_type_id ?? null,
        title: data.title ?? 'Untitled Card',
        url: sanitizeUrl(data.url),
        description: data.description ?? null,
        note: data.note ?? null,
        data: data.data ? JSON.stringify(data.data) : null,
        color_override: data.color_override ?? null,
        emoji_override: data.emoji_override ?? null,
        created_by: data.created_by ?? null,
        created_at: now,
        updated_at: now,
        archived: false,
        archived_at: null,
      };

      await insert(this.db, cards).values(insertData).run();

      const row = await select(this.db).from(cards).where(eq(cards.card_id, cardId)).one();

      if (!row) throw new RepositoryError('Failed to retrieve created card');
      return this.rowToCard(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create card: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<Card | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(cards).where(eq(cards.card_id, fullId)).one();
      return row ? this.rowToCard(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find card: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find card by ID with resolved CardType info
   */
  async findByIdWithType(id: string): Promise<CardWithType | null> {
    const card = await this.findById(id);
    if (!card) return null;
    return this.resolveCardType(card);
  }

  /**
   * Resolve CardType info for a card
   */
  private async resolveCardType(card: Card): Promise<CardWithType> {
    let cardType: CardType | undefined;
    if (card.card_type_id) {
      const row = await select(this.db)
        .from(cardTypes)
        .where(eq(cardTypes.card_type_id, card.card_type_id))
        .one();
      if (row) {
        cardType = {
          card_type_id: row.card_type_id as UUID,
          name: row.name,
          emoji: row.emoji ?? undefined,
          color: row.color ?? undefined,
          json_schema: row.json_schema ? JSON.parse(row.json_schema) : undefined,
          created_by: row.created_by ?? undefined,
          created_at: new Date(row.created_at).toISOString(),
          updated_at: new Date(row.updated_at).toISOString(),
        };
      }
    }

    return {
      ...card,
      card_type: cardType,
      effective_emoji: card.emoji_override ?? cardType?.emoji,
      effective_color: card.color_override ?? cardType?.color,
    };
  }

  async findAll(): Promise<Card[]> {
    try {
      const rows = await select(this.db).from(cards).all();
      return rows.map((row: CardRow) => this.rowToCard(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all cards: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find cards by board ID
   */
  async findByBoardId(
    boardId: BoardID,
    options?: { archived?: boolean; limit?: number; offset?: number }
  ): Promise<Card[]> {
    try {
      const conditions = [eq(cards.board_id, boardId)];
      if (options?.archived !== undefined) {
        conditions.push(eq(cards.archived, options.archived));
      }

      let query = select(this.db)
        .from(cards)
        .where(and(...conditions));

      if (options?.limit) {
        query = query.limit(options.limit);
      }
      if (options?.offset) {
        query = query.offset(options.offset);
      }

      const rows = await query.all();
      return rows.map((row: CardRow) => this.rowToCard(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find cards by board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find cards by card type ID
   */
  async findByCardTypeId(
    cardTypeId: CardTypeID,
    options?: { limit?: number; offset?: number }
  ): Promise<Card[]> {
    try {
      let query = select(this.db).from(cards).where(eq(cards.card_type_id, cardTypeId));

      if (options?.limit) query = query.limit(options.limit);
      if (options?.offset) query = query.offset(options.offset);

      const rows = await query.all();
      return rows.map((row: CardRow) => this.rowToCard(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find cards by type: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Search cards by title (LIKE match)
   */
  async search(
    query: string,
    options?: { boardId?: BoardID; archived?: boolean; limit?: number; offset?: number }
  ): Promise<Card[]> {
    try {
      const conditions = [like(cards.title, `%${query}%`)];
      if (options?.boardId) conditions.push(eq(cards.board_id, options.boardId));
      if (options?.archived !== undefined) conditions.push(eq(cards.archived, options.archived));

      let dbQuery = select(this.db)
        .from(cards)
        .where(and(...conditions));
      if (options?.limit) dbQuery = dbQuery.limit(options.limit);
      if (options?.offset) dbQuery = dbQuery.offset(options.offset);

      const rows = await dbQuery.all();
      return rows.map((row: CardRow) => this.rowToCard(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to search cards: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find cards by zone ID (join with board_objects)
   */
  async findByZoneId(boardId: BoardID, zoneId: string): Promise<Card[]> {
    try {
      // Get board objects in this zone that reference cards
      const objectRows = await select(this.db)
        .from(boardObjects)
        .where(eq(boardObjects.board_id, boardId))
        .all();

      const cardIds: string[] = [];
      for (const row of objectRows) {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        if (data.zone_id === zoneId && row.card_id) {
          cardIds.push(row.card_id);
        }
      }

      if (cardIds.length === 0) return [];

      // Fetch all cards by IDs
      const result: Card[] = [];
      for (const cardId of cardIds) {
        const card = await this.findById(cardId);
        if (card) result.push(card);
      }
      return result;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find cards by zone: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async update(id: string, updates: Partial<Card>): Promise<Card> {
    try {
      const fullId = await this.resolveId(id);

      const setData: Record<string, unknown> = {
        updated_at: new Date(),
      };

      if (updates.title !== undefined) setData.title = updates.title;
      if (updates.card_type_id !== undefined) setData.card_type_id = updates.card_type_id ?? null;
      if (updates.url !== undefined) setData.url = sanitizeUrl(updates.url);
      if (updates.description !== undefined) setData.description = updates.description ?? null;
      if (updates.note !== undefined) setData.note = updates.note ?? null;
      if (updates.data !== undefined) {
        setData.data = updates.data ? JSON.stringify(updates.data) : null;
      }
      if (updates.color_override !== undefined)
        setData.color_override = updates.color_override ?? null;
      if (updates.emoji_override !== undefined)
        setData.emoji_override = updates.emoji_override ?? null;
      if (updates.archived !== undefined) setData.archived = updates.archived;
      if (updates.archived_at !== undefined) {
        setData.archived_at = updates.archived_at ? new Date(updates.archived_at) : null;
      }

      await update(this.db, cards).set(setData).where(eq(cards.card_id, fullId)).run();

      const row = await select(this.db).from(cards).where(eq(cards.card_id, fullId)).one();

      if (!row) throw new EntityNotFoundError('Card', id);
      return this.rowToCard(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update card: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Archive a card
   */
  async archive(id: string): Promise<Card> {
    return this.update(id, {
      archived: true,
      archived_at: new Date().toISOString(),
    });
  }

  /**
   * Unarchive a card
   */
  async unarchive(id: string): Promise<Card> {
    return this.update(id, {
      archived: false,
      archived_at: undefined,
    });
  }

  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);
      const result = await deleteFrom(this.db, cards).where(eq(cards.card_id, fullId)).run();

      if (result.rowsAffected === 0) throw new EntityNotFoundError('Card', id);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete card: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
