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
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AuthenticatedParams,
  CodexAuthImportResult,
  User,
  UserID,
} from '@agor/core/types';
import {
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import {
  type CodexAuthSummary,
  parseCodexAuthJson,
  readCodexAuthFile,
  writeCodexAuthFile,
} from '../utils/codex-auth-file.js';

/** Minimal users-service surface — mirrors the widget handlers' structural typing. */
interface UsersServiceLike {
  get(id: UserID, params?: unknown): Promise<User>;
  patch(
    id: UserID,
    data: { agentic_auth_methods: AgenticAuthMethods },
    params?: unknown
  ): Promise<unknown>;
}

interface AppLike {
  service(path: string): unknown;
}

function importHint(summary: CodexAuthSummary): string {
  if (summary.authMode === 'api_key') {
    return 'Imported a Codex auth file carrying an OpenAI API key.';
  }
  return summary.planType
    ? `Signed in with ChatGPT (${summary.planType} plan).`
    : 'Signed in with ChatGPT.';
}

/**
 * Resolve the Unix account whose `~/.codex/auth.json` Codex will actually read
 * for this user: the daemon user (simple), the shared executor user
 * (insulated), or the caller's own Unix account (strict).
 */
export async function resolveCodexAuthTargetUser(
  userId: UserID,
  withTenantDatabase: <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) => Promise<T>
): Promise<string | null> {
  const config = loadConfigSync();
  const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;

  let unixUsername: string | null = null;
  if (mode === 'strict') {
    const row = await withTenantDatabase((tenantDb) =>
      new UsersRepository(tenantDb).findById(userId)
    );
    unixUsername = row?.unix_username ?? null;
  }

  const resolved = resolveUnixUserForImpersonation({
    mode,
    userUnixUsername: unixUsername,
    executorUnixUser: config.execution?.executor_unix_user,
  });
  validateResolvedUnixUser(mode, resolved.unixUser);
  return resolved.unixUser;
}

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

      let targetUnixUser: string | null;
      try {
        targetUnixUser = await resolveCodexAuthTargetUser(userId, withTenantDatabase);
      } catch (err) {
        throw new BadRequest(
          `Cannot determine which Unix account should hold this Codex login: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      try {
        writeCodexAuthFile(parsed.normalized, targetUnixUser);
      } catch (err) {
        // The error may carry sudo/bash stderr; log a class-level summary only
        // so token material (or its absence) never reaches daemon logs.
        console.error(
          `[CodexAuthImport] Failed to write auth.json${
            targetUnixUser ? ` as ${targetUnixUser}` : ''
          }: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
        );
        throw new BadRequest(
          'Could not write the Codex credentials file on the server. Check daemon logs and sudo configuration, or use an API key instead.'
        );
      }

      const readBack = readCodexAuthFile(targetUnixUser);
      const verified = readBack ? parseCodexAuthJson(readBack) : null;
      if (!verified?.ok) {
        throw new BadRequest(
          'The Codex credentials file was written but could not be read back for verification — try again.'
        );
      }

      // Flip the user's Codex auth method so executors resolve native auth
      // (auth.json) instead of expecting an OPENAI_API_KEY.
      const usersService = app.service('users') as UsersServiceLike;
      const current = await usersService.get(userId, { user: authUser, authenticated: true });
      await usersService.patch(
        userId,
        { agentic_auth_methods: { ...current.agentic_auth_methods, codex: 'subscription' } },
        { user: authUser, authenticated: true }
      );

      return {
        status: 'authenticated',
        authMode: verified.summary.authMode,
        ...(verified.summary.planType ? { planType: verified.summary.planType } : {}),
        hint: importHint(verified.summary),
      };
    },
  };
}
