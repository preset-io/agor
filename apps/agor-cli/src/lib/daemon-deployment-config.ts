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
}

export interface DeploymentIdRepairResult {
  deploymentId: string;
  backupPath: string;
}

/** True when the error is specifically a missing `daemon.deployment_id`. */
export function isMissingDeploymentIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("'daemon.deployment_id' is required");
}

/**
 * Load daemon config for a start/restart.
 *
 * Deliberately non-interactive. Starting a daemon is something service managers,
 * containers and provisioning scripts do, and a command that can block on a
 * prompt is a command that can hang a boot. It also must never rewrite
 * config.yaml as a side effect of "start" — the file is deployment-owned input.
 *
 * A missing deployment ID is therefore a hard failure that points at
 * `agor doctor`, which owns the interactive repair.
 */
export async function loadDaemonConfigWithDeploymentIdentity(
  configPath?: string
): Promise<DeploymentConfigResult> {
  const path = resolve(configPath ?? getConfigPath());
  const config = configPath ? await loadConfigFromFile(path) : await loadConfig();

  try {
    requireDeploymentId(config);
  } catch (error) {
    if (!isMissingDeploymentIdError(error)) throw error;
    throw new Error(describeMissingDeploymentId(path));
  }

  return { config };
}

/** The operator-facing explanation for a missing deployment ID. */
export function describeMissingDeploymentId(configPath: string): string {
  return [
    'Agor cannot start because daemon.deployment_id is missing.',
    '',
    `Fix it interactively:  agor doctor`,
    '',
    `Or add it yourself under daemon in ${configPath}:`,
    `  deployment_id: ${randomUUID()}`,
    '',
    'If this deployment previously had an ID, restore that exact value instead of',
    'the one suggested above — a new ID re-identifies the deployment and every',
    'connected client has to log in again.',
  ].join('\n');
}

/**
 * Interactively add a deployment ID to config.yaml. Used by `agor doctor`, which
 * is the one place a human is definitionally present.
 *
 * Returns null when there is nothing to repair or the user declines.
 */
export async function repairDeploymentId(
  configPath?: string
): Promise<DeploymentIdRepairResult | null> {
  const path = resolve(configPath ?? getConfigPath());
  const config = configPath ? await loadConfigFromFile(path) : await loadConfig();

  try {
    requireDeploymentId(config);
    return null;
  } catch (error) {
    if (!isMissingDeploymentIdError(error)) throw error;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(describeMissingDeploymentId(path));
  }

  const suggested = randomUUID();
  const { deploymentId } = await inquirer.prompt<{ deploymentId: string }>([
    {
      type: 'input',
      name: 'deploymentId',
      default: suggested,
      message:
        'Deployment ID to write (press enter for a new one, or paste this deployment’s previous ID):',
      validate: (value: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim()) ||
        'Enter a UUID.',
    },
  ]);

  const { rewrite } = await inquirer.prompt<{ rewrite: boolean }>([
    {
      type: 'confirm',
      name: 'rewrite',
      default: false,
      message: `Write deployment_id to ${path}? A backup will be created; YAML comments and formatting may be lost.`,
    },
  ]);
  if (!rewrite) return null;

  // Validated as a UUID by the prompt above; `migrateConfigDeploymentId` takes the
  // narrowed `crypto.UUID` template type.
  const migrated = await migrateConfigDeploymentId(
    path,
    deploymentId.trim().toLowerCase() as ReturnType<typeof randomUUID>
  );
  return { deploymentId: migrated.deploymentId, backupPath: migrated.backupPath };
}
