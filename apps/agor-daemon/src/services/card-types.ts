/**
 * Card Types Service
 *
 * Provides REST + WebSocket API for card type management.
 * CardTypes are global (org-level) definitions for card categories.
 */

import { PAGINATION } from '@agor/core/config';
import { CardTypeRepository, type Database } from '@agor/core/db';
import type { CardType, QueryParams } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type CardTypeParams = QueryParams<{
  name?: string;
}>;

export class CardTypesService extends DrizzleService<CardType, Partial<CardType>, CardTypeParams> {
  constructor(db: Database) {
    super(new CardTypeRepository(db), {
      id: 'card_type_id',
      resourceType: 'CardType',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
  }
}

export function createCardTypesService(db: Database): CardTypesService {
  return new CardTypesService(db);
}
