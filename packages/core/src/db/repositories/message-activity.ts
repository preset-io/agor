import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { messages } from '../schema';

export interface LatestAssistantMessageRow {
  session_id: string;
  data: unknown;
}

/**
 * Return one (deterministically selected) assistant message per session.
 *
 * This is intentionally a single set-based query.  A correlated NOT EXISTS
 * keeps it portable across SQLite and PostgreSQL and lets the existing
 * `(session_id, index)` index do the work without loading complete transcripts.
 */
export async function findLatestAssistantMessages(
  db: Database,
  sessionIds: string[]
): Promise<LatestAssistantMessageRow[]> {
  if (sessionIds.length === 0) return [];

  const latest = sql`NOT EXISTS (
    SELECT 1
    FROM "messages" AS newer
    WHERE newer."session_id" = ${messages.session_id}
      AND newer."role" = 'assistant'
      AND (
        newer."index" > ${messages.index}
        OR (
          newer."index" = ${messages.index}
          AND newer."message_id" > ${messages.message_id}
        )
      )
  )`;

  const rows = await select(db, {
    session_id: messages.session_id,
    data: messages.data,
  })
    .from(messages)
    .where(and(inArray(messages.session_id, sessionIds), eq(messages.role, 'assistant'), latest))
    .all();

  return rows as LatestAssistantMessageRow[];
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
