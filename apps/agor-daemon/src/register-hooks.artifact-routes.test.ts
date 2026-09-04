import type { Server } from 'node:http';
import {
  ArtifactRepository,
  BoardRepository,
  createTenantScopedDatabaseProxy,
  generateId,
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
import type { HookContext, UUID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { expect } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { RuntimeJWTStrategy } from './auth/runtime-jwt-strategy.js';
import { type RegisterHooksContext, registerHooks } from './register-hooks.js';
import {
  ARTIFACTS_SERVICE_TRANSPORT_METHODS,
  createArtifactsService,
} from './services/artifacts.js';
import { createUsersService } from './services/users.js';

const JWT_SECRET = 'artifact-custom-route-test-secret';
const STATIC_TENANT = 'artifact-custom-route-test';

const authenticationConfig = {
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
};

function accessToken(userId: UUID): string {
  return jwt.sign({ sub: userId, type: 'access' }, JWT_SECRET, {
    issuer: 'agor',
    audience: 'https://agor.dev',
    expiresIn: '15m',
  });
}

const inertService = {
  async find() {
    return [];
  },
  async get() {
    return null;
  },
  async create(data: unknown) {
    return data;
  },
  async update(_id: unknown, data: unknown) {
    return data;
  },
  async patch(_id: unknown, data: unknown) {
    return data;
  },
  async remove() {
    return null;
  },
};

dbTest(
  'authenticated artifact payload and console routes enter the guarded SQLite tenant scope',
  async ({ db: rawDb }) => {
    const ownerId = generateId() as UUID;
    const viewerId = generateId() as UUID;
    const memberId = generateId() as UUID;
    const users = new UsersRepository(rawDb);
    await users.create({
      user_id: ownerId,
      email: 'artifact-owner@example.test',
      role: ROLES.MEMBER,
    });
    await users.create({
      user_id: viewerId,
      email: 'artifact-viewer@example.test',
      role: ROLES.VIEWER,
    });
    await users.create({
      user_id: memberId,
      email: 'artifact-member@example.test',
      role: ROLES.MEMBER,
    });
    const board = await new BoardRepository(rawDb).create({
      name: 'Artifact custom route test board',
      created_by: ownerId,
    });
    const artifact = await new ArtifactRepository(rawDb).create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'Guarded custom route artifact',
      template: 'static',
      files: { '/index.html': '<h1>Scoped artifact payload</h1>' },
      content_hash: 'guarded-custom-route-hash',
      public: true,
      created_by: ownerId,
    });

    // Production wraps the daemon handle with this guard. It is armed for
    // SQLite too, so an unscoped custom-route repository access fails exactly
    // as it did after #2662.
    const db = createTenantScopedDatabaseProxy(rawDb, {
      label: 'artifact custom route test database',
    });
    const config = {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: STATIC_TENANT },
      execution: { branch_rbac: false },
    } as RegisterHooksContext['config'];
    const app = feathersExpress(feathers());
    app.use(feathersExpress.json());
    app.configure(rest());
    (app as unknown as { publish: () => void }).publish = () => undefined;
    app.set('config', config);
    app.set('authentication', authenticationConfig);

    // registerHooks expects the ordinary daemon services to exist. Only users
    // and artifacts participate in this focused request; the rest are inert.
    for (const path of [
      'messages',
      'repos',
      'branches',
      'sessions',
      'leaderboard',
      'schedules',
      'tasks',
    ]) {
      app.use(`/${path}`, inertService);
    }
    app.use('/users', createUsersService(db, app, config));
    const authentication = new AuthenticationService(app);
    authentication.register('jwt', new RuntimeJWTStrategy());
    app.use('/authentication', authentication);
    app.use('/artifacts', createArtifactsService(db, app), {
      methods: [...ARTIFACTS_SERVICE_TRANSPORT_METHODS],
    });

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
      boardsService: undefined,
      branchRepository: { findById: async () => null } as never,
      usersRepository: users,
      sessionsRepository: {} as never,
    });
    app.use(errorHandler());

    const server = (await app.listen(0)) as Server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authHeaders = (userId: UUID) => ({
      authorization: `Bearer ${accessToken(userId)}`,
    });

    try {
      const unauthenticated = await fetch(`${baseUrl}/artifacts/${artifact.artifact_id}/payload`);
      expect(unauthenticated.status).toBe(401);

      // Viewer remains sufficient for a public payload and the repository read
      // succeeds through the armed guard only because the custom route is scoped.
      const payload = await fetch(`${baseUrl}/artifacts/${artifact.artifact_id}/payload`, {
        headers: authHeaders(viewerId),
      });
      expect(payload.status, await payload.clone().text()).toBe(200);
      await expect(payload.json()).resolves.toMatchObject({
        artifact_id: artifact.artifact_id,
        files: { '/index.html': '<h1>Scoped artifact payload</h1>' },
      });

      // The same shared registrar scopes custom writes without changing their
      // role floor: viewers remain forbidden, while members can append logs.
      const viewerWrite = await fetch(`${baseUrl}/artifacts/${artifact.artifact_id}/console`, {
        method: 'POST',
        headers: { ...authHeaders(viewerId), 'content-type': 'application/json' },
        body: JSON.stringify({ entries: [] }),
      });
      expect(viewerWrite.status).toBe(403);

      const memberWrite = await fetch(`${baseUrl}/artifacts/${artifact.artifact_id}/console`, {
        method: 'POST',
        headers: { ...authHeaders(memberId), 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: [{ timestamp: 1, level: 'log', message: 'scoped console write' }],
        }),
      });
      expect(memberWrite.status, await memberWrite.clone().text()).toBe(201);
      await expect(memberWrite.json()).resolves.toEqual({ success: true });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
);
