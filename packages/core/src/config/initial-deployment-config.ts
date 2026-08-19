/** Creation and validation of the immutable config needed for first daemon boot. */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  ConfigAlreadyExistsError,
  createInitialConfig,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  requireDeploymentId,
} from './config-manager.js';
import type { AgorConfig } from './types.js';

export interface InitialDeploymentConfigOptions {
  deploymentId?: string;
}

/**
 * Add the stable identity and secrets required for a freshly initialized daemon.
 * Existing operator-provided values win unless deploymentId is explicitly supplied.
 */
export function prepareInitialDeploymentConfig(
  config: AgorConfig = getDefaultConfig(),
  options: InitialDeploymentConfigOptions = {}
): AgorConfig {
  const daemon = config.daemon ?? {};
  return {
    ...config,
    daemon: {
      ...daemon,
      deployment_id: options.deploymentId ?? daemon.deployment_id ?? randomUUID(),
      jwtSecret: daemon.jwtSecret || randomBytes(32).toString('hex'),
      masterSecret: daemon.masterSecret || randomBytes(32).toString('hex'),
    },
  };
}

export interface DeploymentSecretEnvironment {
  AGOR_JWT_SECRET?: string;
  AGOR_MASTER_SECRET?: string;
}

/** Enforce the config/env invariants required before daemon startup. */
export function requireBootableDeploymentConfig(
  config: AgorConfig,
  environment: DeploymentSecretEnvironment = process.env
): string {
  const deploymentId = requireDeploymentId(config);
  if (!(environment.AGOR_JWT_SECRET || config.daemon?.jwtSecret)) {
    throw new Error(
      "Config error: either AGOR_JWT_SECRET or 'daemon.jwtSecret' is required for daemon startup"
    );
  }
  if (!(environment.AGOR_MASTER_SECRET || config.daemon?.masterSecret)) {
    throw new Error(
      "Config error: either AGOR_MASTER_SECRET or 'daemon.masterSecret' is required for daemon startup"
    );
  }
  return deploymentId;
}

export interface EnsureInitialDeploymentConfigResult {
  config: AgorConfig;
  deploymentId: string;
  created: boolean;
}

/**
 * Persist a complete initial deployment config or validate the existing winner.
 * createInitialConfig publishes atomically, so a concurrent loser never observes
 * the winner's file until its complete contents have been flushed and closed.
 */
export async function ensureInitialDeploymentConfig(
  initialConfig: AgorConfig,
  environment: DeploymentSecretEnvironment = process.env
): Promise<EnsureInitialDeploymentConfigResult> {
  requireBootableDeploymentConfig(initialConfig, environment);
  const configPath = getConfigPath();

  try {
    await fs.access(configPath);
    const config = await loadConfig();
    return {
      config,
      deploymentId: requireBootableDeploymentConfig(config, environment),
      created: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    await createInitialConfig(initialConfig);
    return {
      config: initialConfig,
      deploymentId: requireBootableDeploymentConfig(initialConfig, environment),
      created: true,
    };
  } catch (error) {
    if (!(error instanceof ConfigAlreadyExistsError)) throw error;
    const config = await loadConfig();
    return {
      config,
      deploymentId: requireBootableDeploymentConfig(config, environment),
      created: false,
    };
  }
}
