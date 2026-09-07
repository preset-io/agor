import {
  BranchRepository,
  EnvironmentCommandRepository,
  generateId,
  runWithTenantContext,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  environmentCommandTokenId,
  type TenantID,
} from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BranchesService } from './branches';
import { EnvironmentCommandReportsService } from './environment-command-reports';

const { dispatch, query } = vi.hoisted(() => ({
  dispatch: vi.fn(async () => undefined),
  query: vi.fn(),
}));
vi.mock('../utils/spawn-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor.js')>()),
  requestExecutor: query,
}));
vi.mock('../utils/environment-command-dispatch.js', () => ({
  dispatchEnvironmentCommand: dispatch,
}));
afterEach(() => vi.clearAllMocks());
const tenantId = 'environment-service-test' as TenantID;
const config = {
  deployment: { mode: 'ha', ha: { execution_topology: 'external' } },
  execution: {
    unix_user_mode: 'delegated',
    executor_command_template: 'fake-launcher --no-wait',
    managed_envs_execution_mode: 'hybrid',
    environment_command_job_deadline_ms: 365000,
  },
};

describe('executor-owned command reports', () => {
  dbTest(
    'returns admitted state without a claim/result waiter and settles through another service instance',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const emit = vi.fn();
      const instanceConfig = { ...config, execution: { ...config.execution } };
      const app = {
        get: () => instanceConfig,
        sessionTokenService: { generateCommandToken: vi.fn(async () => 'test-credential') },
        service: () => ({ emit }),
      } as unknown as Application;
      const service = new BranchesService(db, app);
      vi.spyOn(service, 'get').mockImplementation(
        async () => (await new BranchRepository(db).findById(branch.branch_id))! as never
      );
      vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
        env: {},
        branchFsAccess: 'write',
        delegatedHomeKey: 'opaque-test-home',
      } as never);
      const params = {
        provider: 'rest',
        tenant: { tenant_id: tenantId, source: 'explicit' },
        user: { ...user, role: 'member' },
      } as AuthenticatedParams;
      await runWithTenantContext(tenantId, async () => {
        const admitted = await service.startEnvironment(branch.branch_id, params);
        const attempt = admitted.environment_instance!.command_attempt!;
        expect(attempt.claimed_at).toBeUndefined();
        expect(attempt.finished_at).toBeUndefined();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0]).toBeDefined();
        await expect(service.stopEnvironment(branch.branch_id, params)).rejects.toThrow(
          'still active'
        );
        await expect(service.restartEnvironment(branch.branch_id, params)).rejects.toThrow(
          'Restart is unavailable'
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
        // A diagnostic query has its own prerequisites and never owns lifecycle state.
        expect(await service.getLogs(branch.branch_id, params)).toMatchObject({
          error: expect.stringContaining('executor-response-v1'),
        });
        expect(query).not.toHaveBeenCalled();
        Object.assign(instanceConfig.execution, {
          executor_response: {
            external_protocol: 'executor-response-v1',
            origin_url: 'https://exact-replica.example.test',
          },
        });
        query.mockResolvedValueOnce({
          success: true,
          data: { logs: 'diagnostic snapshot', timestamp: 'now' },
        });
        expect(await service.getLogs(branch.branch_id, params)).toMatchObject({
          logs: 'diagnostic snapshot',
        });
        query.mockRejectedValueOnce(new Error('initiating query replica disappeared'));
        expect(await service.getLogs(branch.branch_id, params)).toMatchObject({
          error: 'initiating query replica disappeared',
        });
        expect((await service.get(branch.branch_id)).environment_instance?.command_attempt).toEqual(
          attempt
        );
        const reporter = new EnvironmentCommandReportsService(db, app);
        const reportParams = {
          ...params,
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-command',
              session_id: environmentCommandTokenId('start', attempt.id),
              branch_id: branch.branch_id,
              tenant_id: tenantId,
              sub: user.user_id,
            },
          },
        } as AuthenticatedParams;
        const scope = { branch_id: branch.branch_id, attempt_id: attempt.id, action: 'start' };
        await reporter.create({ ...scope, kind: 'claim' }, reportParams);
        await reporter.create(
          {
            ...scope,
            kind: 'result',
            outcome: 'succeeded',
            message: 'remote trigger exited zero',
            access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
          },
          reportParams
        );
        expect((await service.get(branch.branch_id)).environment_instance).toMatchObject({
          status: 'running',
          access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
        });
        expect(emit).toHaveBeenCalledWith(
          'patched',
          expect.anything(),
          expect.objectContaining({ params: expect.objectContaining({ tenant: params.tenant }) })
        );
      });
    }
  );

  dbTest(
    'rejects ordinary/task/foreign-scope credentials and untrusted or oversized report data',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const id = generateId();
      await new EnvironmentCommandRepository(db).admit({
        branch,
        userId: user.user_id,
        action: 'start',
        attemptId: id,
      });
      const reporter = new EnvironmentCommandReportsService(db, {
        service: () => ({ emit: vi.fn() }),
      } as unknown as Application);
      const payload = {
        type: 'executor-session',
        purpose: 'executor-command',
        session_id: environmentCommandTokenId('start', id),
        branch_id: branch.branch_id,
        tenant_id: tenantId,
        sub: user.user_id,
      };
      const params = {
        provider: 'rest',
        tenant: { tenant_id: tenantId, source: 'explicit' },
        user: { ...user, role: 'member' },
        authentication: { strategy: 'jwt', payload },
      } as AuthenticatedParams;
      const scope = { branch_id: branch.branch_id, attempt_id: id, action: 'start', kind: 'claim' };
      await runWithTenantContext(tenantId, async () => {
        for (const auth of [
          undefined,
          { ...payload, purpose: 'executor-task' },
          { ...payload, branch_id: generateId() },
          { ...payload, session_id: environmentCommandTokenId('stop', id) },
          { ...payload, session_id: environmentCommandTokenId('start', generateId()) },
        ]) {
          await expect(
            reporter.create(scope, {
              ...params,
              authentication: auth ? { strategy: 'jwt', payload: auth } : undefined,
            } as AuthenticatedParams)
          ).rejects.toThrow('scoped');
        }
        await expect(
          reporter.create(scope, {
            ...params,
            user: { ...user, role: 'viewer', user_id: generateId() },
          } as AuthenticatedParams)
        ).rejects.toThrow('permission');
        for (const data of [
          { ...scope, kind: 'output', sequence: 1, output: '😀'.repeat(32768), truncated: false },
          {
            ...scope,
            kind: 'result',
            outcome: 'succeeded',
            message: 'x',
            access_urls: [{ name: 'bad', url: 'javascript:alert(1)' }],
          },
          {
            ...scope,
            kind: 'result',
            outcome: 'succeeded',
            message: 'x',
            access_urls: [{ name: 'Preview', url: 'https://preview.example.test', extra: true }],
          },
          { ...scope, status: 'running' },
        ])
          await expect(reporter.create(data, params)).rejects.toThrow('Invalid or oversized');
        await expect(
          reporter.create(scope, {
            ...params,
            tenant: { tenant_id: 'foreign' as TenantID, source: 'explicit' },
          })
        ).rejects.toThrow('current tenant');
        await expect(
          reporter.create(scope, {
            ...params,
            authentication: { strategy: 'jwt', payload: { ...payload, tenant_id: 'foreign' } },
          })
        ).rejects.toThrow('current tenant');
        expect(
          (await new BranchRepository(db).findById(branch.branch_id))?.environment_instance
            ?.command_attempt?.claimed_at
        ).toBeUndefined();
      });
    }
  );
});
