/**
 * Gateway Channel Repository
 *
 * Type-safe CRUD operations for gateway channels with short ID support.
 * Handles encryption/decryption of sensitive platform credentials in the config blob.
 */

import type {
  ChannelType,
  GatewayAgenticConfig,
  GatewayChannel,
  GatewayChannelID,
  UUID,
} from '@agor/core/types';
import { eq, like } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type GatewayChannelInsert, type GatewayChannelRow, gatewayChannels } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/** Sensitive config fields that should be encrypted at rest */
const SENSITIVE_CONFIG_FIELDS = ['bot_token', 'app_token', 'signing_secret'];

/** Sentinel value used by the API to redact sensitive fields in responses */
const REDACTED_SENTINEL = '••••••••';

/**
 * Encrypt sensitive fields within a config object
 */
function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const encrypted = { ...config };
  for (const field of SENSITIVE_CONFIG_FIELDS) {
    if (typeof encrypted[field] === 'string' && encrypted[field]) {
      encrypted[field] = encryptApiKey(encrypted[field] as string);
    }
  }
  return encrypted;
}

/**
 * Decrypt sensitive fields within a config object
 */
function decryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const decrypted = { ...config };
  for (const field of SENSITIVE_CONFIG_FIELDS) {
    if (typeof decrypted[field] === 'string' && decrypted[field]) {
      try {
        decrypted[field] = decryptApiKey(decrypted[field] as string);
      } catch (error) {
        // If decryption fails (e.g., key changed), leave as-is
        console.error(
          `[gateway-channels] Failed to decrypt ${field}:`,
          error instanceof Error ? error.message : String(error)
        );
        console.error(
          '[gateway-channels] Channel credentials may be corrupted or master secret changed'
        );
      }
    }
  }
  return decrypted;
}

/**
 * Gateway channel repository implementation
 */
export class GatewayChannelRepository
  implements BaseRepository<GatewayChannel, Partial<GatewayChannel>>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to GatewayChannel type
   */
  private rowToChannel(row: GatewayChannelRow): GatewayChannel {
    const config = row.config as Record<string, unknown>;

    return {
      id: row.id as GatewayChannelID,
      created_by: row.created_by,
      name: row.name,
      channel_type: row.channel_type as ChannelType,
      target_worktree_id: row.target_worktree_id as UUID,
      agor_user_id: row.agor_user_id as UUID,
      channel_key: row.channel_key,
      config: decryptConfig(config),
      agentic_config: (row.agentic_config as unknown as GatewayAgenticConfig) ?? null,
      enabled: Boolean(row.enabled),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      last_message_at: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    };
  }

  /**
   * Convert GatewayChannel to database insert format
   */
  private channelToInsert(data: Partial<GatewayChannel>): GatewayChannelInsert {
    const now = Date.now();
    const id = data.id ?? generateId();

    return {
      id,
      created_at: new Date(data.created_at ?? now),
      updated_at: new Date(data.updated_at ?? now),
      created_by: data.created_by ?? 'anonymous',
      name: data.name ?? 'Untitled Channel',
      channel_type: data.channel_type ?? 'slack',
      target_worktree_id: data.target_worktree_id ?? '',
      agor_user_id: data.agor_user_id ?? '',
      channel_key: data.channel_key ?? generateId(),
      enabled: data.enabled ?? true,
      last_message_at: data.last_message_at ? new Date(data.last_message_at) : null,
      config: data.config ? encryptConfig(data.config) : {},
      agentic_config: (data.agentic_config as unknown as Record<string, unknown>) ?? null,
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db)
      .from(gatewayChannels)
      .where(like(gatewayChannels.id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('GatewayChannel', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'GatewayChannel',
        id,
        results.map((r: { id: string }) => formatShortId(r.id as UUID))
      );
    }

    return results[0].id;
  }

  /**
   * Create a new gateway channel
   */
  async create(data: Partial<GatewayChannel>): Promise<GatewayChannel> {
    try {
      const insertData = this.channelToInsert({
        ...data,
        id: data.id ?? generateId(),
        channel_key: data.channel_key ?? generateId(),
      });

      await insert(this.db, gatewayChannels).values(insertData).run();

      const row = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, insertData.id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created gateway channel');
      }

      return this.rowToChannel(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find gateway channel by ID (supports short ID)
   */
  async findById(id: string): Promise<GatewayChannel | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, fullId))
        .one();

      return row ? this.rowToChannel(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all gateway channels
   */
  async findAll(): Promise<GatewayChannel[]> {
    try {
      const rows = await select(this.db).from(gatewayChannels).all();
      return rows.map((row: GatewayChannelRow) => this.rowToChannel(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all gateway channels: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update gateway channel by ID
   */
  async update(id: string, updates: Partial<GatewayChannel>): Promise<GatewayChannel> {
    try {
      const fullId = await this.resolveId(id);

      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('GatewayChannel', id);
      }

      // Merge updates, but preserve existing encrypted credentials if update has empty values
      const merged = { ...current, ...updates };

      // Preserve existing credentials if updates contain empty, falsy, or redacted values.
      // The API redacts sensitive fields to '••••••••' in responses, so if the client
      // sends that sentinel back it means "no change" — not "set token to bullets".
      if (updates.config) {
        const mergedConfig = { ...current.config, ...updates.config };
        for (const field of SENSITIVE_CONFIG_FIELDS) {
          const updateValue = updates.config[field];
          if ((!updateValue || updateValue === REDACTED_SENTINEL) && current.config[field]) {
            mergedConfig[field] = current.config[field];
          }
        }
        merged.config = mergedConfig;
      }

      const insertData = this.channelToInsert(merged);

      await update(this.db, gatewayChannels)
        .set({
          name: insertData.name,
          channel_type: insertData.channel_type,
          target_worktree_id: insertData.target_worktree_id,
          agor_user_id: insertData.agor_user_id,
          enabled: insertData.enabled,
          config: insertData.config,
          agentic_config: insertData.agentic_config,
          updated_at: new Date(),
        })
        .where(eq(gatewayChannels.id, fullId))
        .run();

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated gateway channel');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete gateway channel by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, gatewayChannels)
        .where(eq(gatewayChannels.id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('GatewayChannel', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find gateway channel by channel_key (auth lookup for inbound webhooks)
   */
  async findByKey(channelKey: string): Promise<GatewayChannel | null> {
    try {
      const row = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.channel_key, channelKey))
        .one();

      return row ? this.rowToChannel(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find gateway channel by key: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all gateway channels for a user
   */
  async findByUser(userId: string): Promise<GatewayChannel[]> {
    try {
      const rows = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.agor_user_id, userId))
        .all();

      return rows.map((row: GatewayChannelRow) => this.rowToChannel(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find gateway channels by user: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Touch last_message_at timestamp
   */
  async updateLastMessage(id: GatewayChannelID): Promise<void> {
    try {
      await update(this.db, gatewayChannels)
        .set({
          last_message_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(gatewayChannels.id, id))
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to update last message timestamp: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
