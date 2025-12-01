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
import { createDatabaseAsync } from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  feathers,
  JWTStrategy,
  LocalStrategy,
} from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
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

    // Configure authentication with JWT (matching index.ts production setup)
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

    // Should reject unauthenticated request
    await expect(app.service('/test-protected').find({})).rejects.toThrow();
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
      user: { user_id: 'user-1', email: 'test@example.com', role: 'member' },
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
        create: [requireAuth, requireMinimumRole('admin', 'perform admin action')],
      },
    });

    // Should reject member role
    await expect(
      app.service('/test-admin').create({}, {
        user: { user_id: 'user-1', email: 'test@example.com', role: 'member' },
        authenticated: true,
      } as any)
    ).rejects.toThrow();

    // Should accept admin role
    const result = await app.service('/test-admin').create({}, {
      user: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' },
      authenticated: true,
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'spawn')],
        },
      });

      // Should reject without user
      await expect(app.service('/sessions/:id/spawn').create({})).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'spawn')],
        },
      });

      // Should accept with valid user
      const result = await app.service('/sessions/:id/spawn-auth').create({}, {
        user: { user_id: 'user-1', email: 'test@example.com', role: 'member' },
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'fork')],
        },
      });

      await expect(app.service('/sessions/:id/fork').create({})).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'stop')],
        },
      });

      await expect(app.service('/sessions/:id/stop').create({})).rejects.toThrow();
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
          find: [populateRouteParams, requireAuth, requireMinimumRole('member', 'view')],
        },
      });

      await expect(app.service('/sessions/:id/mcp-servers').find({})).rejects.toThrow();
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
          create: [requireAuth, requireMinimumRole('member', 'create tasks')],
        },
      });

      await expect(app.service('/tasks/bulk').create([])).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'complete')],
        },
      });

      await expect(app.service('/tasks/:id/complete').create({})).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'fail')],
        },
      });

      await expect(app.service('/tasks/:id/fail').create({})).rejects.toThrow();
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
          create: [requireAuth, requireMinimumRole('member', 'add repos')],
        },
      });

      await expect(app.service('/repos/local').create({})).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'create')],
        },
      });

      await expect(app.service('/repos/:id/worktrees').create({})).rejects.toThrow();
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
          remove: [populateRouteParams, requireAuth, requireMinimumRole('member', 'remove')],
        },
      });

      await expect(app.service('/repos/:id/worktrees/:name').remove('id')).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'react')],
        },
      });

      await expect(app.service('/board-comments/:id/toggle-reaction').create({})).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('member', 'modify')],
        },
      });

      await expect(app.service('/boards/:id/sessions').create({})).rejects.toThrow();
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('admin', 'start')],
        },
      });

      // Reject unauthenticated
      await expect(app.service('/worktrees/:id/start').create({})).rejects.toThrow();

      // Reject non-admin (member role)
      await expect(
        app.service('/worktrees/:id/start').create({}, {
          user: { user_id: 'user-1', email: 'test@example.com', role: 'member' },
          authenticated: true,
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
          create: [populateRouteParams, requireAuth, requireMinimumRole('admin', 'stop')],
        },
      });

      await expect(app.service('/worktrees/:id/stop').create({})).rejects.toThrow();
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
          find: [populateRouteParams, requireAuth, requireMinimumRole('member', 'check')],
        },
      });

      await expect(app.service('/worktrees/:id/health').find({})).rejects.toThrow();
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
          find: [requireAuth, requireMinimumRole('member', 'view logs')],
        },
      });

      await expect(app.service('/worktrees/logs').find({})).rejects.toThrow();
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
          find: [requireAuth, requireMinimumRole('member', 'search files')],
        },
      });

      await expect(app.service('/files').find({})).rejects.toThrow();
    });
  });
});
