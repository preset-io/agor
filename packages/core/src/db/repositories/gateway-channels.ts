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
  validateDiscordConfig,
} from '../../types/gateway';
import { prefixToLikePattern } from '../../types/id';
import type { Database, SystemDatabase } from '../client';
import {
  deleteFrom,
  executeRaw,
  insert,
  isPostgresDatabase,
  jsonExtract,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type GatewayChannelInsert, type GatewayChannelRow, gatewayChannels } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
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

function duplicateDiscordChannelIds(
  rows: Array<{
    channel_id?: string;
    tenant_id?: unknown;
    application_id?: unknown;
  }>
): Set<string> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const applicationId = row.application_id;
    if (typeof applicationId !== 'string' || applicationId.length === 0) continue;
    const channelId = row.channel_id;
    if (!channelId) continue;
    const key = `${String(row.tenant_id ?? 'default')}:${applicationId}`;
    groups.set(key, [...(groups.get(key) ?? []), channelId]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
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
    // Do not derive duplicate status from the bounded page: a duplicate peer
    // may sort outside this page. Every member of every enabled tenant-local
    // duplicate group must stay inert, regardless of discovery pagination.
    const allDiscordRows = await select(this.db, {
      channel_id: gatewayChannels.id,
      tenant_id: tenantColumn,
      application_id: jsonExtract(this.db, gatewayChannels.config, 'application_id'),
    })
      .from(gatewayChannels)
      .where(and(eq(gatewayChannels.enabled, true), eq(gatewayChannels.channel_type, 'discord')))
      .all();
    const duplicateIds = duplicateDiscordChannelIds(allDiscordRows);

    // The raw page cursor must advance past rows that are filtered locally.
    // Otherwise a page made entirely of fail-closed duplicate Discord rows
    // can starve every valid candidate after it, including another tenant.
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
        if (duplicateIds.has(row.channel_id)) continue;
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
    decrypted.envVars = (rawEnvVars as GatewayEnvVar[]).map((envVar) => {
      try {
        return {
          ...envVar,
          value: envVar.value ? decryptApiKey(envVar.value) : envVar.value,
        };
      } catch {
        return envVar;
      }
    });
  } else if (rawEnvVars && typeof rawEnvVars === 'object') {
    // Legacy shape support: Record<string, string>
    decrypted.envVars = Object.fromEntries(
      Object.entries(rawEnvVars as Record<string, unknown>).map(([key, value]) => {
        if (typeof value !== 'string' || !value) return [key, value];
        try {
          return [key, decryptApiKey(value)];
        } catch {
          return [key, value];
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
    const allDiscordRows = await select(this.db, {
      channel_id: gatewayChannels.id,
      application_id: jsonExtract(this.db, gatewayChannels.config, 'application_id'),
    })
      .from(gatewayChannels)
      .where(and(eq(gatewayChannels.enabled, true), eq(gatewayChannels.channel_type, 'discord')))
      .all();
    const duplicateIds = duplicateDiscordChannelIds(allDiscordRows);
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
        if (duplicateIds.has(row.id)) continue;
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
        agor_user_id: row.agor_user_id as UUID,
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

    const presetId = data.agentic_config?.presetId;
    const storesDefaultReference = Boolean(
      presetId && isAgenticToolDefaultConfigurationReference(presetId)
    );
    const { presetId: _presetId, ...agenticConfigWithoutPreset } = data.agentic_config ?? {};
    const storedAgenticConfig = storesDefaultReference
      ? (data.agentic_config ?? {})
      : agenticConfigWithoutPreset;
    const encryptedAgenticConfig = encryptAgenticConfig(
      Object.keys(storedAgenticConfig).length > 0
        ? (storedAgenticConfig as unknown as Record<string, unknown>)
        : null
    );

    return {
      id,
      created_at: new Date(data.created_at ?? now),
      updated_at: new Date(data.updated_at ?? now),
      created_by: data.created_by,
      name: data.name ?? 'Untitled Channel',
      channel_type: data.channel_type ?? 'slack',
      target_branch_id: data.target_branch_id ?? '',
      agor_user_id: data.agor_user_id ?? '',
      channel_key: data.channel_key ?? generateId(),
      enabled: data.enabled ?? true,
      last_message_at: data.last_message_at ? new Date(data.last_message_at) : null,
      config: data.config ? encryptConfig(data.config) : {},
      agentic_config: encryptedAgenticConfig,
      agentic_tool_preset_id: storesDefaultReference ? null : (presetId ?? null),
      mcp_server_ids: data.mcp_server_ids ?? null,
    };
  }

  /**
   * Enforce the "enabled requires secrets" invariant on every write path.
   *
   * An enabled channel can never exist without the secrets its type needs to
   * function. Runs on the post-merge, decrypted config so a patch that only
   * flips `enabled: true` on a channel with already-stored tokens passes.
   * Disabled ("draft") channels are exempt.
   */
  private assertRequiredSecretsWhenEnabled(channel: Partial<GatewayChannel>): void {
    // Insert defaults `enabled` to true, so treat undefined as enabled here.
    if (channel.enabled === false) return;

    const channelType = channel.channel_type ?? 'slack';
    const config = channel.config ?? {};
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
      if (typeof channel.agor_user_id !== 'string' || channel.agor_user_id.trim() === '') {
        throw new RepositoryError(
          'Cannot enable Discord gateway channel: a fixed agor_user_id is required'
        );
      }
      const validation = validateDiscordConfig(config, { requireBotToken: false });
      if (!validation.ok) {
        throw new RepositoryError(
          `Cannot enable Discord gateway channel: invalid configuration ${validation.errors.join('; ')}`
        );
      }
    }
  }

  /**
   * Discord's gateway manager is process-local and cannot safely share one
   * application identity across enabled rows in the same tenant. The tenant
   * scoped database wrapper is the authority for this check; other tenants are
   * never visible here (including under PostgreSQL RLS).
   */
  private async assertDiscordApplicationIdUnique(
    db: Database,
    channel: Partial<GatewayChannel>
  ): Promise<void> {
    if (channel.channel_type !== 'discord' || channel.enabled === false) return;
    const applicationId = channel.config?.application_id;
    if (typeof applicationId !== 'string' || applicationId.length === 0) return;
    const rows = await select(db)
      .from(gatewayChannels)
      .where(and(eq(gatewayChannels.channel_type, 'discord'), eq(gatewayChannels.enabled, true)))
      .all();
    const duplicate = rows.find(
      (row: GatewayChannelRow) =>
        row.id !== channel.id &&
        (this.rowToChannel(row).config.application_id as unknown) === applicationId
    );
    if (duplicate) {
      throw new RepositoryError(
        `Cannot enable Discord gateway channel: application_id ${applicationId} is already used by another enabled channel`
      );
    }
  }

  /** Serialize the admission check so two first writers cannot both pass it. */
  private async lockDiscordApplicationAdmission(txDb: Database): Promise<void> {
    if (!isPostgresDatabase(this.db)) return;
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new RepositoryError(
        'Discord application admission requires an active tenant database scope'
      );
    }
    await executeRaw(
      txDb,
      sql`SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`agor:gateway-discord-application-admission:${tenantId}`},
          0
        )
      )`
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
      const insertData = this.channelToInsert({
        ...data,
        id: data.id ?? generateId(),
        channel_key: data.channel_key ?? generateId(),
      });

      this.assertRequiredSecretsWhenEnabled(data);
      const row = await runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await this.lockDiscordApplicationAdmission(txDb);
          await this.assertDiscordApplicationIdUnique(txDb, {
            ...data,
            id: insertData.id as GatewayChannelID,
          });
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

      const updated = await runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await this.lockDiscordApplicationAdmission(txDb);
          const currentRow = await select(txDb)
            .from(gatewayChannels)
            .where(eq(gatewayChannels.id, fullId))
            .one();
          if (!currentRow) throw new EntityNotFoundError('GatewayChannel', id);
          const current = this.rowToChannel(currentRow);
          const merged = { ...current, ...updates };
          if (updates.config) {
            const mergedConfig = { ...current.config, ...updates.config };
            for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
              const updateValue = updates.config[field];
              if (
                (!updateValue || updateValue === GATEWAY_REDACTED_SENTINEL) &&
                current.config[field]
              ) {
                mergedConfig[field] = current.config[field];
              }
            }
            merged.config = mergedConfig;
          }
          this.assertRequiredSecretsWhenEnabled(merged);
          await this.assertDiscordApplicationIdUnique(txDb, merged);
          const insertData = this.channelToInsert(merged);
          await update(txDb, gatewayChannels)
            .set({
              name: insertData.name,
              channel_type: insertData.channel_type,
              target_branch_id: insertData.target_branch_id,
              agor_user_id: insertData.agor_user_id,
              enabled: insertData.enabled,
              config: insertData.config,
              agentic_config: insertData.agentic_config,
              agentic_tool_preset_id: insertData.agentic_tool_preset_id,
              mcp_server_ids: insertData.mcp_server_ids,
              updated_at: new Date(),
              listener_claim_token: null,
              listener_claimed_at: null,
              listener_lease_expires_at: null,
              listener_instance_id: null,
              listener_boot_id: null,
              listener_generation: sql`${gatewayChannels.listener_generation} + 1`,
              listener_checkpoint: null,
              listener_checkpoint_updated_at: null,
            })
            .where(eq(gatewayChannels.id, fullId))
            .run();
          return select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, fullId)).one();
        },
        { sqliteImmediate: true }
      );

      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated gateway channel');
      }

      return this.rowToChannel(updated);
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
