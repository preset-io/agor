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
  resolveCodexAuthTargetUser,
} from './codex-auth-import.js';

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
  if (!res.ok) throw new Error(`usercode request failed with status ${res.status}`);

  const body = (await res.json()) as Record<string, unknown>;
  const deviceAuthId = body.device_auth_id;
  const userCode = body.user_code ?? body.usercode;
  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
    throw new Error('usercode response missing expected fields');
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
  if (!res.ok) throw new Error(`device token poll failed with status ${res.status}`);

  const body = (await res.json()) as Record<string, unknown>;
  const authorizationCode = body.authorization_code;
  const codeVerifier = body.code_verifier;
  if (typeof authorizationCode !== 'string' || typeof codeVerifier !== 'string') {
    throw new Error('device token response missing expected fields');
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
  if (!res.ok) throw new Error(`token exchange failed with status ${res.status}`);

  const body = (await res.json()) as Record<string, unknown>;
  const { id_token, access_token, refresh_token } = body;
  if (
    typeof id_token !== 'string' ||
    typeof access_token !== 'string' ||
    typeof refresh_token !== 'string'
  ) {
    throw new Error('token exchange response missing expected fields');
  }
  return { idToken: id_token, accessToken: access_token, refreshToken: refresh_token };
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
}

function statusOf(attempt: DeviceAuthAttempt | undefined): CodexDeviceAuthStatus {
  if (!attempt) return { phase: 'idle' };
  const base: CodexDeviceAuthStatus = { phase: attempt.phase };
  if (attempt.phase === 'pending') {
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
    if (hint) attempt.hint = hint;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = undefined;
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
      // Transient transport errors should not kill a 15-minute window; only
      // an unexpected provider status is terminal.
      const message = err instanceof Error ? err.message : '';
      if (message.includes('status')) {
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
      const tokens = await exchangeCodeForTokens(approved);
      if (attempt.cancelled) return;
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
      console.error(
        `[CodexDeviceAuth] Finalizing sign-in failed: ${
          err instanceof Error ? err.constructor.name : 'unknown error'
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

      cancelAttempt(key);

      let grant: UserCodeGrant | 'unavailable';
      try {
        grant = await requestUserCode();
      } catch {
        throw new BadRequest(
          'Could not reach ChatGPT to start the sign-in — check the server’s network access and try again.'
        );
      }

      if (grant === 'unavailable') {
        const attempt: DeviceAuthAttempt = {
          userId,
          tenantId,
          authUser,
          targetUnixUser,
          phase: 'unavailable',
          deviceAuthId: '',
          userCode: '',
          intervalMs: 0,
          expiresAtMs: 0,
          hint: UNAVAILABLE_HINT,
          cancelled: false,
        };
        attempts.set(key, attempt);
        return statusOf(attempt);
      }

      const attempt: DeviceAuthAttempt = {
        userId,
        tenantId,
        authUser,
        targetUnixUser,
        phase: 'pending',
        deviceAuthId: grant.deviceAuthId,
        userCode: grant.userCode,
        intervalMs: grant.intervalMs,
        expiresAtMs: Date.now() + DEVICE_CODE_LIFETIME_MS,
        cancelled: false,
      };
      attempts.set(key, attempt);
      scheduleNext(attempt);
      return statusOf(attempt);
    },

    async find(params?: AuthenticatedParams): Promise<CodexDeviceAuthStatus> {
      const { key } = await requireContext(params);
      return statusOf(attempts.get(key));
    },
  };
}
