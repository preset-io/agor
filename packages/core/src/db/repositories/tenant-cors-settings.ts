import { and, desc, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  type StoredTenantCorsSettings,
  TENANT_CORS_SETTINGS_ID,
  type TenantCorsAuditEvent,
  type UserID,
} from '../../types';
import type { Database } from '../client';
import {
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  type TenantCorsAuditEventInsert,
  type TenantCorsAuditEventRow,
  type TenantCorsSettingsInsert,
  type TenantCorsSettingsRow,
  tenantCorsAuditEvents,
  tenantCorsSettings,
} from '../schema';

export class TenantCorsRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number
  ) {
    super(
      `Tenant CORS settings changed since they were loaded ` +
        `(expected revision ${expectedRevision}, current revision ${actualRevision})`
    );
    this.name = 'TenantCorsRevisionConflictError';
  }
}

function jsonStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') {
    try {
      return jsonStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function rowToSettings(row: TenantCorsSettingsRow | null): StoredTenantCorsSettings {
  if (!row) return { revision: 0, origins: [] };
  return {
    revision: row.revision,
    origins: jsonStringArray(row.origins),
    ...(row.updated_by ? { updated_by: row.updated_by as UserID } : {}),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function rowToAuditEvent(row: TenantCorsAuditEventRow): TenantCorsAuditEvent {
  return {
    event_id: row.event_id,
    revision: row.revision,
    added_origins: jsonStringArray(row.added_origins),
    removed_origins: jsonStringArray(row.removed_origins),
    ...(row.actor_user_id ? { actor_user_id: row.actor_user_id as UserID } : {}),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Typed, tenant-scoped persistence for the live origin list.
 *
 * PostgreSQL tenant isolation is supplied by the ambient tenant database
 * scope and forced RLS. SQLite has one `current` row in static mode.
 */
export class TenantCorsSettingsRepository {
  constructor(private readonly db: Database) {}

  async get(): Promise<StoredTenantCorsSettings> {
    const row = (await select(this.db)
      .from(tenantCorsSettings)
      .where(eq(tenantCorsSettings.settings_id, TENANT_CORS_SETTINGS_ID))
      .one()) as TenantCorsSettingsRow | null;
    return rowToSettings(row);
  }

  async replace(
    origins: string[],
    expectedRevision: number,
    actorUserId: UserID | null
  ): Promise<StoredTenantCorsSettings> {
    try {
      return await runDatabaseTransaction(
        this.db,
        async (tx) => {
          await lockRowForUpdate(
            tx,
            this.db,
            tenantCorsSettings,
            eq(tenantCorsSettings.settings_id, TENANT_CORS_SETTINGS_ID)
          );
          const row = (await select(tx)
            .from(tenantCorsSettings)
            .where(eq(tenantCorsSettings.settings_id, TENANT_CORS_SETTINGS_ID))
            .one()) as TenantCorsSettingsRow | null;
          const current = rowToSettings(row);
          if (current.revision !== expectedRevision) {
            throw new TenantCorsRevisionConflictError(expectedRevision, current.revision);
          }
          if (
            current.origins.length === origins.length &&
            current.origins.every((origin, index) => origin === origins[index])
          ) {
            return current;
          }

          const now = new Date();
          const revision = current.revision + 1;
          let savedRow: TenantCorsSettingsRow;
          if (row) {
            savedRow = (await update(tx, tenantCorsSettings)
              .set({
                revision,
                origins,
                updated_by: actorUserId,
                updated_at: now,
              })
              .where(
                and(
                  eq(tenantCorsSettings.settings_id, TENANT_CORS_SETTINGS_ID),
                  eq(tenantCorsSettings.revision, expectedRevision)
                )
              )
              .returning()
              .one()) as TenantCorsSettingsRow;
          } else {
            const values: TenantCorsSettingsInsert = {
              settings_id: TENANT_CORS_SETTINGS_ID,
              revision,
              origins,
              updated_by: actorUserId,
              created_at: now,
              updated_at: now,
            };
            savedRow = (await insert(tx, tenantCorsSettings)
              .values(values)
              .returning()
              .one()) as TenantCorsSettingsRow;
          }

          const previous = new Set(current.origins);
          const next = new Set(origins);
          const audit: TenantCorsAuditEventInsert = {
            event_id: generateId(),
            revision,
            added_origins: origins.filter((origin) => !previous.has(origin)),
            removed_origins: current.origins.filter((origin) => !next.has(origin)),
            actor_user_id: actorUserId,
            created_at: now,
          };
          await insert(tx, tenantCorsAuditEvents).values(audit).run();
          return rowToSettings(savedRow);
        },
        { sqliteImmediate: true }
      );
    } catch (error) {
      if (error instanceof TenantCorsRevisionConflictError) throw error;

      // Two first writers cannot lock a row that does not exist yet. The
      // losing insert is still safe (the singleton key rejects it), but map
      // that database-level race back to the same revision-conflict contract.
      const latest = await this.get();
      if (latest.revision !== expectedRevision) {
        throw new TenantCorsRevisionConflictError(expectedRevision, latest.revision);
      }
      throw error;
    }
  }

  async listAuditEvents(limit = 20): Promise<TenantCorsAuditEvent[]> {
    const rows = (await select(this.db)
      .from(tenantCorsAuditEvents)
      .orderBy(desc(tenantCorsAuditEvents.revision))
      .limit(Math.max(1, Math.min(limit, 100)))
      .all()) as TenantCorsAuditEventRow[];
    return rows.map(rowToAuditEvent);
  }
}
