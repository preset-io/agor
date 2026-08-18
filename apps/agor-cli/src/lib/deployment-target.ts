import { loadConfig, requireDeploymentId, resolveDaemonUrl } from '@agor/core/config';
import { normalizeHttpBaseUrl } from '@agor/core/utils/url';
import { getApiKeyFromEnv } from '@agor-live/client';
import { loadToken } from './auth.js';

export interface DeploymentTarget {
  deploymentId: string;
  source: 'environment' | 'local' | 'login';
  url: string;
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
    };
  }

  const storedAuth = await loadToken();
  return storedAuth ? { ...storedAuth.target, source: 'login' } : null;
}

/** Resolve the daemon owned by this host's effective local configuration. */
export async function resolveLocalDeploymentTarget(): Promise<DeploymentTarget> {
  const config = await loadConfig();
  return {
    url: resolveDaemonUrl(config),
    deploymentId: requireDeploymentId(config),
    source: 'local',
  };
}
