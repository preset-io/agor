/**
 * Codex Device-Code Sign-In Service
 *
 * Drives OpenAI's ChatGPT device-code authorization for Codex natively from
 * the daemon, so the onboarding wizard can sign a user in without a terminal:
 *
 *   1. `create` → POST auth.openai.com/api/accounts/deviceauth/usercode with
 *      Codex's public client id → `{device_auth_id, user_code, interval}`.
 *      The UI shows the code + verification URL; the daemon starts polling.
 *   2. Poll POST .../deviceauth/token with `{device_auth_id, user_code}` at
 *      the server-specified interval. 403/404 mean "not approved yet"; codes
 *      hard-expire after 15 minutes.
 *   3. On approval the server returns an authorization code plus a
 *      server-generated PKCE pair, exchanged at /oauth/token
 *      (grant_type=authorization_code) for id/access/refresh tokens.
 *   4. Tokens are persisted as a Codex-format auth.json (0600, as the Unix
 *      identity that runs Codex for this user) and the user's Codex auth
 *      method flips to `subscription`.
 *
 * Protocol verified against openai/codex `codex-rs/login/src/device_code_auth.rs`
 * and `server.rs` (July 2026).
 *
 * One in-flight attempt per user: starting a new attempt cancels and replaces
 * the previous one. Attempts live in daemon memory only — a restart discards
 * them and the user simply requests a fresh code.
 *
 * SECURITY CONTRACT: tokens transit UI ↔ daemon ↔ auth.openai.com and the
 * target user's filesystem only. Status responses carry the user code and
 * non-secret metadata; token material is never returned, logged, or exposed
 * to any agent/LLM context. Callers act only on their own credentials.
 */

import { isTenantAgenticToolEnabled } from '@agor/core/config';
import {
  generateId,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  CodexDeviceAuthAttemptID,
  CodexDeviceAuthStatus,
  TenantID,
  UserID,
} from '@agor/core/types';
import {
  exchangeCodexDeviceAuthorization,
  pollCodexDeviceAuthorization,
} from './codex-device-auth-flow.js';
import {
  buildDeviceAuthJson,
  CODEX_AUTH_ISSUER,
  codexDeviceAuthProvider,
  DEVICE_CODE_LIFETIME_MS,
  DeviceAuthProviderError,
  requestUserCode,
  type UserCodeGrant,
} from './codex-device-auth-provider.js';

export { buildDeviceAuthJson } from './codex-device-auth-provider.js';

import type { CodexCredentialBindInvalidator } from '../codex-auth-bind-invalidation.js';
import {
  type AppLike,
  persistVerifiedCodexAuth,
  resolveCodexCredentialRoute,
} from './codex-auth-shared.js';

const UNAVAILABLE_HINT =
  'Your ChatGPT account does not allow device-code sign-in. Personal accounts can turn it on under ChatGPT Settings → Security → "Device code authorization for Codex"; workspace accounts need an admin to enable it. You can also paste an auth.json or use an API key instead.';

interface DeviceAuthAttempt {
  attemptId: CodexDeviceAuthAttemptID;
  key: string;
  userId: UserID;
  tenantId: TenantID | string;
  authUser: NonNullable<AuthenticatedParams['user']>;
  delegatedHomeKey: string | null;
  codexHome?: string;
  phase: CodexDeviceAuthStatus['phase'];
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAtMs: number;
  planType?: string;
  hint?: string;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  finishedAtMs?: number;
}

/** How long a finished attempt stays queryable before eviction. */
const TERMINAL_ATTEMPT_TTL_MS = 60 * 60 * 1000;

function statusOf(attempt: DeviceAuthAttempt | undefined): CodexDeviceAuthStatus {
  if (!attempt) return { phase: 'idle' };
  const base: CodexDeviceAuthStatus = { phase: attempt.phase, attemptId: attempt.attemptId };
  // userCode is empty while the slot is reserved but the provider has not
  // answered yet — don't surface a blank code for that sub-second window.
  if (attempt.phase === 'pending' && attempt.userCode) {
    base.userCode = attempt.userCode;
    base.verificationUrl = `${CODEX_AUTH_ISSUER}/codex/device`;
    base.expiresAt = new Date(attempt.expiresAtMs).toISOString();
  }
  if (attempt.planType) base.planType = attempt.planType;
  if (attempt.hint) base.hint = attempt.hint;
  return base;
}

export function createCodexDeviceAuthService(
  app: AppLike,
  db: TenantScopeAwareDatabase,
  invalidateCredentialBinds: CodexCredentialBindInvalidator = async () => undefined
) {
  const attempts = new Map<string, DeviceAuthAttempt>();

  function cancelAttempt(key: string): void {
    const existing = attempts.get(key);
    if (!existing) return;
    existing.cancelled = true;
    if (existing.timer) clearTimeout(existing.timer);
  }

  function finish(
    attempt: DeviceAuthAttempt,
    phase: DeviceAuthAttempt['phase'],
    hint?: string
  ): void {
    attempt.phase = phase;
    attempt.finishedAtMs = Date.now();
    if (hint) attempt.hint = hint;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = undefined;
  }

  /**
   * Abandoned flows would otherwise grow the map forever on long-running
   * daemons — one entry per user who started and never finished a sign-in.
   */
  function pruneFinishedAttempts(): void {
    const cutoff = Date.now() - TERMINAL_ATTEMPT_TTL_MS;
    for (const [key, attempt] of attempts) {
      if (attempt.phase !== 'pending' && (attempt.finishedAtMs ?? 0) < cutoff) {
        attempts.delete(key);
      }
    }
  }

  async function pollTick(attempt: DeviceAuthAttempt): Promise<void> {
    if (attempt.cancelled || attempt.phase !== 'pending') return;
    if (Date.now() >= attempt.expiresAtMs) {
      finish(attempt, 'expired', 'The sign-in code expired — get a new one and try again.');
      return;
    }

    const polled = await pollCodexDeviceAuthorization(codexDeviceAuthProvider, {
      deviceAuthId: attempt.deviceAuthId,
      userCode: attempt.userCode,
      intervalMs: attempt.intervalMs,
    });
    if (attempt.cancelled) return;

    if (polled.outcome === 'retry') {
      attempt.intervalMs = polled.intervalMs;
      scheduleNext(attempt);
      return;
    }
    if (polled.outcome === 'failed') {
      finish(attempt, 'error', 'ChatGPT sign-in failed — get a new code and try again.');
      return;
    }
    if (polled.outcome === 'denied') {
      finish(attempt, 'error', 'ChatGPT sign-in was denied — get a new code and try again.');
      return;
    }
    if (polled.outcome === 'expired') {
      finish(attempt, 'expired', 'The sign-in code expired — get a new one and try again.');
      return;
    }

    try {
      const exchanged = await exchangeCodexDeviceAuthorization(
        codexDeviceAuthProvider,
        polled.approved
      );
      if (exchanged.outcome === 'failed') {
        finish(attempt, 'error', 'Signing in succeeded but saving the login failed — try again.');
        return;
      }
      const { tokens } = exchanged;
      // Ownership check in addition to the cancelled flag: a replacement
      // attempt registered during the exchange must not have its freshly
      // written credential clobbered by this older one.
      if (attempt.cancelled || attempts.get(attempt.key) !== attempt) return;
      const summary = await runWithTenantDatabaseScope(db, attempt.tenantId, () =>
        persistVerifiedCodexAuth({
          app,
          normalized: buildDeviceAuthJson(tokens),
          delegatedHomeKey: attempt.delegatedHomeKey,
          userId: attempt.userId,
          authUser: attempt.authUser,
          codexHome: attempt.codexHome,
        })
      );
      await invalidateCredentialBinds({
        tenantId: String(attempt.tenantId),
        userId: attempt.userId,
        reason: 'credentials_imported',
      });
      attempt.planType = summary.planType;
      finish(
        attempt,
        'success',
        summary.planType
          ? `Signed in with ChatGPT (${summary.planType} plan).`
          : 'Signed in with ChatGPT.'
      );
    } catch (err) {
      // Messages reaching this catch are already sanitized: the raw-token
      // write path rethrows as BadRequest with operator-safe text inside
      // persistVerifiedCodexAuth, and everything else is service/DB failures
      // whose messages help operators.
      console.error(
        `[CodexDeviceAuth] Finalizing sign-in failed: ${err instanceof Error ? err.constructor.name : 'unknown error'}`
      );
      finish(
        attempt,
        'error',
        err instanceof BadRequest && err.message
          ? err.message
          : 'Signing in succeeded but saving the login failed — try again.'
      );
    }
  }

  function scheduleNext(attempt: DeviceAuthAttempt): void {
    if (attempt.cancelled || attempt.phase !== 'pending') return;
    const delay = Math.min(attempt.intervalMs, Math.max(attempt.expiresAtMs - Date.now(), 0));
    attempt.timer = setTimeout(() => {
      void pollTick(attempt);
    }, delay);
    attempt.timer.unref?.();
  }

  async function requireContext(params?: AuthenticatedParams): Promise<{
    authUser: NonNullable<AuthenticatedParams['user']>;
    userId: UserID;
    tenantId: TenantID | string;
    key: string;
  }> {
    const authUser = params?.user;
    if (!authUser?.user_id) {
      throw new NotAuthenticated('Sign in before starting a ChatGPT device sign-in.');
    }
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for Codex device auth');
    const userId = authUser.user_id as UserID;
    return { authUser, userId, tenantId, key: `${tenantId}:${userId}` };
  }

  return {
    async create(_data: unknown, params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const { authUser, userId, tenantId, key } = await requireContext(params);

      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);
      if (
        !(await withTenantDatabase((tenantDb) => isTenantAgenticToolEnabled('codex', tenantDb)))
      ) {
        throw new BadRequest('Codex is disabled for this workspace.');
      }

      // Resolve the credential destination before the user approves the code.
      const identity = await resolveCodexCredentialRoute(
        userId,
        withTenantDatabase,
        app.get('config')
      );
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine which execution home should hold this Codex login: ${identity.message}`
        );
      }

      // Reserve the per-user slot BEFORE any await: an overlapping create()
      // (double-click, impatient retry) then cancels THIS attempt instead of
      // racing past a not-yet-registered one and leaving its poll loop
      // orphaned against OpenAI for the full 15-minute window.
      cancelAttempt(key);
      pruneFinishedAttempts();
      const attempt: DeviceAuthAttempt = {
        attemptId: generateId() as CodexDeviceAuthAttemptID,
        key,
        userId,
        tenantId,
        authUser,
        delegatedHomeKey: identity.delegatedHomeKey,
        codexHome: identity.codexHome,
        phase: 'pending',
        deviceAuthId: '',
        userCode: '',
        intervalMs: 0,
        expiresAtMs: Date.now() + DEVICE_CODE_LIFETIME_MS,
        cancelled: false,
      };
      attempts.set(key, attempt);

      let grant: UserCodeGrant | 'unavailable';
      try {
        grant = await requestUserCode();
      } catch (err) {
        if (!attempt.cancelled) {
          finish(attempt, 'error', 'Could not get a sign-in code from ChatGPT.');
        }
        const terminal = err instanceof DeviceAuthProviderError && err.disposition === 'terminal';
        throw new BadRequest(
          terminal
            ? 'ChatGPT rejected the sign-in request — try again later, or paste an auth.json / use an API key instead.'
            : 'Could not reach ChatGPT to start the sign-in — check the server’s network access and try again.'
        );
      }
      // A newer attempt replaced this one while the provider was answering.
      if (attempt.cancelled) return statusOf(attempts.get(key));

      if (grant === 'unavailable') {
        finish(attempt, 'unavailable', UNAVAILABLE_HINT);
        return statusOf(attempt);
      }

      attempt.deviceAuthId = grant.deviceAuthId;
      attempt.userCode = grant.userCode;
      attempt.intervalMs = grant.intervalMs;
      attempt.expiresAtMs = Date.now() + DEVICE_CODE_LIFETIME_MS;
      scheduleNext(attempt);
      return statusOf(attempt);
    },

    async find(params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const { key } = await requireContext(params);
      pruneFinishedAttempts();
      return statusOf(attempts.get(key));
    },

    async remove(id: unknown, params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const { key } = await requireContext(params);
      if (typeof id !== 'string' || !id) {
        throw new BadRequest('The Codex device sign-in attempt id is required.');
      }
      if (attempts.get(key)?.attemptId !== id) return statusOf(attempts.get(key));
      cancelAttempt(key);
      attempts.delete(key);
      return { phase: 'idle' };
    },
  };
}
