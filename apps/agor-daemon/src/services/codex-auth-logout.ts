/**
 * Codex Auth Logout Service
 *
 * Removes the current user's Codex ChatGPT login: best-effort revokes the OAuth
 * tokens (like `codex logout`), deletes the `auth.json` from the Codex home of
 * the Unix identity that runs Codex for this user, and clears the stored
 * `agentic_auth_methods.codex` so executors stop resolving native auth and the
 * UI re-probes to a disconnected state (the `patched` event drives that).
 *
 * SECURITY CONTRACT:
 * - Acts ONLY on the caller's own login — the target identity is always derived
 *   from the authenticated user, never from request data.
 * - Token material is read transiently to revoke and is never logged or
 *   returned; only a class-level revocation outcome is reported.
 * - Removal is idempotent and is NEVER blocked by a revocation failure.
 * - Unlike import, removal is not gated on hosted-mode / tool-enabled checks:
 *   cleaning up a login must stay possible even after Codex is disabled.
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
import { deleteCodexAuthFile, readCodexAuthFile } from '../utils/codex-auth-file.js';
import { revokeCodexChatgptTokens } from '../utils/codex-auth-revoke.js';
import { type AppLike, resolveCodexUnixIdentity } from './codex-auth-import.js';

/** Minimal users-service surface — mirrors the import service's structural typing. */
interface UsersServiceLike {
  patch(
    id: UserID,
    data: { agentic_auth_methods: AgenticAuthMethods },
    params?: unknown
  ): Promise<unknown>;
}

export function createCodexAuthLogoutService(app: AppLike, db: TenantScopeAwareDatabase) {
  return {
    async create(_data: unknown, params?: AuthenticatedParams): Promise<CodexAuthLogoutResult> {
      const authUser = params?.user;
      if (!authUser?.user_id) {
        throw new NotAuthenticated('Sign in before removing your Codex login.');
      }
      const userId = authUser.user_id as UserID;

      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing active tenant context for Codex auth logout');
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);

      const identity = await resolveCodexUnixIdentity(userId, withTenantDatabase);
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine which Unix account holds this Codex login: ${identity.message}`
        );
      }

      // Capture the current login (if any) to revoke its tokens, then delete it
      // IMMEDIATELY — before the network revoke — so a concurrent connect/refresh
      // can't be clobbered by a delete that waited on the multi-second revoke
      // round-trip. In shared-identity Unix modes the auth.json is a single
      // server-wide file, so connects/deletes are inherently last-writer-wins;
      // deleting before the revoke keeps logout's window to two back-to-back
      // filesystem ops rather than a network-length one.
      const existing = readCodexAuthFile(identity.unixUser);

      // Delete the local login (idempotent). A genuine delete failure is a real
      // server problem worth surfacing — and we do NOT revoke in that case, so a
      // login we could not remove keeps working. Log the error class only.
      try {
        deleteCodexAuthFile(identity.unixUser);
      } catch (err) {
        console.error(
          `[CodexAuth] Failed to delete auth.json${
            identity.unixUser ? ` as ${identity.unixUser}` : ''
          }: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
        );
        throw new BadRequest(
          'Could not remove the Codex credentials file on the server. Check daemon logs and sudo configuration.'
        );
      }

      // Best-effort revoke the tokens we just removed (server-side; independent
      // of the now-deleted file). Never blocks — network/expired/already-revoked
      // all proceed; a missing file simply yields `skipped`.
      const revoked: CodexAuthLogoutResult['revoked'] = existing.ok
        ? await revokeCodexChatgptTokens(existing.content)
        : 'skipped';

      // Clear the stored method via the users SERVICE (not a direct db write) so
      // the Feathers `patched` event fires and the settings pane + board banners
      // re-probe to a disconnected state. Send ONLY the codex key so the
      // service's merge clears it against the FRESH record — preserving any
      // concurrently-updated method for another tool instead of clobbering it
      // with a read-modify-write of a stale snapshot.
      const usersService = app.service('users') as UsersServiceLike;
      await usersService.patch(
        userId,
        { agentic_auth_methods: { codex: undefined } },
        { user: authUser, authenticated: true }
      );

      return { status: 'removed', revoked };
    },
  };
}
