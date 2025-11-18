/**
 * Fix message-to-task linking for sessions where messages weren't linked to tasks
 *
 * This script identifies sessions where messages have task_id = NULL despite
 * tasks existing with message_range data, and fixes the links.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { and, count, eq, gte, isNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { messages, tasks } from '../schema';

const AGOR_DB_PATH = process.env.AGOR_DB_PATH || resolve(homedir(), '.agor/agor.db');

async function main() {
  console.log('🔧 Fixing message-to-task links...\n');

  // Connect to database
  const client = createClient({ url: `file:${AGOR_DB_PATH}` });
  const db = drizzle(client);

  // Find all tasks
  // biome-ignore lint/suspicious/noExplicitAny: SQLite-specific .all() method not available in unified Database type
  const allTasks = await (db as any).select().from(tasks).all();
  console.log(`Found ${allTasks.length} tasks total\n`);

  let fixedSessions = 0;
  let totalLinked = 0;

  // Group by session
  const tasksBySession = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
    const sessionTasks = tasksBySession.get(task.session_id) || [];
    sessionTasks.push(task);
    tasksBySession.set(task.session_id, sessionTasks);
  }

  // Process each session
  for (const [sessionId, sessionTasks] of tasksBySession) {
    // Check if this session has orphaned messages
    const orphanedCount = await db
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.session_id, sessionId), isNull(messages.task_id)))
      .all();

    if (!orphanedCount.length || orphanedCount[0] === null) {
      continue;
    }

    console.log(`Session ${sessionId.substring(0, 8)}: ${sessionTasks.length} tasks`);
    let linkedInSession = 0;

    // Link messages to tasks based on message_range
    for (const task of sessionTasks) {
      const data = task.data as {
        message_range?: {
          start_index?: number;
          end_index?: number;
        };
      };
      const messageRange = data.message_range;

      if (
        !messageRange ||
        messageRange.start_index === undefined ||
        messageRange.end_index === undefined
      ) {
        console.log(`  ⚠️  Task ${task.task_id.substring(0, 8)}: missing message_range`);
        continue;
      }

      // Update messages in this range
      const result = await db
        .update(messages)
        .set({ task_id: task.task_id })
        .where(
          and(
            eq(messages.session_id, sessionId),
            gte(messages.index, messageRange.start_index),
            lte(messages.index, messageRange.end_index),
            isNull(messages.task_id)
          )
        )
        .run();

      const updatedCount = result.rowsAffected || 0;
      linkedInSession += updatedCount;
    }

    if (linkedInSession > 0) {
      console.log(`  ✓ Linked ${linkedInSession} messages\n`);
      fixedSessions++;
      totalLinked += linkedInSession;
    }
  }

  console.log(`\n✅ Fixed ${fixedSessions} sessions (${totalLinked} messages linked)`);
  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
