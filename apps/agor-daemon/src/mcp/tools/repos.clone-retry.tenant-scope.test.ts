import {
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { RepoSlug, TenantID, UserID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { type RepoParams, ReposService } from '../../services/repos.js';
import type { McpContext } from '../server.js';
import { registerRepoTools } from './repos.js';

const executor = vi.hoisted(() => ({ spawn: vi.fn(), request: vi.fn() }));
vi.mock('../../utils/spawn-executor.js', () => ({
  spawnExecutorFireAndForget: executor.spawn,
  requestExecutor: executor.request,
  getDaemonUrl: () => 'http://daemon.test',
}));
vi.mock('../../services/session-token-service.js', () => ({
  issueExecutorCommandToken: vi.fn(async () => 'test-command-token'),
}));

dbTest('MCP retries failed clones in the guarded DB scope (#2643)', async ({ db }) => {
  executor.spawn.mockClear();
  executor.request.mockClear();
  const guardedDb = createTenantScopedDatabaseProxy(db, {
    label: 'daemon database',
    requireScope: true,
  });
  const app = {
    get: () => ({ execution: { unix_user_mode: 'simple' } }),
    service: (name: string) => {
      if (name === 'repos') return service;
      if (name === 'branches') return {};
      throw new Error(`Unexpected service: ${name}`);
    },
  } as unknown as Application;
  const service = new ReposService(guardedDb, app);
  const params: McpContext['baseServiceParams'] & RepoParams = {
    provider: 'mcp',
    authenticated: true,
    tenant: { tenant_id: 'tenant-a' as TenantID, source: 'auth_claim' },
    user: { user_id: 'test-user' as UserID, role: 'member', email: 'test@example.test' },
    query: { cleanup: true },
  };
  const args = { url: 'https://github.com/apache/superset.git', slug: 'apache/superset' };
  const repository = new RepoRepository(guardedDb);
  const inScope = <T>(work: () => Promise<T>) =>
    runWithTenantDatabaseScope(guardedDb, 'tenant-a', work);
  const failed = await inScope(() =>
    repository.create({
      slug: args.slug as RepoSlug,
      repo_type: 'remote',
      remote_url: args.url,
      local_path: '/test/repos/apache/superset',
      clone_status: 'failed',
      clone_error: { category: 'not_found', exit_code: 1, message: 'Repository not found' },
    })
  );

  // The guarded repository still requires a DB scope; the service now opens it
  // for direct callers as well as joining the MCP transport's unit of work.
  await expect(
    runWithTenantContext('tenant-a', () => repository.findBySlug(args.slug))
  ).rejects.toThrow(
    'Failed to find repo by slug: Missing tenant database scope for daemon database access'
  );
  expect(await inScope(() => repository.findById(failed.repo_id))).toEqual(failed);

  type Handler = (
    input: typeof args
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  let handler: Handler | undefined;
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      if (name === 'agor_repos_create_remote') handler = fn;
    },
  } as unknown as McpServer;
  registerRepoTools(server, { app, db: guardedDb, baseServiceParams: params } as McpContext);
  if (!handler) throw new Error('Missing create-remote tool');
  const invoke = handler;

  // Neither entry point may switch from conflicting trusted identity to tenant A.
  await expect(
    runWithTenantContext('tenant-b', () => service.cloneRepository(args, params))
  ).rejects.toThrow();
  await expect(runWithTenantContext('tenant-b', () => invoke(args))).rejects.toThrow();
  expect(await inScope(() => repository.findById(failed.repo_id))).toEqual(failed);
  expect(executor.spawn).not.toHaveBeenCalled();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runWithTenantContext('tenant-a', () => invoke(args));
    const pending = JSON.parse(result.content[0].text) as { status: string; repo_id: string };
    expect(pending.status).toBe('pending');
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    expect(pending.repo_id).toBe(failed.repo_id);
    const retried = await inScope(() => repository.findBySlug(args.slug));
    expect(retried).toMatchObject({
      repo_id: failed.repo_id,
      local_path: failed.local_path,
      clone_status: 'cloning',
      clone_generation: attempt,
    });
    expect(retried?.clone_error).toBeUndefined();
    // An in-flight clone must not be removed or launched a second time.
    const existing = await invoke(args);
    expect(JSON.parse(existing.content[0].text)).toMatchObject({
      status: 'exists',
      repo_id: pending.repo_id,
    });
    await expect(service.cloneRepository(args, params)).resolves.toMatchObject({
      status: 'exists',
      repo_id: failed.repo_id,
    });
    expect(executor.spawn).toHaveBeenCalledTimes(attempt);
    await inScope(() =>
      repository.update(failed.repo_id, {
        clone_status: attempt === 1 ? 'failed' : 'ready',
        clone_generation: attempt,
      })
    );
  }
  const ready = await invoke(args);
  expect(JSON.parse(ready.content[0].text)).toMatchObject({
    status: 'exists',
    repo_id: failed.repo_id,
  });
  expect(executor.spawn).toHaveBeenCalledTimes(2);
  // Even a caller's cleanup=true must not turn retry into filesystem deletion.
  expect(executor.request).not.toHaveBeenCalled();
});
