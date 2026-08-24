import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteClaudeAuthViaExecutor,
  inspectClaudeAuthViaExecutor,
  writeClaudeAuthViaExecutor,
} from './executor-claude-auth.js';
import { requestExecutor } from './spawn-executor.js';

vi.mock('./spawn-executor.js', () => ({ requestExecutor: vi.fn() }));

const requestExecutorMock = vi.mocked(requestExecutor);

describe('executor Claude auth dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes sandbox helpers to the exact per-user Claude config directory', async () => {
    requestExecutorMock.mockResolvedValue({ success: true, data: { status: 'written' } });

    await writeClaudeAuthViaExecutor('credential-json', {
      delegatedHomeKey: null,
      userId: 'user-1',
      claudeConfigDir: '/tenant/user/.claude',
    });

    expect(requestExecutorMock).toHaveBeenCalledWith(
      {
        command: 'claude.auth-file',
        params: { operation: 'write', content: 'credential-json' },
      },
      expect.objectContaining({
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/tenant/user/.claude' }),
        templateVariables: { unix_user: undefined, user_id: 'user-1' },
        sensitiveOutput: true,
      })
    );
  });

  it('maps absent separately from unreadable without exposing executor errors', async () => {
    const routing = { delegatedHomeKey: 'alice', userId: 'user-1' };
    requestExecutorMock.mockResolvedValueOnce({ success: true, data: { status: 'not-found' } });
    await expect(inspectClaudeAuthViaExecutor(routing)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });

    requestExecutorMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'FAIL', message: 'sk-ant-secret' },
    });
    await expect(inspectClaudeAuthViaExecutor(routing)).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('dispatches idempotent deletion through the authenticated response path', async () => {
    requestExecutorMock.mockResolvedValue({ success: true, data: { status: 'deleted' } });
    await deleteClaudeAuthViaExecutor({ delegatedHomeKey: 'alice', userId: 'user-1' });

    expect(requestExecutorMock).toHaveBeenCalledWith(
      { command: 'claude.auth-file', params: { operation: 'delete' } },
      expect.objectContaining({
        delegatedHomeKey: 'alice',
        templateVariables: { unix_user: 'alice', user_id: 'user-1' },
      })
    );
  });
});
