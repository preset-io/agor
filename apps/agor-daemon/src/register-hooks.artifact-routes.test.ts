import type { Server } from 'node:http';
import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
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
import type { BranchID, HookContext, UUID } from '@agor/core/types';
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
    const adminId = generateId() as UUID;
    await users.create({
      user_id: adminId,
      email: 'artifact-admin@example.test',
      role: ROLES.ADMIN,
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
      required_env_vars: ['ARTIFACT_ROUTE_TEST_SECRET'],
      public: true,
      created_by: ownerId,
    });

    const privateArtifact = await new ArtifactRepository(rawDb).create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'Owner-only artifact',
      template: 'static',
      files: { '/index.html': '<h1>private</h1>' },
      public: false,
      created_by: ownerId,
    });

    const repo = await new RepoRepository(rawDb).create({
      repo_id: generateId() as UUID,
      slug: `artifact-route-${generateId()}`,
      name: 'Artifact route repo',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/artifact-route-repo',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(rawDb).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'artifact-route-branch',
      ref: 'refs/heads/artifact-route-branch',
      branch_unique_id: 1,
      path: '/tmp/artifact-route-repo/branch',
      created_by: ownerId,
    });
    const branchArtifact = (isPublic: boolean) =>
      new ArtifactRepository(rawDb).create({
        artifact_id: generateId(),
        board_id: board.board_id,
        branch_id: branch.branch_id,
        name: isPublic ? 'Public branch artifact' : 'Private branch artifact',
        template: 'static',
        files: { '/index.html': '<h1>branch</h1>' },
        public: isPublic,
        created_by: ownerId,
      });
    const publicOnBranch = await branchArtifact(true);
    const privateOnBranch = await branchArtifact(false);

    // Production wraps the daemon handle with this guard. It is armed for
    // SQLite too, so an unscoped custom-route repository access fails exactly
    // as it did after #2662.
    const db = createTenantScopedDatabaseProxy(rawDb, {
      label: 'artifact custom route test database',
    });
    const config = {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: STATIC_TENANT },
      execution: {},
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
      // Everyone can view the seeded branch; only the private rule hides rows.
      branchRepository: {
        findById: async (id: string) => (id === branch.branch_id ? branch : null),
        isOwner: async (_id: string, userId: string) => userId === ownerId,
        resolveUserPermission: async () => 'view',
      } as never,
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

      // Exercise both persisted trust write routes through the real REST
      // boundary. The service's trust repository uses the guarded database,
      // so create and revoke would fail if either custom route lost its tenant
      // database scope.
      const trust = await fetch(`${baseUrl}/artifacts/${artifact.artifact_id}/trust`, {
        method: 'POST',
        headers: { ...authHeaders(memberId), 'content-type': 'application/json' },
        body: JSON.stringify({ scopeType: 'artifact' }),
      });
      expect(trust.status, await trust.clone().text()).toBe(201);
      await expect(trust.json()).resolves.toEqual({ scope: 'artifact', persisted: true });

      const grants = await fetch(`${baseUrl}/me/artifact-trust-grants`, {
        headers: authHeaders(memberId),
      });
      expect(grants.status, await grants.clone().text()).toBe(200);
      const grantList = (await grants.json()) as Array<{ grant_id: string; scope_value: string }>;
      expect(grantList).toEqual([
        expect.objectContaining({
          grant_id: expect.any(String),
          scope_value: artifact.artifact_id,
        }),
      ]);

      const revoke = await fetch(`${baseUrl}/me/artifact-trust-grants/${grantList[0]?.grant_id}`, {
        method: 'DELETE',
        headers: authHeaders(memberId),
      });
      expect(revoke.status, await revoke.clone().text()).toBe(200);
      await expect(revoke.json()).resolves.toMatchObject({
        revoked: true,
        grantId: grantList[0]?.grant_id,
      });

      // get, patch and remove apply the private rule with no role bypass,
      // matching the payload route, so a write can never act as a read.
      const call = (artifactId: string, userId: UUID, method = 'GET', body?: unknown) =>
        fetch(`${baseUrl}/artifacts/${artifactId}`, {
          method,
          headers: { ...authHeaders(userId), 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      expect((await call(privateArtifact.artifact_id, ownerId)).status).toBe(200);
      expect((await call(privateArtifact.artifact_id, memberId)).status).toBe(404);
      expect((await call(privateArtifact.artifact_id, adminId)).status).toBe(404);
      expect((await call(privateOnBranch.artifact_id, adminId)).status).toBe(404);
      expect((await call(privateOnBranch.artifact_id, adminId, 'PATCH', {})).status).toBe(404);
      expect((await call(privateOnBranch.artifact_id, adminId, 'DELETE')).status).toBe(404);

      // Owner-or-admin writes still work on artifacts the caller can see.
      const adminPatch = await call(publicOnBranch.artifact_id, adminId, 'PATCH', {
        name: 'Renamed by admin',
      });
      expect(adminPatch.status, await adminPatch.clone().text()).toBe(200);
      const ownerPatch = await call(privateOnBranch.artifact_id, ownerId, 'PATCH', {
        name: 'Renamed by owner',
      });
      expect(ownerPatch.status, await ownerPatch.clone().text()).toBe(200);
      await expect(ownerPatch.json()).resolves.toMatchObject({ name: 'Renamed by owner' });

      const afterRevoke = await fetch(`${baseUrl}/me/artifact-trust-grants`, {
        headers: authHeaders(memberId),
      });
      expect(afterRevoke.status, await afterRevoke.clone().text()).toBe(200);
      await expect(afterRevoke.json()).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
);
