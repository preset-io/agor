import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── External-dependency mocks (declared before importing the module) ─────────
const writeClaudeAuthViaExecutor = vi.fn(async () => undefined);
vi.mock('../utils/executor-claude-auth.js', () => ({
  writeClaudeAuthViaExecutor: (...args: unknown[]) => writeClaudeAuthViaExecutor(...args),
  deleteClaudeAuthViaExecutor: vi.fn(),
}));

let identityResult: unknown = {
  ok: true,
  delegatedHomeKey: null,
  userId: 'user-A',
};
vi.mock('./codex-auth-shared.js', () => ({
  resolveCodexCredentialRoute: vi.fn(async () => identityResult),
}));

let toolEnabled = true;
vi.mock('@agor/core/config', () => ({
  isTenantAgenticToolEnabled: vi.fn(async () => toolEnabled),
}));

vi.mock('@agor/core/db', () => ({
  getCurrentTenantId: () => 'tenant-1',
  runWithTenantDatabaseScope: <T>(_db: unknown, _tid: unknown, work: (db: unknown) => Promise<T>) =>
    work({}),
}));

import {
  buildAuthorizeUrl,
  buildClaudeCredentialsJson,
  constantTimeEqual,
  createClaudeOAuthService,
  exchangeCodeForTokens,
  generatePkce,
  parsePastedCode,
  TokenExchangeError,
} from './claude-oauth.js';
import { InMemoryClaudeOAuthAttemptStore } from './claude-oauth-attempt-store.js';

const base64urlOf = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Drain the microtask queue so an in-flight `create()` reaches its fetch await. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TOKENS = {
  access_token: 'sk-ant-oat01-ACCESS',
  refresh_token: 'sk-ant-ort01-REFRESH',
  expires_in: 28800,
  scope: 'user:inference',
};

// Drive an attempt to `awaiting_code` and pull the `state` back out of the URL.
async function startAndGetState(svc: {
  create: (
    d: { code?: string; attemptId?: string },
    p?: unknown
  ) => Promise<{ verificationUrl?: string }>;
}) {
  const status = await svc.create({}, { user: { user_id: 'user-A' } });
  const state = new URL(status.verificationUrl as string).searchParams.get('state');
  return state as string;
}

function makeService() {
  const usersGet = vi.fn(async () => ({ agentic_auth_methods: {} }));
  const usersPatch = vi.fn(async () => ({}));
  const app = {
    get: () => ({}),
    service: (path: string) =>
      path === 'users' ? { get: usersGet, patch: usersPatch } : undefined,
  };
  const store = new InMemoryClaudeOAuthAttemptStore();
  const svc = createClaudeOAuthService(
    app as unknown as Parameters<typeof createClaudeOAuthService>[0],
    {} as unknown as Parameters<typeof createClaudeOAuthService>[1],
    store
  );
  return { svc, store, usersGet, usersPatch };
}

const asUserA = { user: { user_id: 'user-A' } };

beforeEach(() => {
  writeClaudeAuthViaExecutor.mockClear();
  writeClaudeAuthViaExecutor.mockResolvedValue(undefined);
  toolEnabled = true;
  identityResult = { ok: true, delegatedHomeKey: null, userId: 'user-A' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(TOKENS))
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PKCE + pure helpers', () => {
  it('generatePkce produces an RFC 7636 S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(base64urlOf(createHash('sha256').update(verifier).digest()));
    expect(challenge).not.toContain('=');
  });

  it('buildAuthorizeUrl sends the verified prod params and never the verifier', () => {
    const { verifier, challenge } = generatePkce();
    const url = new URL(buildAuthorizeUrl(challenge, 'STATE123'));
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback'
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('state')).toBe('STATE123');
    // The PKCE verifier is the secret half — it must never appear in the URL.
    expect(url.toString()).not.toContain(verifier);
  });

  it('parsePastedCode requires exactly one non-empty CODE#STATE', () => {
    expect(parsePastedCode('  abc#xyz  ')).toEqual({ code: 'abc', state: 'xyz' });
    for (const bad of ['abc', 'abc#', '#xyz', 'abc#xyz#extra', '', '#']) {
      expect(() => parsePastedCode(bad)).toThrow();
    }
  });

  it('constantTimeEqual matches only exact equal-length strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('buildClaudeCredentialsJson emits the claudeAiOauth shape with ms expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const json = JSON.parse(
      buildClaudeCredentialsJson({
        accessToken: 'a',
        refreshToken: 'r',
        expiresInSec: 100,
        scopes: ['user:inference'],
      })
    );
    expect(json.claudeAiOauth.expiresAt).toBe(1_000_000 + 100 * 1000);
    expect(json.claudeAiOauth).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
  });
});

describe('exchangeCodeForTokens contract validation', () => {
  it('classifies a definitive 4xx as a "rejected" (pre-consumption) failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false))
    );
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toThrow(/rejected the sign-in code/);
    // A clean 4xx means the code was rejected before any token was issued.
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toMatchObject({
      disposition: 'rejected',
    });
  });

  it('classifies a 5xx as "ambiguous" — the code may have been consumed server-side', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false, 503))
    );
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toBeInstanceOf(TokenExchangeError);
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toMatchObject({
      disposition: 'ambiguous',
    });
  });

  it('classifies a network failure/timeout as "ambiguous" — never replay the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      })
    );
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toMatchObject({
      disposition: 'ambiguous',
    });
  });

  it('classifies a 2xx body missing tokens (contract break) as "ambiguous", not a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ expires_in: 100 }))
    );
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toThrow(/missing tokens/);
    await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toMatchObject({
      disposition: 'ambiguous',
    });
  });

  it('rejects an invalid/absent expiry instead of fabricating 8h', async () => {
    for (const expires_in of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 999_999_999]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ ...TOKENS, expires_in }))
      );
      await expect(exchangeCodeForTokens('c', 'v', 's')).rejects.toThrow(/invalid expiry/);
    }
  });
});

describe('createClaudeOAuthService — flow + security', () => {
  it('start returns the authorize URL and never leaks the verifier or tokens', async () => {
    const { svc } = makeService();
    const status = await svc.create({}, asUserA);
    expect(status.phase).toBe('awaiting_code');
    expect(status.verificationUrl).toContain('https://claude.com/cai/oauth/authorize');
    // attemptId is echoed so a reconnect (possibly to another replica) can name
    // the attempt it is asking about. It is not the OAuth state capability.
    expect(Object.keys(status).sort()).toEqual([
      'attemptId',
      'expiresAt',
      'phase',
      'verificationUrl',
    ]);
    expect(JSON.stringify(status)).not.toMatch(/verifier|accessToken|refreshToken|code_verifier/);
  });

  it('completes a valid paste-back: writes creds as the resolved identity and clears the pasted token', async () => {
    const { svc, usersPatch } = makeService();
    const state = await startAndGetState(svc);

    const status = await svc.create({ code: `AUTHCODE#${state}` }, asUserA);
    expect(status.phase).toBe('success');
    // No token material in the status returned to the caller/UI.
    expect(JSON.stringify(status)).not.toMatch(/sk-ant-|ACCESS|REFRESH/);

    // Written as the identity resolved from the AUTHENTICATED user, not request data.
    expect(writeClaudeAuthViaExecutor).toHaveBeenCalledTimes(1);
    const [content, routing] = writeClaudeAuthViaExecutor.mock.calls[0];
    expect(routing).toEqual({ delegatedHomeKey: null, userId: 'user-A' });
    expect(JSON.parse(content as string).claudeAiOauth.accessToken).toBe(TOKENS.access_token);

    // Flips to subscription AND deletes the stale pasted token (null) in one patch.
    expect(usersPatch).toHaveBeenCalledWith(
      'user-A',
      {
        agentic_auth_methods: { 'claude-code': 'subscription' },
        agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: null } },
      },
      expect.anything()
    );
  });

  it('rejects a wrong state without exchanging, leaving the attempt retryable', async () => {
    const { svc } = makeService();
    await startAndGetState(svc);
    await expect(svc.create({ code: 'AUTHCODE#WRONGSTATE' }, asUserA)).rejects.toThrow(
      /did not match/
    );
    expect(fetch).not.toHaveBeenCalled();
    // Still awaiting_code — the legitimate browser can still paste the real code.
    expect((await svc.find(asUserA)).phase).toBe('awaiting_code');
  });

  it('rejects a bare code (no #state) — CSRF guard', async () => {
    const { svc } = makeService();
    await startAndGetState(svc);
    await expect(svc.create({ code: 'AUTHCODE' }, asUserA)).rejects.toThrow(/whole code/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a concurrent submit is rejected while the first is exchanging', async () => {
    const { svc } = makeService();
    const state = await startAndGetState(svc);
    let release!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse(TOKENS));
          })
      )
    );
    const first = svc.create({ code: `AUTHCODE#${state}` }, asUserA);
    await flush();
    // The reservation is one-shot, so the second submit loses. It now says so
    // specifically rather than reporting the attempt as absent.
    await expect(svc.create({ code: `AUTHCODE#${state}` }, asUserA)).rejects.toThrow(
      /already being completed/
    );
    release();
    expect((await first).phase).toBe('success');
  });

  it('a replacement start invalidates an in-flight submit (no clobber)', async () => {
    const { svc } = makeService();
    const state = await startAndGetState(svc);
    let release!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse(TOKENS));
          })
      )
    );
    const stale = svc.create({ code: `AUTHCODE#${state}` }, asUserA);
    await flush();
    // A fresh start replaces the attempt while the exchange is in flight.
    await svc.create({}, asUserA);
    release();
    await stale;
    // The stale submit must not have written credentials for the replaced attempt.
    expect(writeClaudeAuthViaExecutor).not.toHaveBeenCalled();
    expect((await svc.find(asUserA)).phase).toBe('awaiting_code');
  });

  it('serializes a replacement start behind an already-running credential mutation', async () => {
    const { svc } = makeService();
    const state = await startAndGetState(svc);
    let releaseWrite!: () => void;
    writeClaudeAuthViaExecutor.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        })
    );

    const completing = svc.create({ code: `AUTHCODE#${state}` }, asUserA);
    await vi.waitFor(() => expect(writeClaudeAuthViaExecutor).toHaveBeenCalledTimes(1));

    let replacementFinished = false;
    const replacement = svc.create({}, asUserA).then((value) => {
      replacementFinished = true;
      return value;
    });
    await flush();
    expect(replacementFinished).toBe(false);

    releaseWrite();
    expect((await completing).phase).toBe('success');
    expect((await replacement).phase).toBe('awaiting_code');
  });

  it('binds a paste-back to the attempt id echoed to that browser tab', async () => {
    const { svc } = makeService();
    const first = await svc.create({}, asUserA);
    const firstState = new URL(first.verificationUrl as string).searchParams.get('state');
    const second = await svc.create({}, asUserA);

    await expect(
      svc.create({ code: `AUTHCODE#${firstState}`, attemptId: first.attemptId }, asUserA)
    ).rejects.toThrow(/No sign-in is in progress/);
    expect(fetch).not.toHaveBeenCalled();
    expect((await svc.find({ ...asUserA, query: { attemptId: second.attemptId } })).phase).toBe(
      'awaiting_code'
    );
  });

  it('a malformed provider response ends the attempt in error with no token leak and no write', async () => {
    const { svc } = makeService();
    const state = await startAndGetState(svc);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ nope: true }))
    );
    await expect(svc.create({ code: `AUTHCODE#${state}` }, asUserA)).rejects.toThrow(
      /missing tokens/
    );
    expect(writeClaudeAuthViaExecutor).not.toHaveBeenCalled();
    // A 2xx that consumed the code but returned no usable tokens is ambiguous —
    // the attempt goes terminal (not back to awaiting_code) so the same, possibly
    // spent, code cannot be re-exchanged.
    expect((await svc.find(asUserA)).phase).toBe('error');
  });

  it('a network timeout ends the attempt terminally and forbids replay of the same code', async () => {
    const { svc } = makeService();
    const state = await startAndGetState(svc);
    // The POST may have reached Anthropic and consumed the one-time code before
    // the connection dropped. Nothing about that is retryable with the same code.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      })
    );
    await expect(svc.create({ code: `AUTHCODE#${state}` }, asUserA)).rejects.toThrow(
      /Could not reach Claude/
    );
    expect(writeClaudeAuthViaExecutor).not.toHaveBeenCalled();
    // Terminal — not awaiting_code — so the UI won't accept the same code again.
    expect((await svc.find(asUserA)).phase).toBe('error');
    // Even if the caller re-pastes the same code, the (now non-awaiting) attempt
    // refuses it — the code is never sent to Anthropic a second time. The healthy
    // fetch stub restored by beforeEach would succeed, proving the guard, not luck.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(TOKENS))
    );
    await expect(svc.create({ code: `AUTHCODE#${state}` }, asUserA)).rejects.toThrow(
      /No sign-in is in progress/
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(writeClaudeAuthViaExecutor).not.toHaveBeenCalled();
  });

  it('a definitive 4xx rejection ends the attempt terminally (no silent retry loop)', async () => {
    const { svc } = makeService();
    const state = await startAndGetState(svc);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, false))
    );
    await expect(svc.create({ code: `AUTHCODE#${state}` }, asUserA)).rejects.toThrow(
      /rejected the sign-in code/
    );
    expect(writeClaudeAuthViaExecutor).not.toHaveBeenCalled();
    // A rejected code is dead (single-use + state-bound): terminal, start over.
    const after = await svc.find(asUserA);
    expect(after.phase).toBe('error');
    expect(after.hint).toMatch(/start over/i);
  });

  it('a malformed local paste (bad #state) leaves the attempt awaiting a real code', async () => {
    const { svc } = makeService();
    await startAndGetState(svc);
    // Missing/garbled halves are caught locally, BEFORE any provider call, so the
    // legitimate browser can still paste the genuine code against this attempt.
    await expect(svc.create({ code: 'AUTHCODE#' }, asUserA)).rejects.toThrow(/whole code/);
    expect(fetch).not.toHaveBeenCalled();
    expect((await svc.find(asUserA)).phase).toBe('awaiting_code');
  });

  it('expires an abandoned awaiting_code attempt and prunes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { svc } = makeService();
    await svc.create({}, asUserA);
    expect((await svc.find(asUserA)).phase).toBe('awaiting_code');
    vi.setSystemTime(11 * 60 * 1000);
    expect((await svc.find(asUserA)).phase).toBe('expired');
    // Submitting against an expired link is refused.
    await expect(svc.create({ code: 'AUTHCODE#s' }, asUserA)).rejects.toThrow(/No sign-in/);
  });

  it('isolates attempts per user (no cross-user visibility)', async () => {
    const { svc } = makeService();
    await svc.create({}, asUserA);
    expect((await svc.find({ user: { user_id: 'user-B' } })).phase).toBe('idle');
  });

  it('rejects when the tool is disabled for the workspace', async () => {
    toolEnabled = false;
    const { svc } = makeService();
    await expect(svc.create({}, asUserA)).rejects.toThrow(/disabled/);
  });

  it('fails fast when the unix identity cannot be resolved', async () => {
    identityResult = { ok: false, reason: 'missing-username', message: 'no unix_username' };
    const { svc } = makeService();
    await expect(svc.create({}, asUserA)).rejects.toThrow(/Unix account/);
  });

  it('requires an authenticated user', async () => {
    const { svc } = makeService();
    await expect(svc.create({}, {})).rejects.toThrow();
  });
});
