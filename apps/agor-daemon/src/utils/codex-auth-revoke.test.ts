import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokeCodexChatgptTokens } from './codex-auth-revoke';

const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function authWith(tokens: Record<string, unknown>): string {
  return JSON.stringify({ OPENAI_API_KEY: null, tokens });
}

describe('revokeCodexChatgptTokens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the refresh token with the Codex client_id and returns revoked on 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await revokeCodexChatgptTokens(
      authWith({ refresh_token: 'refresh-xyz', access_token: 'acc' })
    );

    expect(outcome).toBe('revoked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REVOKE_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'refresh-xyz',
      token_type_hint: 'refresh_token',
      client_id: CLIENT_ID,
    });
  });

  it('falls back to the access token (no client_id) when no refresh token is present', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeCodexChatgptTokens(authWith({ access_token: 'acc-only' }));

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ token: 'acc-only', token_type_hint: 'access_token' });
    expect(body.client_id).toBeUndefined();
  });

  it('skips (no network call) when the file has no revocable token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await revokeCodexChatgptTokens(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toBe(
      'skipped'
    );
    expect(await revokeCodexChatgptTokens('not json at all')).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns failed (never throws) on a network error and logs no token bytes', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await revokeCodexChatgptTokens(authWith({ refresh_token: 'refresh-SECRET' }))).toBe(
        'failed'
      );
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).not.toContain('refresh-SECRET');
    } finally {
      warn.mockRestore();
    }
  });

  it('returns failed on a non-2xx response, logging the status only (never the token)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await revokeCodexChatgptTokens(authWith({ refresh_token: 'refresh-SECRET' }))).toBe(
        'failed'
      );
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('400');
      expect(logged).not.toContain('refresh-SECRET');
    } finally {
      warn.mockRestore();
    }
  });
});
