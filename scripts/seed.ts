#!/usr/bin/env tsx
/**
 * Seed Development Database
 *
 * Populates the Agor database with test data for development.
 *
 * Usage:
 *   pnpm tsx scripts/seed.ts [--skip-if-exists]
 *   pnpm seed [--skip-if-exists]
 */

import { seedDevFixtures } from '@agor/core/seed';

async function main() {
  const skipIfExists = process.argv.includes('--skip-if-exists');

  try {
    const result = await seedDevFixtures({ skipIfExists });

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
