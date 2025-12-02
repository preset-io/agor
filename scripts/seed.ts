#!/usr/bin/env tsx

/**
 * Seed Development Database
 *
 * Populates the Agor database with test data for development.
 *
 * Usage:
 *   pnpm tsx scripts/seed.ts [--skip-if-exists] [--user-id <uuid>]
 *   pnpm seed [--skip-if-exists]
 */

import { seedDevFixtures } from '@agor/core/seed';
import type { UUID } from '@agor/core/types';

async function main() {
  const skipIfExists = process.argv.includes('--skip-if-exists');

  // Parse --user-id argument
  const userIdIndex = process.argv.indexOf('--user-id');
  const userId = userIdIndex !== -1 ? (process.argv[userIdIndex + 1] as UUID) : undefined;

  try {
    const result = await seedDevFixtures({ skipIfExists, userId });

    if (result.skipped) {
      console.log('ℹ️  Seeding skipped (data already exists)');
      process.exit(0);
    }

    console.log('✅ Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

main();
