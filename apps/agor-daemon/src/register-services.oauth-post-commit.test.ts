import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Database, runWithTenantContext, runWithTenantDatabaseScope } from '@agor/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preserveCommittedOAuthResult } from './register-services.js';

describe('committed OAuth best-effort tails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['completion_hint', () => Promise.reject(new Error('SECRET_REPOSITORY_LOOKUP_FAILURE'))],
    [
      'completion_notification',
      () => {
        throw new Error('SECRET_SYNC_SOCKET_FAILURE');
      },
    ],
    ['disconnect_notification', () => Promise.reject(new Error('SECRET_ASYNC_SOCKET_FAILURE'))],
  ] as const)(
    'contains %s failure without changing committed state or response',
    async (code, run) => {
      const committedState = { tokenPersisted: true, grantDeleted: true };
      const response = { success: true, tokenObtained: true };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(preserveCommittedOAuthResult(response, [{ code, run }])).resolves.toBe(response);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(committedState).toEqual({ tokenPersisted: true, grantDeleted: true });
      expect(warn).toHaveBeenCalledWith(
        `[MCP Runtime] event=oauth_post_commit_tail_failed code=${code}`
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_');
    }
  );

  it('continues independent notification tails after a repository hint lookup rejects', async () => {
    const notify = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await preserveCommittedOAuthResult({ success: true }, [
      {
        code: 'completion_hint',
        run: () => Promise.reject(new Error('SECRET_REPOSITORY_LOOKUP_FAILURE')),
      },
      { code: 'completion_notification', run: notify },
    ]);

    expect(notify).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_');
  });

  it('does not wait for an availability-only tail that never settles', async () => {
    const response = { success: true };
    const never = new Promise<void>(() => undefined);

    await expect(
      preserveCommittedOAuthResult(response, [
        { code: 'completion_notification', run: () => never },
      ])
    ).resolves.toBe(response);
  });

  it('starts a disconnect notification only after the owning tenant scope commits', async () => {
    const notify = vi.fn();
    const db = { run: vi.fn() } as unknown as Database;

    await runWithTenantContext('tenant-a', () =>
      runWithTenantDatabaseScope(db, 'tenant-a', async () => {
        await preserveCommittedOAuthResult({ success: true }, [
          { code: 'disconnect_notification', run: notify },
        ]);
        expect(notify).not.toHaveBeenCalled();
      })
    );

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps completion and disconnect tails after their authoritative mutations', () => {
    const source = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
    const completionStart = source.indexOf("'/mcp-servers/oauth-complete'");
    const disconnectStart = source.indexOf("'/mcp-servers/oauth-disconnect'");
    const completion = source.slice(completionStart, disconnectStart);
    const disconnect = source.slice(disconnectStart, source.indexOf("'/mcp-servers/oauth-status'"));

    expect(completion.indexOf('persistOAuthTokenForPendingFlow')).toBeLessThan(
      completion.indexOf('preserveCommittedOAuthResult')
    );
    expect(disconnect.indexOf('performOAuthDisconnect')).toBeLessThan(
      disconnect.indexOf('preserveCommittedOAuthResult')
    );
    expect(disconnect).toContain('disconnect_notification');
    expect(source).toContain('enqueueAfterTenantDatabaseCommit(dispatch)');
  });
});
