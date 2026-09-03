import type { BranchRepository } from '@agor/core/db';
import type { Branch, HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { BRANCH_FILESYSTEM_STATUS_EXECUTOR_COMMAND_ID } from './auth/executor-command-ids.js';
import { type RegisterHooksContext, registerHooks } from './register-hooks';

type RegisteredHook = (context: HookContext) => unknown;

interface Harness {
  chains: Map<string, RegisteredHook[]>;
  branchLookups: ReturnType<typeof vi.fn>;
}

function makeBranch(branchId: string): Branch {
  return {
    branch_id: branchId as Branch['branch_id'],
    repo_id: 'repo-a' as Branch['repo_id'],
    name: 'branch-a',
    branch: 'branch-a',
    path: '/fixture/branch-a',
    others_can: 'view',
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as Branch;
}

function buildHarness(branchRbac: boolean): Harness {
  const chains = new Map<string, RegisteredHook[]>();
  const branchLookups = vi.fn(async (branchId: string) => makeBranch(branchId));
  const app = {
    service(path: string) {
      return {
        on() {},
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          const key = path.replace(/^\//, '');
          for (const [method, chain] of Object.entries(hooks.before ?? {})) {
            const mapKey = `${key}.${method}`;
            chains.set(mapKey, [...(chains.get(mapKey) ?? []), ...(chain ?? [])]);
          }
        },
      };
    },
    use() {},
    publish() {},
  };
  const branchRepository = {
    findById: branchLookups,
    isOwner: vi.fn().mockResolvedValue(false),
    resolveUserPermission: vi.fn().mockResolvedValue('view'),
  } as unknown as BranchRepository;

  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'executor-branch-read-test' },
      execution: { branch_rbac: branchRbac },
    } as RegisterHooksContext['config'],
    jwtSecret: 'executor-branch-read-test-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository,
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return { chains, branchLookups };
}

async function runBranchGet(harness: Harness, context: HookContext): Promise<HookContext> {
  const chain = harness.chains.get('branches.get');
  if (!chain?.length) throw new Error('no registered branches.get hooks');
  let current = context;
  for (const hook of chain) {
    current = ((await hook(current)) as HookContext | undefined) ?? current;
  }
  return current;
}

function executorContext(
  branchId: string | undefined,
  commandId = 'branch.filesystem.status'
): HookContext {
  return {
    path: 'branches',
    method: 'get',
    id: 'branch-b',
    params: {
      provider: 'socketio',
      user: { user_id: 'executor-service', role: 'service', _isServiceAccount: true },
      query: {},
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-command',
          session_id: commandId,
          ...(branchId ? { branch_id: branchId } : {}),
        },
      },
    },
  } as unknown as HookContext;
}

function taskExecutorContext(branchId: string): HookContext {
  const context = executorContext(branchId);
  const params = context.params as HookContext['params'] & {
    authentication: { payload: Record<string, unknown> };
  };
  params.authentication.payload = {
    ...params.authentication.payload,
    purpose: 'executor-task',
    task_id: 'task-a',
  };
  return context;
}

describe.each([false, true])('registered branches.get executor guard (RBAC=%s)', (branchRbac) => {
  it('rejects an A-token/B-request before repository lookup', async () => {
    const harness = buildHarness(branchRbac);

    await expect(runBranchGet(harness, executorContext('branch-a'))).rejects.toThrow(
      'scoped to another Branch'
    );
    expect(harness.branchLookups).not.toHaveBeenCalled();
  });

  it('keeps exact branch access and the cleanup-only branchless capability', async () => {
    const harness = buildHarness(branchRbac);

    await expect(
      runBranchGet(harness, { ...executorContext('branch-a'), id: 'branch-a' })
    ).resolves.toBeDefined();
    expect(harness.branchLookups).not.toHaveBeenCalled();

    await expect(
      runBranchGet(harness, { ...taskExecutorContext('branch-a'), id: 'branch-b' })
    ).rejects.toThrow('not authorized to read this Branch');
    expect(harness.branchLookups).not.toHaveBeenCalled();

    await expect(
      runBranchGet(harness, executorContext(undefined, 'unregistered-branch-read'))
    ).rejects.toThrow('not authorized to read this Branch');
    expect(harness.branchLookups).not.toHaveBeenCalled();

    await expect(
      runBranchGet(
        harness,
        executorContext(undefined, BRANCH_FILESYSTEM_STATUS_EXECUTOR_COMMAND_ID)
      )
    ).resolves.toBeDefined();
    expect(harness.branchLookups).not.toHaveBeenCalled();
  });
});

describe('registered branches.get ordinary access', () => {
  it.each([false, true])(
    'preserves an ordinary authenticated user (RBAC=%s)',
    async (branchRbac) => {
      const harness = buildHarness(branchRbac);
      const context = {
        path: 'branches',
        method: 'get',
        id: 'branch-a',
        params: {
          provider: 'rest',
          user: { user_id: 'user-a', role: 'member' },
          query: {},
        },
      } as unknown as HookContext;

      await expect(runBranchGet(harness, context)).resolves.toBeDefined();
      if (branchRbac) expect(harness.branchLookups).toHaveBeenCalledWith('branch-a');
      else expect(harness.branchLookups).not.toHaveBeenCalled();
    }
  );
});
