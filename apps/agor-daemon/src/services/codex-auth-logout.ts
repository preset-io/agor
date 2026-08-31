/**
 * Codex Auth Logout Service
 *
 * Removes the current user's Codex ChatGPT login from THIS server: deletes the
 * `auth.json` from the resolved Codex credential home for this
 * user, and clears the stored `agentic_auth_methods.codex` so executors stop
 * resolving native auth and the UI re-probes to a disconnected state (the
 * `patched` event drives that).
 *
 * DELETE-ONLY BY DESIGN: this is an Agor-scoped action, mirroring the API-key
 * "Clear" precedent — it signs Codex out on THIS server only and does NOT revoke
 * the OAuth tokens. The server's auth.json is frequently a transplant of the
 * user's own laptop login, so a global token revocation would be a footgun
 * (it would sign them out everywhere). Authoritative revocation lives in
 * ChatGPT's security settings or `codex logout` on a machine where they're
 * signed in.
 *
 * SECURITY CONTRACT:
 * - Acts ONLY on the caller's own login — the target identity is always derived
 *   from the authenticated user, never from request data.
 * - Removal is idempotent; a genuine delete failure surfaces and does NOT clear
 *   the stored method (a login we couldn't remove keeps working).
 * - Shared identity resolution refuses an auth-resolved tenant topology unless
 *   the execution substrate guarantees a persistent-per-user home. Cleanup is
 *   not gated on the tool-enabled check, so it remains possible after Codex is
 *   disabled.
 */

import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AuthenticatedParams,
  CodexAuthLogoutResult,
  UserID,
} from '@agor/core/types';
import type { CodexCredentialBindInvalidator } from '../codex-auth-bind-invalidation.js';
import { deleteCodexAuthCredential } from '../utils/executor-codex-auth.js';
import {
  type AppLike,
  CODEX_AUTH_DEFER_USER_REALTIME,
  type CodexCredentialMutationCoordinator,
  resolveCodexCredentialRoute,
  sameCodexCredentialRoute,
} from './codex-auth-shared.js';

/** Minimal users-service surface — mirrors the import service's structural typing. */
interface UsersServiceLike {
  patch(
    id: UserID,
    data: { agentic_auth_methods: AgenticAuthMethods },
    params?: unknown
  ): Promise<unknown>;
}

export function createCodexAuthLogoutService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  credentialMutations?: CodexCredentialMutationCoordinator,
  invalidateCredentialBinds: CodexCredentialBindInvalidator = async () => undefined
) {
  return {
    async create(_data: unknown, params?: AuthenticatedParams): Promise<CodexAuthLogoutResult> {
      const authUser = params?.user;
      if (!authUser?.user_id) {
        throw new NotAuthenticated('Sign in before removing your Codex login.');
      }
      const userId = authUser.user_id as UserID;

      // Hosted multi-tenant mode is safe only when the external substrate
      // selects the same isolated home from trusted tenant/user identity for
      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing active tenant context for Codex auth logout');
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);

      const identity = await resolveCodexCredentialRoute(
        userId,
        withTenantDatabase,
        app.get('config')
      );
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine the credential home for this Codex login: ${identity.message}`
        );
      }

      const validateRoute = async () => {
        const currentRoute = await resolveCodexCredentialRoute(
          userId,
          withTenantDatabase,
          app.get('config')
        );
        if (!currentRoute.ok || !sameCodexCredentialRoute(currentRoute, identity)) {
          throw new BadRequest(
            'The execution home changed while removing credentials. Disconnect again for the current home.'
          );
        }
      };
      const mutate = async (authorityGeneration?: number): Promise<void> => {
        // Delete the local login (idempotent — a missing file is success). A
        // genuine delete failure is a real server problem worth surfacing, and we
        // do NOT clear the method in that case so a login we couldn't remove keeps
        // working. Log the error class only — never token bytes.
        try {
          const routing = {
            delegatedHomeKey: identity.delegatedHomeKey,
            userId: identity.userId,
            codexHome: identity.codexHome,
          };
          if (authorityGeneration === undefined) await deleteCodexAuthCredential(routing);
          else await deleteCodexAuthCredential(routing, authorityGeneration);
        } catch (err) {
          console.error(
            `[CodexAuth] Failed to delete auth.json: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
          );
          throw new BadRequest(
            'Could not remove the Codex credentials file on the server. Check daemon logs.'
          );
        }

        // Clear the stored method via the users SERVICE (not a direct db write) so
        // the Feathers `patched` event fires and the settings pane + board banners
        // re-probe to a disconnected state. Send ONLY the codex key so the
        // service's merge clears it against the FRESH record — preserving any
        // concurrently-updated method for another tool instead of clobbering it
        // with a read-modify-write of a stale snapshot. This relies on the
        // in-process service call: the explicitly-undefined key survives to the
        // merge and is dropped when the JSON column serializes; a client-
        // transported patch would lose the key in JSON and silently no-op.
        const usersService = app.service('users') as UsersServiceLike;
        await usersService.patch(
          userId,
          { agentic_auth_methods: { codex: undefined } },
          {
            user: authUser,
            authenticated: true,
            ...(authorityGeneration === undefined
              ? {}
              : { [CODEX_AUTH_DEFER_USER_REALTIME]: true }),
          }
        );
      };

      if (credentialMutations) {
        await credentialMutations.runCredentialMutation(
          String(tenantId),
          userId,
          'credentials_removed',
          mutate,
          validateRoute
        );
      } else {
        await validateRoute();
        await mutate();
      }
      await invalidateCredentialBinds({
        tenantId: String(tenantId),
        userId,
        reason: 'credentials_removed',
      });

      return { status: 'removed' };
    },
  };
}
