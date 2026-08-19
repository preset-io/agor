#!/usr/bin/env tsx
/**
 * Create the minimal persistent config required by source-mode PostgreSQL
 * development environments.
 *
 * `agor init` owns the normal SQLite bootstrap, so PostgreSQL containers skip
 * it to avoid creating an unrelated SQLite database. The daemon still requires
 * a stable deployment identity. This script creates a validated config exactly
 * once in the named `agor-home` volume and never rewrites an existing file.
 */

import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import {
  createInitialConfig,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  requireDeploymentId,
} from '@agor/core/config';

async function configExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const configPath = getConfigPath();
  if (await configExists(configPath)) {
    const deploymentId = requireDeploymentId(await loadConfig());
    console.log(`✓ Reusing development deployment config (${deploymentId})`);
    return;
  }

  const defaults = getDefaultConfig();
  const deploymentId = randomUUID();
  try {
    await createInitialConfig({
      ...defaults,
      daemon: { ...defaults.daemon, deployment_id: deploymentId },
      agentic_tools: { installed: [] },
    });
    console.log(`✓ Created development deployment config (${deploymentId})`);
  } catch (error) {
    // createInitialConfig uses an exclusive create. If two container starts
    // race, accept the winner only after validating the file it produced.
    if (!(error instanceof Error) || !error.message.startsWith('Refusing to overwrite existing')) {
      throw error;
    }
    const winnerId = requireDeploymentId(await loadConfig());
    console.log(`✓ Reusing concurrently created development deployment config (${winnerId})`);
  }
}

main().catch((error) => {
  console.error(
    `Failed to ensure PostgreSQL development config: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
