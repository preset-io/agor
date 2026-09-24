import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { expect, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from '../src/register-routes';
import { BranchesService } from '../src/services/branches';
import { SessionsService } from '../src/services/sessions';

/** Production route registration, hooks and lifecycle services; unrelated services are inert.
 * Authentication is represented by trusted params, not a provider/browser sign-in. */
export async function retirementRouteApp(db: TenantScopeAwareDatabase, config: AgorConfig) {
  const app = feathersExpress(feathers()) as unknown as Application;
  app.configure(socketio());
  app.set('config', config);
  app.use('branches', new BranchesService(db, app));
  app.use('sessions', new SessionsService(db, app));
  for (const path of ['tasks', 'boards', 'messages', 'schedules', 'board-objects'])
    app.use(path, {
      async find() {
        return [];
      },
    });
  app.use('users', { get: (id: string) => new UsersRepository(db).findById(id) });
  app.use('repos', {
    async get() {
      throw new Error('unrelated');
    },
  });
  const stop = new Error('retirement registered');
  const use = app.use.bind(app);
  const useSpy = vi.spyOn(app, 'use').mockImplementation((...args) => {
    if (args[0] === '/branches/:id/archive-or-delete') throw stop;
    return use(...args);
  });
  try {
    await expect(
      registerRoutes({
        app,
        db,
        config,
        jwtSecret: 'disposable-test-not-a-credential',
        externalLaunchProvider: { enabled: false },
        requireAuth: (context: unknown) => context,
        enforcePasswordChange: (context: unknown) => context,
        superadminOpts: { allowSuperadmin: false },
        sessionsService: app.service('sessions'),
        sessionsRepository: new SessionRepository(db),
        branchRepository: new BranchRepository(db),
        usersRepository: new UsersRepository(db),
      } as unknown as RegisterRoutesContext)
    ).rejects.toBe(stop);
  } finally {
    useSpy.mockRestore();
  }
  return app;
}
