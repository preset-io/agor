import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { isSQLiteDatabase, select, update } from '../database-wrapper';
import { messages, tasks } from '../schema';

/**
 * Snapshot at terminalization, under the Task lock. Only IDs cross the SQL
 * boundary (never arguments/results). The database still parses stored JSON;
 * do this once on completion, not on history reads or every streamed message.
 * Include result-only references so their recorded activity stays reachable.
 */
export async function countRecordedTools(db: Database, taskId: string): Promise<number | null> {
  const ids: SQL = isSQLiteDatabase(db)
    ? sql`(SELECT json_group_array(id) FROM (
        SELECT CASE WHEN json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.type') = 'tool_result'
          THEN json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.tool_use_id') ELSE json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.id') END AS id
        FROM json_each(CASE WHEN json_type(${messages.data}, '$.content') = 'array'
          THEN json_extract(${messages.data}, '$.content') ELSE '[]' END)
        WHERE json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.type') IN ('tool_use', 'tool_result')
        UNION ALL
        SELECT json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.id') FROM json_each(
          CASE WHEN json_type(${messages.data}, '$.tool_uses') = 'array'
            THEN json_extract(${messages.data}, '$.tool_uses') ELSE '[]' END)
      ))`
    : sql`(SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM (
        SELECT CASE WHEN block ->> 'type' = 'tool_result'
          THEN block ->> 'tool_use_id' ELSE block ->> 'id' END AS id
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${messages.data}::jsonb -> 'content') = 'array'
          THEN ${messages.data}::jsonb -> 'content' ELSE '[]'::jsonb END) AS b(block)
        WHERE block ->> 'type' IN ('tool_use', 'tool_result')
        UNION ALL
        SELECT block ->> 'id' FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(${messages.data}::jsonb -> 'tool_uses') = 'array'
            THEN ${messages.data}::jsonb -> 'tool_uses' ELSE '[]'::jsonb END) AS b(block)
      ) AS refs)`;
  const omitted = isSQLiteDatabase(db)
    ? sql`json_extract(${messages.data}, '$.metadata.persistence_omission') IS NOT NULL`
    : sql`${messages.data}::jsonb -> 'metadata' -> 'persistence_omission' IS NOT NULL`;
  const rows = await select(db, { ids, omitted })
    .from(messages)
    .where(eq(messages.task_id, taskId))
    .all();
  const unique = new Set<string>();
  for (const row of rows) {
    if (row.omitted) return null;
    const references: unknown = typeof row.ids === 'string' ? JSON.parse(row.ids) : row.ids;
    if (!Array.isArray(references)) return null;
    for (const id of references) {
      if (typeof id !== 'string' || !id) return null;
      unique.add(id);
    }
  }
  return unique.size;
}

/** Caller holds the Task lock in the transcript-mutation transaction.
 * Avoid rewriting large Task JSON on every live message when already unknown. */
export async function invalidateRecordedToolCount(db: Database, taskId: string): Promise<void> {
  await update(db, tasks)
    .set({
      data: isSQLiteDatabase(db)
        ? sql`json_set(${tasks.data}, '$.recorded_tool_count', NULL)`
        : sql`jsonb_set(${tasks.data}::jsonb, '{recorded_tool_count}', 'null'::jsonb)`,
    })
    .where(
      and(
        eq(tasks.task_id, taskId),
        isSQLiteDatabase(db)
          ? sql`json_extract(${tasks.data}, '$.recorded_tool_count') IS NOT NULL`
          : sql`${tasks.data}::jsonb ->> 'recorded_tool_count' IS NOT NULL`
      )
    )
    .run();
}
