import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCodexAuthFile, writeCodexAuthFile } from '../utils/codex-auth-file.js';
import { createCodexDeviceAuthService } from './codex-device-auth';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    isTenantAgenticToolEnabled: vi.fn(),
    loadConfigSync: vi.fn(),
  };
});

vi.mock('../utils/codex-auth-file.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/codex-auth-file.js')>(
    '../utils/codex-auth-file.js'
  );
  return {
    ...actual,
    writeCodexAuthFile: vi.fn(),
    readCodexAuthFile: vi.fn(),
  };
});

const isTenantAgenticToolEnabledMock = vi.mocked(isTenantAgenticToolEnabled);
const loadConfigSyncMock = vi.mocked(loadConfigSync);
const writeCodexAuthFileMock = vi.mocked(writeCodexAuthFile);
const readCodexAuthFileMock = vi.mocked(readCodexAuthFile);

const TEST_DB = { run: vi.fn() } as never;

function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.signature`;
}

const ID_TOKEN = fakeJwt({
  'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-9' },
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeApp() {
  const usersService = {
    get: vi.fn(async () => ({ agentic_auth_methods: {} })),
    patch: vi.fn(async () => ({})),
  };
  return { app: { service: () => usersService }, usersService };
}

const AUTH_PARAMS = {
  user: { user_id: 'user-1', email: 'u@example.com', role: 'member' },
} as never;

function withTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithTenantContext('tenant-test', work);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  isTenantAgenticToolEnabledMock.mockResolvedValue(true);
  loadConfigSyncMock.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  // Readback verification returns whatever the service wrote.
  let written = '';
  writeCodexAuthFileMock.mockImplementation((content: string) => {
    written = content;
  });
  readCodexAuthFileMock.mockImplementation(() =>
    written ? { ok: true, content: written } : { ok: false, reason: 'not-found' }
  );
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockUserCodeIssued() {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '1' })
  );
}

describe('codex-device-auth', () => {
  it('starts an attempt and reports a pending status with the code and verification URL', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();

    const status = await withTenant(() => service.create({}, AUTH_PARAMS));

    expect(status.phase).toBe('pending');
    expect(status.userCode).toBe('ABCD-1234');
    expect(status.verificationUrl).toBe('https://auth.openai.com/codex/device');
    expect(status.expiresAt).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('maps a gated account (404 on usercode) to the unavailable phase with guidance', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));

    const status = await withTenant(() => service.create({}, AUTH_PARAMS));

    expect(status.phase).toBe('unavailable');
    expect(status.hint).toMatch(/Device code authorization for Codex/);
    expect(status.userCode).toBeUndefined();
  });

  it('polls until approval, exchanges the code, persists auth.json, and reports success', async () => {
    const { app, usersService } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    // First poll: pending. Second poll: approved. Then the token exchange.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_code: 'authz-1',
          code_challenge: 'chal',
          code_verifier: 'verif',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id_token: ID_TOKEN,
          access_token: 'access-tok',
          refresh_token: 'refresh-tok',
        })
      );

    await withTenant(() => service.create({}, AUTH_PARAMS));
    // interval "1" is floored to MIN_POLL_INTERVAL_MS (2s) — each 2.1s
    // advance crosses exactly one scheduled poll.
    await vi.advanceTimersByTimeAsync(2100); // first poll (pending)
    await vi.advanceTimersByTimeAsync(2100); // second poll (approved + exchange)

    const status = await withTenant(() => service.find(AUTH_PARAMS));
    expect(status.phase).toBe('success');
    expect(status.planType).toBe('pro');
    expect(JSON.stringify(status)).not.toContain('refresh-tok');
    expect(JSON.stringify(status)).not.toContain('access-tok');

    const written = JSON.parse(writeCodexAuthFileMock.mock.calls[0][0]);
    expect(written).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: ID_TOKEN,
        access_token: 'access-tok',
        refresh_token: 'refresh-tok',
        account_id: 'acct-9',
      },
    });
    expect(typeof written.last_refresh).toBe('string');

    expect(usersService.patch).toHaveBeenCalledWith(
      'user-1',
      { agentic_auth_methods: { codex: 'subscription' } },
      expect.objectContaining({ authenticated: true })
    );

    // Terminal phase: no further polling.
    const callsAfterSuccess = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterSuccess);
  });

  it('a provider 5xx mid-window is transient — polling continues instead of erroring', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(jsonResponse(403, {}));

    await withTenant(() => service.create({}, AUTH_PARAMS));
    await vi.advanceTimersByTimeAsync(2100); // 502 → keep polling
    expect((await withTenant(() => service.find(AUTH_PARAMS))).phase).toBe('pending');
    await vi.advanceTimersByTimeAsync(2100); // 403 → still pending
    expect((await withTenant(() => service.find(AUTH_PARAMS))).phase).toBe('pending');
    expect(fetchMock.mock.calls.length).toBe(3); // usercode + two polls
  });

  it('retries the post-approval token exchange once on a provider 5xx', async () => {
    const { app, usersService } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_code: 'authz-1',
          code_challenge: 'chal',
          code_verifier: 'verif',
        })
      )
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id_token: ID_TOKEN,
          access_token: 'access-tok',
          refresh_token: 'refresh-tok',
        })
      );

    await withTenant(() => service.create({}, AUTH_PARAMS));
    await vi.advanceTimersByTimeAsync(2100);

    const status = await withTenant(() => service.find(AUTH_PARAMS));
    expect(status.phase).toBe('success');
    expect(usersService.patch).toHaveBeenCalledTimes(1);
  });

  it('a non-pending 4xx during polling is terminal', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    fetchMock.mockResolvedValueOnce(jsonResponse(410, {}));

    await withTenant(() => service.create({}, AUTH_PARAMS));
    await vi.advanceTimersByTimeAsync(2100);
    expect((await withTenant(() => service.find(AUTH_PARAMS))).phase).toBe('error');
  });

  it('an approved response missing the PKCE fields is terminal (contract break)', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authorization_code: 'authz-1' }));

    await withTenant(() => service.create({}, AUTH_PARAMS));
    await vi.advanceTimersByTimeAsync(2100);
    const status = await withTenant(() => service.find(AUTH_PARAMS));
    expect(status.phase).toBe('error');
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('overlapping create calls do not leave an orphaned poll loop', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);

    // First create's usercode response is held until after the second create
    // fully completes — the classic double-click race.
    let releaseFirst: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve(
              jsonResponse(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '1' })
            );
        })
    );
    const first = withTenant(() => service.create({}, AUTH_PARAMS));
    await Promise.resolve(); // let the first create reach its awaited fetch

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { device_auth_id: 'dev-2', user_code: 'WXYZ-9876', interval: '1' })
    );
    const second = await withTenant(() => service.create({}, AUTH_PARAMS));
    expect(second.userCode).toBe('WXYZ-9876');

    releaseFirst?.();
    await first;

    // Only the second attempt is registered and polling.
    expect((await withTenant(() => service.find(AUTH_PARAMS))).userCode).toBe('WXYZ-9876');
    fetchMock.mockResolvedValue(jsonResponse(403, {}));
    await vi.advanceTimersByTimeAsync(2100);
    const pollBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/deviceauth/token'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).device_auth_id);
    expect(pollBodies).not.toContain('dev-1');
    expect(pollBodies).toContain('dev-2');
  });

  it('hard-stops at code expiry and reports expired', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    fetchMock.mockResolvedValue(jsonResponse(403, {}));

    await withTenant(() => service.create({}, AUTH_PARAMS));
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

    const status = await withTenant(() => service.find(AUTH_PARAMS));
    expect(status.phase).toBe('expired');
    expect(writeCodexAuthFileMock).not.toHaveBeenCalled();
  });

  it('starting a new attempt cancels and replaces the previous one', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);
    mockUserCodeIssued();
    await withTenant(() => service.create({}, AUTH_PARAMS));

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { device_auth_id: 'dev-2', user_code: 'WXYZ-9876', interval: '1' })
    );
    const status = await withTenant(() => service.create({}, AUTH_PARAMS));

    expect(status.phase).toBe('pending');
    expect(status.userCode).toBe('WXYZ-9876');
  });

  it('find with no attempt reports idle; unauthenticated callers are rejected', async () => {
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);

    const status = await withTenant(() => service.find(AUTH_PARAMS));
    expect(status.phase).toBe('idle');

    await expect(withTenant(() => service.create({}, undefined))).rejects.toThrow(/Sign in/);
  });

  it('rejects hosted multi-tenant mode before contacting OpenAI', async () => {
    loadConfigSyncMock.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth' },
    } as never);
    const { app } = makeApp();
    const service = createCodexDeviceAuthService(app as never, TEST_DB);

    await expect(withTenant(() => service.create({}, AUTH_PARAMS))).rejects.toThrow(
      /hosted multi-tenant/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
