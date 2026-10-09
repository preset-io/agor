import { isUserEnvPlaceholder } from '../mcp/template-patterns';
import { MCPAuthValidationError } from '../tools/mcp/auth-patch';
import type { MCPAuth } from '../types/mcp';
import { isBoundSecretEnvelope, openBoundSecret, sealBoundSecret } from './oauth-secret-envelope';

/**
 * Configured app credentials are not user grants. Seal at the repository
 * boundary when the repository asks (`seal`: PostgreSQL customer-owned app
 * installs only), and never a `{{ user.env.* }}` reference. The tenant binding
 * is resolved only when sealing.
 */
export function sealConfiguredClientSecret(
  auth: MCPAuth | undefined,
  binding: () => string,
  seal: boolean
): MCPAuth | undefined {
  const secret = auth?.oauth_client_secret;
  if (!secret) return auth;
  if (isBoundSecretEnvelope(secret)) {
    throw new MCPAuthValidationError('Submit a client secret, not stored encrypted material');
  }
  if (!seal || isUserEnvPlaceholder(secret)) return auth;
  if (!process.env.AGOR_MASTER_SECRET) {
    throw new MCPAuthValidationError(
      'Saving a configured OAuth client secret requires the deployment encryption key'
    );
  }
  return {
    ...auth,
    oauth_client_secret: sealBoundSecret(
      secret,
      process.env.AGOR_MASTER_SECRET,
      'configured-mcp-client',
      binding()
    ),
  };
}

export function openConfiguredClientSecret(
  auth: MCPAuth | undefined,
  binding: () => string
): MCPAuth | undefined {
  const secret = auth?.oauth_client_secret;
  // Plaintext and env-reference rows need no tenant binding or key. Existing
  // plaintext PostgreSQL rows remain readable and are sealed on their next save.
  if (!secret || !isBoundSecretEnvelope(secret)) return auth;
  try {
    return {
      ...auth,
      oauth_client_secret: openBoundSecret(
        secret,
        process.env.AGOR_MASTER_SECRET ?? '',
        'configured-mcp-client',
        binding()
      ),
    };
  } catch {
    throw new Error('Configured OAuth client secret is unavailable');
  }
}
