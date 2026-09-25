import { access } from 'node:fs/promises';
import {
  getConfigPath,
  loadConfig,
  requireDeploymentId,
  resolveDaemonUrl,
} from '@agor/core/config';
import { normalizeHttpBaseUrl } from '@agor/core/utils/url';
import { getApiKeyFromEnv } from '@agor-live/client';
import { loadToken } from './auth.js';

export interface DeploymentTarget {
  deploymentId: string;
  source: 'environment' | 'local' | 'login';
  url: string;
  /** Personal API key from a stored `agor login --api-key`. */
  apiKey?: string;
  /**
   * Whether a changed daemon deployment ID means "log in again". False for
   * stored API-key logins: the key is bound server-side to the workspace URL,
   * and a hosted workspace's Cell-derived deployment ID changes when it moves.
   */
  pinDeployment: boolean;
}

/** Resolve the one deployment selected by stored login or API-key environment. */
export async function resolveConnectedDeploymentTarget(): Promise<DeploymentTarget | null> {
  const apiKey = getApiKeyFromEnv();
  if (apiKey) {
    if (!process.env.DAEMON_URL || !process.env.AGOR_DEPLOYMENT_ID) {
      throw new Error(
        'Environment API-key authentication requires DAEMON_URL and AGOR_DEPLOYMENT_ID.'
      );
    }
    return {
      url: normalizeHttpBaseUrl(process.env.DAEMON_URL, 'DAEMON_URL'),
      deploymentId: process.env.AGOR_DEPLOYMENT_ID,
      source: 'environment',
      pinDeployment: true,
    };
  }

  const storedAuth = await loadToken();
  if (!storedAuth) return null;
  if (storedAuth.version === 3) {
    return {
      url: storedAuth.target.url,
      deploymentId: storedAuth.target.deploymentId,
      source: 'login',
      apiKey: storedAuth.apiKey,
      pinDeployment: false,
    };
  }
  return { ...storedAuth.target, source: 'login', pinDeployment: true };
}

/** Resolve the daemon owned by this host's effective local configuration. */
export async function resolveLocalDeploymentTarget(): Promise<DeploymentTarget> {
  const configPath = getConfigPath();
  try {
    await access(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No local config found at ${configPath}. Run agor init.`);
    }
    throw error;
  }

  const config = await loadConfig();
  return {
    url: resolveDaemonUrl(config),
    deploymentId: requireDeploymentId(config),
    source: 'local',
    pinDeployment: true,
  };
}
