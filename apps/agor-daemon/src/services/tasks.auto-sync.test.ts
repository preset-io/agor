import type { Application } from '@agor/core/feathers';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { shouldAutoSyncEnvironmentAfterTask, TasksService } from './tasks';

/** Matches the stub used by the sibling service tests — auto-sync never touches the DB. */
function createTenantScopeTestDb() {
  return { run: vi.fn() };
}

/**
 * Guards for the task-completion auto-sync (`maybeAutoSyncEnvironmentAfterTask`).
 *
 * This path regressed once in production. A task that completes via the executor
 * carries an executor-scoped JWT that is (correctly) NOT valid for the
 * branch/sync endpoint. Auto-sync therefore submits one exact desired revision
 * with fresh tenant-only params instead of forwarding that executor token.
 *
 *   "Executor token is not valid for this endpoint"
 *
 * Executor scope is detected from `params.authentication` + `params.task_id`
 * (see auth/executor-runtime-scope.ts), so the contract these tests enforce is:
 * The branch service owns variant/readiness checks and durable retries.
 */

const branchId = '018f0000-0000-7000-8000-0000000005a1';
const userId = '018f0000-0000-7000-8000-0000000005b2';
const revision = 'a'.repeat(40);

/** Params exactly as they arrive when a task completes via the executor. */
function executorParams() {
  return {
    authentication: { strategy: 'jwt', accessToken: 'executor-scoped-token' },
    task_id: '018f0000-0000-7000-8000-0000000005c3',
    session_id: '018f0000-0000-7000-8000-0000000005d4',
    provider: 'socketio',
    tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
  } as never;
}

function buildService() {
  const calls: Array<{
    params: Record<string, unknown> | undefined;
    options:
      | { desiredRevision: string; requestedByUserId: string; skipIfUnavailable: boolean }
      | undefined;
  }> = [];

  const app = {
    service(path: string) {
      if (path === 'branches') {
        return {
          syncEnvironment: vi.fn(
            async (
              _id: string,
              p?: Record<string, unknown>,
              options?: {
                desiredRevision: string;
                requestedByUserId: string;
                skipIfUnavailable: boolean;
              }
            ) => {
              calls.push({ params: p, options });
              return {};
            }
          ),
        };
      }
      throw new Error(`Unexpected service: ${path}`);
    },
  } as unknown as Application;

  const service = new TasksService(createTenantScopeTestDb() as never, app);
  const run = (desiredRevision: unknown = revision, params: unknown = executorParams()) =>
    (
      service as unknown as {
        maybeAutoSyncEnvironmentAfterTask: (
          b: string,
          revision: unknown,
          userId: string,
          p?: unknown
        ) => Promise<void>;
      }
    ).maybeAutoSyncEnvironmentAfterTask(branchId, desiredRevision, userId, params);

  return { run, calls };
}

describe('TasksService auto-sync submits exact desired state internally', () => {
  it('admits only successfully completed task revisions', () => {
    expect(Object.values(TaskStatus).filter(shouldAutoSyncEnvironmentAfterTask)).toEqual([
      TaskStatus.COMPLETED,
    ]);
  });

  it('never forwards executor-scoped credentials', async () => {
    const { run, calls } = buildService();

    await run();

    expect(calls).toHaveLength(1);
    const params = calls[0]?.params;
    expect(params?.authentication).toBeUndefined();
    expect(params?.task_id).toBeUndefined();
    expect(params?.session_id).toBeUndefined();
    expect(params?.provider).toBeUndefined();
  });

  it('preserves tenant and exact revision/user attribution', async () => {
    const { run, calls } = buildService();

    await run();

    expect((calls[0]?.params?.tenant as { tenant_id?: string } | undefined)?.tenant_id).toBe(
      'tenant-a'
    );
    expect(calls[0]?.options).toEqual({
      desiredRevision: revision,
      requestedByUserId: userId,
      skipIfUnavailable: true,
    });
  });

  it.each(['a'.repeat(12), `${revision}-dirty`, 'unknown', null])(
    'refuses a non-deployable task-end revision: %s',
    async (invalid) => {
      const { run, calls } = buildService();

      await run(invalid);

      expect(calls).toHaveLength(0);
    }
  );
});
