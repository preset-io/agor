import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUserEnvironment: vi.fn(async () => ({}) as Record<string, string>),
  resolveApiKeySync: vi.fn(() => ({ apiKey: undefined, source: 'none', useNativeAuth: true })),
  accountInfo: vi.fn(async () => ({}) as Record<string, unknown>),
  readFile: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
}));

vi.mock('@agor/core/config', () => ({
  resolveUserEnvironment: mocks.resolveUserEnvironment,
  resolveApiKeySync: mocks.resolveApiKeySync,
}));

vi.mock('@agor/core/sdk', () => ({
  Claude: {
    query: () => ({
      accountInfo: mocks.accountInfo,
      close: () => {},
    }),
  },
}));

vi.mock('node:fs', () => ({
  promises: { readFile: mocks.readFile },
}));

import { createCheckAuthService } from './check-auth';

const service = createCheckAuthService({} as TenantScopeAwareDatabase);
const params = { user: { user_id: 'user-1' } } as never;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveUserEnvironment.mockResolvedValue({});
  mocks.resolveApiKeySync.mockReturnValue({
    apiKey: undefined,
    source: 'none',
    useNativeAuth: true,
  });
  mocks.accountInfo.mockResolvedValue({});
  vi.stubGlobal('fetch', fetchMock);
});

describe('check-auth tri-state', () => {
  it('claude subscription/OAuth token → authenticated (injected into the SDK probe)', async () => {
    mocks.resolveUserEnvironment.mockResolvedValue({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' });
    mocks.accountInfo.mockResolvedValue({ tokenSource: 'oauth', email: 'a@b.co' });

    const result = await service.create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('authenticated');
    expect(result.authenticated).toBe(true);
  });

  it('claude API key rejected with 401 → unauthenticated', async () => {
    mocks.resolveUserEnvironment.mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-bad' });
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    const result = await service.create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('claude API key check that times out / errors → unknown (not proof of no auth)', async () => {
    mocks.resolveUserEnvironment.mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-maybe' });
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await service.create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unknown');
  });

  it('claude provider 5xx → unknown', async () => {
    mocks.resolveUserEnvironment.mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-maybe' });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const result = await service.create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unknown');
  });

  it('claude native probe with no auth signal → unauthenticated', async () => {
    mocks.accountInfo.mockResolvedValue({});

    const result = await service.create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('claude native probe that throws (timeout) → unknown', async () => {
    mocks.accountInfo.mockRejectedValue(new Error('probe timed out'));

    const result = await service.create({ tool: 'claude-code' }, params);
    expect(result.status).toBe('unknown');
  });

  it('gemini with no API key → unknown (native login not server-probeable)', async () => {
    const result = await service.create({ tool: 'gemini' }, params);
    expect(result.status).toBe('unknown');
  });

  it('gemini with a valid API key → authenticated', async () => {
    mocks.resolveUserEnvironment.mockResolvedValue({ GEMINI_API_KEY: 'g-key' });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await service.create({ tool: 'gemini' }, params);
    expect(result.status).toBe('authenticated');
  });

  it('codex with no auth.json → unauthenticated', async () => {
    const result = await service.create({ tool: 'codex' }, params);
    expect(result.status).toBe('unauthenticated');
  });

  it('opencode is always authenticated', async () => {
    const result = await service.create({ tool: 'opencode' }, params);
    expect(result.status).toBe('authenticated');
  });

  it('a raw key that 401s → unauthenticated (settings "Test Connection")', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const result = await service.create({ tool: 'claude-code', apiKey: 'sk-typed' }, params);
    expect(result.status).toBe('unauthenticated');
  });
});
