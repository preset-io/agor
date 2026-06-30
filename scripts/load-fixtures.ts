#!/usr/bin/env tsx

/**
 * Load Demo Fixtures
 *
 * Populates the Agor database with a rich set of HARDCODED FAKE data (users,
 * branches, sessions + transcripts, boards/zones, cards, artifacts) for instant
 * end-to-end testing. Pure DB inserts — no git, network, or executor.
 *
 * Gated by `LOAD_FIXTURES=true` in the docker entrypoint. Orthogonal to (and
 * composable with) `SEED=true`. Idempotent: re-running is a no-op.
 *
 * Usage:
 *   pnpm tsx scripts/load-fixtures.ts [--skip-if-exists] [--user-id <uuid>]
 *   pnpm load:fixtures [--skip-if-exists]
 */

import { loadDemoFixtures } from '@agor/core/seed';
import type { UUID } from '@agor/core/types';

async function main() {
  const skipIfExists = process.argv.includes('--skip-if-exists');

  // Parse --user-id argument (optional — demo fixtures own their own users).
  const userIdIndex = process.argv.indexOf('--user-id');
  const userId = userIdIndex !== -1 ? (process.argv[userIdIndex + 1] as UUID) : undefined;

  try {
    const result = await loadDemoFixtures({ skipIfExists, userId });

    if (result.skipped) {
      console.log('ℹ️  Demo fixtures skipped (data already exists)');
      process.exit(0);
    }

    console.log('✅ Demo fixtures complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Loading demo fixtures failed:', error);
    process.exit(1);
  }
}

main();
