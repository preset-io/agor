/**
 * Gateway Channel Repository
 *
 * Type-safe CRUD operations for gateway channels with short ID support.
 * Handles encryption/decryption of sensitive platform credentials in the config blob.
 */

import type {
  ChannelType,
  GatewayChannel,
  GatewayChannelID,
  GatewayEnvVar,
  PersistedGatewayAgenticConfig,
  TenantID,
  UUID,
} from '@agor/core/types';
import { and, asc, eq, gt, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { isAgenticToolDefaultConfigurationReference } from '../../types/agentic-tool-preset';
import {
  DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES,
  GATEWAY_REDACTED_SENTINEL,
  GATEWAY_SENSITIVE_CONFIG_FIELDS,
  getRequiredSecretFields,
  isDiscordSnowflake,
  isGatewayProviderAuthorityPatch,
  isTeamsCredentialOnlyConfigPatch,
  mergeGatewayChannelConfigPatch,
  validateDiscordConfig,
  validateTeamsConfig,
  validateTeamsUserMap,
} from '../../types/gateway';
import { prefixToLikePattern } from '../../types/id';
import type { Database, SystemDatabase } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type GatewayChannelInsert, type GatewayChannelRow, gatewayChannels } from '../schema';
import {
  AmbiguousIdError,
  attachHiddenTenant,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

export interface EnabledGatewayChannelRef {
  channel_id: GatewayChannelID;
  tenant_id: TenantID;
}

export interface GatewayListenerDiscoveryCursor {
  tenant_id: TenantID;
  channel_id: GatewayChannelID;
}

export interface GatewayListenerLease {
  channel_id: GatewayChannelID;
  claim_token: string;
  generation: number;
  claimed_at: string;
  lease_expires_at: string;
  instance_id: string;
  boot_id: string;
  checkpoint: Record<string, unknown> | null;
}

export type GatewayListenerClaimResult =
  | { outcome: 'claimed'; lease: GatewayListenerLease }
  | { outcome: 'held'; lease_expires_at: string | null }
  | { outcome: 'unavailable' };

export interface GatewayListenerClaimInput {
  channelId: GatewayChannelID;
  claimToken: string;
  leaseDurationMs: number;
  instanceId: string;
  bootId: string;
}

/**
 * Capability-specific repository for process-wide listener discovery.
 *
 * This deliberately exposes no full-channel read or credential decryption
 * operations. Callers receive only immutable routing references, leave system
 * scope, and reload each channel through GatewayChannelRepository in its
 * discovered tenant scope.
 */
export class GatewayListenerDiscoveryRepository {
  constructor(private db: SystemDatabase) {}

  async findEnabledTenantRefs(
    options: { limit?: number; after?: GatewayListenerDiscoveryCursor } = {}
  ): Promise<EnabledGatewayChannelRef[]> {
    const tenantColumn = (gatewayChannels as unknown as { tenant_id?: typeof gatewayChannels.id })
      .tenant_id;
    if (!isPostgresDatabase(this.db) || !tenantColumn) {
      throw new RepositoryError('Gateway listener discovery requires PostgreSQL tenant metadata');
    }

    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RepositoryError('Gateway listener discovery limit must be between 1 and 1000');
    }
    const after = options.after;
    const claimable = or(
      isNull(gatewayChannels.listener_claim_token),
      isNull(gatewayChannels.listener_lease_expires_at),
      lte(gatewayChannels.listener_lease_expires_at, sql`CURRENT_TIMESTAMP`)
    );
    // The raw page cursor is tenant/channel ordered so discovery can resume
    // without decrypting provider configuration or crossing tenant scope.
    const refs: EnabledGatewayChannelRef[] = [];
    let rawAfter = after;
    while (refs.length < limit) {
      const afterCondition = rawAfter
        ? or(
            gt(tenantColumn, rawAfter.tenant_id),
            and(eq(tenantColumn, rawAfter.tenant_id), gt(gatewayChannels.id, rawAfter.channel_id))
          )
        : undefined;
      const rows = (await select(this.db, {
        channel_id: gatewayChannels.id,
        tenant_id: tenantColumn,
      })
        .from(gatewayChannels)
        .where(
          and(
            eq(gatewayChannels.enabled, true),
            inArray(gatewayChannels.channel_type, [...DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES]),
            claimable,
            afterCondition
          )
        )
        .orderBy(asc(tenantColumn), asc(gatewayChannels.id))
        .limit(limit)
        .all()) as Array<{ channel_id: string; tenant_id?: unknown }>;

      for (const row of rows) {
        if (typeof row.tenant_id !== 'string' || row.tenant_id.length === 0) {
          throw new RepositoryError(
            `Gateway listener discovery returned channel ${row.channel_id} without a tenant identity`
          );
        }
        refs.push({
          channel_id: row.channel_id as GatewayChannelID,
          tenant_id: row.tenant_id as TenantID,
        });
        if (refs.length === limit) break;
      }

      if (rows.length < limit || refs.length === limit) break;
      const last = rows.at(-1);
      if (!last || typeof last.tenant_id !== 'string') {
        throw new RepositoryError('Gateway listener discovery returned an invalid raw cursor');
      }
      rawAfter = {
        tenant_id: last.tenant_id as TenantID,
        channel_id: last.channel_id as GatewayChannelID,
      };
    }
    return refs;
  }
}

/**
 * Encrypt sensitive fields within a config object
 */
function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const encrypted = { ...config };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
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
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    if (typeof decrypted[field] === 'string' && decrypted[field]) {
      try {
        decrypted[field] = decryptApiKey(decrypted[field] as string);
      } catch (error) {
        console.error(
          `[gateway-channels] Failed to decrypt ${field}:`,
          error instanceof Error ? error.message : String(error)
        );
        console.error(
          '[gateway-channels] Channel credentials may be corrupted or master secret changed'
        );
        // Ciphertext and malformed legacy plaintext are never runtime
        // credentials. Fail this one field closed rather than returning the
        // stored representation to connectors or executor payload assembly.
        delete decrypted[field];
      }
    }
  }
  return decrypted;
}

function encryptAgenticConfig(
  agenticConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!agenticConfig) return null;

  const encrypted = { ...agenticConfig };
  const rawEnvVars = encrypted.envVars;

  if (Array.isArray(rawEnvVars)) {
    encrypted.envVars = (rawEnvVars as GatewayEnvVar[]).map((envVar) => ({
      ...envVar,
      value: envVar.value ? encryptApiKey(envVar.value) : envVar.value,
    }));
  } else if (rawEnvVars && typeof rawEnvVars === 'object') {
    // Legacy shape support: Record<string, string>
    encrypted.envVars = Object.fromEntries(
      Object.entries(rawEnvVars as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === 'string' && value ? encryptApiKey(value) : value,
      ])
    );
  }

  return encrypted;
}

function decryptAgenticConfig(
  agenticConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!agenticConfig) return null;

  const decrypted = { ...agenticConfig };
  const rawEnvVars = decrypted.envVars;

  if (Array.isArray(rawEnvVars)) {
    decrypted.envVars = (rawEnvVars as GatewayEnvVar[]).flatMap((envVar) => {
      try {
        return [
          {
            ...envVar,
            value: envVar.value ? decryptApiKey(envVar.value) : envVar.value,
          },
        ];
      } catch {
        return [];
      }
    });
  } else if (rawEnvVars && typeof rawEnvVars === 'object') {
    // Legacy shape support: Record<string, string>
    decrypted.envVars = Object.fromEntries(
      Object.entries(rawEnvVars as Record<string, unknown>).flatMap(([key, value]) => {
        if (typeof value !== 'string' || !value) return [[key, value]];
        try {
          return [[key, decryptApiKey(value)]];
        } catch {
          return [];
        }
      })
    );
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

  private async mutationNow(txDb: Database, channelId: string): Promise<Date> {
    if (!isPostgresDatabase(this.db)) return new Date();
    const row = await select(txDb, { value: sql<Date>`CURRENT_TIMESTAMP` })
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, channelId))
      .one();
    if (!row) throw new EntityNotFoundError('GatewayChannel', channelId);
    return row.value instanceof Date ? row.value : new Date(row.value);
  }

  private validateLeaseInput(input: GatewayListenerClaimInput): void {
    if (!input.claimToken.trim())
      throw new RepositoryError('Gateway listener claim token required');
    if (!input.instanceId.trim() || !input.bootId.trim()) {
      throw new RepositoryError('Gateway listener diagnostic identity required');
    }
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RepositoryError('Gateway listener lease duration must be positive');
    }
  }

  /**
   * Claim one channel listener with database time and an opaque fence token.
   * The transaction is intentionally limited to one locked row and contains no
   * provider work.
   */
  async claimListener(input: GatewayListenerClaimInput): Promise<GatewayListenerClaimResult> {
    this.validateLeaseInput(input);
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        const row = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        if (!row?.enabled) return { outcome: 'unavailable' };

        const now = await this.mutationNow(txDb, input.channelId);
        if (
          row.listener_claim_token &&
          row.listener_lease_expires_at &&
          new Date(row.listener_lease_expires_at).getTime() > now.getTime()
        ) {
          return {
            outcome: 'held',
            lease_expires_at: new Date(row.listener_lease_expires_at).toISOString(),
          };
        }

        const generation = row.listener_generation + 1;
        const expiresAt = new Date(now.getTime() + input.leaseDurationMs);
        await update(txDb, gatewayChannels)
          .set({
            listener_claim_token: input.claimToken,
            listener_claimed_at: now,
            listener_lease_expires_at: expiresAt,
            listener_instance_id: input.instanceId,
            listener_boot_id: input.bootId,
            listener_generation: generation,
          })
          .where(eq(gatewayChannels.id, input.channelId))
          .run();

        return {
          outcome: 'claimed',
          lease: {
            channel_id: input.channelId,
            claim_token: input.claimToken,
            generation,
            claimed_at: now.toISOString(),
            lease_expires_at: expiresAt.toISOString(),
            instance_id: input.instanceId,
            boot_id: input.bootId,
            checkpoint:
              row.listener_checkpoint && typeof row.listener_checkpoint === 'object'
                ? (row.listener_checkpoint as Record<string, unknown>)
                : null,
          },
        };
      },
      { sqliteImmediate: true }
    );
  }

  /** Renew only an unexpired current token. Expired owners must re-contend. */
  async renewListener(
    channelId: GatewayChannelID,
    claimToken: string,
    leaseDurationMs: number
  ): Promise<GatewayListenerLease | null> {
    if (!claimToken.trim() || !Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new RepositoryError('Valid gateway listener renewal token and duration required');
    }
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, gatewayChannels, eq(gatewayChannels.id, channelId));
        const row = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, channelId))
          .one();
        if (!row?.enabled || row.listener_claim_token !== claimToken) return null;
        const now = await this.mutationNow(txDb, channelId);
        if (
          !row.listener_lease_expires_at ||
          new Date(row.listener_lease_expires_at).getTime() <= now.getTime()
        ) {
          return null;
        }
        const expiresAt = new Date(now.getTime() + leaseDurationMs);
        await update(txDb, gatewayChannels)
          .set({ listener_lease_expires_at: expiresAt })
          .where(
            and(
              eq(gatewayChannels.id, channelId),
              eq(gatewayChannels.listener_claim_token, claimToken)
            )
          )
          .run();
        return {
          channel_id: channelId,
          claim_token: claimToken,
          generation: row.listener_generation,
          claimed_at: new Date(row.listener_claimed_at ?? now).toISOString(),
          lease_expires_at: expiresAt.toISOString(),
          instance_id: row.listener_instance_id ?? 'unknown',
          boot_id: row.listener_boot_id ?? 'unknown',
          checkpoint:
            row.listener_checkpoint && typeof row.listener_checkpoint === 'object'
              ? (row.listener_checkpoint as Record<string, unknown>)
              : null,
        };
      },
      { sqliteImmediate: true }
    );
  }

  /** Current-token check used to fence callbacks and provider checkpoints. */
  async listenerClaimIsCurrent(channelId: GatewayChannelID, claimToken: string): Promise<boolean> {
    const row = await select(this.db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, channelId))
      .one();
    if (!row?.enabled || row.listener_claim_token !== claimToken) return false;
    const now = isPostgresDatabase(this.db) ? null : new Date();
    if (now) {
      return !!row.listener_lease_expires_at && new Date(row.listener_lease_expires_at) > now;
    }
    const current = await select(this.db, {
      current: sql<boolean>`${gatewayChannels.listener_lease_expires_at} > CURRENT_TIMESTAMP`,
    })
      .from(gatewayChannels)
      .where(
        and(
          eq(gatewayChannels.id, channelId),
          eq(gatewayChannels.listener_claim_token, claimToken),
          eq(gatewayChannels.enabled, true)
        )
      )
      .one();
    return current?.current === true;
  }

  async saveListenerCheckpoint(
    channelId: GatewayChannelID,
    claimToken: string,
    checkpoint: Record<string, unknown>
  ): Promise<boolean> {
    const now = new Date();
    const currentCondition = isPostgresDatabase(this.db)
      ? sql`${gatewayChannels.listener_lease_expires_at} > CURRENT_TIMESTAMP`
      : gt(gatewayChannels.listener_lease_expires_at, now);
    const result = await update(this.db, gatewayChannels)
      .set({
        listener_checkpoint: checkpoint,
        listener_checkpoint_updated_at: isPostgresDatabase(this.db) ? sql`CURRENT_TIMESTAMP` : now,
      })
      .where(
        and(
          eq(gatewayChannels.id, channelId),
          eq(gatewayChannels.enabled, true),
          eq(gatewayChannels.listener_claim_token, claimToken),
          currentCondition
        )
      )
      .run();
    return result.rowsAffected > 0;
  }

  async releaseListener(channelId: GatewayChannelID, claimToken: string): Promise<boolean> {
    const result = await update(this.db, gatewayChannels)
      .set({
        listener_claim_token: null,
        listener_claimed_at: null,
        listener_lease_expires_at: null,
        listener_instance_id: null,
        listener_boot_id: null,
      })
      .where(
        and(eq(gatewayChannels.id, channelId), eq(gatewayChannels.listener_claim_token, claimToken))
      )
      .run();
    return result.rowsAffected > 0;
  }

  /** Bounded tenant-local candidates for static PostgreSQL deployments. */
  async findEnabledListenerCandidates(
    limit = 25,
    afterId?: GatewayChannelID
  ): Promise<GatewayChannel[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RepositoryError('Gateway listener candidate limit must be between 1 and 1000');
    }
    const claimable = isPostgresDatabase(this.db)
      ? or(
          isNull(gatewayChannels.listener_claim_token),
          isNull(gatewayChannels.listener_lease_expires_at),
          lte(gatewayChannels.listener_lease_expires_at, sql`CURRENT_TIMESTAMP`)
        )
      : undefined;
    const auditedProvider = isPostgresDatabase(this.db)
      ? inArray(gatewayChannels.channel_type, [...DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES])
      : undefined;
    const candidates: GatewayChannel[] = [];
    let rawAfterId = afterId;
    while (candidates.length < limit) {
      const rows = await select(this.db)
        .from(gatewayChannels)
        .where(
          and(
            eq(gatewayChannels.enabled, true),
            auditedProvider,
            claimable,
            rawAfterId ? gt(gatewayChannels.id, rawAfterId) : undefined
          )
        )
        .orderBy(asc(gatewayChannels.id))
        .limit(limit)
        .all();

      for (const row of rows as GatewayChannelRow[]) {
        candidates.push(this.rowToChannel(row));
        if (candidates.length === limit) break;
      }

      if (rows.length < limit || candidates.length === limit) break;
      const last = rows.at(-1) as GatewayChannelRow | undefined;
      if (!last) break;
      rawAfterId = last.id as GatewayChannelID;
    }
    return candidates;
  }

  /**
   * Convert database row to GatewayChannel type
   */
  private rowToChannel(row: GatewayChannelRow): GatewayChannel {
    const config = row.config as Record<string, unknown>;
    const agenticConfig = decryptAgenticConfig(
      (row.agentic_config as Record<string, unknown> | null) ?? null
    );

    return attachHiddenTenant(
      {
        id: row.id as GatewayChannelID,
        created_by: row.created_by,
        name: row.name,
        channel_type: row.channel_type as ChannelType,
        target_branch_id: row.target_branch_id as UUID,
        agor_user_id: (row.agor_user_id as UUID | null) ?? null,
        provider_installation_id: row.provider_installation_id ?? null,
        provider_config_generation: row.provider_config_generation ?? 1,
        channel_key: row.channel_key,
        config: decryptConfig(config),
        agentic_config: agenticConfig
          ? ({
              ...(agenticConfig as unknown as PersistedGatewayAgenticConfig),
              presetId:
                (row.agentic_tool_preset_id as PersistedGatewayAgenticConfig['presetId']) ??
                (agenticConfig.presetId as PersistedGatewayAgenticConfig['presetId']) ??
                undefined,
            } as PersistedGatewayAgenticConfig)
          : null,
        mcp_server_ids: row.mcp_server_ids ?? undefined,
        enabled: Boolean(row.enabled),
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        last_message_at: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      },
      row
    );
  }

  /**
   * Convert GatewayChannel to database insert format
   */
  private channelToInsert(data: Partial<GatewayChannel>): GatewayChannelInsert {
    const now = Date.now();
    const id = data.id ?? generateId();
    if (!data.created_by) {
      throw new RepositoryError('GatewayChannel must have a created_by');
    }

    const agenticStorage = this.agenticConfigStorage(data.agentic_config);

    return {
      id,
      created_at: new Date(data.created_at ?? now),
      updated_at: new Date(data.updated_at ?? now),
      created_by: data.created_by,
      name: data.name ?? 'Untitled Channel',
      channel_type: data.channel_type ?? 'slack',
      target_branch_id: data.target_branch_id ?? '',
      agor_user_id: data.agor_user_id ?? null,
      provider_installation_id: data.provider_installation_id ?? null,
      provider_config_generation: data.provider_config_generation ?? 1,
      channel_key: data.channel_key ?? generateId(),
      enabled: data.enabled ?? true,
      last_message_at: data.last_message_at ? new Date(data.last_message_at) : null,
      config: data.config ? encryptConfig(data.config) : {},
      ...agenticStorage,
      mcp_server_ids: data.mcp_server_ids ?? null,
    };
  }

  private agenticConfigStorage(
    agenticConfig: GatewayChannel['agentic_config'] | undefined
  ): Pick<GatewayChannelInsert, 'agentic_config' | 'agentic_tool_preset_id'> {
    const presetId = agenticConfig?.presetId;
    const storesDefaultReference = Boolean(
      presetId && isAgenticToolDefaultConfigurationReference(presetId)
    );
    const { presetId: _presetId, ...agenticConfigWithoutPreset } = agenticConfig ?? {};
    const storedAgenticConfig = storesDefaultReference
      ? (agenticConfig ?? {})
      : agenticConfigWithoutPreset;
    return {
      agentic_config: encryptAgenticConfig(
        Object.keys(storedAgenticConfig).length > 0
          ? (storedAgenticConfig as unknown as Record<string, unknown>)
          : null
      ),
      agentic_tool_preset_id: storesDefaultReference ? null : (presetId ?? null),
    };
  }

  /**
   * Enforce the "enabled requires secrets" invariant on every write path.
   *
   * An enabled channel can never exist without the secrets its type needs to
   * function. Runs on the post-merge, decrypted config so a patch that only
   * flips `enabled: true` on a channel with already-stored tokens passes.
   * Disabled ("draft") channels are exempt from secret checks; identity
   * configuration remains validated.
   */
  private assertRequiredSecretsWhenEnabled(channel: Partial<GatewayChannel>): void {
    const channelType = channel.channel_type ?? 'slack';
    const config = channel.config ?? {};

    // Teams user mappings are identity configuration, not deferred secrets;
    // validate them even on disabled drafts before the enabled-only checks.
    if (channelType === 'teams') {
      const validation = validateTeamsUserMap(config.user_map);
      if (!validation.ok) {
        throw new RepositoryError(
          `Cannot persist Teams gateway channel: invalid configuration ${validation.errors.join('; ')}`
        );
      }
    }

    // Insert defaults `enabled` to true, so treat undefined as enabled here.
    if (channel.enabled === false) return;

    const missing = getRequiredSecretFields(channelType, config).filter((field) => {
      const value = config[field];
      return (
        typeof value !== 'string' || value.trim() === '' || value === GATEWAY_REDACTED_SENTINEL
      );
    });

    if (missing.length > 0) {
      throw new RepositoryError(
        `Cannot enable ${channelType} gateway channel: missing required secret(s) ${missing.join(', ')}`
      );
    }

    if (channelType === 'discord') {
      const validation = validateDiscordConfig(config, { requireBotToken: false });
      if (!validation.ok) {
        throw new RepositoryError(
          `Cannot enable Discord gateway channel: invalid configuration ${validation.errors.join('; ')}`
        );
      }
      const applicationId = config.application_id;
      if (
        typeof channel.provider_installation_id !== 'string' ||
        !isDiscordSnowflake(channel.provider_installation_id) ||
        channel.provider_installation_id !== applicationId
      ) {
        throw new RepositoryError(
          'Cannot enable Discord gateway channel: a verified Discord application binding is required'
        );
      }
      if (config.align_discord_users === true) {
        if (channel.agor_user_id !== null && channel.agor_user_id !== undefined) {
          throw new RepositoryError(
            'Cannot enable Discord gateway channel: aligned identity cannot use a fixed agor_user_id'
          );
        }
      } else if (typeof channel.agor_user_id !== 'string' || channel.agor_user_id.trim() === '') {
        throw new RepositoryError(
          'Cannot enable Discord gateway channel: fixed identity requires agor_user_id'
        );
      }
    }

    if (channelType === 'teams') {
      const validation = validateTeamsConfig(config, { requireAppPassword: true });
      if (!validation.ok) {
        throw new RepositoryError(
          `Cannot enable Teams gateway channel: invalid configuration ${validation.errors.join('; ')}`
        );
      }
      if (channel.provider_installation_id !== config.app_id) {
        throw new RepositoryError(
          'Cannot enable Teams gateway channel: a configured Teams application binding is required'
        );
      }
      const hasUserMap =
        config.user_map &&
        typeof config.user_map === 'object' &&
        !Array.isArray(config.user_map) &&
        Object.keys(config.user_map).length > 0;
      if (!hasUserMap && (!channel.agor_user_id || !String(channel.agor_user_id).trim())) {
        throw new RepositoryError(
          'Cannot enable Teams gateway channel: fixed agor_user_id or user_map is required'
        );
      }
    }
  }

  private isDiscordInstallationConflict(error: unknown): boolean {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      messages.push(current instanceof Error ? current.message : String(current));
      current =
        typeof current === 'object' && current !== null && 'cause' in current
          ? (current as { cause?: unknown }).cause
          : undefined;
    }
    const message = messages.join('\n');
    return (
      message.includes('gateway_channels_discord_installation_unique') ||
      (message.toLowerCase().includes('unique') &&
        message.includes('provider_installation_id') &&
        message.includes('channel_type'))
    );
  }

  private isTeamsInstallationConflict(error: unknown): boolean {
    return String(error).includes('gateway_channels_teams_installation_unique');
  }

  private duplicateDiscordInstallationError(): RepositoryError {
    return new RepositoryError(
      'Cannot enable Discord gateway channel: this Discord application is already enabled'
    );
  }

  private duplicateTeamsInstallationError(): RepositoryError {
    return new RepositoryError(
      'Cannot enable Teams gateway channel: this Teams application is already enabled'
    );
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    const pattern = prefixToLikePattern(id);

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
        results.map((r: { id: string }) => r.id)
      );
    }

    return results[0].id;
  }

  /**
   * Create a new gateway channel
   */
  async create(data: Partial<GatewayChannel>): Promise<GatewayChannel> {
    try {
      const channelType = data.channel_type ?? 'slack';
      const prepared = {
        ...data,
        config: mergeGatewayChannelConfigPatch({}, data.config, channelType, data.enabled ?? true),
        id: data.id ?? generateId(),
        channel_key: data.channel_key ?? generateId(),
      };
      const preparedProviderInstallationId =
        channelType === 'teams' &&
        prepared.enabled !== false &&
        typeof prepared.config.app_id === 'string'
          ? prepared.config.app_id
          : prepared.provider_installation_id;
      const insertData = this.channelToInsert({
        ...prepared,
        provider_installation_id: preparedProviderInstallationId,
      });

      this.assertRequiredSecretsWhenEnabled({
        ...prepared,
        provider_installation_id: insertData.provider_installation_id,
      });
      const row = await runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await insert(txDb, gatewayChannels).values(insertData).run();
          return select(txDb)
            .from(gatewayChannels)
            .where(eq(gatewayChannels.id, insertData.id))
            .one();
        },
        { sqliteImmediate: true }
      );

      if (!row) {
        throw new RepositoryError('Failed to retrieve created gateway channel');
      }

      return this.rowToChannel(row);
    } catch (error) {
      if (this.isDiscordInstallationConflict(error)) {
        throw this.duplicateDiscordInstallationError();
      }
      if (this.isTeamsInstallationConflict(error)) {
        throw this.duplicateTeamsInstallationError();
      }
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
    return this.updateInternal(id, updates);
  }

  /**
   * Materialize a provider identity only after a connector has verified the
   * token-owned application. This method is intentionally not part of the
   * public gateway write DTO or MCP transport surface.
   */
  async updateWithVerifiedDiscordInstallation(
    id: string,
    updates: Partial<GatewayChannel>,
    providerInstallationId: string,
    expectedProviderConfigGeneration: number
  ): Promise<GatewayChannel> {
    if (!isDiscordSnowflake(providerInstallationId)) {
      throw new RepositoryError('Verified Discord application identity is invalid');
    }
    if (
      !Number.isSafeInteger(expectedProviderConfigGeneration) ||
      expectedProviderConfigGeneration < 1
    ) {
      throw new RepositoryError('Verified Discord installation requires a valid config generation');
    }
    return this.updateInternal(
      id,
      updates,
      providerInstallationId,
      expectedProviderConfigGeneration
    );
  }

  private async updateInternal(
    id: string,
    updates: Partial<GatewayChannel>,
    verifiedProviderInstallationId?: string,
    expectedProviderConfigGeneration?: number
  ): Promise<GatewayChannel> {
    try {
      const fullId = await this.resolveId(id);

      const updated = isTeamsCredentialOnlyConfigPatch(updates)
        ? await this.updateTeamsCredentialOnly(id, fullId, updates)
        : isGatewayProviderAuthorityPatch(updates)
          ? await this.updateAuthority(
              id,
              fullId,
              updates,
              verifiedProviderInstallationId,
              expectedProviderConfigGeneration
            )
          : await this.updateNonAuthority(id, fullId, updates);

      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated gateway channel');
      }

      return this.rowToChannel(updated);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      if (this.isDiscordInstallationConflict(error)) {
        throw this.duplicateDiscordInstallationError();
      }
      if (this.isTeamsInstallationConflict(error)) {
        throw this.duplicateTeamsInstallationError();
      }
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  private listenerRevocationSet() {
    return {
      listener_claim_token: null,
      listener_claimed_at: null,
      listener_lease_expires_at: null,
      listener_instance_id: null,
      listener_boot_id: null,
      listener_generation: sql`${gatewayChannels.listener_generation} + 1`,
      listener_checkpoint: null,
      listener_checkpoint_updated_at: null,
    };
  }

  /** Rotate only the Teams app password without fencing active gateway work. */
  private async updateTeamsCredentialOnly(
    id: string,
    fullId: string,
    updates: Partial<GatewayChannel>
  ): Promise<GatewayChannelRow | null> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, gatewayChannels, eq(gatewayChannels.id, fullId));
        const currentRow = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, fullId))
          .one();
        if (!currentRow) throw new EntityNotFoundError('GatewayChannel', id);
        if (currentRow.channel_type !== 'teams') {
          throw new RepositoryError('Credential-only rotation requires a Teams gateway channel');
        }

        const current = this.rowToChannel(currentRow);
        const config = mergeGatewayChannelConfigPatch(
          current.config,
          updates.config,
          'teams',
          current.enabled
        );
        this.assertRequiredSecretsWhenEnabled({ ...current, config });
        await update(txDb, gatewayChannels)
          .set({ config: encryptConfig(config), updated_at: new Date() })
          .where(eq(gatewayChannels.id, fullId))
          .run();
        return select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, fullId)).one();
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Serialize every provider-authority mutation. The provider probe is never
   * part of this transaction; verified callers carry the predecessor
   * generation into the short locked compare-and-swap below.
   */
  private async updateAuthority(
    id: string,
    fullId: string,
    updates: Partial<GatewayChannel>,
    verifiedProviderInstallationId?: string,
    expectedProviderConfigGeneration?: number
  ): Promise<GatewayChannelRow | null> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(txDb, this.db, gatewayChannels, eq(gatewayChannels.id, fullId));
        const currentRow = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, fullId))
          .one();
        if (!currentRow) throw new EntityNotFoundError('GatewayChannel', id);

        const current = this.rowToChannel(currentRow);
        if (
          expectedProviderConfigGeneration !== undefined &&
          current.provider_config_generation !== expectedProviderConfigGeneration
        ) {
          throw new RepositoryError(
            'Provider verification became stale while the gateway configuration changed'
          );
        }

        const merged = { ...current, ...updates };
        merged.config = mergeGatewayChannelConfigPatch(
          current.config,
          updates.config,
          merged.channel_type,
          merged.enabled !== false
        );

        if (verifiedProviderInstallationId !== undefined) {
          if (!['discord', 'teams'].includes(merged.channel_type) || merged.enabled === false) {
            throw new RepositoryError(
              'Verified provider identity requires an enabled Discord or Teams gateway channel'
            );
          }
          const configuredApplicationId =
            merged.channel_type === 'discord' ? merged.config.application_id : merged.config.app_id;
          if (configuredApplicationId !== verifiedProviderInstallationId) {
            throw new RepositoryError(
              'Verified provider identity does not match the configured application'
            );
          }
          merged.provider_installation_id = verifiedProviderInstallationId;
        } else if (merged.channel_type === 'discord' && merged.enabled !== false) {
          throw new RepositoryError(
            'verified Discord application binding is required for enabled authority changes'
          );
        } else if (merged.channel_type === 'teams' && merged.enabled !== false) {
          if (typeof merged.config.app_id !== 'string' || !merged.config.app_id.trim()) {
            throw new RepositoryError(
              'Teams application identity is required for an enabled channel'
            );
          }
          merged.provider_installation_id = merged.config.app_id;
        } else {
          merged.provider_installation_id = null;
        }

        merged.provider_config_generation = current.provider_config_generation + 1;
        this.assertRequiredSecretsWhenEnabled(merged);
        const insertData = this.channelToInsert(merged);
        const result = await update(txDb, gatewayChannels)
          .set({
            ...(updates.name !== undefined ? { name: insertData.name } : {}),
            ...(updates.target_branch_id !== undefined
              ? { target_branch_id: insertData.target_branch_id }
              : {}),
            ...(updates.agentic_config !== undefined
              ? {
                  agentic_config: insertData.agentic_config,
                  agentic_tool_preset_id: insertData.agentic_tool_preset_id,
                }
              : {}),
            ...(updates.mcp_server_ids !== undefined
              ? { mcp_server_ids: insertData.mcp_server_ids }
              : {}),
            ...(updates.channel_type !== undefined
              ? { channel_type: insertData.channel_type }
              : {}),
            ...(updates.agor_user_id !== undefined
              ? { agor_user_id: insertData.agor_user_id }
              : {}),
            ...(updates.config !== undefined ? { config: insertData.config } : {}),
            ...(updates.enabled !== undefined ? { enabled: insertData.enabled } : {}),
            provider_installation_id: insertData.provider_installation_id,
            provider_config_generation: insertData.provider_config_generation,
            updated_at: new Date(),
            ...this.listenerRevocationSet(),
          })
          .where(
            expectedProviderConfigGeneration === undefined
              ? eq(gatewayChannels.id, fullId)
              : and(
                  eq(gatewayChannels.id, fullId),
                  eq(gatewayChannels.provider_config_generation, expectedProviderConfigGeneration)
                )
          )
          .run();

        if (expectedProviderConfigGeneration !== undefined && result.rowsAffected !== 1) {
          throw new RepositoryError(
            'Provider verification became stale while the gateway configuration changed'
          );
        }
        if (result.rowsAffected !== 1) {
          throw new EntityNotFoundError('GatewayChannel', id);
        }
        return select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, fullId)).one();
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Keep non-authority patches sparse so a writer that started from an older
   * channel cannot restore provider configuration, binding, enabled state, or
   * provider generation after an authority commit.
   */
  private async updateNonAuthority(
    id: string,
    fullId: string,
    updates: Partial<GatewayChannel>
  ): Promise<GatewayChannelRow | null> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        const result = await update(txDb, gatewayChannels)
          .set({
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.target_branch_id !== undefined
              ? { target_branch_id: updates.target_branch_id }
              : {}),
            ...(updates.agentic_config !== undefined
              ? {
                  ...this.agenticConfigStorage(updates.agentic_config),
                }
              : {}),
            ...(updates.mcp_server_ids !== undefined
              ? { mcp_server_ids: updates.mcp_server_ids }
              : {}),
            updated_at: new Date(),
            ...this.listenerRevocationSet(),
          })
          .where(eq(gatewayChannels.id, fullId))
          .run();
        if (result.rowsAffected !== 1) throw new EntityNotFoundError('GatewayChannel', id);
        return select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, fullId)).one();
      },
      { sqliteImmediate: true }
    );
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
