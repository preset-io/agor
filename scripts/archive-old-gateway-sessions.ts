#!/usr/bin/env tsx

/**
 * Archive Old Gateway Sessions
 *
 * One-time cleanup script that archives gateway sessions older than a specified
 * number of days. Gateway sessions are identified by having `custom_context.gateway_source`.
 *
 * Usage:
 *   pnpm tsx scripts/archive-old-gateway-sessions.ts [--days <n>] [--dry-run] [--execute]
 *
 * Options:
 *   --days <n>    Archive sessions older than n days (default: 7)
 *   --dry-run     Preview which sessions would be archived (default behavior)
 *   --execute     Actually archive the sessions (must be explicit)
 *
 * Examples:
 *   pnpm tsx scripts/archive-old-gateway-sessions.ts                    # dry-run, 7 days
 *   pnpm tsx scripts/archive-old-gateway-sessions.ts --days 14          # dry-run, 14 days
 *   pnpm tsx scripts/archive-old-gateway-sessions.ts --execute          # archive, 7 days
 *   pnpm tsx scripts/archive-old-gateway-sessions.ts --days 3 --execute # archive, 3 days
 */

import os from 'node:os';
import path from 'node:path';
import { createDatabase, SessionRepository } from '@agor/core/db';
import { getGatewaySource, isGatewaySession } from '@agor/core/types';

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const daysIndex = args.indexOf('--days');
  const days = daysIndex !== -1 ? Number.parseInt(args[daysIndex + 1], 10) : 7;

  if (Number.isNaN(days) || days < 1) {
    console.error('Error: --days must be a positive integer');
    process.exit(1);
  }

  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`\n📋 Archive Old Gateway Sessions`);
  console.log(`   Mode: ${execute ? '🔴 EXECUTE' : '🟡 DRY RUN'}`);
  console.log(`   Cutoff: ${days} days (before ${cutoffDate.toISOString()})`);
  console.log('');

  // Connect to database (same pattern as scripts/get-admin-id.ts)
  const dialect = process.env.AGOR_DB_DIALECT;
  let databaseUrl: string;
  if (dialect === 'postgresql') {
    databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/agor';
  } else {
    const dbPath = path.join(os.homedir(), '.agor', 'agor.db');
    databaseUrl = process.env.DATABASE_URL || `file:${dbPath}`;
  }

  const db = createDatabase({ url: databaseUrl });
  const sessionRepo = new SessionRepository(db);

  // Fetch all sessions
  const allSessions = await sessionRepo.findAll();
  console.log(`   Total sessions: ${allSessions.length}`);

  // Filter to non-archived gateway sessions older than cutoff
  const toArchive = allSessions.filter((s) => {
    if (s.archived) return false;
    if (!isGatewaySession(s)) return false;
    const lastUpdated = new Date(s.last_updated || s.created_at);
    return lastUpdated < cutoffDate;
  });

  const gatewayCount = allSessions.filter((s) => isGatewaySession(s) && !s.archived).length;
  console.log(`   Active gateway sessions: ${gatewayCount}`);
  console.log(`   Gateway sessions older than ${days} days: ${toArchive.length}`);
  console.log('');

  if (toArchive.length === 0) {
    console.log('✅ No gateway sessions to archive.');
    process.exit(0);
  }

  // Show preview
  console.log('Sessions to archive:');
  console.log('─'.repeat(100));
  for (const s of toArchive) {
    const source = getGatewaySource(s);
    const channelType = source?.channel_type || 'unknown';
    const channelName = source?.channel_name || 'unknown';
    const age = Math.floor(
      (Date.now() - new Date(s.last_updated || s.created_at).getTime()) / (24 * 60 * 60 * 1000)
    );
    console.log(
      `  ${s.session_id.substring(0, 8)} | ${String(channelType).padEnd(8)} | #${String(channelName).padEnd(20)} | ${s.status.padEnd(10)} | ${age}d old | ${(s.title || '').substring(0, 40)}`
    );
  }
  console.log('─'.repeat(100));
  console.log('');

  if (!execute) {
    console.log(`🟡 DRY RUN: Would archive ${toArchive.length} session(s).`);
    console.log('   Run with --execute to actually archive them.');
    process.exit(0);
  }

  // Execute archiving
  console.log(`🔴 Archiving ${toArchive.length} session(s)...`);
  let archivedCount = 0;
  let errorCount = 0;

  for (const session of toArchive) {
    try {
      await sessionRepo.update(session.session_id, {
        archived: true,
        archived_reason: 'manual',
      });
      archivedCount++;
    } catch (error) {
      errorCount++;
      console.error(
        `   ❌ Failed to archive ${session.session_id.substring(0, 8)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log('');
  console.log(`✅ Done. Archived: ${archivedCount}, Errors: ${errorCount}`);
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
