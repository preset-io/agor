/**
 * `repos/:id/import-agor-yml` as registered, against PostgreSQL row-level
 * security.
 *
 * The route is classified `identity-only`: tenant identity and write admission
 * are armed, no request transaction is held, and every database access opens
 * its own short unit — because `.agor.yml` is read by an executor process.
 * These tests drive the real registration (around hooks and RBAC before-hooks)
 * and the real ReposService on a scope-requiring handle, connected as a role
 * verified NOSUPERUSER/NOBYPASSRLS, so an unscoped access throws and a
 * cross-tenant read is filtered by the database rather than by the service.
 * Only the executor spawn and the branches service are stubbed.
 */
import {
  acquireTenantWriteGate,
  BoardRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  releaseTenantWriteGate,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  UsersRepository,
} from '@agor/core/db';
import {
  type Application,
  feathers,
  feathersExpress,
  NotFound,
  socketio,
} from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  Repo,
  RepoEnvironment,
  TenantID,
  User,
  UserRole,
} from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from './register-routes.js';
import { ReposService } from './services/repos.js';

const executor = vi.hoisted(() => ({ requestExecutor: vi.fn() }));

vi.mock('./utils/spawn-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils/spawn-executor.js')>()),
  requestExecutor: executor.requestExecutor,
  startContainedExecutorCommand: vi.fn(() => {
    throw new Error('.agor.yml import must not take the workspace-write path');
  }),
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
}));

const INERT_SERVICES = ['tasks', 'users'];

/** Wiring-time collaborator whose methods no import request ever calls. */
const inert = () =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : vi.fn()) });

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

const EXISTING: RepoEnvironment = {
  version: 2,
  default: 'dev',
  variants: { dev: { start: 'pnpm dev' } },
  template_overrides: { port: 4000 },
};
const IMPORTED: RepoEnvironment = {
  version: 2,
  default: 'web',
  variants: { web: { start: 'node server.js' }, api: { start: 'node api.js' } },
};

interface TenantFixture {
  tenantId: TenantID;
  admin: User;
  /** Tenant admin with no grant on the private board that holds the branch. */
  outsiderAdmin: User;
  member: User;
  repo: Repo;
  branch: Branch;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'repos/:id/import-agor-yml registration (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: ReturnType<typeof createTenantScopedDatabaseProxy>;
    let app: Application;
    let reposService: ReposService;
    const tokenTenants: Array<string | undefined> = [];

    async function seedTenant(label: string): Promise<TenantFixture> {
      const tenantId = `agor-yml-${label}-${generateId()}` as TenantID;
      return runWithTenantDatabaseScope(db, tenantId, async () => {
        const users = new UsersRepository(db);
        const admin = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'admin',
        });
        const outsiderAdmin = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'admin',
        });
        const member = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(db).create({
          slug: `agor-yml-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/agor-yml.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        await new RepoRepository(db).setEnvironment(repo.repo_id, EXISTING);
        const board = await new BoardRepository(db).create({
          name: `Agor yml ${label}`,
          created_by: admin.user_id,
          access_mode: 'private',
        });
        const branch = await new BranchRepository(db).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          permission_binding: 'inherit',
          // The admin owns the branch, so the pre-spawn workspace check
          // (view + filesystem read) is satisfied by ownership.
          created_by: admin.user_id,
          name: 'agor-yml',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
        });
        return { tenantId, admin, outsiderAdmin, member, repo, branch };
      });
    }

    function readEnvironment(tenantId: TenantID, repoId: string) {
      return runWithTenantDatabaseScope(
        db,
        tenantId,
        async () => (await new RepoRepository(db).findById(repoId))?.environment
      );
    }

    function callerParams(caller: User, tenantId: TenantID, role: UserRole = caller.role) {
      return {
        provider: 'rest',
        user: { ...caller, role },
        tenant: { tenant_id: tenantId, source: 'explicit' },
      } as AuthenticatedParams;
    }

    /** Through the real route registration, as the UI calls it. */
    function importViaRoute(caller: User, tenantId: TenantID, repoId: string, branchId: string) {
      return app.service('/repos/:id/import-agor-yml').create({ branch_id: branchId }, {
        ...callerParams(caller, tenantId),
        route: { id: repoId },
      } as AuthenticatedParams);
    }

    /**
     * Straight into the service, as an identity-only caller: tenant identity
     * and no database scope. Bypasses the route's role hook, so what refuses
     * here is the service's own check.
     */
    function importDirect(
      caller: User,
      tenantId: TenantID,
      repoId: string,
      branchId: string,
      role: UserRole = caller.role
    ) {
      return runWithTenantContext(tenantId, () =>
        reposService.importFromAgorYml(
          repoId,
          { branch_id: branchId },
          callerParams(caller, tenantId, role) as never
        )
      );
    }

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
      const result = await executeRaw(
        rawDb,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });

      app = feathersExpress(feathers()) as unknown as Application;
      app.configure(socketio());
      app.set('config', { execution: {} });
      (app as unknown as { sessionTokenService: unknown }).sessionTokenService = {
        setJwtSecret: vi.fn(),
        generateCommandToken: vi.fn(async () => {
          // What the real service seals into the token's tenant_id claim.
          tokenTenants.push(getCurrentTenantId());
          return 'command-token';
        }),
      };
      // The real branches service arms its own tenant scope in a hook; mirror
      // that here so the authorization read is RLS-filtered like production.
      app.use('branches', {
        find: async () => [],
        get: (id: string | number, params?: AuthenticatedParams) =>
          runWithTenantDatabaseScope(db, params?.tenant?.tenant_id, async () => {
            const branch = await new BranchRepository(db).findById(String(id));
            if (!branch) throw new NotFound(`Branch not found: ${id}`);
            return branch;
          }),
      } as never);
      reposService = new ReposService(db, app);
      app.use('repos', reposService as never);
      for (const path of INERT_SERVICES) app.use(path, { find: async () => [] });

      // Real Feathers registration and hooks. Registration stops right after
      // import-agor-yml so unrelated routes need no fixtures.
      const stopRegistration = new Error('import-agor-yml registered');
      const use = app.use.bind(app);
      const useSpy = vi.spyOn(app, 'use').mockImplementation((...args) => {
        if (args[0] === '/repos/:id/export-agor-yml') throw stopRegistration;
        return use(...args);
      });
      try {
        await expect(
          registerRoutes({
            app,
            db,
            config: { multi_tenancy: { mode: 'required_from_auth' } },
            externalLaunchProvider: { enabled: false },
            jwtSecret: 'disposable-test-not-a-credential',
            requireAuth: (context: unknown) => context,
            enforcePasswordChange: (context: unknown) => context,
            superadminOpts: { allowSuperadmin: false },
            deployment: { mode: 'standalone' },
            sessionsService: inert(),
            sessionsRepository: new SessionRepository(db),
            branchRepository: new BranchRepository(db),
            usersRepository: new UsersRepository(db),
          } as unknown as RegisterRoutesContext)
        ).rejects.toBe(stopRegistration);
      } finally {
        useSpy.mockRestore();
      }
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    beforeEach(() => {
      tokenTenants.length = 0;
      executor.requestExecutor.mockReset();
    });

    it('holds no database scope across the executor spawn and writes in a fresh unit', async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      const spawnState: Array<{ scope: unknown; tenant: string | undefined }> = [];
      executor.requestExecutor.mockImplementation(
        async (payload: { command: string; params: { cwd: string } }) => {
          spawnState.push({
            scope: getCurrentTenantDatabaseScope(),
            tenant: getCurrentTenantId(),
          });
          expect(payload.command).toBe('branch.agor-yml.import');
          expect(payload.params.cwd).toBe(a.branch.path);
          // A concurrent edit while the executor runs. If the route held a
          // transaction here this would wait on it, and a write from the
          // pre-spawn snapshot would clobber it.
          await runWithTenantDatabaseScope(db, a.tenantId, () =>
            new RepoRepository(db).setEnvironment(a.repo.repo_id, {
              ...EXISTING,
              template_overrides: { port: 5000 },
            })
          );
          return { success: true, data: { environment: IMPORTED } };
        }
      );

      const updated = await importViaRoute(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id);

      expect(spawnState).toEqual([{ scope: undefined, tenant: a.tenantId }]);
      expect(tokenTenants).toEqual([a.tenantId]);
      expect(updated.environment).toEqual({ ...IMPORTED, template_overrides: { port: 5000 } });
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual({
        ...IMPORTED,
        template_overrides: { port: 5000 },
      });
      expect(await readEnvironment(b.tenantId, b.repo.repo_id)).toEqual(EXISTING);
    });

    it("cannot read or write another tenant's repository by id", async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      executor.requestExecutor.mockResolvedValue({
        success: true,
        data: { environment: IMPORTED },
      });

      // Tenant A admin names tenant B's real repo and branch ids.
      await expect(
        importViaRoute(a.admin, a.tenantId, b.repo.repo_id, b.branch.branch_id)
      ).rejects.toMatchObject({ name: 'NotFound' });
      // Tenant A's own repo, tenant B's branch: RLS hides the branch.
      await expect(
        importViaRoute(a.admin, a.tenantId, a.repo.repo_id, b.branch.branch_id)
      ).rejects.toMatchObject({ name: 'NotFound' });

      expect(executor.requestExecutor).not.toHaveBeenCalled();
      expect(tokenTenants).toEqual([]);
      expect(await readEnvironment(b.tenantId, b.repo.repo_id)).toEqual(EXISTING);
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });

    it('refuses the wrong caller at the route, in the service, and at the branch', async () => {
      const a = await seedTenant('a');
      executor.requestExecutor.mockResolvedValue({
        success: true,
        data: { environment: IMPORTED },
      });
      // Route role hook: a member never reaches the service.
      await expect(
        importViaRoute(a.member, a.tenantId, a.repo.repo_id, a.branch.branch_id)
      ).rejects.toMatchObject({ name: 'Forbidden' });
      // The service's own admin check, for callers that bypass the route. The
      // branch owner demoted below admin would pass the workspace check by
      // ownership, so only this check refuses them.
      await expect(
        importDirect(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id, 'member')
      ).rejects.toMatchObject({ name: 'Forbidden' });
      await expect(
        importDirect(a.member, a.tenantId, a.repo.repo_id, a.branch.branch_id)
      ).rejects.toMatchObject({ name: 'Forbidden' });
      // An admin of the same tenant with no grant on the branch's private board
      // fails the pre-spawn workspace check.
      await expect(
        importViaRoute(a.outsiderAdmin, a.tenantId, a.repo.repo_id, a.branch.branch_id)
      ).rejects.toThrow(/branch view permission required/);

      expect(executor.requestExecutor).not.toHaveBeenCalled();
      expect(tokenTenants).toEqual([]);
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });

    it('refuses a write-frozen tenant before the executor starts', async () => {
      const a = await seedTenant('a');
      executor.requestExecutor.mockResolvedValue({
        success: true,
        data: { environment: IMPORTED },
      });
      const { generation } = await acquireTenantWriteGate(rawDb, a.tenantId, {
        holder: 'agor-yml-test',
        reason: 'freeze before .agor.yml import',
      });
      try {
        await expect(
          importViaRoute(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id)
        ).rejects.toThrow(/write-gated/i);
      } finally {
        await releaseTenantWriteGate(rawDb, a.tenantId, { generation });
      }
      expect(executor.requestExecutor).not.toHaveBeenCalled();
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });

    it('re-checks the tenant write gate after the spawn', async () => {
      const a = await seedTenant('a');
      let generation: number | undefined;
      executor.requestExecutor.mockImplementation(async () => {
        // A freeze that begins while the executor is running.
        ({ generation } = await acquireTenantWriteGate(rawDb, a.tenantId, {
          holder: 'agor-yml-test',
          reason: 'freeze during .agor.yml import',
        }));
        return { success: true, data: { environment: IMPORTED } };
      });
      try {
        await expect(
          importViaRoute(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id)
        ).rejects.toThrow(/write-gated/i);
      } finally {
        if (generation !== undefined) {
          await releaseTenantWriteGate(rawDb, a.tenantId, { generation });
        }
      }
      expect(executor.requestExecutor).toHaveBeenCalledOnce();
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });
  }
);
