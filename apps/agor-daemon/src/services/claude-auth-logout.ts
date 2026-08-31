/**
 * Claude Auth Logout Service
 *
 * Removes the current user's Claude subscription login from THIS server: deletes
 * `~/.claude/.credentials.json` from the home of the Unix identity that runs
 * Claude for this user, clears any stored `CLAUDE_CODE_OAUTH_TOKEN`, and clears
 * `agentic_auth_methods['claude-code']` so executors stop resolving native auth
 * and the UI re-probes to a disconnected state (the `patched` event drives that).
 *
 * DELETE-ONLY BY DESIGN: an Agor-scoped action mirroring the Codex logout and the
 * API-key "Clear" precedent — it signs Claude out on THIS server only and does
 * NOT revoke the OAuth tokens. Authoritative revocation lives in the Claude
 * account's settings or `/logout` on a machine where the user is signed in.
 *
 * SECURITY CONTRACT:
 * - Acts ONLY on the caller's own login — the target identity is always derived
 *   from the authenticated user, never from request data.
 * - Removal is idempotent; a genuine delete failure surfaces and does NOT clear
 *   the stored method/token (a login we couldn't remove keeps working).
 * - Shared identity resolution refuses an auth-resolved tenant topology unless
 *   the execution substrate guarantees a persistent-per-user home. Cleanup is
 *   not gated on the tool-enabled check, so it remains possible after Claude is
 *   disabled.
 */

import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AgenticCredentialSources,
  AuthenticatedParams,
  ClaudeAuthLogoutResult,
  UserID,
} from '@agor/core/types';
import { deleteClaudeAuthViaExecutor } from '../utils/executor-claude-auth.js';
import {
  type ClaudeCredentialMutationCoordinator,
  claudeCredentialMutationKey,
} from './claude-oauth.js';
import { type AppLike, resolveCodexCredentialRoute } from './codex-auth-shared.js';
import { markTrustedUserMutation } from './user-mutation-trust.js';

/** Minimal users-service surface — mirrors the Claude OAuth service's typing. */
interface UsersServiceLike {
  patch(
    id: UserID,
    data: {
      agentic_auth_methods?: AgenticAuthMethods;
      agentic_credential_sources?: AgenticCredentialSources;
      agentic_tools?: Partial<Record<'claude-code', Record<string, string | null>>>;
    },
    params?: unknown
  ): Promise<unknown>;
}

export function createClaudeAuthLogoutService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  coordinator?: ClaudeCredentialMutationCoordinator
) {
  return {
    async create(_data: unknown, params?: AuthenticatedParams): Promise<ClaudeAuthLogoutResult> {
      const authUser = params?.user;
      if (!authUser?.user_id) {
        throw new NotAuthenticated('Sign in before removing your Claude login.');
      }
      const userId = authUser.user_id as UserID;

      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing active tenant context for Claude auth logout');
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);

      const key = `${tenantId}:${userId}`;
      const remove = async (generation?: number): Promise<ClaudeAuthLogoutResult> => {
        const identity = await resolveCodexCredentialRoute(
          userId,
          withTenantDatabase,
          app.get('config')
        );
        if (!identity.ok) {
          throw new BadRequest(
            `Cannot determine which Unix account holds this Claude login: ${identity.message}`
          );
        }

        // Fence a provider exchange before touching the file. If completion is
        // already persisting, the shared mutation lock waits for it and logout
        // linearizes afterward, so the old writer cannot resurrect the login.
        coordinator?.invalidate(key, 'This sign-in was cancelled by signing out.');

        // Delete the local login (idempotent — a missing file is success). A
        // genuine delete failure is a real server problem worth surfacing, and we
        // do NOT clear the method/token in that case so a login we couldn't remove
        // keeps working. Log the error class only — never token bytes.
        try {
          const routing = {
            delegatedHomeKey: identity.delegatedHomeKey,
            userId: identity.userId,
            ...(identity.claudeConfigDir ? { claudeConfigDir: identity.claudeConfigDir } : {}),
          };
          if (generation === undefined) await deleteClaudeAuthViaExecutor(routing);
          else await deleteClaudeAuthViaExecutor(routing, generation);
        } catch (err) {
          console.error(
            `[ClaudeAuth] Failed to delete .credentials.json${
              identity.delegatedHomeKey ? ` as ${identity.delegatedHomeKey}` : ''
            }: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
          );
          throw new BadRequest(
            'Could not remove the Claude credentials file on the server. Check daemon logs.'
          );
        }

        // Clear the stored method AND any pasted token via the users SERVICE (not a
        // direct db write) so the Feathers `patched` event fires and the settings
        // pane + board banners re-probe to a disconnected state. Send ONLY the
        // claude-code keys so the service's merge clears them against the FRESH
        // record — preserving any concurrently-updated method for another tool.
        const usersService = app.service('users') as UsersServiceLike;
        try {
          const patchParams = { user: authUser, authenticated: true };
          markTrustedUserMutation(patchParams, 'claude-auth');
          await usersService.patch(
            userId,
            {
              agentic_auth_methods: { 'claude-code': undefined },
              agentic_credential_sources: { 'claude-code': 'none' },
              agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } },
            },
            patchParams
          );
        } catch (error) {
          // The generation-fenced file deletion has already made native auth
          // unavailable. Preserve a write-gate 503, but do not leak database
          // errors. A subsequent Recheck/Disconnect reconciles stale metadata.
          if (error instanceof Unavailable) throw error;
          throw new BadRequest(
            'The Claude login file was removed, but account metadata could not be updated. Recheck or disconnect again.'
          );
        }

        return { status: 'removed' };
      };

      return coordinator
        ? coordinator.runCredentialMutation(
            claudeCredentialMutationKey(app.get('config'), tenantId, userId),
            remove
          )
        : remove();
    },
  };
}
