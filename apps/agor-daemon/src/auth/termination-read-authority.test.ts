import { Forbidden, feathers } from '@agor/core/feathers';
import type { HookContext, Params } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { createTenantRestrictedAuthHook } from './require-auth.js';
import {
  hasTerminationReadAuthority,
  readTerminationEntity,
} from './termination-read-authority.js';

describe('termination read authority through real Feathers hooks', () => {
  it('permits only the scoped in-process read and retires the capability after return', async () => {
    const app = feathers();
    let retained: Params | undefined;
    const hook = createTenantRestrictedAuthHook(
      async (ctx) => ctx,
      { mode: 'static', static_tenant_id: 'tenant-a' as never },
      async (_tenant, ctx) => {
        if (!hasTerminationReadAuthority(ctx)) throw new Forbidden('restricted');
      }
    );
    app.use('tasks', {
      async get(id: string, params: Params) {
        retained = params;
        const context = { path: 'tasks', method: 'get', id, params } as HookContext;
        expect(hasTerminationReadAuthority(context)).toBe(true);
        expect(hasTerminationReadAuthority({ ...context, id: 'task-b' })).toBe(false);
        expect(hasTerminationReadAuthority({ ...context, method: 'patch' })).toBe(false);
        expect(hasTerminationReadAuthority({ ...context, path: 'sessions' })).toBe(false);
        expect(
          hasTerminationReadAuthority({ ...context, params: { ...params, provider: 'rest' } })
        ).toBe(false);
        expect(
          hasTerminationReadAuthority({
            ...context,
            params: { ...params, tenant: { tenant_id: 'tenant-b' } },
          } as HookContext)
        ).toBe(false);
        return { task_id: id };
      },
    });
    app.service('tasks').hooks({ before: { all: [hook as never] } });
    const params = { tenant: { tenant_id: 'tenant-a' }, user: { user_id: 'user-a' } } as Params;
    await expect(
      app.service('tasks').get('task-a', { ...params, bypassRestriction: true })
    ).rejects.toMatchObject({ code: 403 });
    await expect(readTerminationEntity(app, 'tasks', 'task-a', params, 'task-a')).resolves.toEqual({
      task_id: 'task-a',
    });
    await expect(app.service('tasks').get('task-a', retained)).rejects.toMatchObject({ code: 403 });
    await expect(readTerminationEntity(app, 'tasks', 'task-b', params, 'task-a')).rejects.toThrow(
      'Invalid termination read target'
    );
  });
});
