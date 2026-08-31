import { writeVerifiedCodexAuthFile } from '@agor/core/codex/credential-file';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCodexAuthCredential,
  inspectCodexAuthViaExecutor,
  writeCodexAuthCredential,
} from './executor-codex-auth.js';
import { requestExecutor } from './spawn-executor.js';

vi.mock('@agor/core/codex/credential-file', () => ({
  mutateCredentialFile: vi.fn(),
  writeVerifiedCodexAuthFile: vi.fn(),
}));

vi.mock('./spawn-executor.js', () => ({
  requestExecutor: vi.fn(),
}));
const runMock = vi.mocked(requestExecutor);
const writeVerifiedCodexAuthFileMock = vi.mocked(writeVerifiedCodexAuthFile);

describe('executor Codex auth dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, 'alice'] as const)(
    'dispatches with delegated home key %s',
    async (delegatedHomeKey) => {
      runMock.mockResolvedValue({
        success: true,
        data: { status: 'written', authMode: 'chatgpt' },
      });
      await writeCodexAuthCredential('credential-json', {
        delegatedHomeKey,
        userId: 'user-1',
      });
      expect(runMock).toHaveBeenCalledWith(
        {
          command: 'codex.auth-file',
          params: { operation: 'write', content: 'credential-json' },
        },
        {
          delegatedHomeKey: delegatedHomeKey ?? undefined,
          templateVariables: { unix_user: delegatedHomeKey ?? undefined, user_id: 'user-1' },
          sensitiveOutput: true,
          timeoutMs: 10_000,
          logPrefix: '[CodexAuthExecutor]',
        }
      );
    }
  );

  it('maps absent separately from unreadable and never exposes executor errors', async () => {
    runMock.mockResolvedValueOnce({ success: true, data: { status: 'not-found' } });
    const routing = { delegatedHomeKey: 'alice', userId: 'user-1' };
    await expect(inspectCodexAuthViaExecutor(routing)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
    runMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'FAIL', message: 'credential-json' },
    });
    await expect(inspectCodexAuthViaExecutor(routing)).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('routes external auth helpers by trusted user and delegated home key', async () => {
    runMock.mockResolvedValue({ success: true, data: { status: 'deleted' } });
    await deleteCodexAuthCredential({
      delegatedHomeKey: 'alice',
      userId: '019fda98-8206-7eb5-8e77-f95d6c8cd6c1',
    });

    expect(runMock.mock.calls[0]?.[1]).toMatchObject({
      delegatedHomeKey: 'alice',
      templateVariables: {
        unix_user: 'alice',
        user_id: '019fda98-8206-7eb5-8e77-f95d6c8cd6c1',
      },
    });
  });

  it('routes CODEX_HOME without copying daemon secrets into the helper', async () => {
    runMock.mockResolvedValue({ success: true, data: { status: 'not-found' } });
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousMasterSecret = process.env.AGOR_MASTER_SECRET;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.DATABASE_URL = 'postgres://daemon-canary';
    process.env.AGOR_MASTER_SECRET = 'master-canary';
    process.env.CODEX_HOME = '/ambient/user-controlled';
    try {
      await inspectCodexAuthViaExecutor({
        delegatedHomeKey: null,
        userId: 'user-1',
        codexHome: '/tenant/user/.codex',
      });
      const env = runMock.mock.calls[0]?.[1].env;
      expect(env?.CODEX_HOME).toBe('/tenant/user/.codex');
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env?.DATABASE_URL).toBeUndefined();
      expect(env?.AGOR_MASTER_SECRET).toBeUndefined();
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previousMasterSecret;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it('keeps generation-fenced HA mutations in the authority-owning daemon', async () => {
    const content = '{"tokens":{"refresh_token":"credential-json"}}';
    writeVerifiedCodexAuthFileMock.mockResolvedValue({
      outcome: 'written',
      authMode: 'chatgpt',
    });
    await writeCodexAuthCredential(
      content,
      {
        delegatedHomeKey: null,
        userId: 'user-1',
        codexHome: '/tenant/user/.codex',
      },
      42
    );

    expect(runMock).not.toHaveBeenCalled();
    expect(writeVerifiedCodexAuthFileMock).toHaveBeenCalledWith({
      target: '/tenant/user/.codex/auth.json',
      content,
      generation: 42,
    });
  });

  it('dispatches idempotent deletion and throws a secret-free failure', async () => {
    runMock.mockResolvedValueOnce({ success: true, data: { status: 'deleted' } });
    const routing = { delegatedHomeKey: 'alice', userId: 'user-1' };
    await deleteCodexAuthCredential(routing);
    expect(runMock.mock.calls[0]?.[0]).toEqual({
      command: 'codex.auth-file',
      params: { operation: 'delete' },
    });

    runMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'FAIL', message: 'top-secret' },
    });
    const error = await deleteCodexAuthCredential(routing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Executor credential delete failed');
    expect((error as Error).message).not.toContain('top-secret');
  });
});
