import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCodexAuthViaExecutor,
  inspectCodexAuthViaExecutor,
  writeCodexAuthViaExecutor,
} from './executor-codex-auth.js';
import { requestExecutor, startContainedExecutorCommand } from './spawn-executor.js';

vi.mock('./spawn-executor.js', () => ({
  requestExecutor: vi.fn(),
  startContainedExecutorCommand: vi.fn(),
}));
const runMock = vi.mocked(requestExecutor);
const containedMock = vi.mocked(startContainedExecutorCommand);

describe('executor Codex auth dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, 'alice'] as const)(
    'dispatches with delegated home key %s',
    async (delegatedHomeKey) => {
      runMock.mockResolvedValue({
        success: true,
        data: { status: 'written', authMode: 'chatgpt' },
      });
      await writeCodexAuthViaExecutor('credential-json', {
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
    await deleteCodexAuthViaExecutor({
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

  it('contains generation-fenced sandbox mutations before releasing authority', async () => {
    containedMock.mockReturnValue({
      result: Promise.resolve({
        success: true,
        data: { status: 'written', authMode: 'chatgpt' },
      }),
      verifyAbsence: vi.fn(),
      retainContainmentFence: vi.fn(),
    });
    await writeCodexAuthViaExecutor(
      'credential-json',
      {
        delegatedHomeKey: null,
        userId: 'user-1',
        codexHome: '/tenant/user/.codex',
      },
      42
    );

    expect(runMock).not.toHaveBeenCalled();
    expect(containedMock).toHaveBeenCalledWith(
      {
        command: 'codex.auth-file',
        params: { operation: 'write', content: 'credential-json', generation: 42 },
      },
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: '/tenant/user/.codex' }),
        sensitiveOutput: true,
      })
    );
  });

  it('dispatches idempotent deletion and throws a secret-free failure', async () => {
    runMock.mockResolvedValueOnce({ success: true, data: { status: 'deleted' } });
    const routing = { delegatedHomeKey: 'alice', userId: 'user-1' };
    await deleteCodexAuthViaExecutor(routing);
    expect(runMock.mock.calls[0]?.[0]).toEqual({
      command: 'codex.auth-file',
      params: { operation: 'delete' },
    });

    runMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'FAIL', message: 'top-secret' },
    });
    const error = await deleteCodexAuthViaExecutor(routing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Executor credential delete failed');
    expect((error as Error).message).not.toContain('top-secret');
  });
});
