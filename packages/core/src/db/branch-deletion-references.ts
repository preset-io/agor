import { sql } from 'drizzle-orm';
import type { BranchDeletionReferenceCursor, BranchID } from '../types';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';

const SCANS = [
  { table: 'sessions', key: 'session_id' },
  { table: 'tasks', key: 'task_id' },
  { table: 'board_comments', key: 'comment_id' },
  { table: 'users', key: 'user_id' },
  { table: 'branches', key: 'branch_id' },
] as const;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const REFERENCE_KEYS = new Set([
  'session_id',
  'task_id',
  'branch_id',
  'child_session_id',
  'child_task_id',
  'target_session_id',
  'queued_task_id',
  'requested_from_session_id',
  'fork_point_task_id',
  'spawn_point_task_id',
  'parent_session_id',
  'forked_from_session_id',
  'primary_teammate_id',
  'primary_assistant_id',
]);

// Traverse only schema-owned paths, never arbitrary structured user context.
const REFERENCE_PATHS = new Set([
  'genealogy',
  'callback_config',
  'metadata',
  'position',
  'custom_context',
  ...['teammate', 'assistant', 'agent'].flatMap((name) => [
    `custom_context.${name}`,
    `custom_context.${name}.kb`,
  ]),
]);

/** Only canonical metadata paths change; caller-defined JSON remains intact. */
export function scrubBranchDeletionReferences(
  value: unknown,
  owned: ReadonlySet<string>,
  path = ''
): unknown {
  if (!object(value)) return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (path === 'custom_context' || /^custom_context\.(teammate|assistant|agent)$/.test(path)) {
      result[key] = REFERENCE_PATHS.has(childPath)
        ? scrubBranchDeletionReferences(item, owned, childPath)
        : item;
      continue;
    }
    if (REFERENCE_KEYS.has(key) && typeof item === 'string' && owned.has(item)) continue;
    if (key === 'primary_namespace_id' && typeof item === 'string' && owned.has(item)) {
      throw new Error(
        'A surviving teammate depends on this branch Knowledge namespace; change its primary namespace before deletion'
      );
    }
    if (
      key === 'callback_config' &&
      object(item) &&
      typeof item.callback_session_id === 'string' &&
      owned.has(item.callback_session_id)
    ) {
      result[key] = { ...item, enabled: false, callback_session_id: undefined };
      continue;
    }
    if (
      key === 'completion_callback' &&
      object(item) &&
      [item.target_session_id, item.requested_from_session_id].some(
        (id) => typeof id === 'string' && owned.has(id)
      )
    )
      continue;
    if (
      key === 'relative' &&
      object(item) &&
      typeof item.parent_id === 'string' &&
      owned.has(item.parent_id) &&
      (item.parent_type === 'branch' || item.parent_type === 'session')
    )
      continue;
    if (key === 'children' && Array.isArray(item)) {
      result[key] = item.filter((id) => typeof id !== 'string' || !owned.has(id));
      continue;
    }
    if ((key === 'grants' || key === 'callback_dispatches') && Array.isArray(item)) {
      result[key] = item.filter(
        (entry) =>
          !object(entry) ||
          ![entry.namespace_id, entry.target_session_id, entry.queued_task_id].some(
            (id) => typeof id === 'string' && owned.has(id)
          )
      );
      continue;
    }
    result[key] = REFERENCE_PATHS.has(childPath)
      ? scrubBranchDeletionReferences(item, owned, childPath)
      : item;
  }
  return result;
}

function collectIds(value: unknown, ids: Set<string>, path = '') {
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (REFERENCE_PATHS.has(childPath)) collectIds(item, ids, childPath);
    if (path === 'custom_context' || /^custom_context\.(teammate|assistant|agent)$/.test(path))
      continue;
    if (
      (REFERENCE_KEYS.has(key) ||
        key === 'primary_namespace_id' ||
        key === 'callback_session_id') &&
      typeof item === 'string'
    )
      ids.add(item);
    if (key === 'children' && Array.isArray(item))
      for (const id of item) if (typeof id === 'string') ids.add(id);
    if (['relative', 'completion_callback'].includes(key) && object(item)) {
      for (const field of ['parent_id', 'target_session_id', 'requested_from_session_id'])
        if (typeof item[field] === 'string') ids.add(item[field]);
    }
    if (['grants', 'callback_dispatches'].includes(key) && Array.isArray(item))
      for (const entry of item) {
        if (object(entry))
          for (const field of ['namespace_id', 'target_session_id', 'queued_task_id'])
            if (typeof entry[field] === 'string') ids.add(entry[field]);
      }
  }
  if (ids.size > 1000)
    throw new Error('Structured deletion references exceed the bounded reconciliation limit');
}

/**
 * One bounded keyset page before any owning session/task/namespace is removed.
 * The cursor lives in the branch's private claim; no growing resource manifest.
 * Call under the invocation Branch lock. No external work in this transaction.
 */
export async function reconcileBranchDeletionReferencesBatch(
  db: Database,
  branchId: BranchID,
  cursor: BranchDeletionReferenceCursor = { table: 0 }
): Promise<{ done: boolean; cursor: BranchDeletionReferenceCursor }> {
  const scan = SCANS[cursor.table];
  if (!scan) return { done: true, cursor };
  const where =
    scan.table === 'branches'
      ? sql`AND branch_id <> ${branchId}`
      : scan.table === 'sessions'
        ? sql`AND branch_id <> ${branchId}`
        : scan.table === 'tasks'
          ? sql`AND session_id NOT IN (SELECT session_id FROM sessions WHERE branch_id = ${branchId})`
          : sql``;
  const rows = rawRows(
    await executeRaw(
      db,
      sql`SELECT ${sql.identifier(scan.key)} AS id, data FROM ${sql.identifier(scan.table)}
    WHERE ${sql.identifier(scan.key)} > ${cursor.after ?? ''} ${where} ORDER BY ${sql.identifier(scan.key)} LIMIT 25 ${isPostgresDatabase(db) ? sql`FOR UPDATE` : sql``}`
    )
  );
  for (const row of rows) {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (!object(data)) continue;
    // Restrict traversal to application-owned metadata; never inspect message
    // content, prompt text, environment secrets, or arbitrary branch config.
    const selected =
      scan.table === 'sessions'
        ? {
            genealogy: data.genealogy,
            callback_config: data.callback_config,
          }
        : scan.table === 'tasks'
          ? { metadata: data.metadata }
          : scan.table === 'board_comments'
            ? { position: data.position }
            : scan.table === 'users'
              ? {
                  primary_teammate_id: data.primary_teammate_id,
                  primary_assistant_id: data.primary_assistant_id,
                }
              : { custom_context: data.custom_context };
    const ids = new Set<string>();
    collectIds(selected, ids);
    const owned = new Set<string>([branchId]);
    if (ids.size) {
      const list = sql.join(
        [...ids].map((id) => sql`${id}`),
        sql`, `
      );
      const found = rawRows(
        await executeRaw(
          db,
          sql`
        SELECT session_id AS id FROM sessions WHERE branch_id = ${branchId} AND session_id IN (${list})
        UNION ALL SELECT task_id AS id FROM tasks WHERE session_id IN (SELECT session_id FROM sessions WHERE branch_id = ${branchId}) AND task_id IN (${list})
        UNION ALL SELECT namespace_id AS id FROM kb_namespaces WHERE branch_id = ${branchId} AND kind = 'branch' AND namespace_id IN (${list})`
        )
      );
      for (const item of found) owned.add(String(item.id));
    }
    const scrubbed = scrubBranchDeletionReferences(selected, owned) as JsonObject;
    if (JSON.stringify(selected) === JSON.stringify(scrubbed)) continue;
    const next = { ...data };
    for (const key of Object.keys(selected)) {
      if (Object.hasOwn(scrubbed, key) && scrubbed[key] !== undefined) next[key] = scrubbed[key];
      else delete next[key];
    }
    const encoded = JSON.stringify(next);
    await executeRaw(
      db,
      sql`UPDATE ${sql.identifier(scan.table)} SET data = ${isPostgresDatabase(db) ? sql`${encoded}::jsonb` : sql`${encoded}`}
      WHERE ${sql.identifier(scan.key)} = ${String(row.id)}`
    );
  }
  return {
    done: false,
    cursor: rows.length
      ? { table: cursor.table, after: String(rows[rows.length - 1]!.id) }
      : { table: cursor.table + 1 },
  };
}
