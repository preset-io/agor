#!/usr/bin/env tsx
/**
 * Create the minimal persistent config required by source-mode PostgreSQL
 * development environments.
 *
 * `agor init` owns the normal SQLite bootstrap, so PostgreSQL containers skip
 * it to avoid creating an unrelated SQLite database. The daemon still requires
 * a stable deployment identity and encryption/authentication secrets. This
 * script creates a complete validated config exactly once in the named
 * `agor-home` volume and never rewrites an existing file.
 */

import {
  ensureInitialDeploymentConfig,
  getDefaultConfig,
  prepareInitialDeploymentConfig,
} from '@agor/core/config';

async function main(): Promise<void> {
  const defaults = getDefaultConfig();
  const result = await ensureInitialDeploymentConfig(
    prepareInitialDeploymentConfig({
      ...defaults,
      agentic_tools: { installed: [] },
    })
  );
  console.log(
    `✓ ${result.created ? 'Created' : 'Reusing'} development deployment config (${result.deploymentId})`
  );
}

main().catch((error) => {
  console.error(
    `Failed to ensure PostgreSQL development config: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
