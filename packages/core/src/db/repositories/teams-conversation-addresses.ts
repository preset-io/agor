/** Durable Teams conversation addresses. Secrets and routing coordinates stay
 * encrypted at rest; the row is refreshed by every verified inbound activity. */

import type {
  GatewayChannelID,
  TeamsConversationAddress,
  TeamsConversationAddressID,
  TenantID,
} from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  databaseNowExpression,
  getDatabaseNow,
  insert,
  isSQLiteDatabase,
  select,
  update,
} from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import {
  gatewayChannels,
  type TeamsConversationAddressInsert,
  type TeamsConversationAddressRow,
  teamsConversationAddresses,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

export interface TeamsConversationAddressInput {
  gatewayChannelId: GatewayChannelID;
  threadId: string;
  conversationId: string;
  rootMessageId?: string | null;
  address: Record<string, unknown>;
  verifiedAppId: string;
  verifiedTenantId: string;
  providerConfigGeneration: number;
}

/** Verified activities refresh a usable Bot Framework address for this period. */
export const TEAMS_CONVERSATION_ADDRESS_TTL_MS = 24 * 60 * 60 * 1000;

function iso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

function rowToAddress(row: TeamsConversationAddressRow): TeamsConversationAddress {
  return {
    address_id: row.address_id as TeamsConversationAddressID,
    gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
    thread_id: row.thread_id,
    conversation_id: row.conversation_id,
    root_message_id: row.root_message_id ?? null,
    encrypted_address: row.encrypted_address,
    verified_app_id: row.verified_app_id,
    verified_tenant_id: row.verified_tenant_id,
    provider_config_generation: row.provider_config_generation,
    refreshed_at: iso(row.refreshed_at),
    expires_at: row.expires_at ? iso(row.expires_at) : null,
  };
}

export function decryptTeamsConversationAddress(
  row: TeamsConversationAddress
): Record<string, unknown> {
  try {
    const value = JSON.parse(decryptApiKey(row.encrypted_address)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('address is not an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new RepositoryError('Failed to decrypt Teams conversation address', error);
  }
}

function requireTenant(db: Database): TenantID | undefined {
  if (isSQLiteDatabase(db)) return undefined;
  const tenantId = getCurrentTenantId();
  if (!tenantId)
    throw new RepositoryError('Teams conversation address requires explicit tenant identity');
  return tenantId as TenantID;
}

export class TeamsConversationAddressRepository {
  constructor(private readonly db: Database) {}

  async upsertInTransaction(
    tx: Database,
    input: TeamsConversationAddressInput
  ): Promise<TeamsConversationAddress> {
    if (!input.threadId.trim() || !input.conversationId.trim()) {
      throw new RepositoryError('Teams conversation and thread IDs are required');
    }
    if (!input.verifiedAppId.trim() || !input.verifiedTenantId.trim()) {
      throw new RepositoryError('Teams address verification identity is required');
    }
    const tenantId = requireTenant(tx);
    const now = await getDatabaseNow(
      tx,
      gatewayChannels,
      eq(gatewayChannels.id, input.gatewayChannelId)
    );
    if (!now) throw new RepositoryError('Unable to obtain database time for Teams address');
    const expiresAt = new Date(now.getTime() + TEAMS_CONVERSATION_ADDRESS_TTL_MS);
    const encryptedAddress = encryptApiKey(JSON.stringify(input.address));
    const where = and(
      eq(teamsConversationAddresses.gateway_channel_id, input.gatewayChannelId),
      eq(teamsConversationAddresses.thread_id, input.threadId)
    );
    const existing = await select(tx).from(teamsConversationAddresses).where(where).one();
    if (existing) {
      const updated = await update(tx, teamsConversationAddresses)
        .set({
          conversation_id: input.conversationId,
          root_message_id: input.rootMessageId ?? null,
          encrypted_address: encryptedAddress,
          verified_app_id: input.verifiedAppId,
          verified_tenant_id: input.verifiedTenantId,
          provider_config_generation: input.providerConfigGeneration,
          refreshed_at: now,
          expires_at: expiresAt,
        })
        .where(eq(teamsConversationAddresses.address_id, existing.address_id))
        .returning()
        .one();
      return rowToAddress(updated);
    }
    const insertData: TeamsConversationAddressInsert = {
      address_id: generateId(),
      gateway_channel_id: input.gatewayChannelId,
      thread_id: input.threadId,
      conversation_id: input.conversationId,
      root_message_id: input.rootMessageId ?? null,
      encrypted_address: encryptedAddress,
      verified_app_id: input.verifiedAppId,
      verified_tenant_id: input.verifiedTenantId,
      provider_config_generation: input.providerConfigGeneration,
      refreshed_at: now,
      expires_at: expiresAt,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    };
    await insert(tx, teamsConversationAddresses).values(insertData).run();
    const row = await select(tx)
      .from(teamsConversationAddresses)
      .where(eq(teamsConversationAddresses.address_id, insertData.address_id))
      .one();
    if (!row) throw new RepositoryError('Failed to retrieve Teams conversation address');
    return rowToAddress(row);
  }

  async findByChannelAndThread(
    gatewayChannelId: GatewayChannelID,
    threadId: string
  ): Promise<TeamsConversationAddress | null> {
    const row = await select(this.db)
      .from(teamsConversationAddresses)
      .where(
        and(
          eq(teamsConversationAddresses.gateway_channel_id, gatewayChannelId),
          eq(teamsConversationAddresses.thread_id, threadId)
        )
      )
      .one();
    return row ? rowToAddress(row) : null;
  }

  /** Compare expiry with the database clock, not a worker's wall clock. */
  async isExpired(addressId: TeamsConversationAddressID): Promise<boolean> {
    const row = (await select(this.db, {
      expires_at: teamsConversationAddresses.expires_at,
      database_now: databaseNowExpression(this.db),
    })
      .from(teamsConversationAddresses)
      .where(eq(teamsConversationAddresses.address_id, addressId))
      .one()) as { expires_at?: Date | string | number | null; database_now?: unknown } | null;
    if (!row?.expires_at || row.database_now === undefined || row.database_now === null) {
      return false;
    }
    const expiresAt = new Date(row.expires_at).getTime();
    const databaseNow = new Date(row.database_now as string | number).getTime();
    return Number.isFinite(expiresAt) && Number.isFinite(databaseNow) && expiresAt <= databaseNow;
  }

  async addressForChannelAndThread(
    gatewayChannelId: GatewayChannelID,
    threadId: string
  ): Promise<Record<string, unknown> | null> {
    const row = await this.findByChannelAndThread(gatewayChannelId, threadId);
    return row ? decryptTeamsConversationAddress(row) : null;
  }
}
