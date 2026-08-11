/**
 * AGOR_MASTER_SECRET resolution.
 *
 * Resolves the deployment master secret (used to encrypt API keys and to seal
 * MCP OAuth secrets at rest) and promotes it onto `process.env` so that every
 * downstream consumer — including services constructed eagerly during service
 * registration — can read it off `process.env.AGOR_MASTER_SECRET`.
 *
 * IMPORTANT — call this BEFORE registerServices(). On PostgreSQL,
 * `MCPOAuthPendingFlowAuthority` is constructed during service registration and
 * reads `process.env.AGOR_MASTER_SECRET` in its constructor (fail-fast). It was
 * previously resolved later, inside startup() after service registration, which
 * booted fine only when the secret came from an env var. Deployments that keep
 * the secret in config.yaml (`daemon.masterSecret`) fail-fasted with
 * "PostgreSQL MCP OAuth pending flows require the deployment AGOR_MASTER_SECRET"
 * because the config value had not yet been promoted onto process.env.
 *
 * Resolution order (env > config > fail-fast) is shared with the JWT secret via
 * {@link resolvePersistedSecret}.
 */

import type { AgorConfig } from '@agor/core/config';
import { resolvePersistedSecret } from './persisted-secret.js';

/**
 * Resolve AGOR_MASTER_SECRET and set it on `process.env`.
 *
 * @returns where the value came from, so callers can shape their startup log.
 * @throws when neither the env var nor `daemon.masterSecret` is configured.
 */
export async function resolveMasterSecretIntoEnv(config: AgorConfig): Promise<'env' | 'config'> {
  const resolution = await resolvePersistedSecret({
    name: 'AGOR_MASTER_SECRET (API key encryption)',
    envVar: 'AGOR_MASTER_SECRET',
    existing: config.daemon?.masterSecret,
    configKey: 'daemon.masterSecret',
  });
  // Side effect: downstream code (encrypted-creds resolver, MCP OAuth secret
  // envelope, pending-flow authority) reads this off process.env, not a
  // parameter. Keep that contract.
  process.env.AGOR_MASTER_SECRET = resolution.value;
  return resolution.source;
}
