import { runWithTenantDatabaseTransaction } from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { coordinateMCPServerMutationAfterWrite } from './coordination';

dbTest(
  'server revocation cancels local calls only after commit, never after rollback',
  async ({ db }) => {
    const gateway = { abortServer: vi.fn().mockReturnValue(0) };
    const context = {
      params: { tenant: { tenant_id: 'default' } },
      result: { mcp_server_id: 'deleted-server' },
    } as unknown as HookContext;
    await expect(
      runWithTenantDatabaseTransaction(db, 'default', async () => {
        coordinateMCPServerMutationAfterWrite(context, gateway);
        expect(gateway.abortServer).not.toHaveBeenCalled();
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(gateway.abortServer).not.toHaveBeenCalled();
    await runWithTenantDatabaseTransaction(db, 'default', async () => {
      coordinateMCPServerMutationAfterWrite(context, gateway);
      expect(gateway.abortServer).not.toHaveBeenCalled();
    });
    expect(gateway.abortServer).toHaveBeenCalledExactlyOnceWith(
      'default',
      'deleted-server',
      'stale_capability'
    );
  }
);
