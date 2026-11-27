import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw, insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { scheduledCodexRetirements as records } from '../schema';
import { scheduledCodexRetirements as pgRecords } from '../schema.postgres';
import { requireCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

type Retirement = typeof records.$inferSelect;

function tenantCondition(db: Database) {
  return isPostgresDatabase(db) ? eq(pgRecords.tenant_id, requireCurrentTenantId()) : undefined;
}

/** Codex accepts alternate UUID spellings for the same thread. */
export function normalizeCodexThreadHandle(handle: unknown): string | undefined {
  if (typeof handle !== 'string') return;
  const value = handle
    .toLowerCase()
    .replace(/^urn:uuid:/, '')
    .replace(/^\{([\da-f-]+)\}$/, '$1');
  if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value)) return value;
  if (/^[\da-f]{32}$/.test(value)) {
    return [
      value.slice(0, 8),
      value.slice(8, 12),
      value.slice(12, 16),
      value.slice(16, 20),
      value.slice(20),
    ].join('-');
  }
}

export async function lockCodexThreadReference(db: Database, branchId: string, threadId: string) {
  if (isPostgresDatabase(db)) {
    const key = `codex-thread:${requireCurrentTenantId()}:${branchId}:${threadId}`;
    await executeRaw(
      db,
      sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
    );
  }
}

/** Serialize a new native-thread reference with the retention tombstone. */
export async function admitCodexThreadReference(
  db: Database,
  branchId: string,
  threadId: string
): Promise<void> {
  const canonical = normalizeCodexThreadHandle(threadId);
  if (!canonical) return;
  await lockCodexThreadReference(db, branchId, canonical);
  const found = await select(db)
    .from(records)
    .where(
      and(tenantCondition(db), eq(records.branch_id, branchId), eq(records.thread_id, canonical))
    )
    .one();
  if (found) throw new RepositoryError('That Codex thread is being retired');
}

export class ScheduledCodexRetirementRepository {
  constructor(private readonly db: Database) {}

  /** Call inside the transaction deleting the original Agor session. */
  async stage(target: Pick<Retirement, 'session_id' | 'branch_id' | 'user_id' | 'thread_id'>) {
    await insert(this.db, records)
      .values({
        ...target,
        ...(isPostgresDatabase(this.db) ? { tenant_id: requireCurrentTenantId() } : {}),
        next_attempt_at: new Date(),
      })
      .onConflictDoNothing()
      .run();
  }

  async due(now: Date, limit: number) {
    return select(this.db)
      .from(records)
      .where(
        and(tenantCondition(this.db), isNull(records.retired_at), lte(records.next_attempt_at, now))
      )
      .orderBy(asc(records.next_attempt_at), asc(records.session_id))
      .limit(limit)
      .all();
  }

  async claim(sessionId: string, now: Date, retryAt: Date) {
    return update(this.db, records)
      .set({ next_attempt_at: retryAt })
      .where(
        and(
          tenantCondition(this.db),
          eq(records.session_id, sessionId),
          isNull(records.retired_at),
          lte(records.next_attempt_at, now)
        )
      )
      .returning()
      .one();
  }

  /** System scheduler discovery exposes routing identities only. */
  async dueTenants(now: Date, limit: number) {
    if (!isPostgresDatabase(this.db)) return [];
    return select(this.db, { tenantId: pgRecords.tenant_id })
      .from(pgRecords)
      .where(and(isNull(pgRecords.retired_at), lte(pgRecords.next_attempt_at, now)))
      .groupBy(pgRecords.tenant_id)
      .orderBy(sql`min(${pgRecords.next_attempt_at})`, asc(pgRecords.tenant_id))
      .limit(limit)
      .all();
  }

  async settle(item: Retirement, now: Date) {
    await update(this.db, records)
      .set({ retired_at: now })
      .where(
        and(
          tenantCondition(this.db),
          eq(records.session_id, item.session_id),
          eq(records.next_attempt_at, item.next_attempt_at),
          isNull(records.retired_at)
        )
      )
      .run();
  }
}
