import type { HookContext } from '@agor/core/types';
import {
  branchCleanupCommandId,
  branchDeletionCommandId,
  environmentCommandTokenId,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { isTenantSafetySettlement } from './tenant-safety-settlement.js';

function context(path: string, method: string, data: unknown, command?: string): HookContext {
  return {
    path,
    method,
    data,
    params: {
      provider: 'rest',
      tenant: { tenant_id: 'tenant-a' },
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: command ? 'executor-command' : 'executor-task',
          session_id: command ?? 'session-a',
          task_id: command ? undefined : 'task-a',
          branch_id: 'branch-a',
        },
      },
    },
  } as HookContext;
}

describe('tenant safety settlement classification', () => {
  it.each([
    'getTerminationState',
    'reportTerminationComplete',
    'reportRuntimeTelemetry',
    'reportSdkHealthFailure',
  ])('requires exact task authority for %s', async (method) => {
    await expect(
      isTenantSafetySettlement(context('tasks', method, { task_id: 'task-a' }))
    ).resolves.toBe(true);
    await expect(
      isTenantSafetySettlement(context('tasks', method, { task_id: 'task-b' }))
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      isTenantSafetySettlement(context('tasks', method, { task_id: 'task-a' }, 'command-a'))
    ).rejects.toMatchObject({ code: 403 });
  });
  it.each(['get', 'find', 'connectExecutor', 'patch', 'create'])(
    'never grants ordinary task %s',
    async (method) => {
      await expect(
        isTenantSafetySettlement(
          context('tasks', method, { task_id: 'task-a', bypassRestriction: true })
        )
      ).resolves.toBe(false);
    }
  );
  it.each(['start', 'stop', 'nuke'] as const)(
    'separates environment %s claim from settlement',
    async (action) => {
      const data = { branch_id: 'branch-a', attempt_id: 'attempt-a', action };
      const command = environmentCommandTokenId(action, data.attempt_id);
      for (const kind of ['output', 'result', 'claim']) {
        await expect(
          isTenantSafetySettlement(
            context('environment-command-reports', 'create', { ...data, kind }, command)
          )
        ).resolves.toBe(kind !== 'claim' || action === 'stop');
      }
      await expect(
        isTenantSafetySettlement(
          context(
            'environment-command-reports',
            'create',
            { ...data, kind: 'result', branch_id: 'branch-b' },
            command
          )
        )
      ).resolves.toBe(false);
    }
  );
  it('allows bounded cleanup settlement, not a new claim', async () => {
    const data = { branch_id: 'branch-a', execution_id: 'execution-a' };
    for (const action of ['claim', 'succeeded', 'failed', 'unknown']) {
      await expect(
        isTenantSafetySettlement(
          context(
            'branch-cleanup-steps',
            'create',
            { ...data, action },
            branchCleanupCommandId(data.execution_id)
          )
        )
      ).resolves.toBe(action !== 'claim');
    }
    for (const action of [
      'claim',
      'heartbeat',
      'quiesce',
      'upload',
      'storage',
      'data',
      'finalize',
      'failed',
    ]) {
      await expect(
        isTenantSafetySettlement(
          context(
            'branch-deletion-steps',
            'create',
            { ...data, action },
            branchDeletionCommandId(data.execution_id)
          )
        )
      ).resolves.toBe(action !== 'claim');
    }
  });
});
