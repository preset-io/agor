import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { isSQLiteDatabase, rawRows } from '../database-wrapper';
import { messages } from '../schema';

export interface LatestAssistantMessageRow {
  session_id: string;
  data: unknown;
}

/**
 * Return one (deterministically selected) assistant message per session.
 *
 * This is intentionally a single set-based query. The two-stage aggregate
 * keeps the work driven by the requested sessions: first find the greatest
 * assistant index, then use message_id as a deterministic tie-breaker. This
 * avoids scanning every candidate message with a correlated NOT EXISTS for
 * every row in a long transcript and remains portable across SQLite and
 * PostgreSQL.
 */
export async function findLatestAssistantMessages(
  db: Database,
  sessionIds: string[]
): Promise<LatestAssistantMessageRow[]> {
  if (sessionIds.length === 0) return [];

  const sessionFilter = inArray(messages.session_id, sessionIds);
  const query = sql`WITH assistant_max_index AS (
          SELECT ${messages.session_id} AS session_id,
                 MAX(${messages.index}) AS max_index
          FROM ${messages}
          WHERE ${messages.role} = 'assistant'
            AND ${sessionFilter}
          GROUP BY ${messages.session_id}
        ), assistant_max_id AS (
          SELECT ${messages.session_id} AS session_id,
                 MAX(${messages.message_id}) AS message_id
          FROM ${messages}
          INNER JOIN assistant_max_index
            ON assistant_max_index.session_id = ${messages.session_id}
           AND assistant_max_index.max_index = ${messages.index}
          WHERE ${messages.role} = 'assistant'
          GROUP BY ${messages.session_id}
        )
        SELECT ${messages.session_id} AS session_id,
               ${messages.data} AS data
        FROM ${messages}
        INNER JOIN assistant_max_id
          ON assistant_max_id.session_id = ${messages.session_id}
         AND assistant_max_id.message_id = ${messages.message_id}
        WHERE ${messages.role} = 'assistant'`;
  // Drizzle's SQLite `run` is mutation-only; use `all` for a raw SELECT while
  // PostgreSQL's `execute` returns rows directly. Keep the dialect branch here
  // so callers still get one SQL statement on either backend.
  const result = isSQLiteDatabase(db)
    ? await (db as unknown as { all(statement: unknown): Promise<unknown> }).all(query)
    : await (db as unknown as { execute(statement: unknown): Promise<unknown> }).execute(query);

  return rawRows<{ session_id: string; data: unknown }>(result).map((row) => ({
    session_id: row.session_id,
    // Raw SQLite queries do not apply Drizzle's JSON decoder. PostgreSQL
    // already returns jsonb as an object, so only decode string payloads.
    data: typeof row.data === 'string' ? parseJsonData(row.data) : row.data,
  }));
}

function parseJsonData(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function extractMessageText(data: unknown): string {
  const content = (data as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n');
}

export function truncateMessageText(text: string, length: number): string {
  return text.length > length ? `${text.substring(0, length)}...` : text;
}
