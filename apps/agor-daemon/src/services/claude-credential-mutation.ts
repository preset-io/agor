/** Shared Claude credential/method mutation boundary for HA. */

import {
  type AgorConfig,
  hasCrossReplicaExecutorCredentialLock,
  hasExactUserExecutorCredentialHome,
  type ResolvedDeploymentConfig,
} from '@agor/core/config';
import {
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { Params, UserID } from '@agor/core/types';
import {
  deleteClaudeAuthViaExecutor,
  fenceClaudeAuthCredential,
} from '../utils/executor-claude-auth.js';
import { deleteCodexAuthCredential } from '../utils/executor-codex-auth.js';
import { CLAUDE_AUTH_TRUSTED_USER_MUTATION } from './claude-credential-mutation-trust.js';
import type { ClaudeOAuthAttemptStore } from './claude-oauth-attempt-store.js';
import { type AppLike, resolveCodexCredentialRoute } from './codex-auth-shared.js';

export { CLAUDE_AUTH_TRUSTED_USER_MUTATION } from './claude-credential-mutation-trust.js';

interface ClaudeCredentialPatch {
  agentic_auth_methods?: Record<string, unknown>;
  agentic_credential_sources?: Record<string, unknown>;
  agentic_tools?: Record<string, Record<string, unknown> | undefined>;
  unix_username?: string;
  filesystem_home?: string;
}

const CLAUDE_SECRET_FIELDS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export interface ClaudeUserCredentialPatchCoordinator {
  applies(data: ClaudeCredentialPatch, params?: Params): boolean;
  changesSource(data: ClaudeCredentialPatch, params?: Params): boolean;
  changesRoute(data: ClaudeCredentialPatch): boolean;
  coordinatesRemoval(): boolean;
  lock(tenantId: string, userId: UserID): Promise<(() => Promise<void>) | void>;
  complete(tenantId: string, userId: UserID): Promise<void>;
  cleanupRouteBeforePatch(tenantId: string, userId: UserID): Promise<void>;
  cleanupRouteBeforeRemove(tenantId: string, userId: UserID): Promise<void>;
}

export function needsUserCredentialRouteCoordinator(deployment: ResolvedDeploymentConfig): boolean {
  return (
    deployment.mode !== 'ha' ||
    deployment.capabilities.claudeOAuth ||
    deployment.capabilities.claudeAuth ||
    deployment.capabilities.codexCredentialFiles
  );
}

/**
 * Cleanup authority is narrower than OAuth/runtime admission but must survive
 * a containment-policy downgrade. A local exact home with the shared kernel
 * lock can safely tombstone credentials written by a prior contained config;
 * external/delegated/unknown routes remain outside daemon filesystem authority.
 */
export function canManageClaudeCredentialRoute(
  deployment: ResolvedDeploymentConfig,
  config: AgorConfig
): boolean {
  return (
    deployment.mode !== 'ha' ||
    (deployment.topology.execution === 'shared-local' &&
      hasExactUserExecutorCredentialHome(config) &&
      hasCrossReplicaExecutorCredentialLock(config))
  );
}

interface CodexExternalRouteMutationAuthority {
  completeExternalUserRouteMutation(
    tenantId: string,
    userId: UserID,
    work: (authorityGeneration?: number) => Promise<void>,
    reason: 'execution_home_changed' | 'user_removed',
    sharedGeneration?: number
  ): Promise<void>;
}

/**
 * External API-key/token/method changes participate in the same lock and file
 * generation as OAuth/logout. UsersService calls `lock` before its role lock.
 * Source-only changes call `complete` after their SQL update; route changes
 * and removal generation-delete the old route before changing the users row.
 */
export function createClaudeUserCredentialPatchCoordinator(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  authority: Pick<
    ClaudeOAuthAttemptStore,
    'lockExternalUserMutation' | 'completeExternalUserMutation'
  >,
  codexAuthority?: CodexExternalRouteMutationAuthority,
  options: { manageClaudeRoute?: boolean } = {}
): ClaudeUserCredentialPatchCoordinator {
  const manageClaudeRoute = options.manageClaudeRoute !== false;
  const routeSelectors = () => {
    const execution = app.get('config').execution;
    return {
      delegatedHomeKey: execution?.unix_user_mode === 'delegated',
      filesystemHome:
        execution?.sandbox?.enabled === true && execution.sandbox.home_mode === 'per_user',
    };
  };
  const changesRoute = (data: ClaudeCredentialPatch) => {
    const selectors = routeSelectors();
    return (
      (selectors.delegatedHomeKey && Object.hasOwn(data, 'unix_username')) ||
      (selectors.filesystemHome && Object.hasOwn(data, 'filesystem_home'))
    );
  };
  const changesSource = (data: ClaudeCredentialPatch, params?: Params): boolean => {
    if (
      (params as (Params & { [CLAUDE_AUTH_TRUSTED_USER_MUTATION]?: boolean }) | undefined)?.[
        CLAUDE_AUTH_TRUSTED_USER_MUTATION
      ]
    ) {
      return false;
    }
    if (Object.hasOwn(data.agentic_auth_methods ?? {}, 'claude-code')) return true;
    if (Object.hasOwn(data.agentic_credential_sources ?? {}, 'claude-code')) return true;
    const patch = data.agentic_tools?.['claude-code'];
    return !!patch && Object.keys(patch).some((field) => CLAUDE_SECRET_FIELDS.has(field));
  };
  async function cleanCurrentRoute(
    tenantId: string,
    userId: UserID,
    reason: 'execution_home_changed' | 'user_removed'
  ): Promise<void> {
    const selectors = routeSelectors();
    if (!selectors.delegatedHomeKey && !selectors.filesystemHome) {
      // Shared-home standalone users still need attempt invalidation and queue
      // serialization on removal, but their account row does not own the
      // process-wide credential file. Never delete that shared file here.
      await authority.completeExternalUserMutation(
        tenantId,
        userId,
        async (generation) => {
          await codexAuthority?.completeExternalUserRouteMutation(
            tenantId,
            userId,
            async () => undefined,
            reason,
            generation
          );
        },
        reason
      );
      return;
    }
    // Resolve while the old users row is still present and while this caller
    // owns the tenant/user credential lock. File cleanup must precede the
    // route update/removal; resolving afterward either selects the new home or
    // loses the only trusted route entirely.
    const route = await resolveCodexCredentialRoute(
      userId,
      <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work),
      app.get('config')
    );
    await authority.completeExternalUserMutation(
      tenantId,
      userId,
      async (claudeGeneration) => {
        const deleteOldRoute = async (codexGeneration?: number, cleanCodex = false) => {
          if (!route.ok && route.reason === 'unsupported-home-override') {
            // Neither admitted HA writer targets an override home. Its
            // canonical predecessor was cleaned when the route changed into
            // the override; do not turn an unproved, potentially shared path
            // into daemon filesystem authority during later cleanup.
            return;
          }
          if (!route.ok) {
            throw new BadRequest(`Cannot clean the prior credential route: ${route.message}`);
          }
          if (manageClaudeRoute) {
            const claudeRoute = {
              delegatedHomeKey: route.delegatedHomeKey,
              userId: route.userId,
              ...(route.claudeConfigDir ? { claudeConfigDir: route.claudeConfigDir } : {}),
            };
            if (claudeGeneration === undefined) await deleteClaudeAuthViaExecutor(claudeRoute);
            else await deleteClaudeAuthViaExecutor(claudeRoute, claudeGeneration);
          }
          if (cleanCodex) {
            const codexRoute = {
              delegatedHomeKey: route.delegatedHomeKey,
              userId: route.userId,
              ...(route.codexHome ? { codexHome: route.codexHome } : {}),
            };
            if (codexGeneration === undefined) await deleteCodexAuthCredential(codexRoute);
            else await deleteCodexAuthCredential(codexRoute, codexGeneration);
          }
        };
        if (codexAuthority) {
          await codexAuthority.completeExternalUserRouteMutation(
            tenantId,
            userId,
            (generation) => deleteOldRoute(generation, true),
            reason,
            claudeGeneration
          );
          return;
        }
        await deleteOldRoute();
      },
      reason
    );
  }

  return {
    applies(data, params): boolean {
      // Trusted OAuth/logout metadata patches may bypass the recursive source
      // fence, but never a route change. A future internal caller carrying the
      // symbol must not gain a way around execution-home lifecycle authority.
      if (changesRoute(data)) return true;
      return changesSource(data, params);
    },

    changesSource,

    changesRoute,

    coordinatesRemoval(): boolean {
      // Removal must always fence an in-flight attempt, including standalone
      // shared-home mode where cleanup deliberately leaves the process-wide
      // credential file alone.
      return true;
    },

    lock(tenantId, userId) {
      return authority.lockExternalUserMutation(tenantId, userId);
    },

    async complete(tenantId, userId): Promise<void> {
      if (app.get('config').deployment?.mode !== 'ha') {
        // The process-global queue is retained by UsersService through this
        // callback. Standalone has no detached writer to tombstone and native
        // auth may intentionally be unavailable, so source changes only need
        // to invalidate the held in-memory attempt.
        await authority.completeExternalUserMutation(tenantId, userId, async () => undefined);
        return;
      }
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
        if (!route.ok) {
          throw new BadRequest(
            `Cannot generation-fence this Claude authentication change: ${route.message}`
          );
        }
        // Standalone completion holds the process-global mutation queue until
        // the users write finishes, so it has no detached/stale writer to
        // tombstone. HA admitted routes always supply the exact local dir.
        if (!route.claudeConfigDir) return;
        if (generation === undefined) {
          throw new Error('HA Claude credential mutation requires a durable generation');
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

    async cleanupRouteBeforePatch(tenantId, userId): Promise<void> {
      await cleanCurrentRoute(tenantId, userId, 'execution_home_changed');
    },

    async cleanupRouteBeforeRemove(tenantId, userId): Promise<void> {
      await cleanCurrentRoute(tenantId, userId, 'user_removed');
    },
  };
}
