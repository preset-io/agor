import type { Server } from 'node:http';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  BoardRepository,
  BranchRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  feathers,
  feathersExpress,
  rest,
} from '@agor/core/feathers';
import type { HookContext, UserID } from '@agor/core/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import { RuntimeJWTStrategy } from '../src/auth/runtime-jwt-strategy.js';
import { type RegisterHooksContext, registerHooks } from '../src/register-hooks.js';
import { createBoardsService } from '../src/services/boards.js';
import { setupCapabilityPolicyServices } from '../src/services/capability-policies.js';
import { setupBoardEffectiveAccessService } from '../src/services/groups.js';
import { createUsersService } from '../src/services/users.js';

const JWT_SECRET = 'board-metadata-disposable-test-secret';

/** Real REST/auth/hooks/repositories; only unrelated daemon services are inert. */
export async function boardMetadataTestApp(
  db: TenantScopeAwareDatabase,
  config: RegisterHooksContext['config']
) {
  const app = feathersExpress(feathers());
  app.use(express.json());
  app.configure(rest());
  (app as unknown as { publish: () => void }).publish = () => undefined;
  app.set('config', config);
  app.set('authentication', {
    secret: JWT_SECRET,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: 'https://agor.dev',
      issuer: 'agor',
      algorithm: 'HS256',
      expiresIn: '15m',
    },
  });
  for (const path of [
    'messages',
    'repos',
    'branches',
    'sessions',
    'leaderboard',
    'schedules',
    'tasks',
  ]) {
    app.use(path, {
      async find() {
        return [];
      },
    });
  }
  app.use('users', createUsersService(db, app, config));
  const authentication = new AuthenticationService(app);
  authentication.register(
    'jwt',
    new RuntimeJWTStrategy({ multiTenancy: resolveMultiTenancyConfig(config) })
  );
  app.use('authentication', authentication);
  const boardsService = createBoardsService(db);
  app.use('boards', boardsService);
  setupBoardEffectiveAccessService(app, new BoardRepository(db), { allowSuperadmin: false });
  setupCapabilityPolicyServices(app, db, { allowSuperadmin: false });
  registerHooks({
    db,
    app,
    config,
    jwtSecret: JWT_SECRET,
    requireAuth: authenticate({ strategies: ['jwt'] }) as (
      context: HookContext
    ) => Promise<HookContext>,
    superadminOpts: { allowSuperadmin: false },
    deployment: { mode: 'standalone' },
    sessionsService: app.service('sessions') as never,
    messagesService: app.service('messages') as never,
    // Match registerServices' custom-method transport declaration adapter.
    boardsService: boardsService as unknown as RegisterHooksContext['boardsService'],
    branchRepository: new BranchRepository(db),
    usersRepository: new UsersRepository(db),
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });
  app.use(errorHandler());
  const server = (await app.listen(0)) as Server;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected test TCP server');
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    headers(userId: UserID, tenantId?: string) {
      const token = jwt.sign(
        { sub: userId, type: 'access', ...(tenantId ? { tenant_id: tenantId } : {}) },
        JWT_SECRET,
        {
          issuer: 'agor',
          audience: 'https://agor.dev',
          expiresIn: '15m',
        }
      );
      return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    },
    async close() {
      await app.teardown();
    },
  };
}
