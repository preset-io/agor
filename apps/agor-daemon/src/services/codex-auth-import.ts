/**
 * Codex Auth Import Service
 *
 * Accepts the contents of a Codex CLI `auth.json` pasted in the browser
 * (onboarding wizard / settings), validates its shape, writes it 0600 into the
 * Codex execution home for this user, verifies
 * it back, and flips the user's Codex auth method to `subscription` so
 * executors use the file instead of an env API key.
 *
 * SECURITY CONTRACT:
 * - The pasted payload is token material: browser → daemon → target user's
 *   filesystem only. It is never logged, never echoed back, and never enters
 *   any agent/LLM context. The response carries non-secret metadata only.
 * - The write uses the configured execution substrate with restrictive file
 *   permissions in the selected execution home.
 * - Callers act only on their own credentials — the target identity is always
 *   derived from the authenticated user, never from request data.
 */

import { isTenantAgenticToolEnabled } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, CodexAuthImportResult, UserID } from '@agor/core/types';
import type { CodexCredentialBindInvalidator } from '../codex-auth-bind-invalidation.js';
import { parseCodexAuthJson } from '../utils/codex-auth-file.js';
import {
  type AppLike,
  type CodexCredentialMutationCoordinator,
  persistVerifiedCodexAuth,
  resolveCodexCredentialRoute,
} from './codex-auth-shared.js';

export function createCodexAuthImportService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  credentialMutations?: CodexCredentialMutationCoordinator,
  invalidateCredentialBinds: CodexCredentialBindInvalidator = async () => undefined
) {
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

      const persist = (authorityGeneration?: number) =>
        persistVerifiedCodexAuth({
          app,
          normalized: parsed.normalized,
          delegatedHomeKey: identity.delegatedHomeKey,
          userId,
          authUser,
          codexHome: identity.codexHome,
          authorityGeneration,
        });
      const summary = credentialMutations
        ? await credentialMutations.runCredentialMutation(
            String(tenantId),
            userId,
            'credentials_imported',
            persist
          )
        : await persist();
      await invalidateCredentialBinds({
        tenantId: String(tenantId),
        userId,
        reason: 'credentials_imported',
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
