/**
 * Codex Auth Shared Core
 *
 * The identity-resolution and credential-persistence primitives shared by every
 * Codex auth endpoint — paste-import, device sign-in, logout, and the check-auth
 * probe. Kept in one neutral module so no single endpoint file (formerly
 * `codex-auth-import`) doubles as the shared core its siblings import from.
 *
 * SECURITY CONTRACT (inherited by every caller):
 * - The delegated home key is always derived from the authenticated user,
 *   never from request data — callers act only on their own credentials.
 * - Token material flows browser → daemon → target user's filesystem only. It is
 *   never logged, echoed back, or placed in any agent/LLM context; failures log
 *   an error class, never token bytes.
 * - Writes run through the configured execution substrate and use restrictive
 *   file permissions in the selected execution home.
 */

import { join } from 'node:path';
import {
  type AgorConfig,
  hasTenantSafeExecutorCredentialHome,
  unixUserModeRequiresExecutionHomeKey,
} from '@agor/core/config';
import { getCurrentTenantId, type TenantScopedDatabase, UsersRepository } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AuthenticatedParams,
  DeepReadonly,
  User,
  UserID,
} from '@agor/core/types';
import { resolveDelegatedHomeKey, type UnixUserMode } from '@agor/core/unix';
import type { CodexAuthSummary } from '../utils/codex-auth-file.js';
import { writeCodexAuthViaExecutor } from '../utils/executor-codex-auth.js';
import { resolveOwnerHomeStore } from '../utils/sandbox-context.js';

export interface AppLike {
  get(name: 'config'): DeepReadonly<AgorConfig>;
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

export type CodexCredentialRouteResolution =
  | {
      ok: true;
      /** Opaque home key reported to an external executor launcher. */
      delegatedHomeKey: string | null;
      /** Stable trusted identity for persistent-per-user storage selection. */
      userId: UserID;
      /**
       * Explicit `CODEX_HOME` (the `.codex` dir) for the auth-file executor.
       * Set in `unix_user_mode: sandbox` to the caller's per-user home store so
       * auth is written where the sandboxed session (with that store overlaid at
       * `~`) reads it. Undefined in other modes (executor uses the effective
       * user's `~/.codex`).
       */
      codexHome?: string;
    }
  | {
      ok: false;
      reason: 'missing-username' | 'resolve-failed' | 'unsupported-mode';
      message: string;
    };

/**
 * Resolve the credential-home route that Codex will read for this user.
 * Delegated execution additionally requires an explicit persistent-per-user
 * executor-home guarantee.
 *
 * Returns a discriminated result rather than throwing so callers with
 * different failure semantics (the import endpoint rejects, the check-auth
 * probe must distinguish "no identity configured" from "could not resolve")
 * don't have to grep error messages.
 */
export async function resolveCodexCredentialRoute(
  userId: UserID | undefined,
  withTenantDatabase: <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) => Promise<T>,
  config: DeepReadonly<AgorConfig>
): Promise<CodexCredentialRouteResolution> {
  const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;

  if (!hasTenantSafeExecutorCredentialHome(config)) {
    return {
      ok: false,
      reason: 'unsupported-mode',
      message:
        'hosted multi-tenant Codex credentials require ' +
        'execution.executor_storage.user_home: persistent-per-user.',
    };
  }

  // The operation itself runs through the executor template. Fail closed
  // unless that substrate promises the same isolated home for auth helpers
  // and later Tasks for the trusted user identity.
  if (
    mode === 'delegated' &&
    config.execution?.executor_command_template &&
    config.execution?.executor_storage?.user_home !== 'persistent-per-user'
  ) {
    return {
      ok: false,
      reason: 'unsupported-mode',
      message:
        'In delegated execution mode with templated execution, Codex credentials live in the ' +
        "execution substrate's per-user home, but execution.executor_storage.user_home does not " +
        'guarantee persistent-per-user routing. Configure that contract or use an API key.',
    };
  }

  let unixUsername: string | null = null;
  // Delegated execution requires a stable per-user home key. A missing value
  // must surface as the actionable `missing-username` result.
  if (unixUserModeRequiresExecutionHomeKey(mode)) {
    if (!userId) {
      return {
        ok: false,
        reason: 'resolve-failed',
        message: 'Delegated execution mode requires an authenticated user context.',
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
          'Delegated execution mode requires a unix_username — ask an admin to set one for your account.',
      };
    }
  }

  try {
    const resolved = resolveDelegatedHomeKey({
      mode,
      executionHomeKey: unixUsername,
    });
    if (!userId) {
      return {
        ok: false,
        reason: 'resolve-failed',
        message: 'Codex credential routing requires an authenticated user identity.',
      };
    }
    // In sandbox mode the executor runs as the daemon user with the caller's
    // per-user store overlaid at `~`. Auth must be written to THAT store's
    // `.codex` (honoring an explicit filesystem_home), so both the auth flow and
    // later sandboxed sessions agree on where auth.json lives.
    let codexHome: string | undefined;
    if (mode === 'sandbox') {
      const tenantId = getCurrentTenantId();
      const row = await withTenantDatabase((tenantDb) =>
        new UsersRepository(tenantDb).findById(userId)
      );
      codexHome = join(
        resolveOwnerHomeStore({
          config,
          tenantId,
          ownerUserId: userId,
          filesystemHome: row?.filesystem_home,
        }),
        '.codex'
      );
    }
    return {
      ok: true,
      delegatedHomeKey: resolved.delegatedHomeKey,
      userId,
      ...(codexHome ? { codexHome } : {}),
    };
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
  delegatedHomeKey: string | null;
  userId: UserID;
  authUser: NonNullable<AuthenticatedParams['user']>;
  /** Per-user store `.codex` for sandbox mode (see CodexCredentialRouteResolution.codexHome). */
  codexHome?: string;
}): Promise<CodexAuthSummary> {
  const { app, normalized, delegatedHomeKey, userId, authUser, codexHome } = options;

  let summary: CodexAuthSummary;
  try {
    summary = await writeCodexAuthViaExecutor(normalized, {
      delegatedHomeKey,
      userId,
      codexHome,
    });
  } catch (err) {
    // The error may carry launcher stderr; log a class-level summary only
    // so token material (or its absence) never reaches daemon logs.
    console.error(
      `[CodexAuth] Failed to write auth.json: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
    );
    throw new BadRequest(
      'Could not write the Codex credentials file on the server. Check daemon logs or use an API key instead.'
    );
  }

  const usersService = app.service('users') as UsersServiceLike;
  const current = await usersService.get(userId, { user: authUser, authenticated: true });
  await usersService.patch(
    userId,
    { agentic_auth_methods: { ...current.agentic_auth_methods, codex: 'subscription' } },
    { user: authUser, authenticated: true }
  );

  return summary;
}
