import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  contained: true,
  credentialSource: 'managed_file' as 'managed_file' | 'api_key' | 'none',
  resolveProviderConnection: vi.fn(async () => ({
    source: 'user',
    useNativeAuth: true,
    connection: {},
  })),
}));
const routeMocks = vi.hoisted(() => ({
  claudeConfigDir: '/homes/user-1/.claude',
  resolve: vi.fn(async () => ({
    ok: true as const,
    delegatedHomeKey: null,
    userId: 'user-1',
    claudeConfigDir: routeMocks.claudeConfigDir,
  })),
}));
const dbMocks = vi.hoisted(() => ({ depth: 0, tenants: [] as string[] }));

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  hasContainedClaudeRuntimeCredentials: () => configMocks.contained,
  resolveProviderConnection: configMocks.resolveProviderConnection,
}));
vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  UsersRepository: class {
    async findById() {
      return {
        agentic_credential_sources: { 'claude-code': configMocks.credentialSource },
      };
    }
  },
  runWithTenantDatabaseScope: async (
    db: unknown,
    _tenantId: string,
    work: (scoped: unknown) => unknown
  ) => {
    dbMocks.tenants.push(_tenantId);
    dbMocks.depth += 1;
    try {
      return await work(db);
    } finally {
      dbMocks.depth -= 1;
    }
  },
}));
vi.mock('./codex-auth-shared.js', () => ({
  resolveCodexCredentialRoute: routeMocks.resolve,
}));

import { BadRequest, Unavailable } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import { buildClaudeCredentialsJson, TokenExchangeError } from './claude-oauth.js';
import { ClaudeRuntimeCredentialResolver } from './claude-runtime-credential.js';

const NOW = 2_000_000_000_000;
const USER = 'user-1' as UserID;

function credential(access: string, expiresAt: number, refresh = 'sk-ant-ort01-refresh') {
  return `${JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    },
  })}\n`;
}

function authority() {
  const runCredentialMutation = vi.fn(
    async <T>(_key: string, work: (generation: number) => Promise<T>) => work(42)
  );
  return { runCredentialMutation, invalidate: vi.fn() };
}

function resolver(options: {
  read: ReturnType<typeof vi.fn>;
  refresh?: ReturnType<typeof vi.fn>;
  compareAndSwap?: ReturnType<typeof vi.fn>;
  auth?: ReturnType<typeof authority>;
  config?: Record<string, unknown>;
  runtimeIsolationAvailable?: () => boolean;
}) {
  const auth = options.auth ?? authority();
  const refresh =
    options.refresh ??
    vi.fn(async () => ({
      accessToken: 'sk-ant-oat01-refreshed',
      refreshToken: 'sk-ant-ort01-rotated',
      expiresInSec: 8 * 60 * 60,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    }));
  const compareAndSwap =
    options.compareAndSwap ?? vi.fn(async () => ({ outcome: 'written' as const }));
  return {
    auth,
    refresh,
    compareAndSwap,
    instance: new ClaudeRuntimeCredentialResolver({} as never, options.config ?? {}, auth, {
      now: () => NOW,
      read: options.read,
      refresh,
      compareAndSwap,
      runtimeIsolationAvailable: options.runtimeIsolationAvailable ?? (() => true),
    }),
  };
}

describe('ClaudeRuntimeCredentialResolver', () => {
  it('refuses managed tokens for every user when the live sandbox lacks a PID namespace', async () => {
    const read = vi.fn(async () => credential('sk-ant-oat01-secret', NOW + 8 * 60 * 60 * 1000));
    const subject = resolver({ read, runtimeIsolationAvailable: () => false });

    await expect(subject.instance.resolve('tenant-a', USER)).rejects.toThrow(
      /private PID namespace/
    );
    await expect(subject.instance.resolve('tenant-a', 'user-2' as UserID)).rejects.toThrow(
      /private PID namespace/
    );
    expect(read).not.toHaveBeenCalled();
    expect(routeMocks.resolve).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.contained = true;
    configMocks.credentialSource = 'managed_file';
    routeMocks.claudeConfigDir = '/homes/user-1/.claude';
    dbMocks.depth = 0;
    dbMocks.tenants = [];
    configMocks.resolveProviderConnection.mockResolvedValue({
      source: 'user',
      useNativeAuth: true,
      connection: {},
    });
  });

  it('takes the fresh fast path without network after authority revalidation', async () => {
    const read = vi.fn(async () => credential('sk-ant-oat01-fresh', NOW + 2 * 60 * 60 * 1000));
    const subject = resolver({ read });

    await expect(subject.instance.resolve('tenant-1', USER)).resolves.toEqual({
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fresh' },
      useNativeAuth: false,
    });
    expect(subject.refresh).not.toHaveBeenCalled();
    expect(subject.auth.runCredentialMutation).toHaveBeenCalledTimes(1);
    expect(subject.compareAndSwap).not.toHaveBeenCalled();
  });

  it('lets a source switch queued ahead of a fresh return suppress the old identity', async () => {
    const fresh = credential('sk-ant-oat01-old-identity', NOW + 2 * 60 * 60 * 1000);
    let releaseAuthority!: () => void;
    const ahead = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const auth = authority();
    auth.runCredentialMutation.mockImplementation(async (_key, work) => {
      await ahead;
      return work(42);
    });
    const subject = resolver({ read: vi.fn(async () => fresh), auth });
    const resolving = subject.instance.resolve('tenant-1', USER);

    await vi.waitFor(() => expect(auth.runCredentialMutation).toHaveBeenCalledTimes(1));
    configMocks.credentialSource = 'api_key';
    configMocks.resolveProviderConnection.mockResolvedValue({
      source: 'user',
      useNativeAuth: false,
      connection: { ANTHROPIC_API_KEY: 'replacement-key' },
    });
    releaseAuthority();

    await expect(resolving).rejects.toThrow(/authentication method changed/i);
  });

  it('lets logout queued ahead of a fresh return suppress the deleted login', async () => {
    const fresh = credential('sk-ant-oat01-logged-out', NOW + 2 * 60 * 60 * 1000);
    let releaseAuthority!: () => void;
    const ahead = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const auth = authority();
    auth.runCredentialMutation.mockImplementation(async (_key, work) => {
      await ahead;
      return work(42);
    });
    const read = vi.fn(async () => fresh);
    const subject = resolver({ read, auth });
    const resolving = subject.instance.resolve('tenant-1', USER);

    await vi.waitFor(() => expect(auth.runCredentialMutation).toHaveBeenCalledTimes(1));
    configMocks.credentialSource = 'none';
    configMocks.resolveProviderConnection.mockResolvedValue({
      source: 'none',
      useNativeAuth: false,
      connection: {},
    });
    releaseAuthority();

    await expect(resolving).rejects.toThrow(/authentication method changed/i);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects a fresh credential replaced before authority revalidation', async () => {
    const old = credential('sk-ant-oat01-old-identity', NOW + 2 * 60 * 60 * 1000);
    const replacement = credential('sk-ant-oat01-new-identity', NOW + 2 * 60 * 60 * 1000);
    const read = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    const subject = resolver({ read });

    await expect(subject.instance.resolve('tenant-1', USER)).rejects.toThrow(
      /managed Claude login changed/i
    );
    expect(subject.refresh).not.toHaveBeenCalled();
  });

  it('revalidates the second fresh path when another task refreshed before the flight', async () => {
    const expiring = credential('sk-ant-oat01-expiring', NOW + 5 * 60 * 1000);
    const fresh = credential('sk-ant-oat01-other-task', NOW + 2 * 60 * 60 * 1000);
    const read = vi
      .fn()
      .mockResolvedValueOnce(expiring)
      .mockResolvedValueOnce(fresh)
      .mockResolvedValueOnce(fresh);
    const subject = resolver({ read });

    await expect(subject.instance.resolve('tenant-1', USER)).resolves.toMatchObject({
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-other-task' },
    });
    expect(subject.auth.runCredentialMutation).toHaveBeenCalledTimes(1);
    expect(subject.refresh).not.toHaveBeenCalled();
  });

  it('accepts the exact canonical login document when subscription type is absent', async () => {
    const canonical = buildClaudeCredentialsJson(
      {
        accessToken: 'sk-ant-oat01-fresh',
        refreshToken: 'sk-ant-ort01-refresh',
        expiresInSec: 2 * 60 * 60,
        scopes: ['user:inference'],
      },
      NOW
    );
    const subject = resolver({ read: vi.fn(async () => canonical) });
    await expect(subject.instance.resolve('tenant-1', USER)).resolves.toMatchObject({
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fresh' },
    });
    expect(subject.refresh).not.toHaveBeenCalled();
  });

  it('refreshes one near-expiry grant and generation-CASes the canonical file', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const subject = resolver({ read: vi.fn(async () => old) });

    await expect(subject.instance.resolve('tenant-1', USER)).resolves.toMatchObject({
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-refreshed' },
      useNativeAuth: false,
    });
    expect(subject.refresh).toHaveBeenCalledTimes(1);
    expect(subject.auth.runCredentialMutation).toHaveBeenCalledTimes(1);
    expect(subject.compareAndSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        target: '/homes/user-1/.claude/.credentials.json',
        expectedContent: old,
        generation: 42,
      })
    );
  });

  it('performs provider POST outside database and credential locks', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const auth = authority();
    let authorityDepth = 0;
    auth.runCredentialMutation.mockImplementation(async (_key, work) => {
      authorityDepth += 1;
      try {
        return await work(42);
      } finally {
        authorityDepth -= 1;
      }
    });
    const refresh = vi.fn(async () => {
      expect(dbMocks.depth).toBe(0);
      expect(authorityDepth).toBe(0);
      return {
        accessToken: 'sk-ant-oat01-refreshed',
        refreshToken: 'sk-ant-ort01-rotated',
        expiresInSec: 8 * 60 * 60,
        scopes: ['user:inference'],
      };
    });
    const subject = resolver({ read: vi.fn(async () => old), refresh, auth });
    await subject.instance.resolve('tenant-1', USER);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('single-flights ten concurrent launches for one tenant/user', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    let finish!: (value: {
      accessToken: string;
      refreshToken: string;
      expiresInSec: number;
      scopes: string[];
    }) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>((resolve) => {
      finish = resolve;
    });
    const refresh = vi.fn(() => pending);
    const subject = resolver({ read: vi.fn(async () => old), refresh });
    const launches = Array.from({ length: 10 }, () => subject.instance.resolve('tenant-1', USER));

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    finish({
      accessToken: 'sk-ant-oat01-winner',
      refreshToken: 'sk-ant-ort01-winner',
      expiresInSec: 8 * 60 * 60,
      scopes: ['user:inference'],
    });
    const results = await Promise.all(launches);
    expect(results).toHaveLength(10);
    expect(
      results.every((item) => item.connection.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-winner')
    ).toBe(true);
    expect(subject.auth.runCredentialMutation).toHaveBeenCalledTimes(1);
  });

  it('does not share refresh flights across tenants with the same user id', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const subject = resolver({ read: vi.fn(async () => old) });

    await Promise.all([
      subject.instance.resolve('tenant-a', USER),
      subject.instance.resolve('tenant-b', USER),
    ]);
    expect(subject.refresh).toHaveBeenCalledTimes(2);
    expect(dbMocks.tenants).toContain('tenant-a');
    expect(dbMocks.tenants).toContain('tenant-b');
  });

  it('adopts a cross-replica CAS winner instead of writing the loser result', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const winner = credential('sk-ant-oat01-other-replica', NOW + 8 * 60 * 60 * 1000);
    const subject = resolver({
      read: vi.fn(async () => old),
      compareAndSwap: vi.fn(async () => ({ outcome: 'changed' as const, content: winner })),
    });

    await expect(subject.instance.resolve('tenant-1', USER)).resolves.toMatchObject({
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-other-replica' },
    });
  });

  it.each([
    ['ambiguous 5xx', new TokenExchangeError('ambiguous', 'safe'), Unavailable],
    ['invalid_grant', new TokenExchangeError('rejected', 'safe'), BadRequest],
  ])('preserves source and file on %s', async (_case, failure, ErrorType) => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const subject = resolver({
      read: vi.fn(async () => old),
      refresh: vi.fn(async () => Promise.reject(failure)),
    });

    await expect(subject.instance.resolve('tenant-1', USER)).rejects.toBeInstanceOf(ErrorType);
    expect(subject.auth.runCredentialMutation).toHaveBeenCalledTimes(1);
    expect(subject.compareAndSwap).not.toHaveBeenCalled();
  });

  it('does not put access or refresh token material in logs or errors', async () => {
    const access = 'sk-ant-oat01-never-log-this';
    const refreshToken = 'sk-ant-ort01-never-log-this';
    const old = credential(access, NOW + 5 * 60 * 1000, refreshToken);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const subject = resolver({
      read: vi.fn(async () => old),
      refresh: vi.fn(async () =>
        Promise.reject(new TokenExchangeError('ambiguous', 'provider failed safely'))
      ),
    });

    const error = await subject.instance.resolve('tenant-1', USER).catch((value) => value);
    const emitted = JSON.stringify([...warn.mock.calls, ...errorLog.mock.calls, String(error)]);
    expect(emitted).not.toContain(access);
    expect(emitted).not.toContain(refreshToken);
    warn.mockRestore();
    errorLog.mockRestore();
  });

  it('adopts a winner after another replica receives the rotating refresh token', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const winner = credential('sk-ant-oat01-winner', NOW + 8 * 60 * 60 * 1000);
    const read = vi
      .fn()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(winner);
    const subject = resolver({
      read,
      refresh: vi.fn(async () => Promise.reject(new TokenExchangeError('rejected', 'safe'))),
    });

    await expect(subject.instance.resolve('tenant-1', USER)).resolves.toMatchObject({
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-winner' },
    });
    expect(subject.compareAndSwap).not.toHaveBeenCalled();
  });

  it('lets logout/source change win while provider refresh is in flight', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    configMocks.resolveProviderConnection.mockResolvedValueOnce({
      source: 'none',
      useNativeAuth: false,
      connection: {},
    });
    const subject = resolver({ read: vi.fn(async () => old) });

    await expect(subject.instance.resolve('tenant-1', USER)).rejects.toThrow(
      /authentication method changed/i
    );
    expect(subject.compareAndSwap).not.toHaveBeenCalled();
  });

  it('lets a route change win and never writes the old home', async () => {
    const old = credential('sk-ant-oat01-old', NOW + 5 * 60 * 1000);
    const refresh = vi.fn(async () => {
      routeMocks.claudeConfigDir = '/homes/user-1-new/.claude';
      return {
        accessToken: 'sk-ant-oat01-refreshed',
        refreshToken: 'sk-ant-ort01-rotated',
        expiresInSec: 8 * 60 * 60,
        scopes: ['user:inference'],
      };
    });
    const subject = resolver({ read: vi.fn(async () => old), refresh });

    await expect(subject.instance.resolve('tenant-1', USER)).rejects.toThrow(
      /credential home changed/i
    );
    expect(subject.compareAndSwap).not.toHaveBeenCalled();
  });

  it('fails closed in shared, delegated, or otherwise uncontained topologies', async () => {
    configMocks.contained = false;
    const read = vi.fn();
    const subject = resolver({ read });
    await expect(subject.instance.resolve('tenant-1', USER)).rejects.toBeInstanceOf(BadRequest);
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed in HA even when the local sandbox is otherwise contained', async () => {
    const read = vi.fn();
    const subject = resolver({ read, config: { deployment: { mode: 'ha' } } });
    await expect(subject.instance.resolve('tenant-1', USER)).rejects.toBeInstanceOf(BadRequest);
    expect(read).not.toHaveBeenCalled();
  });
});
