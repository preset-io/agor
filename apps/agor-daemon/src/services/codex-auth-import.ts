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

export interface AppLike {
  service(path: string): unknown;
}

export type CodexUnixIdentityResolution =
  | { ok: true; unixUser: string | null }
  | { ok: false; reason: 'missing-username' | 'resolve-failed'; message: string };

/**
 * Resolve the Unix account whose `~/.codex/auth.json` Codex will actually read
 * for this user: the daemon user (simple), the shared executor user
 * (insulated), or the caller's own Unix account (strict).
 *
 * Returns a discriminated result rather than throwing so callers with
 * different failure semantics (the import endpoint rejects, the check-auth
 * probe must distinguish "no identity configured" from "could not resolve")
 * don't have to grep error messages.
 */
export async function resolveCodexUnixIdentity(
  userId: UserID | undefined,
  withTenantDatabase: <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) => Promise<T>
): Promise<CodexUnixIdentityResolution> {
  const config = loadConfigSync();
  const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;

  let unixUsername: string | null = null;
  if (mode === 'strict') {
    if (!userId) {
      return {
        ok: false,
        reason: 'resolve-failed',
        message: 'Strict Unix user mode requires an authenticated user context.',
      };
    }
    const row = await withTenantDatabase((tenantDb) =>
      new UsersRepository(tenantDb).findById(userId)
    );
    unixUsername = row?.unix_username ?? null;
    if (!unixUsername) {
      return {
        ok: false,
        reason: 'missing-username',
        message:
          'Strict Unix user mode requires a unix_username — ask an admin to set one for your account.',
      };
    }
  }

  try {
    const resolved = resolveUnixUserForImpersonation({
      mode,
      userUnixUsername: unixUsername,
      executorUnixUser: config.execution?.executor_unix_user,
    });
    validateResolvedUnixUser(mode, resolved.unixUser);
    return { ok: true, unixUser: resolved.unixUser };
  } catch (err) {
    return {
      ok: false,
      reason: 'resolve-failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Persist a validated auth.json for a user: write it 0600 as the target Unix
 * user, verify by reading it back, then flip the user's Codex auth method to
 * `subscription` so executors resolve native auth. Shared by the paste-import
 * and device-code sign-in flows. Throws `BadRequest` with user-facing,
 * secret-free messages.
 */
export async function persistVerifiedCodexAuth(options: {
  app: AppLike;
  normalized: string;
  targetUnixUser: string | null;
  userId: UserID;
  authUser: NonNullable<AuthenticatedParams['user']>;
}): Promise<CodexAuthSummary> {
  const { app, normalized, targetUnixUser, userId, authUser } = options;

  try {
    writeCodexAuthFile(normalized, targetUnixUser);
  } catch (err) {
    // The error may carry sudo/bash stderr; log a class-level summary only
    // so token material (or its absence) never reaches daemon logs.
    console.error(
      `[CodexAuth] Failed to write auth.json${targetUnixUser ? ` as ${targetUnixUser}` : ''}: ${
        err instanceof Error ? err.constructor.name : 'unknown error'
      }`
    );
    throw new BadRequest(
      'Could not write the Codex credentials file on the server. Check daemon logs and sudo configuration, or use an API key instead.'
    );
  }

  // Read-back verification: the file must contain exactly the bytes just
  // written — "some valid credential is there" would let a concurrent
  // import/refresh be mistaken for this one. A transient read failure gets
  // one retry (the write already succeeded by exit status). Failing out
  // leaves the file on disk with the auth method unflipped; that state is
  // harmless because a re-import cleanly overwrites both.
  let readBack = readCodexAuthFile(targetUnixUser);
  if (!readBack.ok && readBack.reason === 'unreadable') {
    readBack = readCodexAuthFile(targetUnixUser);
  }
  const verified =
    readBack.ok && readBack.content === normalized ? parseCodexAuthJson(readBack.content) : null;
  if (!verified?.ok) {
    throw new BadRequest(
      'The Codex credentials file was written but could not be verified back — try again.'
    );
  }

  const usersService = app.service('users') as UsersServiceLike;
  const current = await usersService.get(userId, { user: authUser, authenticated: true });
  await usersService.patch(
    userId,
    { agentic_auth_methods: { ...current.agentic_auth_methods, codex: 'subscription' } },
    { user: authUser, authenticated: true }
  );

  return verified.summary;
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
