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

import {
  type AgorConfig,
  hasCrossReplicaExecutorCredentialLock,
  hasTenantSafeExecutorCredentialHome,
} from '@agor/core/config';
import {
  getCurrentTenantId,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  AgenticAuthMethods,
  AuthenticatedParams,
  DeepReadonly,
  User,
  UserID,
} from '@agor/core/types';
import type { CodexAuthSummary } from '../utils/codex-auth-file.js';
import { writeCodexAuthCredential } from '../utils/executor-codex-auth.js';
import {
  ExecutionCredentialHomeResolutionError,
  resolveExecutionCredentialHome,
} from './credential-home-identity.js';

export interface AppLike {
  get(name: 'config'): DeepReadonly<AgorConfig>;
  get(name: 'db'): TenantScopeAwareDatabase;
  service(path: string): unknown;
}

/** Narrow authority required by import/logout to serialize credential-file mutations. */
export interface CodexCredentialMutationCoordinator {
  runCredentialMutation<T>(
    tenantId: string,
    userId: UserID,
    reason: 'credentials_imported' | 'credentials_removed',
    work: (authorityGeneration: number) => Promise<T>
  ): Promise<T>;
}

/** In-process users-service flag: publish this mutation only after its outer DB commit. */
export const CODEX_AUTH_DEFER_USER_REALTIME = Symbol('codex-auth-defer-user-realtime');

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
       * Explicit native Codex state root for the auth-file executor.
       * Set for the built-in local `simple` executor to an Agor-managed user
       * namespace, and in `sandbox` to the caller's per-user home store.
       * Undefined for templated/external execution, where that substrate owns
       * the effective user's home.
       */
      codexHome?: string;
    }
  | {
      ok: false;
      reason:
        | 'missing-username'
        | 'resolve-failed'
        | 'unsupported-mode'
        | 'unsupported-home-override';
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
  const mode = config.execution?.unix_user_mode ?? 'simple';

  if (config.deployment?.mode === 'ha' && !hasCrossReplicaExecutorCredentialLock(config)) {
    return {
      ok: false,
      reason: 'unsupported-mode',
      message:
        'HA Codex credential operations require ' +
        'execution.executor_storage.user_home_locking: cross-replica-flock. ' +
        'Verify the shared storage propagates flock across every replica, or use an API key.',
    };
  }

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

  try {
    if (!userId) {
      return {
        ok: false,
        reason: 'resolve-failed',
        message: 'Codex credential routing requires an authenticated user identity.',
      };
    }
    // Resolve the exact same identity used by the session execution path. The
    // native-auth safety check compares these values, so deriving the write
    // route independently would make that check vulnerable to semantic drift.
    const resolved = await resolveExecutionCredentialHome({
      userId,
      tenantId: getCurrentTenantId(),
      config,
      withTenantDatabase,
      agenticTool: 'codex',
    });
    if (config.deployment?.mode === 'ha' && resolved.homeStoreSource === 'override') {
      return {
        ok: false,
        reason: 'unsupported-home-override',
        message:
          'HA Codex subscription auth requires Agor’s canonical tenant/user home. ' +
          'Remove the filesystem_home override for this account or use an API key.',
      };
    }
    return {
      ok: true,
      delegatedHomeKey: resolved.delegatedHomeKey,
      userId,
      ...(resolved.codexHome ? { codexHome: resolved.codexHome } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof ExecutionCredentialHomeResolutionError && err.reason === 'missing-username'
          ? 'missing-username'
          : 'resolve-failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Persist a validated auth.json for a user: write it 0600 through the selected
 * credential route, verify it, then flip the user's Codex auth method to
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
  /** Daemon-authorized `CODEX_HOME` when the local execution mode selects one explicitly. */
  codexHome?: string;
  /** PostgreSQL authority generation for HA filesystem fencing. */
  authorityGeneration?: number;
}): Promise<CodexAuthSummary> {
  const { app, normalized, delegatedHomeKey, userId, authUser, codexHome, authorityGeneration } =
    options;

  let summary: CodexAuthSummary;
  try {
    summary = await writeCodexAuthCredential(
      normalized,
      {
        delegatedHomeKey,
        userId,
        codexHome,
      },
      authorityGeneration
    );
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
    {
      user: authUser,
      authenticated: true,
      ...(authorityGeneration === undefined ? {} : { [CODEX_AUTH_DEFER_USER_REALTIME]: true }),
    }
  );

  return summary;
}
