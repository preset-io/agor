import { type SQL, sql } from 'drizzle-orm';
import type { BranchID } from '../types';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { requireCurrentTenantId } from './tenant-context';

export const BRANCH_DELETION_BATCH_SIZE = 100;

/** All identifiers below are private, static SQL, never supplied by a caller. */
interface DataStep {
  table: string;
  keys: string[];
  where: string;
  set?: string;
  sqliteOnly?: boolean;
}
const del = (table: string, key: string, where: string): DataStep => ({
  table,
  keys: key.split(','),
  where,
});
const clear = (table: string, key: string, column: string, owned: string): DataStep => ({
  table,
  keys: [key],
  where: `${column} IN (SELECT id FROM ${owned})`,
  set: `${column} = NULL`,
});

/**
 * Leaves before parents. Ownership derives from branch membership, NEVER fork
 * ancestry or a provenance FK. Permissions and the branch placement are kept
 * for finalization. Cascades are only a backstop after their children drained.
 */
export const BRANCH_DELETION_DATA_STEPS: readonly DataStep[] = [
  del(
    'kb_graph_edges',
    'edge_id',
    'source_node_id IN (SELECT id FROM og) OR target_node_id IN (SELECT id FROM og)'
  ),
  del('kb_graph_nodes', 'node_id', 'node_id IN (SELECT id FROM og)'),
  del(
    'discord_message_deliveries',
    'delivery_id',
    'message_id IN (SELECT id FROM om) OR gateway_channel_id IN (SELECT id FROM oc) OR thread_session_map_id IN (SELECT id FROM ox)'
  ),
  del('gateway_inbound_events', 'id', 'gateway_channel_id IN (SELECT id FROM oc)'),
  clear('gateway_inbound_events', 'id', 'session_id', 'os'),
  clear('gateway_inbound_events', 'id', 'task_id', 'ot'),
  clear('gateway_outbound_messages', 'id', 'emitted_by_session_id', 'os'),
  clear('gateway_outbound_messages', 'id', 'consumed_by_session_id', 'os'),
  clear('gateway_outbound_messages', 'id', 'emitted_by_task_id', 'ot'),
  clear('gateway_outbound_messages', 'id', 'emitted_by_schedule_id', 'oq'),
  del(
    'gateway_outbound_messages',
    'id',
    'gateway_channel_id IN (SELECT id FROM oc) OR target_branch_id IN (SELECT id FROM ob)'
  ),
  del('thread_session_map', 'id', 'id IN (SELECT id FROM ox)'),
  del('gateway_channels', 'id', 'id IN (SELECT id FROM oc)'),
  clear('artifacts', 'artifact_id', 'source_session_id', 'os'),
  clear('artifacts', 'artifact_id', 'branch_id', 'ob'),
  clear('board_comments', 'comment_id', 'parent_comment_id', 'ocom'),
  clear('board_comments', 'comment_id', 'session_id', 'os'),
  clear('board_comments', 'comment_id', 'task_id', 'ot'),
  clear('board_comments', 'comment_id', 'message_id', 'om'),
  del('board_comments', 'comment_id', 'branch_id IN (SELECT id FROM ob)'),
  clear('kb_documents', 'document_id', 'updated_by_session_id', 'os'),
  clear('kb_document_versions', 'version_id', 'created_by_session_id', 'os'),
  {
    table: 'kb_documents',
    keys: ['document_id'],
    where: 'document_id IN (SELECT id FROM od) AND current_version_id IS NOT NULL',
    set: 'current_version_id = NULL',
  },
  del('kb_document_units', 'unit_id', 'unit_id IN (SELECT id FROM ou)'),
  del('kb_document_versions', 'version_id', 'document_id IN (SELECT id FROM od)'),
  del('kb_documents', 'document_id', 'document_id IN (SELECT id FROM od)'),
  del('kb_namespace_acl', 'namespace_acl_id', 'namespace_id IN (SELECT id FROM onsp)'),
  del('kb_namespaces', 'namespace_id', 'namespace_id IN (SELECT id FROM onsp)'),
  clear('kb_namespaces', 'namespace_id', 'branch_id', 'ob'),
  del('session_mcp_servers', 'session_id,mcp_server_id', 'session_id IN (SELECT id FROM os)'),
  del('session_env_selections', 'session_id,env_var_name', 'session_id IN (SELECT id FROM os)'),
  del(
    'session_relationships',
    'relationship_id',
    'source_session_id IN (SELECT id FROM os) OR target_session_id IN (SELECT id FROM os)'
  ),
  {
    table: 'session_relationships',
    keys: ['relationship_id'],
    where: 'callback_session_id IN (SELECT id FROM os)',
    set: 'callback_enabled = false, callback_session_id = NULL',
  },
  clear('sessions', 'session_id', 'parent_session_id', 'os'),
  clear('sessions', 'session_id', 'forked_from_session_id', 'os'),
  clear('sessions', 'session_id', 'schedule_id', 'oq'),
  clear('schedules', 'schedule_id', 'last_run_session_id', 'os'),
  // A foreign-session message is not owned merely because it names an owned task.
  {
    table: 'messages',
    keys: ['message_id'],
    where: 'task_id IN (SELECT id FROM ot) AND session_id NOT IN (SELECT id FROM os)',
    set: 'task_id = NULL',
  },
  del('messages', 'message_id', 'session_id IN (SELECT id FROM os)'),
  del('tasks', 'task_id', 'session_id IN (SELECT id FROM os)'),
  del('sessions', 'session_id', 'branch_id IN (SELECT id FROM ob)'),
  del('schedules', 'schedule_id', 'branch_id IN (SELECT id FROM ob)'),
  clear('boards', 'board_id', 'primary_teammate_id', 'ob'),
  { ...clear('boards', 'board_id', 'primary_assistant_id', 'ob'), sqliteOnly: true },
];

function ownership(branchId: BranchID): SQL {
  return sql`WITH ob AS (SELECT ${branchId} AS id),
    os AS (SELECT session_id AS id FROM sessions WHERE branch_id IN (SELECT id FROM ob)),
    ot AS (SELECT task_id AS id FROM tasks WHERE session_id IN (SELECT id FROM os)),
    om AS (SELECT message_id AS id FROM messages WHERE session_id IN (SELECT id FROM os)),
    oq AS (SELECT schedule_id AS id FROM schedules WHERE branch_id IN (SELECT id FROM ob)),
    oc AS (SELECT id FROM gateway_channels WHERE target_branch_id IN (SELECT id FROM ob)),
    ox AS (SELECT id FROM thread_session_map WHERE branch_id IN (SELECT id FROM ob)
      OR session_id IN (SELECT id FROM os) OR channel_id IN (SELECT id FROM oc)),
    ocom AS (SELECT comment_id AS id FROM board_comments WHERE branch_id IN (SELECT id FROM ob)),
    onsp AS (SELECT namespace_id AS id FROM kb_namespaces WHERE kind = 'branch' AND branch_id IN (SELECT id FROM ob)),
    od AS (SELECT document_id AS id FROM kb_documents WHERE namespace_id IN (SELECT id FROM onsp)),
    ou AS (SELECT unit_id AS id FROM kb_document_units WHERE document_id IN (SELECT id FROM od)),
    og AS (SELECT node_id AS id FROM kb_graph_nodes WHERE namespace_id IN (SELECT id FROM onsp)
      OR document_id IN (SELECT id FROM od) OR unit_id IN (SELECT id FROM ou)
      OR branch_id IN (SELECT id FROM ob) OR session_id IN (SELECT id FROM os)
      OR task_id IN (SELECT id FROM ot) OR message_id IN (SELECT id FROM om))`;
}

/** Caller MUST hold the invocation's Branch lock and trusted tenant scope. */
export async function deleteBranchDataBatch(
  db: Database,
  branchId: BranchID,
  preserveAuthorityId: string
): Promise<{ remaining: boolean; table?: string; changed: number }> {
  const prefix = ownership(branchId);
  // Bytes must be removed by their storage owner before their lookup rows or
  // owning sessions are deleted. Conflicting plain-ID bindings also block here.
  const uploads = rawRows(
    await executeRaw(
      db,
      sql`${prefix} SELECT upload_ref FROM uploads
    WHERE branch_id IN (SELECT id FROM ob) OR session_id IN (SELECT id FROM os) LIMIT 1`
    )
  );
  if (uploads.length)
    throw new Error('Required upload storage remains; remove it before database cleanup');

  // Security tombstones retain only their existing authority fields until the
  // existing expiry sweep. Never delete live authority ahead of its task owner.
  const revokedAt = isPostgresDatabase(db) ? sql`clock_timestamp()` : sql`${Date.now()}`;
  const revoked = rawRows(
    await executeRaw(
      db,
      sql`${prefix} UPDATE executor_session_token_authorities SET revoked_at = ${revokedAt}
    WHERE token_fingerprint IN (SELECT token_fingerprint FROM executor_session_token_authorities
      WHERE revoked_at IS NULL AND session_id <> ${preserveAuthorityId} AND (branch_id IN (SELECT id FROM ob)
        OR session_id IN (SELECT id FROM os) OR task_id IN (SELECT id FROM ot))
      ORDER BY token_fingerprint LIMIT ${BRANCH_DELETION_BATCH_SIZE}) RETURNING token_fingerprint`
    )
  );
  if (revoked.length)
    return {
      remaining: true,
      table: 'executor_session_token_authorities',
      changed: revoked.length,
    };

  if (isPostgresDatabase(db)) {
    const exists = rawRows(
      await executeRaw(db, sql`SELECT to_regclass('public.kb_unit_embeddings') AS name`)
    );
    if (exists[0]?.name) {
      const tenantId = requireCurrentTenantId();
      const result = rawRows(
        await executeRaw(
          db,
          sql`${prefix} DELETE FROM kb_unit_embeddings WHERE tenant_id = ${tenantId} AND (unit_id, embedding_space_id) IN
        (SELECT unit_id, embedding_space_id FROM kb_unit_embeddings WHERE tenant_id = ${tenantId} AND unit_id IN (SELECT id FROM ou) ORDER BY unit_id, embedding_space_id LIMIT ${BRANCH_DELETION_BATCH_SIZE}) RETURNING unit_id`
        )
      );
      if (result.length)
        return { remaining: true, table: 'kb_unit_embeddings', changed: result.length };
    }
  }
  for (const step of BRANCH_DELETION_DATA_STEPS) {
    if (step.sqliteOnly && isPostgresDatabase(db)) continue;
    const keys = step.keys.map((key) => `"${key}"`).join(', ');
    const tuple = step.keys.length > 1 ? `(${keys})` : keys;
    const verb = step.set
      ? `UPDATE "${step.table}" SET ${step.set}`
      : `DELETE FROM "${step.table}"`;
    const query = `${verb} WHERE ${tuple} IN (SELECT ${keys} FROM "${step.table}" WHERE ${step.where}
      ORDER BY ${keys} LIMIT ${BRANCH_DELETION_BATCH_SIZE}) RETURNING ${keys}`;
    const result = rawRows(await executeRaw(db, sql`${prefix} ${sql.raw(query)}`));
    if (result.length) return { remaining: true, table: step.table, changed: result.length };
  }
  return { remaining: false, changed: 0 };
}
