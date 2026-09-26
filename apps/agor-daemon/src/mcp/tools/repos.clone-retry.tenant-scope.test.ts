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

dbTest('MCP replaces failed clones under a real guarded DB scope (#2643)', async ({ db }) => {
  executor.spawn.mockClear();
  executor.request.mockClear();
  const guardedDb = createTenantScopedDatabaseProxy(db, { label: 'daemon database' });
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

  // Same real custom service call as pre-#2612: identity alone is insufficient.
  await expect(
    runWithTenantContext('tenant-a', () => service.cloneRepository(args, params))
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

  // Conflicting trusted identity cannot switch to tenant A and remove its tombstone.
  await expect(runWithTenantContext('tenant-b', () => invoke(args))).rejects.toThrow();
  expect(await inScope(() => repository.findById(failed.repo_id))).toEqual(failed);
  expect(executor.spawn).not.toHaveBeenCalled();

  let previousId = failed.repo_id;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runWithTenantContext('tenant-a', () => invoke(args));
    const pending = JSON.parse(result.content[0].text) as { status: string; repo_id: string };
    expect(pending.status).toBe('pending');
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    expect(pending.repo_id).not.toBe(previousId);
    expect(await inScope(() => repository.findById(previousId))).toBeNull();
    const replacement = await inScope(() => repository.findBySlug(args.slug));
    expect(replacement).toMatchObject({ repo_id: pending.repo_id, clone_status: 'cloning' });
    expect(replacement?.clone_error).toBeUndefined();
    // An in-flight clone must not be removed or launched a second time.
    const existing = await invoke(args);
    expect(JSON.parse(existing.content[0].text)).toMatchObject({
      status: 'exists',
      repo_id: pending.repo_id,
    });
    if (!replacement) throw new Error('Missing replacement clone');
    previousId = replacement.repo_id;
    await inScope(() => repository.update(previousId, { clone_status: 'failed' }));
  }
  await inScope(() => repository.update(previousId, { clone_status: 'ready' }));
  const ready = await invoke(args);
  expect(JSON.parse(ready.content[0].text)).toMatchObject({
    status: 'exists',
    repo_id: previousId,
  });
  expect(executor.spawn).toHaveBeenCalledTimes(2);
  // Even a caller's cleanup=true must not turn retry into filesystem deletion.
  expect(executor.request).not.toHaveBeenCalled();
});
