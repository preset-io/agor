/** Provider-only pieces of Codex device authorization. No tenant state lives here. */

import { codexIdTokenClaims } from '../utils/codex-auth-file.js';

export const CODEX_AUTH_ISSUER = 'https://auth.openai.com';
/** Codex CLI's public OAuth client id. */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_S = 5;
const MIN_POLL_INTERVAL_MS = 2_000;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class DeviceAuthProviderError extends Error {
  constructor(
    readonly disposition: 'transient' | 'terminal' | 'ambiguous',
    readonly safeCode: string
  ) {
    super(`Codex device provider operation failed (${safeCode})`);
  }
}

function providerStatusError(
  endpoint: 'usercode' | 'poll' | 'exchange',
  status: number
): DeviceAuthProviderError {
  return new DeviceAuthProviderError(
    endpoint === 'exchange' && status >= 500
      ? 'ambiguous'
      : status >= 500
        ? 'transient'
        : 'terminal',
    `${endpoint}_http_${status}`
  );
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await res.json()) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface UserCodeGrant {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

export async function requestUserCode(): Promise<UserCodeGrant | 'unavailable'> {
  const res = await fetchWithTimeout(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (res.status === 404 || res.status === 403) return 'unavailable';
  if (!res.ok) throw providerStatusError('usercode', res.status);

  const body = await safeJson(res);
  const deviceAuthId = body.device_auth_id;
  const userCode = body.user_code ?? body.usercode;
  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
    throw new DeviceAuthProviderError('terminal', 'usercode_contract');
  }
  const intervalSeconds = Number.parseInt(String(body.interval ?? ''), 10);
  const intervalMs = Math.max(
    (Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds
      : DEFAULT_POLL_INTERVAL_S) * 1000,
    MIN_POLL_INTERVAL_MS
  );
  return { deviceAuthId, userCode, intervalMs };
}

export interface ApprovedCode {
  authorizationCode: string;
  codeVerifier: string;
}

export type DevicePollResult =
  | { outcome: 'pending' }
  | { outcome: 'slow_down'; intervalIncreaseMs: number }
  | { outcome: 'denied' }
  | { outcome: 'expired' }
  | { outcome: 'approved'; approved: ApprovedCode };

/**
 * Poll semantics accept both the status-code behavior used by Codex today and
 * standard device-grant error names. Provider text is intentionally discarded.
 */
export async function pollDeviceToken(
  deviceAuthId: string,
  userCode: string
): Promise<DevicePollResult> {
  const res = await fetchWithTimeout(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (res.status === 403 || res.status === 404) {
    const error = (await safeJson(res)).error;
    if (error === 'slow_down') return { outcome: 'slow_down', intervalIncreaseMs: 5_000 };
    if (error === 'access_denied' || error === 'authorization_declined') {
      return { outcome: 'denied' };
    }
    if (error === 'expired_token') return { outcome: 'expired' };
    return { outcome: 'pending' };
  }
  if (!res.ok) {
    const error = (await safeJson(res)).error;
    if (error === 'authorization_pending') return { outcome: 'pending' };
    if (error === 'slow_down') return { outcome: 'slow_down', intervalIncreaseMs: 5_000 };
    if (error === 'access_denied' || error === 'authorization_declined') {
      return { outcome: 'denied' };
    }
    if (error === 'expired_token') return { outcome: 'expired' };
    throw providerStatusError('poll', res.status);
  }

  const body = await safeJson(res);
  const authorizationCode = body.authorization_code;
  const codeVerifier = body.code_verifier;
  if (typeof authorizationCode !== 'string' || typeof codeVerifier !== 'string') {
    throw new DeviceAuthProviderError('terminal', 'poll_contract');
  }
  return { outcome: 'approved', approved: { authorizationCode, codeVerifier } };
}

export interface ExchangedTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

/** One-shot by contract: callers must never retry an ambiguous exchange. */
export async function exchangeCodeForTokens(approved: ApprovedCode): Promise<ExchangedTokens> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${CODEX_AUTH_ISSUER}/oauth/token`, {
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
  } catch {
    throw new DeviceAuthProviderError('ambiguous', 'exchange_transport');
  }
  if (!res.ok) throw providerStatusError('exchange', res.status);

  const body = await safeJson(res);
  const { id_token, access_token, refresh_token } = body;
  if (
    typeof id_token !== 'string' ||
    typeof access_token !== 'string' ||
    typeof refresh_token !== 'string'
  ) {
    throw new DeviceAuthProviderError('ambiguous', 'exchange_contract');
  }
  return { idToken: id_token, accessToken: access_token, refreshToken: refresh_token };
}

export function buildDeviceAuthJson(tokens: ExchangedTokens): string {
  const { accountId } = codexIdTokenClaims(tokens.idToken);
  return `${JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: accountId ?? null,
      },
      last_refresh: new Date().toISOString(),
    },
    null,
    2
  )}\n`;
}

export interface CodexDeviceAuthProvider {
  requestUserCode: typeof requestUserCode;
  pollDeviceToken: typeof pollDeviceToken;
  exchangeCodeForTokens: typeof exchangeCodeForTokens;
}

export const codexDeviceAuthProvider: CodexDeviceAuthProvider = {
  requestUserCode,
  pollDeviceToken,
  exchangeCodeForTokens,
};
