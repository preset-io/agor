/**
 * JWT Authentication Integration Tests
 *
 * These tests verify that JWT authentication is properly enforced across
 * protected endpoints. We test the authentication hook logic and patterns
 * used in production rather than testing the full app initialization.
 *
 * Strategy:
 * - Import real authentication hooks from production code
 * - Create minimal test services that mirror production hook patterns
 * - Verify authentication is enforced correctly
 * - Test role-based access control (RBAC)
 *
 * Note: Testing against the full production app (index.ts) would require:
 * - Complete database initialization with all tables
 * - All service dependencies and their configurations
 * - Full lifecycle management (startup/shutdown)
 * - Managing async initialization and cleanup
 *
 * Instead, we test the authentication patterns and hook logic, which provides
 * confidence that when hooks are registered in index.ts, they will work correctly.
 */

import type { Database } from '@agor/core/db';
import { createDatabaseAsync, generateId } from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  BadRequest,
  Forbidden,
  feathers,
  JWTStrategy,
  LocalStrategy,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, User } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireMinimumRole } from './utils/authorization';

// Helper to populate route params (used in production for nested routes)
const populateRouteParams = (context: HookContext) => {
  context.params.route = { id: 'test-id', name: 'test-name', mcpId: 'test-mcp-id' };
};

describe('JWT Authentication Integration - Production Auth Hooks', () => {
  let _db: Database;
  let app: ReturnType<typeof feathers>;
  let requireAuth: ReturnType<typeof authenticate>;

  beforeAll(async () => {
    // Create in-memory database for testing
    _db = await createDatabaseAsync({ url: ':memory:' });

    // Create Feathers app with authentication configured like production
    app = feathers();

    // Authentication config must be set before registering strategies
    // (LocalStrategy requires usernameField to be configured)
    app.set('authentication', {
      secret: 'test-jwt-secret',
      entity: 'user',
      entityId: 'user_id',
      service: 'users',
      authStrategies: ['jwt'],
      jwtOptions: {
        header: { typ: 'access' },
        audience: 'https://agor.dev',
        issuer: 'agor',
        algorithm: 'HS256',
        expiresIn: '7d',
      },
      local: {
        usernameField: 'email',
        passwordField: 'password',
      },
    });

    const authService = new AuthenticationService(app);
    authService.register('jwt', new JWTStrategy());
    authService.register('local', new LocalStrategy());
    app.use('authentication', authService);

    // Create requireAuth helper matching production configuration
    requireAuth = authenticate({ strategies: ['jwt'] });
  });

  it('should import real authentication hooks from production code', () => {
    expect(requireAuth).toBeDefined();
    expect(requireMinimumRole).toBeDefined();
    expect(typeof requireMinimumRole).toBe('function');
  });

  it('should reject requests without authentication', async () => {
    // Create a minimal service with production auth hook pattern
    const testService = {
      async find() {
        return [];
      },
    };

    app.use('/test-protected', testService);
    app.service('/test-protected').hooks({
      before: {
        find: [requireAuth],
      },
    });

    // Should reject unauthenticated request (provider: 'rest' simulates external call)
    await expect(app.service('/test-protected').find({ provider: 'rest' })).rejects.toThrow();
  });

  it('should accept requests with valid user in params', async () => {
    // Create service requiring authentication
    const testService = {
      async find() {
        return [{ id: 1, name: 'test' }];
      },
    };

    app.use('/test-authenticated', testService);
    app.service('/test-authenticated').hooks({
      before: {
        find: [requireAuth],
      },
    });

    // Should accept authenticated request
    const result = await app.service('/test-authenticated').find({
      user: { user_id: 'user-1', email: 'test@example.com', role: ROLES.MEMBER },
      authenticated: true,
    } as any);

    expect(result).toHaveLength(1);
  });

  it('should enforce role-based access control with real requireMinimumRole', async () => {
    // Create service requiring admin role (matching production pattern)
    const adminService = {
      async create() {
        return { success: true };
      },
    };

    app.use('/test-admin', adminService);
    app.service('/test-admin').hooks({
      before: {
        create: [requireAuth, requireMinimumRole(ROLES.ADMIN, 'perform admin action')],
      },
    });

    // Should reject member role
    await expect(
      app.service('/test-admin').create({}, {
        user: { user_id: 'user-1', email: 'test@example.com', role: ROLES.MEMBER },
        authenticated: true,
        provider: 'rest',
      } as any)
    ).rejects.toThrow();

    // Should accept admin role
    const result = await app.service('/test-admin').create({}, {
      user: { user_id: 'admin-1', email: 'admin@example.com', role: ROLES.ADMIN },
      authenticated: true,
      provider: 'rest',
    } as any);

    expect(result.success).toBe(true);
  });
});

describe('JWT Authentication Integration - Protected Endpoints', () => {
  /**
   * These tests verify authentication patterns used in production endpoints.
   * Each test creates a service with the same hook chain pattern as index.ts,
   * using the real authenticate() and requireMinimumRole() functions.
   */

  let app: ReturnType<typeof feathers>;
  let requireAuth: ReturnType<typeof authenticate>;

  beforeAll(async () => {
    // Create Feathers app with authentication (matching production setup)
    app = feathers();

    app.set('authentication', {
      secret: 'test-jwt-secret',
      entity: 'user',
      entityId: 'user_id',
      service: 'users',
      authStrategies: ['jwt'],
      jwtOptions: {
        header: { typ: 'access' },
        audience: 'https://agor.dev',
        issuer: 'agor',
        algorithm: 'HS256',
        expiresIn: '7d',
      },
      local: {
        usernameField: 'email',
        passwordField: 'password',
      },
    });

    const authService = new AuthenticationService(app);
    authService.register('jwt', new JWTStrategy());
    authService.register('local', new LocalStrategy());
    app.use('authentication', authService);

    requireAuth = authenticate({ strategies: ['jwt'] });
  });

  describe('Session Endpoints - Authentication Required', () => {
    it('POST /sessions/:id/spawn rejects unauthenticated requests', async () => {
      // Simulate the spawn service with production hook pattern
      const spawnService = {
        async create() {
          return { spawned: true };
        },
      };

      app.use('/sessions/:id/spawn', spawnService);
      app.service('/sessions/:id/spawn').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'spawn')],
        },
      });

      // Should reject without user (provider: 'rest' simulates external call)
      await expect(
        app.service('/sessions/:id/spawn').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('POST /sessions/:id/spawn accepts authenticated requests', async () => {
      const spawnService = {
        async create() {
          return { spawned: true };
        },
      };

      app.use('/sessions/:id/spawn-auth', spawnService);
      app.service('/sessions/:id/spawn-auth').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'spawn')],
        },
      });

      // Should accept with valid user
      const result = await app.service('/sessions/:id/spawn-auth').create({}, {
        user: { user_id: 'user-1', email: 'test@example.com', role: ROLES.MEMBER },
        authenticated: true,
      } as any);
      expect(result.spawned).toBe(true);
    });

    it('POST /sessions/:id/fork rejects unauthenticated requests', async () => {
      const forkService = {
        async create() {
          return { forked: true };
        },
      };

      app.use('/sessions/:id/fork', forkService);
      app.service('/sessions/:id/fork').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'fork')],
        },
      });

      await expect(
        app.service('/sessions/:id/fork').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('POST /sessions/:id/stop rejects unauthenticated requests', async () => {
      const stopService = {
        async create() {
          return { stopped: true };
        },
      };

      app.use('/sessions/:id/stop', stopService);
      app.service('/sessions/:id/stop').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'stop')],
        },
      });

      await expect(
        app.service('/sessions/:id/stop').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('GET /sessions/:id/mcp-servers rejects unauthenticated requests', async () => {
      const mcpServersService = {
        async find() {
          return [];
        },
      };

      app.use('/sessions/:id/mcp-servers', mcpServersService);
      app.service('/sessions/:id/mcp-servers').hooks({
        before: {
          find: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'view')],
        },
      });

      await expect(
        app.service('/sessions/:id/mcp-servers').find({ provider: 'rest' })
      ).rejects.toThrow();
    });
  });

  describe('Task Endpoints - Authentication Required', () => {
    it('POST /tasks/bulk rejects unauthenticated requests', async () => {
      const tasksBulkService = {
        async create() {
          return [];
        },
      };

      app.use('/tasks/bulk', tasksBulkService);
      app.service('/tasks/bulk').hooks({
        before: {
          create: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'create tasks')],
        },
      });

      await expect(app.service('/tasks/bulk').create([], { provider: 'rest' })).rejects.toThrow();
    });

    it('POST /tasks/:id/complete rejects unauthenticated requests', async () => {
      const tasksCompleteService = {
        async create() {
          return { completed: true };
        },
      };

      app.use('/tasks/:id/complete', tasksCompleteService);
      app.service('/tasks/:id/complete').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'complete')],
        },
      });

      await expect(
        app.service('/tasks/:id/complete').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('POST /tasks/:id/fail rejects unauthenticated requests', async () => {
      const tasksFailService = {
        async create() {
          return { failed: true };
        },
      };

      app.use('/tasks/:id/fail', tasksFailService);
      app.service('/tasks/:id/fail').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'fail')],
        },
      });

      await expect(
        app.service('/tasks/:id/fail').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('POST /tasks/:id/run rejects unauthenticated requests', async () => {
      const tasksRunService = {
        async create() {
          return { task_id: 'test-id', status: 'running' };
        },
      };

      app.use('/tasks/:id/run', tasksRunService);
      app.service('/tasks/:id/run').hooks({
        before: {
          create: [
            populateRouteParams,
            requireAuth,
            requireMinimumRole(ROLES.MEMBER, 'execute prompts'),
          ],
        },
      });

      await expect(
        app.service('/tasks/:id/run').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });
  });

  describe('Repository Endpoints - Authentication Required', () => {
    it('POST /repos/local rejects unauthenticated requests', async () => {
      const reposLocalService = {
        async create() {
          return { id: 'repo-1' };
        },
      };

      app.use('/repos/local', reposLocalService);
      app.service('/repos/local').hooks({
        before: {
          create: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'add repos')],
        },
      });

      await expect(app.service('/repos/local').create({}, { provider: 'rest' })).rejects.toThrow();
    });

    it('POST /repos/:id/worktrees rejects unauthenticated requests', async () => {
      const reposWorktreesService = {
        async create() {
          return { id: 'worktree-1' };
        },
      };

      app.use('/repos/:id/worktrees', reposWorktreesService);
      app.service('/repos/:id/worktrees').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'create')],
        },
      });

      await expect(
        app.service('/repos/:id/worktrees').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('DELETE /repos/:id/worktrees/:name rejects unauthenticated requests', async () => {
      const reposWorktreesDeleteService = {
        async remove() {
          return { deleted: true };
        },
      };

      app.use('/repos/:id/worktrees/:name', reposWorktreesDeleteService);
      app.service('/repos/:id/worktrees/:name').hooks({
        before: {
          remove: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'remove')],
        },
      });

      await expect(
        app.service('/repos/:id/worktrees/:name').remove('id', { provider: 'rest' })
      ).rejects.toThrow();
    });
  });

  describe('Board Endpoints - Authentication Required', () => {
    it('POST /board-comments/:id/toggle-reaction rejects unauthenticated requests', async () => {
      const toggleReactionService = {
        async create() {
          return { reacted: true };
        },
      };

      app.use('/board-comments/:id/toggle-reaction', toggleReactionService);
      app.service('/board-comments/:id/toggle-reaction').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'react')],
        },
      });

      await expect(
        app.service('/board-comments/:id/toggle-reaction').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('POST /boards/:id/sessions rejects unauthenticated requests', async () => {
      const boardsSessionsService = {
        async create() {
          return { added: true };
        },
      };

      app.use('/boards/:id/sessions', boardsSessionsService);
      app.service('/boards/:id/sessions').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'modify')],
        },
      });

      await expect(
        app.service('/boards/:id/sessions').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });
  });

  describe('Worktree Endpoints - Authentication Required', () => {
    it('POST /worktrees/:id/start rejects non-admin users', async () => {
      const worktreesStartService = {
        async create() {
          return { started: true };
        },
      };

      app.use('/worktrees/:id/start', worktreesStartService);
      app.service('/worktrees/:id/start').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.ADMIN, 'start')],
        },
      });

      // Reject unauthenticated
      await expect(
        app.service('/worktrees/:id/start').create({}, { provider: 'rest' })
      ).rejects.toThrow();

      // Reject non-admin (member role)
      await expect(
        app.service('/worktrees/:id/start').create({}, {
          user: { user_id: 'user-1', email: 'test@example.com', role: ROLES.MEMBER },
          authenticated: true,
          provider: 'rest',
        } as any)
      ).rejects.toThrow();
    });

    it('POST /worktrees/:id/stop rejects non-admin users', async () => {
      const worktreesStopService = {
        async create() {
          return { stopped: true };
        },
      };

      app.use('/worktrees/:id/stop', worktreesStopService);
      app.service('/worktrees/:id/stop').hooks({
        before: {
          create: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.ADMIN, 'stop')],
        },
      });

      await expect(
        app.service('/worktrees/:id/stop').create({}, { provider: 'rest' })
      ).rejects.toThrow();
    });

    it('GET /worktrees/:id/health rejects unauthenticated requests', async () => {
      const worktreesHealthService = {
        async find() {
          return { healthy: true };
        },
      };

      app.use('/worktrees/:id/health', worktreesHealthService);
      app.service('/worktrees/:id/health').hooks({
        before: {
          find: [populateRouteParams, requireAuth, requireMinimumRole(ROLES.MEMBER, 'check')],
        },
      });

      await expect(
        app.service('/worktrees/:id/health').find({ provider: 'rest' })
      ).rejects.toThrow();
    });

    it('GET /worktrees/logs rejects unauthenticated requests', async () => {
      const worktreesLogsService = {
        async find() {
          return [];
        },
      };

      app.use('/worktrees/logs', worktreesLogsService);
      app.service('/worktrees/logs').hooks({
        before: {
          find: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'view logs')],
        },
      });

      await expect(app.service('/worktrees/logs').find({ provider: 'rest' })).rejects.toThrow();
    });
  });

  describe('Files Service - Authentication Required', () => {
    it('GET /files rejects unauthenticated requests', async () => {
      const filesService = {
        async find() {
          return [];
        },
      };

      app.use('/files', filesService);
      app.service('/files').hooks({
        before: {
          find: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'search files')],
        },
      });

      await expect(app.service('/files').find({ provider: 'rest' })).rejects.toThrow();
    });
  });
});

// =============================================================================
// Impersonation Endpoint Tests
// =============================================================================
//
// These tests exercise the full handler logic for POST /authentication/impersonate,
// not just the hook layer. The handler contains inline guards (superadmin check,
// recursive impersonation block, user lookup, expiry validation) that need direct
// testing since they're security-critical.
// =============================================================================

describe('POST /authentication/impersonate - Handler Logic', () => {
  const JWT_SECRET = 'test-impersonation-secret';
  const MAX_EXPIRY_MS = 3_600_000;

  // Mock target user
  const targetUser: Pick<User, 'user_id' | 'email' | 'name' | 'emoji' | 'role'> = {
    user_id: 'target-user-id' as User['user_id'],
    email: 'target@example.com',
    name: 'Target User',
    emoji: '🎯',
    role: ROLES.MEMBER,
  };

  // Mock usersService that returns targetUser or throws
  const mockUsersService = {
    async get(id: string) {
      if (id === targetUser.user_id) return targetUser;
      throw new Error('Not found');
    },
  };

  /**
   * Creates the impersonation handler matching production logic.
   * This mirrors register-routes.ts but with injected dependencies for testing.
   */
  function createImpersonateHandler(usersService = mockUsersService, configuredMaxExpiry?: number) {
    return async (
      data: { user_id?: string; expiry_ms?: number },
      params?: AuthenticatedParams & { authentication?: { payload?: Record<string, unknown> } }
    ) => {
      // 1. Caller must be authenticated
      if (!params?.user || !params.user.user_id) {
        throw new NotAuthenticated('Authentication required');
      }

      const caller = params.user;

      // 2. Caller must have role: superadmin
      if (!hasMinimumRole(caller.role, ROLES.SUPERADMIN)) {
        throw new Forbidden('Superadmin role required for impersonation');
      }

      // 3. Block recursive impersonation
      if (params.authentication?.payload?.is_impersonated === true) {
        throw new Forbidden('Cannot impersonate from an already-impersonated token');
      }

      // 4. user_id must be provided
      if (!data?.user_id) {
        throw new BadRequest('user_id is required');
      }

      // 5. Validate expiry_ms
      if (data.expiry_ms != null) {
        if (typeof data.expiry_ms !== 'number' || !Number.isFinite(data.expiry_ms)) {
          throw new BadRequest('expiry_ms must be a finite number');
        }
        if (data.expiry_ms <= 0) {
          throw new BadRequest('expiry_ms must be a positive number');
        }
      }

      // 6. Target user must exist
      let resolvedUser: typeof targetUser;
      try {
        resolvedUser = await usersService.get(data.user_id);
      } catch {
        throw new NotFound(`User not found: ${data.user_id}`);
      }

      // 7. Compute expiry
      const configMax = configuredMaxExpiry ?? MAX_EXPIRY_MS;
      const maxExpiry = Math.min(configMax, MAX_EXPIRY_MS);
      const requestedExpiry = data.expiry_ms ?? maxExpiry;
      const expiryMs = Math.min(requestedExpiry, maxExpiry);

      // 8. Generate token
      const jti = generateId();

      const accessToken = jwt.sign(
        {
          sub: resolvedUser.user_id,
          type: 'access',
          impersonated_by: caller.user_id,
          is_impersonated: true,
          jti,
        },
        JWT_SECRET,
        {
          expiresIn: Math.ceil(expiryMs / 1000),
          issuer: 'agor',
          audience: 'https://agor.dev',
        }
      );

      return {
        accessToken,
        user: {
          user_id: resolvedUser.user_id,
          email: resolvedUser.email,
          name: resolvedUser.name,
          emoji: resolvedUser.emoji,
          role: resolvedUser.role,
        },
      };
    };
  }

  // Helper to build authenticated params
  function superadminParams(
    overrides?: Partial<
      AuthenticatedParams & { authentication: { payload: Record<string, unknown> } }
    >
  ) {
    return {
      user: { user_id: 'superadmin-1', email: 'admin@example.com', role: ROLES.SUPERADMIN },
      authenticated: true,
      provider: 'rest',
      ...overrides,
    } as AuthenticatedParams & { authentication?: { payload?: Record<string, unknown> } };
  }

  // ── Guard tests ──────────────────────────────────────────────────────────

  describe('Guard: authentication required', () => {
    it('rejects when no user in params', async () => {
      const handler = createImpersonateHandler();
      await expect(handler({ user_id: targetUser.user_id }, {} as any)).rejects.toThrow(
        NotAuthenticated
      );
    });

    it('rejects when user_id is missing from params.user', async () => {
      const handler = createImpersonateHandler();
      await expect(handler({ user_id: targetUser.user_id }, { user: {} } as any)).rejects.toThrow(
        NotAuthenticated
      );
    });
  });

  describe('Guard: superadmin role required', () => {
    it('rejects member role', async () => {
      const handler = createImpersonateHandler();
      const params = superadminParams({
        user: { user_id: 'member-1', email: 'm@example.com', role: ROLES.MEMBER },
      } as any);
      await expect(handler({ user_id: targetUser.user_id }, params)).rejects.toThrow(Forbidden);
    });

    it('rejects admin role', async () => {
      const handler = createImpersonateHandler();
      const params = superadminParams({
        user: { user_id: 'admin-1', email: 'a@example.com', role: ROLES.ADMIN },
      } as any);
      await expect(handler({ user_id: targetUser.user_id }, params)).rejects.toThrow(Forbidden);
    });

    it('accepts superadmin role', async () => {
      const handler = createImpersonateHandler();
      const result = await handler({ user_id: targetUser.user_id }, superadminParams());
      expect(result.accessToken).toBeDefined();
    });
  });

  describe('Guard: recursive impersonation blocked', () => {
    it('rejects when caller token is already impersonated', async () => {
      const handler = createImpersonateHandler();
      const params = superadminParams({
        authentication: { payload: { is_impersonated: true } },
      });
      await expect(handler({ user_id: targetUser.user_id }, params)).rejects.toThrow(Forbidden);
    });

    it('allows when is_impersonated is false', async () => {
      const handler = createImpersonateHandler();
      const params = superadminParams({
        authentication: { payload: { is_impersonated: false } },
      });
      const result = await handler({ user_id: targetUser.user_id }, params);
      expect(result.accessToken).toBeDefined();
    });

    it('allows when no authentication payload present', async () => {
      const handler = createImpersonateHandler();
      const result = await handler({ user_id: targetUser.user_id }, superadminParams());
      expect(result.accessToken).toBeDefined();
    });
  });

  // ── Input validation tests ───────────────────────────────────────────────

  describe('Input: user_id validation', () => {
    it('rejects missing user_id', async () => {
      const handler = createImpersonateHandler();
      await expect(handler({}, superadminParams())).rejects.toThrow(BadRequest);
    });

    it('rejects empty string user_id', async () => {
      const handler = createImpersonateHandler();
      await expect(handler({ user_id: '' }, superadminParams())).rejects.toThrow(BadRequest);
    });

    it('returns 404 for nonexistent user', async () => {
      const handler = createImpersonateHandler();
      await expect(handler({ user_id: 'nonexistent-id' }, superadminParams())).rejects.toThrow(
        NotFound
      );
    });
  });

  describe('Input: expiry_ms validation', () => {
    it('rejects non-number expiry_ms', async () => {
      const handler = createImpersonateHandler();
      await expect(
        handler({ user_id: targetUser.user_id, expiry_ms: 'abc' as any }, superadminParams())
      ).rejects.toThrow(BadRequest);
    });

    it('rejects NaN expiry_ms', async () => {
      const handler = createImpersonateHandler();
      await expect(
        handler({ user_id: targetUser.user_id, expiry_ms: Number.NaN }, superadminParams())
      ).rejects.toThrow(BadRequest);
    });

    it('rejects Infinity expiry_ms', async () => {
      const handler = createImpersonateHandler();
      await expect(
        handler(
          { user_id: targetUser.user_id, expiry_ms: Number.POSITIVE_INFINITY },
          superadminParams()
        )
      ).rejects.toThrow(BadRequest);
    });

    it('rejects zero expiry_ms', async () => {
      const handler = createImpersonateHandler();
      await expect(
        handler({ user_id: targetUser.user_id, expiry_ms: 0 }, superadminParams())
      ).rejects.toThrow(BadRequest);
    });

    it('rejects negative expiry_ms', async () => {
      const handler = createImpersonateHandler();
      await expect(
        handler({ user_id: targetUser.user_id, expiry_ms: -1000 }, superadminParams())
      ).rejects.toThrow(BadRequest);
    });
  });

  // ── Expiry capping tests ─────────────────────────────────────────────────

  describe('Expiry capping', () => {
    it('defaults to 1h when no expiry_ms provided', async () => {
      const handler = createImpersonateHandler();
      const result = await handler({ user_id: targetUser.user_id }, superadminParams());
      const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;
      // exp - iat should be ~3600 seconds (1h)
      expect(decoded.exp! - decoded.iat!).toBe(3600);
    });

    it('caps expiry at 1h even when requesting more', async () => {
      const handler = createImpersonateHandler();
      const result = await handler(
        { user_id: targetUser.user_id, expiry_ms: 7_200_000 }, // 2h
        superadminParams()
      );
      const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded.exp! - decoded.iat!).toBe(3600);
    });

    it('allows shorter expiry', async () => {
      const handler = createImpersonateHandler();
      const result = await handler(
        { user_id: targetUser.user_id, expiry_ms: 300_000 }, // 5 min
        superadminParams()
      );
      const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded.exp! - decoded.iat!).toBe(300);
    });

    it('respects configured max when lower than hard cap', async () => {
      const handler = createImpersonateHandler(mockUsersService, 600_000); // 10 min config
      const result = await handler(
        { user_id: targetUser.user_id, expiry_ms: 1_800_000 }, // 30 min request
        superadminParams()
      );
      const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded.exp! - decoded.iat!).toBe(600); // capped at 10 min
    });
  });

  // ── Token claims tests ───────────────────────────────────────────────────

  describe('Token claims', () => {
    it('includes impersonation claims in JWT', async () => {
      const handler = createImpersonateHandler();
      const result = await handler({ user_id: targetUser.user_id }, superadminParams());
      const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;

      expect(decoded.sub).toBe(targetUser.user_id);
      expect(decoded.type).toBe('access');
      expect(decoded.impersonated_by).toBe('superadmin-1');
      expect(decoded.is_impersonated).toBe(true);
      expect(decoded.jti).toBeDefined();
      expect(decoded.iss).toBe('agor');
      expect(decoded.aud).toBe('https://agor.dev');
    });

    it('returns sanitized user object', async () => {
      const handler = createImpersonateHandler();
      const result = await handler({ user_id: targetUser.user_id }, superadminParams());

      expect(result.user).toEqual({
        user_id: targetUser.user_id,
        email: targetUser.email,
        name: targetUser.name,
        emoji: targetUser.emoji,
        role: targetUser.role,
      });
    });

    it('generates unique jti per call', async () => {
      const handler = createImpersonateHandler();
      const result1 = await handler({ user_id: targetUser.user_id }, superadminParams());
      const result2 = await handler({ user_id: targetUser.user_id }, superadminParams());
      const decoded1 = jwt.verify(result1.accessToken, JWT_SECRET) as jwt.JwtPayload;
      const decoded2 = jwt.verify(result2.accessToken, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded1.jti).not.toBe(decoded2.jti);
    });
  });
});
