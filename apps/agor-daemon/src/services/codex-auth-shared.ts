/**
 * Codex Auth Shared Core
 *
 * The identity-resolution and credential-persistence primitives shared by every
 * Codex auth endpoint — paste-import, device sign-in, logout, and the check-auth
 * probe. Kept in one neutral module so no single endpoint file (formerly
 * `codex-auth-import`) doubles as the shared core its siblings import from.
 *
 * SECURITY CONTRACT (inherited by every caller):
 * - The target Unix identity is always derived from the authenticated user,
 *   never from request data — callers act only on their own credentials.
 * - Token material flows browser → daemon → target user's filesystem only. It is
 *   never logged, echoed back, or placed in any agent/LLM context; failures log
 *   an error class, never token bytes.
 * - Writes happen AS the target Unix user (sudo, content over stdin), so
 *   ownership and 0600 permissions hold in insulated/strict modes.
 */

import { loadConfigSync } from '@agor/core/config';
import { type TenantScopedDatabase, UsersRepository } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AgenticAuthMethods, AuthenticatedParams, User, UserID } from '@agor/core/types';
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

export interface AppLike {
  service(path: string): unknown;
}

/** Minimal users-service surface — mirrors the widget handlers' structural typing. */
interface UsersServiceLike {
  get(id: UserID, params?: unknown): Promise<User>;
  patch(
    id: UserID,
    data: { agentic_auth_methods: AgenticAuthMethods },
    params?: unknown
  ): Promise<unknown>;
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
