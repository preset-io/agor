import type { Application } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

/** Matches the stub used by the sibling service tests — auto-sync never touches the DB. */
function createTenantScopeTestDb() {
  return { run: vi.fn() };
}

/**
 * Guards for the task-completion auto-sync (`maybeAutoSyncEnvironmentAfterTask`).
 *
 * This path regressed once in production. A task that completes via the executor
 * carries an executor-scoped JWT that is (correctly) NOT valid for the
 * branch/repo/sync endpoints. The first fix only cleaned the params passed to
 * `syncEnvironment`, leaving `branches.get` and `repos.get` still forwarding the
 * executor token — so auto-sync failed with:
 *
 *   "Executor token is not valid for this endpoint"
 *
 * Executor scope is detected from `params.authentication` + `params.task_id`
 * (see auth/executor-runtime-scope.ts), so the contract these tests enforce is:
 * EVERY service call made by auto-sync must use freshly-built internal params
 * carrying only the tenant — never the completing caller's params.
 */

const branchId = '018f0000-0000-7000-8000-0000000005a1';
const repoId = '018f0000-0000-7000-8000-0000000005b2';

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

function buildService(opts: { status?: string; noSync?: boolean } = {}) {
  const calls: Array<{ call: string; params: Record<string, unknown> | undefined }> = [];

  const app = {
    service(path: string) {
      if (path === 'branches') {
        return {
          get: vi.fn(async (_id: string, p?: Record<string, unknown>) => {
            calls.push({ call: 'branches.get', params: p });
            return {
              repo_id: repoId,
              environment_variant: 'codespaces',
              environment_instance: { status: opts.status ?? 'running' },
            };
          }),
          syncEnvironment: vi.fn(async (_id: string, p?: Record<string, unknown>) => {
            calls.push({ call: 'syncEnvironment', params: p });
            return {};
          }),
        };
      }
      if (path === 'repos') {
        return {
          get: vi.fn(async (_id: string, p?: Record<string, unknown>) => {
            calls.push({ call: 'repos.get', params: p });
            return {
              environment: {
                default: 'local',
                variants: {
                  codespaces: opts.noSync ? {} : { sync: 'scripts/agor-codespace.sh sync' },
                },
              },
            };
          }),
        };
      }
      throw new Error(`Unexpected service: ${path}`);
    },
  } as unknown as Application;

  const service = new TasksService(createTenantScopeTestDb() as never, app);
  // Private by design; the regression lives inside it, so it is exercised directly.
  const run = (params?: unknown) =>
    (
      service as unknown as {
        maybeAutoSyncEnvironmentAfterTask: (b: string, p?: unknown) => Promise<void>;
      }
    ).maybeAutoSyncEnvironmentAfterTask(branchId, params);

  return { run, calls };
}

describe('TasksService auto-sync runs as a trusted internal operation', () => {
  it('never forwards executor-scoped credentials to branches, repos or sync', async () => {
    const { run, calls } = buildService();

    await run(executorParams());

    // All three calls must happen — this is the full path that regressed.
    expect(calls.map((c) => c.call)).toEqual(['branches.get', 'repos.get', 'syncEnvironment']);

    for (const { call, params } of calls) {
      // The executor markers. Their presence is what made the endpoint reject us.
      expect(params?.authentication, `${call} leaked authentication`).toBeUndefined();
      expect(params?.task_id, `${call} leaked task_id`).toBeUndefined();
      expect(params?.session_id, `${call} leaked session_id`).toBeUndefined();
      // `provider` marks an external transport call rather than a trusted server one.
      expect(params?.provider, `${call} leaked provider`).toBeUndefined();
    }
  });

  it('preserves tenant context on every call (no cross-tenant leakage)', async () => {
    const { run, calls } = buildService();

    await run(executorParams());

    for (const { call, params } of calls) {
      expect((params?.tenant as { tenant_id?: string } | undefined)?.tenant_id, call).toBe(
        'tenant-a'
      );
    }
  });

  it('does not sync a branch whose environment is not running', async () => {
    const { run, calls } = buildService({ status: 'starting' });

    await run(executorParams());

    expect(calls.map((c) => c.call)).toEqual(['branches.get']);
  });

  it('does not sync when the variant defines no sync command', async () => {
    const { run, calls } = buildService({ noSync: true });

    await run(executorParams());

    expect(calls.some((c) => c.call === 'syncEnvironment')).toBe(false);
  });
});
