/** Shared Claude credential/method mutation boundary for HA. */

import {
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { Params, UserID } from '@agor/core/types';
import { fenceClaudeAuthCredential } from '../utils/executor-claude-auth.js';
import type { ClaudeOAuthAttemptAuthority } from './claude-oauth-attempt-authority.js';
import { type AppLike, resolveCodexCredentialRoute } from './codex-auth-shared.js';

/** Marks the users patch already covered by the outer Claude authority. */
export const CLAUDE_AUTH_TRUSTED_USER_MUTATION = Symbol('claude-auth-trusted-user-mutation');

interface ClaudeCredentialPatch {
  agentic_auth_methods?: Record<string, unknown>;
  agentic_tools?: Record<string, Record<string, unknown> | undefined>;
}

const CLAUDE_SECRET_FIELDS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export interface ClaudeUserCredentialPatchCoordinator {
  applies(data: ClaudeCredentialPatch, params?: Params): boolean;
  lock(tenantId: string, userId: UserID): Promise<void>;
  complete(tenantId: string, userId: UserID): Promise<void>;
}

/**
 * External API-key/token/method changes participate in the same lock and file
 * generation as OAuth/logout. UsersService calls `lock` before its role lock,
 * and calls `complete` only after authorization and the SQL update succeed.
 */
export function createClaudeUserCredentialPatchCoordinator(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  authority: ClaudeOAuthAttemptAuthority
): ClaudeUserCredentialPatchCoordinator {
  return {
    applies(data, params): boolean {
      if (
        (params as (Params & { [CLAUDE_AUTH_TRUSTED_USER_MUTATION]?: boolean }) | undefined)?.[
          CLAUDE_AUTH_TRUSTED_USER_MUTATION
        ]
      ) {
        return false;
      }
      if (Object.hasOwn(data.agentic_auth_methods ?? {}, 'claude-code')) return true;
      const patch = data.agentic_tools?.['claude-code'];
      return !!patch && Object.keys(patch).some((field) => CLAUDE_SECRET_FIELDS.has(field));
    },

    lock(tenantId, userId) {
      return authority.lockExternalUserMutation(tenantId, userId);
    },

    async complete(tenantId, userId): Promise<void> {
      await authority.completeExternalUserMutation(tenantId, userId, async (generation) => {
        const route = await resolveCodexCredentialRoute(
          userId,
          <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
            runWithTenantDatabaseScope(db, tenantId, work),
          app.get('config')
        );
        if (!route.ok && route.reason === 'unsupported-home-override') {
          // OAuth start/finalization rejects an override route and revalidates
          // that decision before writing. The database lock + attempt
          // invalidation is therefore the complete fence here; still allow the
          // user to switch to an API key or pasted token.
          return;
        }
        if (!route.ok || !route.claudeConfigDir) {
          throw new BadRequest(
            `Cannot generation-fence this Claude authentication change: ${
              route.ok ? 'the exact execution home is unavailable' : route.message
            }`
          );
        }
        await fenceClaudeAuthCredential(
          {
            delegatedHomeKey: route.delegatedHomeKey,
            userId: route.userId,
            claudeConfigDir: route.claudeConfigDir,
          },
          generation
        );
      });
    },
  };
}
