/**
 * Gateway Channel Repository
 *
 * Type-safe CRUD operations for gateway channels with short ID support.
 * Handles encryption/decryption of sensitive platform credentials in the config blob.
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  ChannelType,
  GatewayChannel,
  GatewayChannelID,
  GatewayEnvVar,
  PersistedGatewayAgenticConfig,
  TenantID,
  UUID,
} from '@agor/core/types';
import { and, asc, eq, gt, inArray, isNull, like, lte, ne, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { isAgenticToolDefaultConfigurationReference } from '../../types/agentic-tool-preset';
import {
  DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES,
  GATEWAY_REDACTED_SENTINEL,
  GATEWAY_SENSITIVE_CONFIG_FIELDS,
  getRequiredSecretFields,
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
import { isDatabaseUniqueConstraintError } from '../sanitize-error';
import {
  type GatewayChannelInsert,
  type GatewayChannelRow,
  gatewayChannels,
  gatewayProviderActions,
} from '../schema';
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

export interface GatewayProviderInstallationClaimInput {
  channelId: GatewayChannelID;
  channelType: ChannelType;
  providerInstallationId: string;
  /** Exact token-authenticated config used by the provider probe. */
  expectedConfig: Record<string, unknown>;
  expectedConfigGeneration?: number;
  providerProbe?: {
    claimToken: string;
    generation: number;
  };
  /** Keep the exact setup owner after binding so it can perform one reviewed mutation. */
  retainProviderProbeLeaseMs?: number;
}

export interface GatewayProviderProbeLease {
  channel_id: GatewayChannelID;
  claim_token: string;
  generation: number;
  provider_config_generation: number;
  lease_expires_at: string;
}

export type GatewayProviderProbeClaimResult =
  | { outcome: 'claimed'; lease: GatewayProviderProbeLease }
  | { outcome: 'held'; lease_expires_at: string }
  | { outcome: 'unavailable' };

export class ProviderInstallationConflictError extends RepositoryError {
  constructor() {
    super('Provider installation is already connected');
    this.name = 'ProviderInstallationConflictError';
  }
}

export class ProviderProbeInProgressError extends RepositoryError {
  constructor() {
    super('Discord connection test is in progress; enable the channel after it completes');
    this.name = 'ProviderProbeInProgressError';
  }
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
    const afterCondition = after
      ? or(
          gt(tenantColumn, after.tenant_id),
          and(eq(tenantColumn, after.tenant_id), gt(gatewayChannels.id, after.channel_id))
        )
      : undefined;
    const rows = await select(this.db, {
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
      .all();

    return (rows as Array<{ channel_id: string; tenant_id?: unknown }>).map((row) => {
      if (typeof row.tenant_id !== 'string' || row.tenant_id.length === 0) {
        throw new RepositoryError(
          `Gateway listener discovery returned channel ${row.channel_id} without a tenant identity`
        );
      }
      return {
        channel_id: row.channel_id as GatewayChannelID,
        tenant_id: row.tenant_id as TenantID,
      };
    });
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
   * Materialize a token-verified provider identity without trusting the public
   * application ID. The row lock proves the probed credentials still match;
   * the global partial unique index closes cross-tenant/concurrent races.
   */
  async claimProviderInstallationIdentity(
    input: GatewayProviderInstallationClaimInput
  ): Promise<boolean> {
    if (!input.providerInstallationId.trim()) {
      throw new RepositoryError('Verified provider installation identity required');
    }
    if (
      input.channelType === 'discord' &&
      (input.expectedConfig.application_id !== input.providerInstallationId ||
        typeof input.expectedConfig.bot_token !== 'string' ||
        input.expectedConfig.bot_token.length === 0 ||
        input.expectedConfig.bot_token === GATEWAY_REDACTED_SENTINEL)
    ) {
      throw new RepositoryError('Discord provider claim requires verified bot credentials');
    }
    if (
      input.retainProviderProbeLeaseMs !== undefined &&
      (!input.providerProbe ||
        !Number.isInteger(input.retainProviderProbeLeaseMs) ||
        input.retainProviderProbeLeaseMs <= 0 ||
        input.retainProviderProbeLeaseMs > 60_000)
    ) {
      throw new RepositoryError('Retained provider probe lease must be between 1 and 60000ms');
    }
    try {
      return await runDatabaseTransaction(
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
          if (!row || row.channel_type !== input.channelType) return false;

          if (
            input.expectedConfigGeneration !== undefined &&
            row.provider_config_generation !== input.expectedConfigGeneration
          ) {
            return false;
          }
          if (input.providerProbe) {
            const now = await this.mutationNow(txDb, input.channelId);
            if (
              row.enabled ||
              row.provider_probe_claim_token !== input.providerProbe.claimToken ||
              row.provider_probe_generation !== input.providerProbe.generation ||
              row.provider_probe_config_generation !== row.provider_config_generation ||
              !row.provider_probe_lease_expires_at ||
              new Date(row.provider_probe_lease_expires_at).getTime() <= now.getTime()
            ) {
              return false;
            }
          }

          const currentConfig = decryptConfig(row.config as Record<string, unknown>);
          for (const [key, expectedValue] of Object.entries(input.expectedConfig)) {
            if (currentConfig[key] !== expectedValue) return false;
          }
          if (currentConfig.application_id !== input.providerInstallationId) return false;
          if (row.provider_installation_id === input.providerInstallationId) {
            if (input.providerProbe) {
              const retain = input.retainProviderProbeLeaseMs !== undefined;
              await update(txDb, gatewayChannels)
                .set({
                  provider_probe_claim_token: retain ? input.providerProbe.claimToken : null,
                  provider_probe_lease_expires_at: retain
                    ? new Date(
                        (await this.mutationNow(txDb, input.channelId)).getTime() +
                          input.retainProviderProbeLeaseMs!
                      )
                    : null,
                  provider_probe_config_generation: retain ? row.provider_config_generation : null,
                  provider_probe_generation: retain
                    ? row.provider_probe_generation
                    : sql`${gatewayChannels.provider_probe_generation} + 1`,
                })
                .where(eq(gatewayChannels.id, input.channelId))
                .run();
            }
            return true;
          }

          const nextProviderConfigGeneration = row.provider_config_generation + 1;
          const retainProbe = input.providerProbe && input.retainProviderProbeLeaseMs !== undefined;
          const retainedProbeExpiry = retainProbe
            ? new Date(
                (await this.mutationNow(txDb, input.channelId)).getTime() +
                  input.retainProviderProbeLeaseMs!
              )
            : null;
          await update(txDb, gatewayChannels)
            .set({
              provider_installation_id: input.providerInstallationId,
              provider_config_generation: nextProviderConfigGeneration,
              updated_at: new Date(),
              listener_claim_token: null,
              listener_claimed_at: null,
              listener_lease_expires_at: null,
              listener_instance_id: null,
              listener_boot_id: null,
              listener_generation: sql`${gatewayChannels.listener_generation} + 1`,
              listener_checkpoint: null,
              listener_checkpoint_updated_at: null,
              ...(input.providerProbe
                ? {
                    provider_probe_claim_token: retainProbe ? input.providerProbe.claimToken : null,
                    provider_probe_lease_expires_at: retainedProbeExpiry,
                    provider_probe_config_generation: retainProbe
                      ? nextProviderConfigGeneration
                      : null,
                    provider_probe_generation: retainProbe
                      ? row.provider_probe_generation
                      : sql`${gatewayChannels.provider_probe_generation} + 1`,
                  }
                : {}),
            })
            .where(eq(gatewayChannels.id, input.channelId))
            .run();
          await update(txDb, gatewayProviderActions)
            .set({
              status: 'canceled',
              canceled_at: new Date(),
              last_error_code: 'provider_configuration_changed',
              claim_token: null,
              claim_expires_at: null,
              claim_listener_token: null,
              claim_listener_generation: null,
              claim_instance_id: null,
              claim_boot_id: null,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(gatewayProviderActions.gateway_channel_id, input.channelId),
                inArray(gatewayProviderActions.status, ['pending', 'processing', 'retry']),
                ne(gatewayProviderActions.provider_config_generation, nextProviderConfigGeneration)
              )
            )
            .run();
          return true;
        },
        { sqliteImmediate: true }
      );
    } catch (error) {
      if (isDatabaseUniqueConstraintError(error)) {
        // This is intentionally generic: never expose another tenant/channel.
        throw new ProviderInstallationConflictError();
      }
      throw error;
    }
  }

  /** PostgreSQL-only serialized setup ownership for one persisted disabled Discord channel. */
  async claimProviderProbe(input: {
    channelId: GatewayChannelID;
    claimToken: string;
    leaseDurationMs: number;
  }): Promise<GatewayProviderProbeClaimResult> {
    if (!isPostgresDatabase(this.db)) {
      throw new RepositoryError('Discord setup probes require PostgreSQL');
    }
    if (!input.claimToken.trim() || input.claimToken.length > 200) {
      throw new RepositoryError('Valid provider probe claim token required');
    }
    if (
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0 ||
      input.leaseDurationMs > 60_000
    ) {
      throw new RepositoryError('Provider probe lease must be between 1 and 60000 milliseconds');
    }
    return runDatabaseTransaction(this.db, async (txDb) => {
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
      if (!row || row.enabled || row.channel_type !== 'discord') return { outcome: 'unavailable' };
      const now = await this.mutationNow(txDb, input.channelId);
      if (
        row.provider_probe_claim_token &&
        row.provider_probe_lease_expires_at &&
        new Date(row.provider_probe_lease_expires_at).getTime() > now.getTime()
      ) {
        return {
          outcome: 'held',
          lease_expires_at: new Date(row.provider_probe_lease_expires_at).toISOString(),
        };
      }
      const generation = row.provider_probe_generation + 1;
      const expiresAt = new Date(now.getTime() + input.leaseDurationMs);
      await update(txDb, gatewayChannels)
        .set({
          provider_probe_claim_token: input.claimToken,
          provider_probe_lease_expires_at: expiresAt,
          provider_probe_generation: generation,
          provider_probe_config_generation: row.provider_config_generation,
        })
        .where(eq(gatewayChannels.id, input.channelId))
        .run();
      return {
        outcome: 'claimed',
        lease: {
          channel_id: input.channelId,
          claim_token: input.claimToken,
          generation,
          provider_config_generation: row.provider_config_generation,
          lease_expires_at: expiresAt.toISOString(),
        },
      };
    });
  }

  async providerProbeClaimIsCurrent(
    channelId: GatewayChannelID,
    claimToken: string,
    generation: number,
    providerConfigGeneration: number
  ): Promise<boolean> {
    if (!isPostgresDatabase(this.db)) return false;
    const current = await select(this.db, {
      current: sql<boolean>`${gatewayChannels.provider_probe_lease_expires_at} > CURRENT_TIMESTAMP`,
    })
      .from(gatewayChannels)
      .where(
        and(
          eq(gatewayChannels.id, channelId),
          eq(gatewayChannels.enabled, false),
          eq(gatewayChannels.channel_type, 'discord'),
          eq(gatewayChannels.provider_probe_claim_token, claimToken),
          eq(gatewayChannels.provider_probe_generation, generation),
          eq(gatewayChannels.provider_probe_config_generation, providerConfigGeneration),
          eq(gatewayChannels.provider_config_generation, providerConfigGeneration)
        )
      )
      .one();
    return current?.current === true;
  }

  /** Renew only the exact unexpired disabled-channel probe/config fence. */
  async renewProviderProbe(input: {
    channelId: GatewayChannelID;
    claimToken: string;
    generation: number;
    providerConfigGeneration: number;
    leaseDurationMs: number;
  }): Promise<GatewayProviderProbeLease | null> {
    if (!isPostgresDatabase(this.db)) {
      throw new RepositoryError('Discord setup probes require PostgreSQL');
    }
    if (
      !input.claimToken.trim() ||
      !Number.isSafeInteger(input.generation) ||
      input.generation <= 0 ||
      !Number.isSafeInteger(input.providerConfigGeneration) ||
      input.providerConfigGeneration <= 0 ||
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0 ||
      input.leaseDurationMs > 60_000
    ) {
      throw new RepositoryError('Valid provider probe renewal fence required');
    }
    return runDatabaseTransaction(this.db, async (txDb) => {
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
      if (
        !row ||
        row.enabled ||
        row.channel_type !== 'discord' ||
        row.provider_probe_claim_token !== input.claimToken ||
        row.provider_probe_generation !== input.generation ||
        row.provider_probe_config_generation !== input.providerConfigGeneration ||
        row.provider_config_generation !== input.providerConfigGeneration
      ) {
        return null;
      }
      const now = await this.mutationNow(txDb, input.channelId);
      if (
        !row.provider_probe_lease_expires_at ||
        new Date(row.provider_probe_lease_expires_at).getTime() <= now.getTime()
      ) {
        return null;
      }
      const expiresAt = new Date(now.getTime() + input.leaseDurationMs);
      await update(txDb, gatewayChannels)
        .set({ provider_probe_lease_expires_at: expiresAt })
        .where(eq(gatewayChannels.id, input.channelId))
        .run();
      return {
        channel_id: input.channelId,
        claim_token: input.claimToken,
        generation: input.generation,
        provider_config_generation: input.providerConfigGeneration,
        lease_expires_at: expiresAt.toISOString(),
      };
    });
  }

  async releaseProviderProbe(
    channelId: GatewayChannelID,
    claimToken: string,
    generation: number
  ): Promise<boolean> {
    if (!isPostgresDatabase(this.db)) return false;
    const result = await update(this.db, gatewayChannels)
      .set({
        provider_probe_claim_token: null,
        provider_probe_lease_expires_at: null,
        provider_probe_config_generation: null,
      })
      .where(
        and(
          eq(gatewayChannels.id, channelId),
          eq(gatewayChannels.provider_probe_claim_token, claimToken),
          eq(gatewayChannels.provider_probe_generation, generation)
        )
      )
      .run();
    return result.rowsAffected === 1;
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
  async listenerClaimIsCurrent(
    channelId: GatewayChannelID,
    claimToken: string,
    expectedGeneration?: number
  ): Promise<boolean> {
    const row = await select(this.db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, channelId))
      .one();
    if (
      !row?.enabled ||
      row.listener_claim_token !== claimToken ||
      (expectedGeneration !== undefined && row.listener_generation !== expectedGeneration)
    ) {
      return false;
    }
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
          ...(expectedGeneration === undefined
            ? []
            : [eq(gatewayChannels.listener_generation, expectedGeneration)]),
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
    const rows = await select(this.db)
      .from(gatewayChannels)
      .where(
        and(
          eq(gatewayChannels.enabled, true),
          auditedProvider,
          claimable,
          afterId ? gt(gatewayChannels.id, afterId) : undefined
        )
      )
      .orderBy(asc(gatewayChannels.id))
      .limit(limit)
      .all();
    return rows.map((row: GatewayChannelRow) => this.rowToChannel(row));
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
        provider_installation_id: row.provider_installation_id,
        provider_config_generation: row.provider_config_generation,
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
      provider_installation_id: data.provider_installation_id ?? null,
      provider_config_generation: data.provider_config_generation ?? 1,
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
    if (channelType === 'discord' && !isPostgresDatabase(this.db)) {
      throw new RepositoryError('Cannot enable Discord gateway channel: PostgreSQL is required');
    }
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
        // Only claimProviderInstallationIdentity may materialize this field.
        provider_installation_id: null,
      });

      this.assertRequiredSecretsWhenEnabled(data);

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
      return await runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, gatewayChannels, eq(gatewayChannels.id, fullId));
          const currentRow = await select(txDb)
            .from(gatewayChannels)
            .where(eq(gatewayChannels.id, fullId))
            .one();
          if (!currentRow) throw new EntityNotFoundError('GatewayChannel', id);
          const current = this.rowToChannel(currentRow);
          const now = await this.mutationNow(txDb, fullId);
          const preserveRevokedProbeTombstone =
            currentRow.channel_type === 'discord' &&
            !!currentRow.provider_probe_claim_token &&
            !!currentRow.provider_probe_lease_expires_at &&
            new Date(currentRow.provider_probe_lease_expires_at).getTime() > now.getTime();

          // Do not let a disabled-channel setup client overlap a newly enabled
          // listener. Other config mutations may revoke/fence the probe result,
          // but enabling waits until the short DB-time probe lease is gone.
          if (
            currentRow.channel_type === 'discord' &&
            !currentRow.enabled &&
            updates.enabled === true &&
            currentRow.provider_probe_claim_token &&
            currentRow.provider_probe_lease_expires_at &&
            new Date(currentRow.provider_probe_lease_expires_at).getTime() > now.getTime()
          ) {
            throw new ProviderProbeInProgressError();
          }

          // Merge updates, but preserve existing encrypted credentials if update has empty values.
          const merged = {
            ...current,
            ...updates,
            // Public/general repository updates cannot self-assert verification.
            provider_installation_id: current.provider_installation_id,
          };

          // The API redaction sentinel means "no change", never "store bullets".
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

          // Verified provider identity is bound to provider type plus the exact
          // bot credential/application pair and cannot survive their mutation.
          const providerBindingChanged =
            (updates.channel_type !== undefined && updates.channel_type !== current.channel_type) ||
            (updates.config !== undefined &&
              (merged.config.application_id !== current.config.application_id ||
                merged.config.bot_token !== current.config.bot_token));
          if (providerBindingChanged) merged.provider_installation_id = null;

          const providerConfigurationChanged =
            (updates.channel_type !== undefined && updates.channel_type !== current.channel_type) ||
            (updates.enabled !== undefined && updates.enabled !== current.enabled) ||
            (updates.config !== undefined && !isDeepStrictEqual(merged.config, current.config));
          const providerConfigGeneration =
            current.provider_config_generation + (providerConfigurationChanged ? 1 : 0);

          this.assertRequiredSecretsWhenEnabled(merged);
          const insertData = this.channelToInsert(merged);

          await update(txDb, gatewayChannels)
            .set({
              name: insertData.name,
              channel_type: insertData.channel_type,
              target_branch_id: insertData.target_branch_id,
              agor_user_id: insertData.agor_user_id,
              enabled: insertData.enabled,
              provider_installation_id: insertData.provider_installation_id,
              provider_config_generation: providerConfigGeneration,
              config: insertData.config,
              agentic_config: insertData.agentic_config,
              agentic_tool_preset_id: insertData.agentic_tool_preset_id,
              mcp_server_ids: insertData.mcp_server_ids,
              updated_at: now,
              // Every repository update revokes the process-local listener;
              // provider config generation separately decides action validity.
              listener_claim_token: null,
              listener_claimed_at: null,
              listener_lease_expires_at: null,
              listener_instance_id: null,
              listener_boot_id: null,
              listener_generation: sql`${gatewayChannels.listener_generation} + 1`,
              listener_checkpoint: null,
              listener_checkpoint_updated_at: null,
              // An update invalidates the exact config snapshot immediately,
              // but retains a live token/expiry as a serialization tombstone
              // until the old probe tears down and releases it. Otherwise a
              // second daemon could construct a new REST client during the
              // heartbeat's bounded fence-loss detection interval.
              provider_probe_claim_token: preserveRevokedProbeTombstone
                ? currentRow.provider_probe_claim_token
                : null,
              provider_probe_lease_expires_at: preserveRevokedProbeTombstone
                ? currentRow.provider_probe_lease_expires_at
                : null,
              provider_probe_config_generation: null,
              provider_probe_generation: preserveRevokedProbeTombstone
                ? currentRow.provider_probe_generation
                : sql`${gatewayChannels.provider_probe_generation} + 1`,
            })
            .where(eq(gatewayChannels.id, fullId))
            .run();

          if (providerConfigurationChanged) {
            await update(txDb, gatewayProviderActions)
              .set({
                status: 'canceled',
                canceled_at: now,
                last_error_code: 'provider_configuration_changed',
                claim_token: null,
                claim_expires_at: null,
                claim_listener_token: null,
                claim_listener_generation: null,
                claim_instance_id: null,
                claim_boot_id: null,
                updated_at: now,
              })
              .where(
                and(
                  eq(gatewayProviderActions.gateway_channel_id, fullId),
                  inArray(gatewayProviderActions.status, ['pending', 'processing', 'retry']),
                  ne(gatewayProviderActions.provider_config_generation, providerConfigGeneration)
                )
              )
              .run();
          }

          const updatedRow = await select(txDb)
            .from(gatewayChannels)
            .where(eq(gatewayChannels.id, fullId))
            .one();
          if (!updatedRow) throw new RepositoryError('Failed to retrieve updated gateway channel');
          return this.rowToChannel(updatedRow);
        },
        { sqliteImmediate: true }
      );
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
