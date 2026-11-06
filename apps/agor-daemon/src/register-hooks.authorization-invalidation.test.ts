/**
 * Wiring guard for single-branch authorization invalidation.
 *
 * `authorizationInvalidationBranchId` is unit-tested in register-hooks.test.ts,
 * but that cannot notice the registered after-hook ceasing to forward its
 * answer. These tests run the after-hook chains `registerHooks` actually
 * installs and assert on the `realtime:authorization-invalidated` event the app
 * emits, so dropping `affectedBranchId` from the emission (which silently turns
 * every branch revocation back into a tenant-wide eviction) fails here.
 */

import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';
import { markBranchBoardChanged } from './utils/branch-board-move-invalidation';

type RegisteredHook = (context: HookContext) => unknown;

const BRANCH_ID = '018f0000-0000-7000-8000-0000000000a4';
const OTHER_BRANCH_ID = '018f0000-0000-7000-8000-0000000000b5';
// Distinct from the static tenant in config so the assertion proves the event
// carries the request's trusted tenant, not an ambient/default one.
const REQUEST_TENANT_ID = 'tenant-from-request';

type InvalidationEvent = {
  tenantId: string;
  disconnectSockets: boolean;
  affectedBranchId?: string;
  revocationScope?: string;
};

const registerAndCapture = () => {
  const after = new Map<string, Record<string, RegisteredHook[]>>();
  const emitted: InvalidationEvent[] = [];
  const app = {
    service(path: string) {
      return {
        hooks(hooks: { after?: Record<string, RegisteredHook[]> }) {
          const entry = after.get(path) ?? {};
          for (const [method, chain] of Object.entries(hooks?.after ?? {})) {
            entry[method] = [...(entry[method] ?? []), ...(chain ?? [])];
          }
          after.set(path, entry);
        },
      };
    },
    use() {},
    publish() {},
    io: { to: () => ({ emit() {} }) },
    emit: vi.fn((event: string, payload: InvalidationEvent) => {
      if (event === 'realtime:authorization-invalidated') emitted.push(payload);
      return true;
    }),
  };

  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'static-config-tenant' },
      execution: {},
    } as RegisterHooksContext['config'],
    jwtSecret: 'authorization-invalidation-test-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return { after, emitted };
};

/**
 * Run every registered after-hook for the verb, as Feathers would. Unrelated
 * hooks on the same path need services this stand-in does not provide; their
 * failures are not the subject here, only what the chain emits.
 */
const runAfterChain = async (
  after: Map<string, Record<string, RegisteredHook[]>>,
  context: Partial<HookContext> & Pick<HookContext, 'path' | 'method'>
) => {
  const chain = after.get(context.path)?.[context.method];
  if (!chain?.length) throw new Error(`${context.path}.${context.method} registers no after hooks`);
  const full = {
    params: { tenant: { tenant_id: REQUEST_TENANT_ID } },
    ...context,
  } as HookContext;
  for (const hook of chain) {
    try {
      await hook(full);
    } catch {
      // Irrelevant to the invalidation emission.
    }
  }
};

describe('registered after-hooks emit branch-scoped authorization invalidation', () => {
  it.each([
    ['board_id', { board_id: 'board-2' }],
    ['permission_binding', { permission_binding: { kind: 'board' } }],
  ])('scopes a branches patch changing %s to the patched branch', async (_field, data) => {
    const { after, emitted } = registerAndCapture();
    await runAfterChain(after, {
      path: 'branches',
      method: 'patch',
      data,
      result: { branch_id: BRANCH_ID, ...data },
      params: {
        tenant: { tenant_id: REQUEST_TENANT_ID },
        query: { affectedBranchId: OTHER_BRANCH_ID },
      },
    } as never);

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    // Branch-scoped revocation: receivers keep unrelated sockets connected.
    // disconnectSockets stays true so pre-scope replicas still evict.
    expect(emitted[0]).toEqual({
      tenantId: REQUEST_TENANT_ID,
      disconnectSockets: true,
      affectedBranchId: BRANCH_ID,
      revocationScope: 'branch',
    });
  });

  it('emits nothing for a board_id patch the service proved did not move the branch', async () => {
    const { after, emitted } = registerAndCapture();
    const params = { tenant: { tenant_id: REQUEST_TENANT_ID } };
    markBranchBoardChanged(params, false);
    await runAfterChain(after, {
      path: 'branches',
      method: 'patch',
      data: { board_id: 'board-1' },
      result: { branch_id: BRANCH_ID, board_id: 'board-1', permission_binding: 'inherit' },
      params,
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(emitted).toEqual([]);
  });

  it('only clears caches when an override-bound branch moves boards', async () => {
    const { after, emitted } = registerAndCapture();
    const params = { tenant: { tenant_id: REQUEST_TENANT_ID } };
    markBranchBoardChanged(params, true);
    await runAfterChain(after, {
      path: 'branches',
      method: 'patch',
      data: { board_id: 'board-2' },
      result: { branch_id: BRANCH_ID, board_id: 'board-2', permission_binding: 'override' },
      params,
    } as never);

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toEqual({ tenantId: REQUEST_TENANT_ID, disconnectSockets: false });
  });

  it('does not narrow a bulk branches patch (no single validated target)', async () => {
    const { after, emitted } = registerAndCapture();
    await runAfterChain(after, {
      path: 'branches',
      method: 'patch',
      data: { board_id: 'board-2' },
      result: [{ branch_id: BRANCH_ID }, { branch_id: OTHER_BRANCH_ID }],
    } as never);

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toEqual({
      tenantId: REQUEST_TENANT_ID,
      disconnectSockets: true,
    });
    expect(emitted[0]).not.toHaveProperty('affectedBranchId');
  });

  it.each([
    ['boards', { access_mode: 'private' }, { branch_id: BRANCH_ID }],
    ['users', { role: 'member' }, { branch_id: BRANCH_ID }],
  ])(
    'keeps %s revocations tenant-wide despite a branch-looking result',
    async (path, data, result) => {
      const { after, emitted } = registerAndCapture();
      await runAfterChain(after, {
        path,
        method: 'patch',
        data,
        result,
        params: {
          tenant: { tenant_id: REQUEST_TENANT_ID },
          route: { id: BRANCH_ID },
        },
      } as never);

      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      expect(emitted[0]).toEqual({ tenantId: REQUEST_TENANT_ID, disconnectSockets: true });
    }
  );
});
