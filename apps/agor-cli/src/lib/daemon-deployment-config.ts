import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import {
  getConfigPath,
  loadConfig,
  loadConfigFromFile,
  migrateConfigDeploymentId,
  requireDeploymentId,
} from '@agor/core/config';
import inquirer from 'inquirer';

export interface DeploymentConfigResult {
  config: AgorConfig;
  migrated?: { deploymentId: string; backupPath: string };
}

/** Load daemon config and explicitly upgrade a pre-deployment-ID file when approved. */
export async function loadDaemonConfigWithDeploymentIdentity(
  configPath?: string
): Promise<DeploymentConfigResult> {
  const path = resolve(configPath ?? getConfigPath());
  const config = configPath ? await loadConfigFromFile(path) : await loadConfig();
  try {
    requireDeploymentId(config);
    return { config };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("'daemon.deployment_id' is required")) throw error;
  }

  const deploymentId = randomUUID();
  const snippet = `Add this under daemon in ${path}:\n  deployment_id: ${deploymentId}`;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Agor cannot start because daemon.deployment_id is missing.\n\n${snippet}`);
  }

  const { rewrite } = await inquirer.prompt<{ rewrite: boolean }>([
    {
      type: 'confirm',
      name: 'rewrite',
      default: false,
      message:
        'Add a deployment ID by rewriting config.yaml? A backup will be created; YAML comments and formatting may be lost.',
    },
  ]);
  if (!rewrite) throw new Error(`${snippet}\n\nAgor did not start.`);

  const migrated = await migrateConfigDeploymentId(path, deploymentId);
  return {
    config: migrated.config,
    migrated: { deploymentId: migrated.deploymentId, backupPath: migrated.backupPath },
  };
}
