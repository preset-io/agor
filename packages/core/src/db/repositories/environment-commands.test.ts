import { afterEach, describe, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { ENVIRONMENT_COMMAND_BUDGET as BUDGET, environmentStartConfirmation } from '../../types';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { EnvironmentCommandRepository } from './environment-commands';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';
import { EnvironmentHealthRepository } from './environment-health';

afterEach(() => vi.useRealTimers());
describe('shared environment command admission and transitions', () => {
  dbTest(
    'serializes competing admissions/claims, fences stale reports, and ignores duplicate results',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const a = new EnvironmentCommandRepository(db);
      const b = new EnvironmentCommandRepository(db);
      const attemptId = generateId();
      const inputs = { branch, action: 'start' as const, userId: user.user_id, attemptId };
      const admitted = await Promise.allSettled([
        a.admit(inputs),
        b.admit({ ...inputs, attemptId: generateId() }),
      ]);
      expect(admitted.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const live = (await new BranchRepository(db).findById(branch.branch_id))!
        .environment_instance!;
      const scope = {
        branch_id: branch.branch_id,
        attempt_id: live.command_attempt!.id,
        action: 'start' as const,
      };
      const claims = await Promise.allSettled([
        a.report({ ...scope, kind: 'claim' }),
        b.report({ ...scope, kind: 'claim' }),
      ]);
      expect(
        claims.filter((r) => r.status === 'fulfilled'),
        claims.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join('; ')
      ).toHaveLength(1);
      await expect(
        a.report({
          ...scope,
          attempt_id: generateId(),
          kind: 'result',
          outcome: 'succeeded',
          message: 'stale',
        })
      ).rejects.toThrow('Stale');
      await a.report({ ...scope, kind: 'output', sequence: 2, output: 'latest', truncated: true });
      await b.report({ ...scope, kind: 'output', sequence: 1, output: 'stale', truncated: false });
      const finished = await b.report({
        ...scope,
        kind: 'result',
        outcome: 'succeeded',
        message: 'Done',
      });
      expect(finished).toMatchObject({
        status: 'running',
        command_attempt: { output: 'latest', output_truncated: true },
        last_health_check: { status: 'unknown' },
      });
      expect(
        await a.report({ ...scope, kind: 'result', outcome: 'failed', message: 'late duplicate' })
      ).toEqual(finished);
    }
  );

  dbTest(
    'preserves failed/unknown diagnostics; retries Stop; enforces exact, non-sticky Start consent',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const commands = new EnvironmentCommandRepository(db);
      const startId = generateId();
      await commands.admit({ branch, action: 'start', attemptId: startId, userId: user.user_id });
      await commands.report({
        branch_id: branch.branch_id,
        action: 'start',
        attempt_id: startId,
        kind: 'claim',
      });
      await commands.report({
        branch_id: branch.branch_id,
        action: 'start',
        attempt_id: startId,
        kind: 'result',
        outcome: 'failed',
        message: 'partial provider failure',
        output: 'provider created resource before failure',
      });
      await expect(
        commands.admit({ branch, action: 'start', attemptId: generateId(), userId: user.user_id })
      ).rejects.toThrow('cleanup is unconfirmed');
      const stopId = generateId();
      await commands.admit({ branch, action: 'stop', attemptId: stopId, userId: user.user_id });
      await commands.dispatchFailed(branch.branch_id, stopId);
      await expect(
        commands.admit({
          branch,
          action: 'start',
          attemptId: generateId(),
          userId: user.user_id,
          confirmationOf: startId,
        })
      ).rejects.toThrow('cleanup is unconfirmed');
      const confirmed = await commands.admit({
        branch,
        action: 'start',
        attemptId: generateId(),
        userId: user.user_id,
        confirmationOf: stopId,
      });
      expect(confirmed.command_attempt?.confirmation_of).toBe(stopId);
      expect(confirmed.command_history).toHaveLength(2);
      expect(confirmed.command_history?.[0].attempt.output).toContain('provider created');
      expect(environmentStartConfirmation(confirmed)).toBeUndefined();
      await expect(
        commands.admit({ branch, action: 'stop', attemptId: generateId(), userId: user.user_id })
      ).rejects.toThrow('still active');
    }
  );

  dbTest(
    'independently expires lost claim/result and never lets late claims run',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      vi.useFakeTimers({ toFake: ['Date'] });
      const commands = new EnvironmentCommandRepository(db);
      const first = generateId();
      await commands.admit({ branch, action: 'start', attemptId: first, userId: user.user_id });
      vi.setSystemTime(Date.now() + BUDGET.claimMs + 1);
      expect(await commands.expire(branch.branch_id)).toBe(true);
      await expect(
        commands.report({
          branch_id: branch.branch_id,
          attempt_id: first,
          action: 'start',
          kind: 'claim',
        })
      ).rejects.toThrow('expired');
      const second = generateId();
      const environment = await commands.admit({
        branch,
        action: 'stop',
        attemptId: second,
        userId: user.user_id,
      });
      await commands.report({
        branch_id: branch.branch_id,
        attempt_id: second,
        action: 'stop',
        kind: 'claim',
      });
      await commands.dispatchFailed(branch.branch_id, second); // launcher loss cannot release a claimed runner
      expect(await commands.expire(branch.branch_id)).toBe(false);
      vi.setSystemTime(Date.parse(environment.command_attempt!.result_deadline) + 1);
      expect(await commands.expire(branch.branch_id)).toBe(true);
      const current = (await new BranchRepository(db).findById(branch.branch_id))!
        .environment_instance!;
      expect(current.last_command?.status).toBe('unknown');
      expect(current.last_error).toContain('incomplete');
      const third = generateId();
      await commands.admit({ branch, action: 'stop', attemptId: third, userId: user.user_id });
      await commands.report({
        branch_id: branch.branch_id,
        attempt_id: third,
        action: 'stop',
        kind: 'claim',
      });
      await commands.report({
        branch_id: branch.branch_id,
        attempt_id: third,
        action: 'stop',
        kind: 'result',
        outcome: 'succeeded',
        message: 'Stop exited zero',
      });
      await expect(
        commands.admit({ branch, action: 'start', attemptId: generateId(), userId: user.user_id })
      ).resolves.toMatchObject({ status: 'starting' });
    }
  );

  dbTest(
    'blocks mutation bypasses and prevents an early health result releasing command ownership',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const branches = new BranchRepository(db);
      const commands = new EnvironmentCommandRepository(db);
      const id = generateId();
      await commands.admit({ branch, action: 'start', attemptId: id, userId: user.user_id });
      for (const patch of [
        { environment_instance: { status: 'stopped' as const } },
        { start_command: 'evil' },
        { archived: true },
        { path: '/elsewhere' },
      ]) {
        await expect(branches.update(branch.branch_id, patch)).rejects.toThrow(
          /active environment command|attempt-scoped/
        );
      }
      await expect(branches.delete(branch.branch_id)).rejects.toThrow('active environment command');
      const health = new EnvironmentHealthRepository(db);
      const claim = await health.claim({
        branchId: branch.branch_id,
        claimToken: 'health',
        leaseDurationMs: 10000,
        identity: { instanceId: 'other', bootId: 'other' },
      });
      if (claim.outcome !== 'claimed') throw new Error('health not claimed');
      await health.commit({
        branchId: branch.branch_id,
        claimToken: 'health',
        environmentGeneration: claim.claim.environment_generation,
        observation: { status: 'healthy', message: 'HTTP 200', recordWhileStarting: true },
      });
      expect((await branches.findById(branch.branch_id))?.environment_instance?.status).toBe(
        'starting'
      );
      await expect(
        commands.admit({ branch, action: 'stop', attemptId: generateId(), userId: user.user_id })
      ).rejects.toThrow('still active');
    }
  );

  dbTest(
    'rejects changed command snapshots and archived/unready branches before launch',
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const branches = new BranchRepository(db);
      const commands = new EnvironmentCommandRepository(db);
      await branches.update(branch.branch_id, { start_command: 'changed' });
      await expect(
        commands.admit({ branch, action: 'start', attemptId: generateId(), userId: user.user_id })
      ).rejects.toThrow('configuration changed');
      await branches.update(branch.branch_id, { archived: true });
      await expect(
        commands.admit({ branch, action: 'start', attemptId: generateId(), userId: user.user_id })
      ).rejects.toThrow('non-archived');
    }
  );
});
