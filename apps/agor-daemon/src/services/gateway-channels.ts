/**
 * Gateway Channels Service
 *
 * Provides REST + WebSocket API for gateway channel management.
 * Uses DrizzleService adapter with GatewayChannelRepository.
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, GatewayChannelRepository } from '@agor/core/db';
import type { GatewayChannel } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export class GatewayChannelsService extends DrizzleService<
  GatewayChannel,
  Partial<GatewayChannel>
> {
  constructor(db: Database) {
    const repo = new GatewayChannelRepository(db);
    super(repo, {
      id: 'id',
      resourceType: 'GatewayChannel',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
  }
}

/**
 * Service factory function
 */
export function createGatewayChannelsService(db: Database): GatewayChannelsService {
  return new GatewayChannelsService(db);
}
