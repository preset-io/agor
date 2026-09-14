import { eq, sql } from 'drizzle-orm';
import { lockBranchForAdmission } from './branch-admission';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase, select } from './database-wrapper';
import { RepositoryError } from './repositories/base';
import { kbNamespaces } from './schema';
import { requireCurrentTenantId } from './tenant-context';

/** Short reference mutations serialize before any Branch lock, including deletion scans. */
export async function lockBranchReferenceMutation(db: Database): Promise<void> {
  if (isPostgresDatabase(db)) {
    const key = `branch-deletion-references:${requireCurrentTenantId()}`;
    await executeRaw(
      db,
      sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
    );
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Fence new teammate dependencies at persistence, not only service preflight. */
export async function admitTeammateKnowledgeReferences(
  db: Database,
  context: unknown
): Promise<void> {
  if (!object(context)) return;
  await lockBranchReferenceMutation(db);
  const ids = new Set<string>();
  for (const name of ['teammate', 'assistant', 'agent']) {
    const config = context[name];
    if (!object(config) || !object(config.kb)) continue;
    const kb = config.kb;
    if (typeof kb.primary_namespace_id === 'string') ids.add(kb.primary_namespace_id);
    if (Array.isArray(kb.grants))
      for (const grant of kb.grants) {
        if (object(grant) && typeof grant.namespace_id === 'string') ids.add(grant.namespace_id);
      }
  }
  const owners = new Set<string>();
  for (const id of ids) {
    const namespace = await select(db)
      .from(kbNamespaces)
      .where(eq(kbNamespaces.namespace_id, id))
      .one();
    if (!namespace || namespace.archived)
      throw new RepositoryError('Teammate Knowledge namespace is unavailable');
    if (namespace.branch_id) owners.add(namespace.branch_id);
  }
  for (const owner of [...owners].sort()) await lockBranchForAdmission(db, owner);
}
