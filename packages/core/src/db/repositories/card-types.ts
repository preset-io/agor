/**
 * CardType Repository
 *
 * Type-safe CRUD operations for card types with short ID support.
 */

import type { CardType, UUID } from '@agor/core/types';
import { eq, like } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type CardTypeInsert, type CardTypeRow, cardTypes } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

export class CardTypeRepository implements BaseRepository<CardType, Partial<CardType>> {
  constructor(private db: Database) {}

  private rowToCardType(row: CardTypeRow): CardType {
    return {
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

  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) return id;

    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;
    const results = await select(this.db)
      .from(cardTypes)
      .where(like(cardTypes.card_type_id, pattern))
      .all();

    if (results.length === 0) throw new EntityNotFoundError('CardType', id);
    if (results.length > 1) {
      throw new AmbiguousIdError(
        'CardType',
        id,
        results.map((r: { card_type_id: string }) => formatShortId(r.card_type_id as UUID))
      );
    }
    return results[0].card_type_id;
  }

  async create(data: Partial<CardType>): Promise<CardType> {
    try {
      const now = new Date();
      const cardTypeId = data.card_type_id ?? generateId();

      const insertData: CardTypeInsert = {
        card_type_id: cardTypeId,
        name: data.name ?? 'Untitled Type',
        emoji: data.emoji ?? null,
        color: data.color ?? null,
        json_schema: data.json_schema ? JSON.stringify(data.json_schema) : null,
        created_by: data.created_by ?? null,
        created_at: now,
        updated_at: now,
      };

      await insert(this.db, cardTypes).values(insertData).run();

      const row = await select(this.db)
        .from(cardTypes)
        .where(eq(cardTypes.card_type_id, cardTypeId))
        .one();

      if (!row) throw new RepositoryError('Failed to retrieve created card type');
      return this.rowToCardType(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create card type: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<CardType | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(cardTypes)
        .where(eq(cardTypes.card_type_id, fullId))
        .one();
      return row ? this.rowToCardType(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find card type: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findAll(): Promise<CardType[]> {
    try {
      const rows = await select(this.db).from(cardTypes).all();
      return rows.map((row: CardTypeRow) => this.rowToCardType(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all card types: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async update(id: string, updates: Partial<CardType>): Promise<CardType> {
    try {
      const fullId = await this.resolveId(id);

      const setData: Record<string, unknown> = {
        updated_at: new Date(),
      };

      if (updates.name !== undefined) setData.name = updates.name;
      if (updates.emoji !== undefined) setData.emoji = updates.emoji;
      if (updates.color !== undefined) setData.color = updates.color;
      if (updates.json_schema !== undefined) {
        setData.json_schema = updates.json_schema ? JSON.stringify(updates.json_schema) : null;
      }

      await update(this.db, cardTypes).set(setData).where(eq(cardTypes.card_type_id, fullId)).run();

      const row = await select(this.db)
        .from(cardTypes)
        .where(eq(cardTypes.card_type_id, fullId))
        .one();

      if (!row) throw new EntityNotFoundError('CardType', id);
      return this.rowToCardType(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update card type: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);
      const result = await deleteFrom(this.db, cardTypes)
        .where(eq(cardTypes.card_type_id, fullId))
        .run();

      if (result.rowsAffected === 0) throw new EntityNotFoundError('CardType', id);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete card type: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
