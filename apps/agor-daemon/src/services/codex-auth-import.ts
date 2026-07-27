/**
 * Codex Auth Import Service
 *
 * Accepts the contents of a Codex CLI `auth.json` pasted in the browser
 * (onboarding wizard / settings), validates its shape, writes it 0600 into the
 * Codex home of the Unix identity that will run Codex for this user, verifies
 * it back, and flips the user's Codex auth method to `subscription` so
 * executors use the file instead of an env API key.
 *
 * SECURITY CONTRACT:
 * - The pasted payload is token material: browser → daemon → target user's
 *   filesystem only. It is never logged, never echoed back, and never enters
 *   any agent/LLM context. The response carries non-secret metadata only.
 * - The write happens AS the target Unix user (sudo, content over stdin), so
 *   ownership and 0600 permissions hold in insulated/strict modes.
 * - Callers act only on their own credentials — the target identity is always
 *   derived from the authenticated user, never from request data.
 */

import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, CodexAuthImportResult, UserID } from '@agor/core/types';
import { parseCodexAuthJson } from '../utils/codex-auth-file.js';
import {
  type AppLike,
  persistVerifiedCodexAuth,
  resolveCodexUnixIdentity,
} from './codex-auth-shared.js';

export function createCodexAuthImportService(app: AppLike, db: TenantScopeAwareDatabase) {
  return {
    async create(
      data: { authJson?: string },
      params?: AuthenticatedParams
    ): Promise<CodexAuthImportResult> {
      const authUser = params?.user;
      if (!authUser?.user_id) {
        throw new NotAuthenticated('Sign in before importing Codex credentials.');
      }
      const userId = authUser.user_id as UserID;

      const config = loadConfigSync();
      if (config.multi_tenancy?.mode === 'required_from_auth') {
        throw new BadRequest(
          'Codex subscription login is unavailable in hosted multi-tenant mode — use an OpenAI API key instead.'
        );
      }

      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing active tenant context for Codex auth import');
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);

      if (
        !(await withTenantDatabase((tenantDb) => isTenantAgenticToolEnabled('codex', tenantDb)))
      ) {
        throw new BadRequest('Codex is disabled for this workspace.');
      }

      const parsed = parseCodexAuthJson(data?.authJson);
      if (!parsed.ok) throw new BadRequest(parsed.error);

      const identity = await resolveCodexUnixIdentity(userId, withTenantDatabase);
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine which Unix account should hold this Codex login: ${identity.message}`
        );
      }

      const summary = await persistVerifiedCodexAuth({
        app,
        normalized: parsed.normalized,
        targetUnixUser: identity.unixUser,
        userId,
        authUser,
      });

      return {
        status: 'authenticated',
        authMode: summary.authMode,
        ...(summary.planType ? { planType: summary.planType } : {}),
        hint:
          summary.authMode === 'api_key'
            ? 'Imported a Codex auth file carrying an OpenAI API key.'
            : summary.planType
              ? `Signed in with ChatGPT (${summary.planType} plan).`
              : 'Signed in with ChatGPT.',
      };
    },
  };
}
