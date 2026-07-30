import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCodexAuthViaExecutor,
  inspectCodexAuthViaExecutor,
  writeCodexAuthViaExecutor,
} from './executor-codex-auth.js';
import { runExecutorCommand } from './spawn-executor.js';

vi.mock('./spawn-executor.js', () => ({ runExecutorCommand: vi.fn() }));
const runMock = vi.mocked(runExecutorCommand);

describe('executor Codex auth dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, 'alice'] as const)('dispatches as the resolved identity %s', async (asUser) => {
    runMock.mockResolvedValue({ success: true, data: { status: 'written', authMode: 'chatgpt' } });
    await writeCodexAuthViaExecutor('credential-json', asUser);
    expect(runMock).toHaveBeenCalledWith(
      {
        command: 'codex.auth-file',
        params: { operation: 'write', content: 'credential-json' },
      },
      {
        asUser,
        sensitiveOutput: true,
        timeoutMs: 10_000,
        logPrefix: '[CodexAuthExecutor]',
      }
    );
  });

  it('maps absent separately from unreadable and never exposes executor errors', async () => {
    runMock.mockResolvedValueOnce({ success: true, data: { status: 'not-found' } });
    await expect(inspectCodexAuthViaExecutor('alice')).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
    runMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'FAIL', message: 'credential-json' },
    });
    await expect(inspectCodexAuthViaExecutor('alice')).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('dispatches idempotent deletion and throws a secret-free failure', async () => {
    runMock.mockResolvedValueOnce({ success: true, data: { status: 'deleted' } });
    await deleteCodexAuthViaExecutor('alice');
    expect(runMock.mock.calls[0]?.[0]).toEqual({
      command: 'codex.auth-file',
      params: { operation: 'delete' },
    });

    runMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'FAIL', message: 'top-secret' },
    });
    const error = await deleteCodexAuthViaExecutor('alice').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Executor credential delete failed');
    expect((error as Error).message).not.toContain('top-secret');
  });
});
