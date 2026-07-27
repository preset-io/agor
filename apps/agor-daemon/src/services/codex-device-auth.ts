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

import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  CodexDeviceAuthStatus,
  TenantID,
  UserID,
} from '@agor/core/types';
import { codexIdTokenClaims } from '../utils/codex-auth-file.js';
import {
  type AppLike,
  persistVerifiedCodexAuth,
  resolveCodexUnixIdentity,
} from './codex-auth-shared.js';

const CODEX_AUTH_ISSUER = 'https://auth.openai.com';
/** Codex CLI's public OAuth client id (codex-rs/login/src/auth/manager.rs). */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Server-side validity window for a device code (fixed by OpenAI). */
const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_S = 5;
const MIN_POLL_INTERVAL_MS = 2_000;
const FETCH_TIMEOUT_MS = 15_000;

const UNAVAILABLE_HINT =
  'Your ChatGPT account does not allow device-code sign-in. Personal accounts can turn it on under ChatGPT Settings → Security → "Device code authorization for Codex"; workspace accounts need an admin to enable it. You can also paste an auth.json or use an API key instead.';

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider failure with an explicit retry disposition, so callers never have
 * to infer transient-vs-terminal from message text. 5xx are transient (a
 * provider blip must not kill a 15-minute approval window); non-pending 4xx
 * and contract breaks (missing response fields) are terminal.
 */
class DeviceAuthProviderError extends Error {
  constructor(
    readonly disposition: 'transient' | 'terminal',
    message: string
  ) {
    super(message);
  }
}

function providerStatusError(endpoint: string, status: number): DeviceAuthProviderError {
  return new DeviceAuthProviderError(
    status >= 500 ? 'transient' : 'terminal',
    `${endpoint} failed with status ${status}`
  );
}

interface UserCodeGrant {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

/** `unavailable` maps the server's refusal to issue a code (gated account/workspace). */
async function requestUserCode(): Promise<UserCodeGrant | 'unavailable'> {
  const res = await fetchWithTimeout(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (res.status === 404 || res.status === 403) return 'unavailable';
  if (!res.ok) throw providerStatusError('usercode request', res.status);

  const body = (await res.json()) as Record<string, unknown>;
  const deviceAuthId = body.device_auth_id;
  const userCode = body.user_code ?? body.usercode;
  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
    throw new DeviceAuthProviderError('terminal', 'usercode response missing expected fields');
  }
  // The server sends `interval` as a decimal string (seconds).
  const intervalSeconds = Number.parseInt(String(body.interval ?? ''), 10);
  const intervalMs = Math.max(
    (Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds
      : DEFAULT_POLL_INTERVAL_S) * 1000,
    MIN_POLL_INTERVAL_MS
  );
  return { deviceAuthId, userCode, intervalMs };
}

interface ApprovedCode {
  authorizationCode: string;
  codeVerifier: string;
}

/** 403/404 are the server's "authorization pending" signals for this endpoint. */
async function pollDeviceToken(
  deviceAuthId: string,
  userCode: string
): Promise<ApprovedCode | 'pending'> {
  const res = await fetchWithTimeout(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (res.status === 403 || res.status === 404) return 'pending';
  if (!res.ok) throw providerStatusError('device token poll', res.status);

  const body = (await res.json()) as Record<string, unknown>;
  const authorizationCode = body.authorization_code;
  const codeVerifier = body.code_verifier;
  if (typeof authorizationCode !== 'string' || typeof codeVerifier !== 'string') {
    // The response contract broke — retrying the same request cannot help.
    throw new DeviceAuthProviderError('terminal', 'device token response missing expected fields');
  }
  return { authorizationCode, codeVerifier };
}

interface ExchangedTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

async function exchangeCodeForTokens(approved: ApprovedCode): Promise<ExchangedTokens> {
  const res = await fetchWithTimeout(`${CODEX_AUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: approved.authorizationCode,
      redirect_uri: `${CODEX_AUTH_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: approved.codeVerifier,
    }).toString(),
  });
  if (!res.ok) throw providerStatusError('token exchange', res.status);

  const body = (await res.json()) as Record<string, unknown>;
  const { id_token, access_token, refresh_token } = body;
  if (
    typeof id_token !== 'string' ||
    typeof access_token !== 'string' ||
    typeof refresh_token !== 'string'
  ) {
    throw new DeviceAuthProviderError(
      'terminal',
      'token exchange response missing expected fields'
    );
  }
  return { idToken: id_token, accessToken: access_token, refreshToken: refresh_token };
}

/**
 * The exchange runs once, AFTER the user already approved — a provider blip
 * here would otherwise force a whole new code+approval round-trip. One retry
 * on a transient failure mirrors the poll loop's own policy.
 */
async function exchangeWithOneRetry(approved: ApprovedCode): Promise<ExchangedTokens> {
  try {
    return await exchangeCodeForTokens(approved);
  } catch (err) {
    if (err instanceof DeviceAuthProviderError && err.disposition === 'terminal') throw err;
    return exchangeCodeForTokens(approved);
  }
}

/** Codex-format auth.json content for a fresh ChatGPT login. */
export function buildDeviceAuthJson(tokens: ExchangedTokens): string {
  const { accountId } = codexIdTokenClaims(tokens.idToken);
  const authDotJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: accountId ?? null,
    },
    last_refresh: new Date().toISOString(),
  };
  return `${JSON.stringify(authDotJson, null, 2)}\n`;
}

interface DeviceAuthAttempt {
  key: string;
  userId: UserID;
  tenantId: TenantID | string;
  authUser: NonNullable<AuthenticatedParams['user']>;
  targetUnixUser: string | null;
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
  const base: CodexDeviceAuthStatus = { phase: attempt.phase };
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

export function createCodexDeviceAuthService(app: AppLike, db: TenantScopeAwareDatabase) {
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

    let approved: ApprovedCode | 'pending';
    try {
      approved = await pollDeviceToken(attempt.deviceAuthId, attempt.userCode);
    } catch (err) {
      // Network blips and provider 5xx are transient — keep polling until the
      // code expires. Only a definitive rejection or contract break ends the
      // attempt early.
      if (err instanceof DeviceAuthProviderError && err.disposition === 'terminal') {
        finish(attempt, 'error', 'ChatGPT sign-in failed — get a new code and try again.');
        return;
      }
      scheduleNext(attempt);
      return;
    }
    if (attempt.cancelled) return;

    if (approved === 'pending') {
      scheduleNext(attempt);
      return;
    }

    try {
      const tokens = await exchangeWithOneRetry(approved);
      // Ownership check in addition to the cancelled flag: a replacement
      // attempt registered during the exchange must not have its freshly
      // written credential clobbered by this older one.
      if (attempt.cancelled || attempts.get(attempt.key) !== attempt) return;
      const summary = await runWithTenantDatabaseScope(db, attempt.tenantId, () =>
        persistVerifiedCodexAuth({
          app,
          normalized: buildDeviceAuthJson(tokens),
          targetUnixUser: attempt.targetUnixUser,
          userId: attempt.userId,
          authUser: attempt.authUser,
        })
      );
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
        `[CodexDeviceAuth] Finalizing sign-in failed: ${
          err instanceof Error ? `${err.constructor.name}: ${err.message}` : 'unknown error'
        }`
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

      const config = loadConfigSync();
      if (config.multi_tenancy?.mode === 'required_from_auth') {
        throw new BadRequest(
          'Codex subscription login is unavailable in hosted multi-tenant mode — use an OpenAI API key instead.'
        );
      }
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);
      if (
        !(await withTenantDatabase((tenantDb) => isTenantAgenticToolEnabled('codex', tenantDb)))
      ) {
        throw new BadRequest('Codex is disabled for this workspace.');
      }

      // Resolve the destination identity up front so a strict-mode user with
      // no unix_username fails fast instead of after approving the code.
      const identity = await resolveCodexUnixIdentity(userId, withTenantDatabase);
      if (!identity.ok) {
        throw new BadRequest(
          `Cannot determine which Unix account should hold this Codex login: ${identity.message}`
        );
      }

      // Reserve the per-user slot BEFORE any await: an overlapping create()
      // (double-click, impatient retry) then cancels THIS attempt instead of
      // racing past a not-yet-registered one and leaving its poll loop
      // orphaned against OpenAI for the full 15-minute window.
      cancelAttempt(key);
      pruneFinishedAttempts();
      const attempt: DeviceAuthAttempt = {
        key,
        userId,
        tenantId,
        authUser,
        targetUnixUser: identity.unixUser,
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
  };
}
