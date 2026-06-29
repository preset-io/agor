#!/usr/bin/env tsx
/**
 * Get Admin User ID
 *
 * Queries the database for the admin user's full UUID
 */

import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';

async function main() {
  // Respect DATABASE_URL and AGOR_DB_DIALECT environment variables
  let databaseUrl: string;
  const dialect = process.env.AGOR_DB_DIALECT;

  if (dialect === 'postgresql') {
    databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/agor';
  } else {
    const configPath = path.join(os.homedir(), '.agor');
    const dbPath = path.join(configPath, 'agor.db');
    databaseUrl = process.env.DATABASE_URL || `file:${dbPath}`;
  }

  try {
    const db = createTenantScopedDatabaseProxy(createDatabase({ url: databaseUrl }));
    const config = await loadConfig();
    const multiTenancy = resolveMultiTenancyConfig(config);
    const tenantId = multiTenancy.mode === 'static' ? multiTenancy.static_tenant_id : undefined;

    // Find admin user in the active static tenant when configured.
    const adminUser = await runWithTenantDatabaseScope(db, tenantId, async () => {
      const userRepo = new UsersRepository(db);
      return userRepo.findByEmail('admin@agor.live');
    });

    if (!adminUser) {
      console.error('Admin user not found');
      process.exit(1);
    }

    // Output just the user ID (for shell script to capture)
    console.log(adminUser.user_id);
    process.exit(0);
  } catch (error) {
    console.error('Failed to query admin user:', error);
    process.exit(1);
  }
}

main();
