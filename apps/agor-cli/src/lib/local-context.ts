import type { AgorConfig } from '@agor/core/config';
import { requireDeploymentId } from '@agor/core/config';
import { loadToken } from './auth.js';

/** Refuse local administration while authenticated to another deployment. */
export async function assertLocalContextUnlocked(config: AgorConfig): Promise<void> {
  const localDeploymentId = requireDeploymentId(config);
  const connection = await loadToken();
  if (connection && connection.target.deploymentId !== localDeploymentId) {
    throw new Error(
      `Local administration is locked while logged into another deployment.\n\n` +
        `Local deployment: ${localDeploymentId}\n` +
        `Current login: ${connection.target.deploymentId} at ${connection.target.url}\n\n` +
        'Run `agor logout` or `agor login --local` first.'
    );
  }
}
