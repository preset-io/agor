/** Durable Teams conversation addresses. Secrets and routing coordinates stay
 * encrypted at rest. There is no TTL: a verified activity refreshes the row,
 * and removal events or revoking send errors mark it unusable until the next
 * verified activity re-arms it. */

import type {
  GatewayChannel,
  GatewayChannelID,
  TeamsAddressRevocationReason,
  TeamsConversationAddress,
  TeamsConversationAddressID,
  TenantID,
} from '@agor/core/types';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { isAllowedTeamsServiceUrl } from '../../gateway/teams-service-url';
import { generateId } from '../../lib/ids';
import { TEAMS_ADDRESS_REVOCATION_REASONS } from '../../types/gateway';
import type { Database } from '../client';
import {
  getDatabaseNow,
  insert,
  isSQLiteDatabase,
  runDatabaseTransaction,
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
  /** Team thread id (`channelData.team.id`) for team-wide removal events. */
  teamId?: string | null;
  /** `channelData.team.aadGroupId` when the activity carried it. */
  teamAadGroupId?: string | null;
  /** `channelData.channel.type` when the activity carried it. */
  teamsChannelType?: string | null;
  address: Record<string, unknown>;
  verifiedAppId: string;
  verifiedTenantId: string;
  providerConfigGeneration: number;
}

/** The stored address points at a host outside the Bot Connector allowlist. */
export class TeamsServiceUrlNotAllowedError extends RepositoryError {
  constructor() {
    super('Teams conversation address service URL is not an allowed Bot Connector host');
    this.name = 'TeamsServiceUrlNotAllowedError';
  }
}

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
    team_id: row.team_id ?? null,
    team_aad_group_id: row.team_aad_group_id ?? null,
    teams_channel_type: row.teams_channel_type ?? null,
    encrypted_address: row.encrypted_address,
    verified_app_id: row.verified_app_id,
    verified_tenant_id: row.verified_tenant_id,
    provider_config_generation: row.provider_config_generation,
    refreshed_at: iso(row.refreshed_at),
    revoked_at: row.revoked_at ? iso(row.revoked_at) : null,
    revoked_reason: row.revoked_reason ?? null,
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

/** Why a stored address cannot be used for a send right now. */
export type TeamsAddressFenceCode =
  | 'conversation_address_missing'
  | 'conversation_address_stale'
  | 'conversation_address_revoked'
  | 'conversation_address_suspended'
  | 'conversation_address_invalid'
  | 'conversation_service_url_not_allowed'
  | 'conversation_not_standard_channel';

export type FencedTeamsAddress =
  | { ok: true; row: TeamsConversationAddress; address: Record<string, unknown> }
  | { ok: false; code: TeamsAddressFenceCode };

function requireTenant(db: Database): TenantID | undefined {
  if (isSQLiteDatabase(db)) return undefined;
  const tenantId = getCurrentTenantId();
  if (!tenantId)
    throw new RepositoryError('Teams conversation address requires explicit tenant identity');
  return tenantId as TenantID;
}

// Newest rows checked per lookup; older siblings of a live conversation add nothing.
const LOOKUP_LIMIT = 20;
const NON_STANDARD_CHANNEL_TYPES = ['private', 'shared'] as const;

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
    if (!isAllowedTeamsServiceUrl(input.address.serviceUrl)) {
      throw new TeamsServiceUrlNotAllowedError();
    }
    const tenantId = requireTenant(tx);
    const now = await getDatabaseNow(
      tx,
      gatewayChannels,
      eq(gatewayChannels.id, input.gatewayChannelId)
    );
    if (!now) throw new RepositoryError('Unable to obtain database time for Teams address');
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
          team_id: input.teamId ?? existing.team_id ?? null,
          team_aad_group_id: input.teamAadGroupId ?? existing.team_aad_group_id ?? null,
          teams_channel_type:
            input.teamsChannelType?.toLowerCase() ?? existing.teams_channel_type ?? null,
          encrypted_address: encryptedAddress,
          verified_app_id: input.verifiedAppId,
          verified_tenant_id: input.verifiedTenantId,
          provider_config_generation: input.providerConfigGeneration,
          refreshed_at: now,
          revoked_at: null,
          revoked_reason: null,
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
      team_id: input.teamId ?? null,
      team_aad_group_id: input.teamAadGroupId ?? null,
      teams_channel_type: input.teamsChannelType?.toLowerCase() ?? null,
      encrypted_address: encryptedAddress,
      verified_app_id: input.verifiedAppId,
      verified_tenant_id: input.verifiedTenantId,
      provider_config_generation: input.providerConfigGeneration,
      refreshed_at: now,
      revoked_at: null,
      revoked_reason: null,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    };
    return rowToAddress(
      await insert(tx, teamsConversationAddresses).values(insertData).returning().one()
    );
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

  /** Refresh (or re-arm) an address from a verified activity in its own transaction. */
  async refresh(input: TeamsConversationAddressInput): Promise<TeamsConversationAddress> {
    return runDatabaseTransaction(this.db, (tx) => this.upsertInTransaction(tx, input));
  }

  /** Mark every address of these base conversations unusable (removal, deletion). */
  async revokeConversations(
    channelId: string,
    conversationIds: string[],
    reason: TeamsAddressRevocationReason = 'bot_removed'
  ): Promise<number> {
    const ids = [...new Set(conversationIds.filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return 0;
    return this.revokeWhere(
      and(
        eq(teamsConversationAddresses.gateway_channel_id, channelId),
        inArray(teamsConversationAddresses.conversation_id, ids)
      ) as SQL,
      reason
    );
  }

  /** Mark every channel address of a team unusable (bot removed from the team, team deleted). */
  async revokeTeam(
    channelId: string,
    teamId: string,
    reason: TeamsAddressRevocationReason = 'bot_removed'
  ): Promise<number> {
    if (!teamId) return 0;
    return this.revokeWhere(
      and(
        eq(teamsConversationAddresses.gateway_channel_id, channelId),
        eq(teamsConversationAddresses.team_id, teamId)
      ) as SQL,
      reason
    );
  }

  /** Apply a classified lifecycle event (`teamsAddressRevocationFromActivity`). */
  async revokeForEvent(
    channelId: string,
    event: {
      conversationIds: string[];
      teamId: string | null;
      reason: TeamsAddressRevocationReason;
    }
  ): Promise<number> {
    const byConversation = await this.revokeConversations(
      channelId,
      event.conversationIds,
      event.reason
    );
    const byTeam = event.teamId ? await this.revokeTeam(channelId, event.teamId, event.reason) : 0;
    return byConversation + byTeam;
  }

  /** Mark one thread's address unusable after a revoking send error. */
  async revokeThread(
    channelId: string,
    threadId: string,
    reason: TeamsAddressRevocationReason
  ): Promise<number> {
    return this.revokeWhere(
      and(
        eq(teamsConversationAddresses.gateway_channel_id, channelId),
        eq(teamsConversationAddresses.thread_id, threadId)
      ) as SQL,
      reason
    );
  }

  private async revokeWhere(where: SQL, reason: TeamsAddressRevocationReason): Promise<number> {
    if (!TEAMS_ADDRESS_REVOCATION_REASONS.includes(reason)) {
      throw new RepositoryError('Unknown Teams address revocation reason');
    }
    const result = await update(this.db, teamsConversationAddresses)
      .set({ revoked_at: new Date(), revoked_reason: reason })
      // A redelivered or overlapping event keeps the first revocation and counts nothing.
      .where(
        and(
          where,
          or(
            isNull(teamsConversationAddresses.revoked_at),
            ne(teamsConversationAddresses.revoked_reason, reason)
          )
        ) as SQL
      )
      .run();
    return result.rowsAffected;
  }

  /**
   * Load the address a send may use. Identity fencing happens before decryption,
   * so a stale row never discloses or exercises its address. An address is bound
   * to the verified app and tenant, not the config generation: an allowlist edit
   * must not strand replies to existing conversations.
   * `expected` pins the installation a delivery was enqueued under.
   */
  async loadFenced(input: {
    channel: GatewayChannel;
    threadId: string;
    expected?: { provider_installation_id: string };
  }): Promise<FencedTeamsAddress> {
    const row = await this.findByChannelAndThread(input.channel.id, input.threadId);
    if (!row) return { ok: false, code: 'conversation_address_missing' };
    if (row.thread_id !== input.threadId) return { ok: false, code: 'conversation_address_stale' };
    return this.fenceRow(input.channel, row, input.expected);
  }

  /** The newest usable address in one base conversation; any private or shared marking refuses it. */
  async loadFencedByConversation(input: {
    channel: GatewayChannel;
    conversationId: string;
  }): Promise<FencedTeamsAddress> {
    if ((await this.nonStandardConversationIds(input.channel.id, input.conversationId)).size > 0) {
      return { ok: false, code: 'conversation_not_standard_channel' };
    }
    const rows = await select(this.db)
      .from(teamsConversationAddresses)
      .where(
        and(
          eq(teamsConversationAddresses.gateway_channel_id, input.channel.id),
          eq(teamsConversationAddresses.conversation_id, input.conversationId)
        )
      )
      .orderBy(desc(teamsConversationAddresses.refreshed_at))
      .limit(LOOKUP_LIMIT)
      .all();
    return this.firstFenced(input.channel, rows.map(rowToAddress));
  }

  /** Conversations any thread of which Teams marked private or shared; one marked thread speaks for its channel. */
  async nonStandardConversationIds(
    gatewayChannelId: string,
    conversationId?: string
  ): Promise<Set<string>> {
    const rows = (await select(this.db, {
      conversation_id: teamsConversationAddresses.conversation_id,
    })
      .from(teamsConversationAddresses)
      .where(
        and(
          eq(teamsConversationAddresses.gateway_channel_id, gatewayChannelId),
          inArray(teamsConversationAddresses.teams_channel_type, [...NON_STANDARD_CHANNEL_TYPES]),
          conversationId
            ? eq(teamsConversationAddresses.conversation_id, conversationId)
            : undefined
        )
      )
      .all()) as Array<{ conversation_id: string }>;
    return new Set(rows.map((row) => row.conversation_id));
  }

  /** The newest usable standard-channel address in each of the most recently active teams. */
  async loadFencedTeamAnchors(input: {
    channel: GatewayChannel;
    limit: number;
    /** Only these teams, when the channel restricts them. */
    allowedTeamIds?: string[];
  }): Promise<Array<Extract<FencedTeamsAddress, { ok: true }>>> {
    const live = and(
      eq(teamsConversationAddresses.gateway_channel_id, input.channel.id),
      isNotNull(teamsConversationAddresses.team_id),
      isNull(teamsConversationAddresses.revoked_at),
      input.allowedTeamIds?.length
        ? inArray(teamsConversationAddresses.team_id, input.allowedTeamIds)
        : undefined
    );
    const latest = sql`max(${teamsConversationAddresses.refreshed_at})`;
    const teams = (await select(this.db, { team_id: teamsConversationAddresses.team_id })
      .from(teamsConversationAddresses)
      .where(live)
      .groupBy(teamsConversationAddresses.team_id)
      .orderBy(desc(latest))
      .limit(input.limit)
      .all()) as Array<{ team_id: string }>;
    const excluded = await this.nonStandardConversationIds(input.channel.id);
    const anchors: Array<Extract<FencedTeamsAddress, { ok: true }>> = [];
    for (const { team_id: teamId } of teams) {
      const rows = await select(this.db)
        .from(teamsConversationAddresses)
        .where(and(live, eq(teamsConversationAddresses.team_id, teamId)))
        .orderBy(desc(teamsConversationAddresses.refreshed_at))
        .limit(LOOKUP_LIMIT)
        .all();
      const standard = rows
        .map(rowToAddress)
        .filter((row: TeamsConversationAddress) => !excluded.has(row.conversation_id));
      const fenced = this.firstFenced(input.channel, standard);
      if (fenced.ok) anchors.push(fenced);
    }
    return anchors;
  }

  private firstFenced(
    channel: GatewayChannel,
    rows: TeamsConversationAddress[]
  ): FencedTeamsAddress {
    let first: FencedTeamsAddress = { ok: false, code: 'conversation_address_missing' };
    for (const [index, row] of rows.entries()) {
      const fenced = this.fenceRow(channel, row);
      if (fenced.ok) return fenced;
      if (index === 0) first = fenced;
    }
    return first;
  }

  // One identity fence for every lookup: channel, verified app and tenant, revocation, then host.
  private fenceRow(
    channel: GatewayChannel,
    row: TeamsConversationAddress,
    expected?: { provider_installation_id: string }
  ): FencedTeamsAddress {
    const config = channel.config as Record<string, unknown>;
    if (
      row.gateway_channel_id !== channel.id ||
      row.verified_app_id !== channel.provider_installation_id ||
      row.verified_app_id !== config.app_id ||
      row.verified_tenant_id !== config.microsoft_tenant_id ||
      (expected && row.verified_app_id !== expected.provider_installation_id)
    ) {
      return { ok: false, code: 'conversation_address_stale' };
    }
    if (row.revoked_at) {
      return {
        ok: false,
        code:
          row.revoked_reason === 'bot_disabled'
            ? 'conversation_address_suspended'
            : 'conversation_address_revoked',
      };
    }
    let address: Record<string, unknown>;
    try {
      address = decryptTeamsConversationAddress(row);
    } catch {
      return { ok: false, code: 'conversation_address_invalid' };
    }
    if (!isAllowedTeamsServiceUrl(address.serviceUrl)) {
      return { ok: false, code: 'conversation_service_url_not_allowed' };
    }
    return { ok: true, row, address };
  }
}
