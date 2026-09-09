import { readFileSync } from 'node:fs';
import type { AgorConfig } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  type Database,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { ReposService } from '../../services/repos';
import type { McpContext } from '../server';
import { registerRepoTools } from './repos';

const executor = vi.hoisted(() => vi.fn());
vi.mock('../../utils/spawn-executor', () => ({
  requestExecutor: executor,
  getDaemonUrl: () => 'http://daemon.test',
}));

beforeEach(() => {
  executor.mockReset().mockImplementation(async () => {
    // Real MCP entry has tenant identity, but must not retain a DB unit while
    // waiting on filesystem inspection in another process.
    expect(getCurrentTenantId()).toBe('default');
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    return {
      success: true,
      data: { path: '/inspected/fixture', defaultBranch: 'main', credentialFindingCount: 0 },
    };
  });
});

type Handler = (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>;
const args = { path: '/submitted/fixture', slug: 'local/scope-fixture' };
// This handler does not read the SDK request context.
const context = {} as ServerContext;

function fixture(db: Database, tenantId: string | null = 'default', hosted = false) {
  const guarded = createTenantScopedDatabaseProxy(db, { label: 'daemon database' });
  const config = {
    execution: { unix_user_mode: 'simple' },
    multi_tenancy: { mode: hosted ? 'required_from_auth' : 'static', static_tenant_id: 'default' },
  } as AgorConfig;
  const app = { get: () => config, service: () => service } as unknown as Application;
  const service = new ReposService(guarded, app);
  let handler: Handler | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: Handler) {
      if (name === 'agor_repos_create_local') handler = callback;
    },
  } as unknown as McpServer;
  registerRepoTools(server, {
    app,
    db: guarded,
    baseServiceParams: tenantId ? { tenant: { tenant_id: tenantId } } : {},
  } as McpContext);
  if (!handler) throw new Error('Local registration tool missing');
  return { handler, guarded, service };
}

dbTest('MCP registers a local repo through the real service on guarded SQLite', async ({ db }) => {
  const { handler, guarded, service } = fixture(db);
  const originalCreate = service.create.bind(service);
  const create = vi.spyOn(service, 'create').mockImplementation(async (...parameters) => {
    expect(getCurrentTenantDatabaseScope()).toMatchObject({ kind: 'tenant', tenantId: 'default' });
    return originalCreate(...parameters);
  });
  await runWithTenantContext('default', () => handler(args, context));
  expect(executor).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  const saved = await runWithTenantDatabaseScope(guarded, 'default', () =>
    new RepoRepository(guarded).findBySlug(args.slug)
  );
  expect(saved).toMatchObject({
    local_path: '/inspected/fixture',
    default_branch: 'main',
    repo_type: 'local',
  });
  expect(getCurrentTenantDatabaseScope()).toBeUndefined();
});

dbTest('MCP duplicate registration remains a domain error, not a scope error', async ({ db }) => {
  const { handler } = fixture(db);
  await runWithTenantContext('default', async () => {
    await handler(args, context);
    await expect(handler(args, context)).rejects.toThrow(
      "Repository 'local/scope-fixture' already exists"
    );
  });
  expect(await new RepoRepository(db).findAll()).toHaveLength(1);
});

dbTest('inspection failure does not create a repo', async ({ db }) => {
  executor.mockResolvedValueOnce({ success: false, error: { message: 'Not a git repo' } });
  const { handler } = fixture(db);
  await expect(runWithTenantContext('default', () => handler(args, context))).rejects.toThrow(
    'Not a git repo'
  );
  expect(await new RepoRepository(db).findAll()).toHaveLength(0);
});

dbTest(
  'missing tenant identity fails before executor inspection or persistence',
  async ({ db }) => {
    const { service } = fixture(db);
    await expect(service.addLocalRepository(args)).rejects.toThrow('Missing tenant context');
    expect(executor).not.toHaveBeenCalled();
    expect(await new RepoRepository(db).findAll()).toHaveLength(0);
  }
);

dbTest(
  'conflicting tenant identity fails before executor inspection or persistence',
  async ({ db }) => {
    const { handler } = fixture(db, 'tenant-b');
    await expect(runWithTenantContext('default', () => handler(args, context))).rejects.toThrow(
      /tenant/
    );
    expect(executor).not.toHaveBeenCalled();
    expect(await new RepoRepository(db).findAll()).toHaveLength(0);
  }
);

dbTest(
  'hosted mode still rejects local registration before executor inspection',
  async ({ db }) => {
    const { handler } = fixture(db, 'default', true);
    await expect(runWithTenantContext('default', () => handler(args, context))).rejects.toThrow(
      'unavailable in hosted multi-tenant mode'
    );
    expect(executor).not.toHaveBeenCalled();
    expect(await new RepoRepository(db).findAll()).toHaveLength(0);
  }
);

it('HTTP local registration uses the identity-only long-route boundary', () => {
  const source = readFileSync(new URL('../../register-routes.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/registerLongAuthenticatedRoute\(\s*app,\s*'\/repos\/local'/);
});
