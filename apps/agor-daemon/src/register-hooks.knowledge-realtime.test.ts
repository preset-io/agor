import type { BranchRepository, SessionRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { feathers, socketio } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type RegisterHooksContext,
  registerHooks,
  suppressKnowledgeCommandRealtimeEvent,
} from './register-hooks';
import { emitServiceEvent } from './utils/emit-service-event';
import { KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS } from './utils/knowledge-realtime-publish';
import { configureRealtimePublish } from './utils/realtime-publish';

describe('Knowledge command realtime suppression', () => {
  it('registers the suppression after-hook on the exact command services', () => {
    const registered = new Map<string, Array<{ after?: { create?: unknown[] } }>>();
    const app = {
      service(path: string) {
        return {
          hooks(hooks: { after?: { create?: unknown[] } }) {
            if ((KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS as readonly string[]).includes(path)) {
              registered.set(path, [...(registered.get(path) ?? []), hooks]);
            }
          },
        };
      },
      use() {},
      publish() {},
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    expect([...registered.keys()].sort()).toEqual(
      [...KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS].sort()
    );
    for (const hookRegistrations of registered.values()) {
      expect(
        hookRegistrations.some(({ after }) =>
          after?.create?.includes(suppressKnowledgeCommandRealtimeEvent)
        )
      ).toBe(true);
    }
  });

  it.each(KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS)(
    'preserves the %s response without a local event or Redis relay',
    async (path) => {
      const app = feathers() as Application;
      app.configure(socketio());
      const relay = { relay: vi.fn(), setRelayHandler: vi.fn() };
      configureRealtimePublish({
        app,
        branchRepository: {} as BranchRepository,
        sessionsRepository: {} as SessionRepository,
        multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
        realtimeRelay: relay,
      });

      app.use(
        'kb/documents',
        {
          async get() {
            return { document_id: 'document-1' };
          },
        },
        { methods: ['get'] }
      );
      app.use(
        path,
        {
          async create() {
            if (path === 'kb/document-edits') {
              emitServiceEvent(app, {
                path: 'kb/documents',
                event: 'patched',
                data: { document_id: 'document-1', title: 'Updated' },
              });
            }
            return { path, callerOnly: 'preserved' };
          },
        },
        { methods: ['create'] }
      );
      app.service(path).hooks({
        after: { create: [suppressKnowledgeCommandRealtimeEvent] },
      });

      const commandEvent = vi.fn();
      const documentEvent = vi.fn();
      app.service(path).on('created', commandEvent);
      app.service('kb/documents').on('patched', documentEvent);
      await app.setup();
      try {
        await expect(app.service(path).create({})).resolves.toEqual({
          path,
          callerOnly: 'preserved',
        });
        expect(commandEvent).not.toHaveBeenCalled();
        expect(relay.relay).not.toHaveBeenCalledWith(expect.objectContaining({ path }));

        if (path === 'kb/document-edits') {
          expect(documentEvent).toHaveBeenCalledOnce();
          await vi.waitFor(() =>
            expect(relay.relay).toHaveBeenCalledWith(
              expect.objectContaining({ path: 'kb/documents', event: 'patched' })
            )
          );
        }
      } finally {
        await app.teardown();
      }
    }
  );

  it('sets context.event to null without changing the result', () => {
    const result = { callerOnly: true };
    const context = { event: 'created', result } as HookContext;

    expect(suppressKnowledgeCommandRealtimeEvent(context)).toBe(context);
    expect(context.event).toBeNull();
    expect(context.result).toBe(result);
  });
});

describe('Knowledge document query validation', () => {
  it('validates and coerces kb/documents queries before the service pages them', async () => {
    const registered: Parameters<ReturnType<Application['service']>['hooks']>[0][] = [];
    const registrationApp = {
      service(path: string) {
        return {
          hooks(hooks: (typeof registered)[number]) {
            if (path === 'kb/documents') registered.push(hooks);
          },
        };
      },
      use() {},
      publish() {},
    };
    registerHooks({
      // The tenant-scope hook wraps each call in a transaction; run it inline.
      db: {
        transaction: async (callback: (scoped: unknown) => Promise<unknown>) =>
          callback({ execute: vi.fn().mockResolvedValue([]) }),
      } as unknown as RegisterHooksContext['db'],
      app: registrationApp as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });
    expect(registered.length).toBeGreaterThan(0);

    const app = feathers() as Application;
    const find = vi.fn(async (params: { query?: unknown }) => params.query);
    app.use('kb/documents', { find }, { methods: ['find'] });
    for (const hooks of registered) app.service('kb/documents').hooks(hooks);

    await expect(
      app.service('kb/documents').find({
        provider: 'rest',
        query: { $limit: '25', $skip: '50', $sort: { updated_at: '-1', content_text: '1' } },
      })
    ).resolves.toEqual({ $limit: 25, $skip: 50, $sort: { updated_at: -1 } });

    for (const query of [{ $limit: '-1' }, { $limit: 'all' }, { $skip: '1.5' }]) {
      await expect(app.service('kb/documents').find({ provider: 'rest', query })).rejects.toThrow();
    }
    expect(find).toHaveBeenCalledTimes(1);
  });
});
