import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticationService } from '@agor/core/feathers';
import { simpleGit } from '@agor/core/git';
import { TEAMMATE_FRAMEWORK_REPO_URL, type TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { handleGitBranchAdd } from '../../../../packages/executor/src/commands/git';
import { resolveGitRef as executorResolveGitRef } from '../../../../packages/executor/src/git/index.js';
import type { GitBranchAddPayload } from '../../../../packages/executor/src/payload-types';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import { getOrCreateExecutorConnectionRevocationFence } from '../auth/executor-connection-admission';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy';
import type { RegisterHooksContext } from '../register-hooks';
import { spawnExecutorFireAndForget } from '../utils/spawn-executor';
import { ExecutorGitEnvironmentService } from './executor-git-environment';
import { ReposService } from './repos';
import { SessionTokenService } from './session-token-service';

// Replace process scheduling and remap public template transport below. The
// executor uses real Git and Socket.IO, production auth/hooks and guarded repos.
vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<typeof import('../utils/spawn-executor')>()),
  spawnExecutorFireAndForget: vi.fn(),
}));

const transport = vi.hoisted(() => ({ template: '' }));
vi.mock('../../../../packages/executor/src/git/index.js', async (original) => {
  const git = await original<typeof import('../../../../packages/executor/src/git/index.js')>();
  const canonical = 'https://github.com/preset-io/agor-teammate.git';
  return {
    ...git,
    resolveGitRef: vi.fn(async (...args: Parameters<typeof git.resolveGitRef>) => {
      const [path, ref, options] = args;
      if (options?.remote?.url !== canonical) return git.resolveGitRef(...args);
      const resolved = await git.resolveGitRef(path, ref, {
        ...options,
        remote: { ...options.remote, url: transport.template },
      });
      return { ...resolved, remoteUrl: canonical };
    }),
    createBranchAsClone: (options: Parameters<typeof git.createBranchAsClone>[0]) =>
      git.createBranchAsClone({
        ...options,
        remoteUrl: options.remoteUrl === canonical ? transport.template : options.remoteUrl,
      }),
  };
});

dbTest(
  'real template home, clone and worktree resolve provenance before terminal acknowledgement',
  async ({ db: raw }) => {
    const root = await mkdtemp(join(tmpdir(), 'agor-provenance-'));
    const fixturePaths: string[] = [];
    const source = join(root, 'source');
    await mkdir(source);
    const git = simpleGit(source);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.test');
    await writeFile(join(source, 'IDENTITY.md'), 'Disposable template persona');
    await git.add('.');
    await git.commit('template');
    const sha = (await git.revparse('HEAD')).trim();
    // Only the public template URL is remapped; resolution and clone are real.
    // Production Git deliberately ignores inherited GIT_CONFIG_* overrides.
    transport.template = source;
    expect(vi.isMockFunction(executorResolveGitRef)).toBe(true);
    const localResolution = await executorResolveGitRef(undefined, 'main', {
      remoteOnly: true,
      remote: { url: TEAMMATE_FRAMEWORK_REPO_URL },
    });
    expect(localResolution.sha).toBe(sha);
    const owner = await new UsersRepository(raw).create({
      email: 'creator@example.test',
      role: 'member',
    });
    const outsider = await new UsersRepository(raw).create({
      email: 'outsider@example.test',
      role: 'member',
    });
    const board = await new BoardRepository(raw).create({
      name: 'Disposable',
      created_by: owner.user_id,
    });
    const rows = new BranchRepository(raw);
    const db = createTenantScopedDatabaseProxy(raw, {
      requireScope: true,
      label: 'provenance-integration',
    });
    const tenantId = 'provenance-test' as TenantID;
    const config = {
      database: { dialect: 'sqlite' },
      execution: { unix_user_mode: 'simple' },
      multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
    } as RegisterHooksContext['config'];
    const tokens = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { startCleanupTimer: false }
    );
    tokens.setJwtSecret('board-metadata-disposable-test-secret');
    const server = await boardMetadataTestApp(db, config, true, false, false, async (app) => {
      (app.service('authentication') as unknown as AuthenticationService).register(
        'jwt',
        new RuntimeJWTStrategy({
          multiTenancy: resolveMultiTenancyConfig(config),
          sessionTokenService: tokens,
          executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
        })
      );
      Object.assign(app, { sessionTokenService: tokens });
      await app.unuse('repos');
      app.use('repos', new ReposService(db, app));
      app.use('executor-git-environment', new ExecutorGitEnvironmentService(db));
    });
    try {
      for (const kind of ['home', 'clone', 'worktree'] as const) {
        const repo = await new RepoRepository(raw).create({
          name: `Disposable ${kind}`,
          slug: `fixture/${kind}`,
          repo_type: 'local',
          local_path: source,
          default_branch: 'main',
          remote_url: kind === 'home' ? TEAMMATE_FRAMEWORK_REPO_URL : source,
        });
        const params = {
          user: owner,
          tenant: { tenant_id: tenantId, source: 'explicit' as const },
        };
        const branch = await runWithTenantDatabaseScope(db, tenantId, () =>
          (server.app.service('repos') as unknown as ReposService).createBranch(
            repo.repo_id,
            {
              name: `fresh-${kind}`,
              ref: `fresh-${kind}`,
              createBranch: true,
              sourceBranch: 'main',
              boardId: board.board_id,
              position: { x: 0, y: 0 },
              storage_mode: kind === 'worktree' ? 'worktree' : 'clone',
              ...(kind === 'home'
                ? {
                    custom_context: {
                      teammate: { kind: 'teammate', displayName: 'Disposable home' },
                    },
                  }
                : {}),
            },
            params
          )
        );
        expect(branch.filesystem_status).toBe('creating');
        fixturePaths.push(branch.path);
        const payload = vi
          .mocked(spawnExecutorFireAndForget)
          .mock.calls.at(-1)![0] as GitBranchAddPayload;
        const attempt = branch.provisioning_attempt_id!;
        const provenance = { base_ref: 'refs/heads/main', base_sha: sha };
        const patch = (token: string, data: object) =>
          fetch(`${server.url}/branches/${branch.branch_id}`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
        const issue = (
          user = owner.user_id,
          branchId = branch.branch_id,
          attemptId: string | undefined = attempt,
          tenant = tenantId,
          command = 'git.branch.add'
        ) =>
          runWithTenantContext(tenant, () =>
            tokens.generateCommandToken(
              command,
              user,
              branchId,
              undefined,
              command === 'git.branch.add' ? attemptId : undefined
            )
          );
        if (kind === 'home') {
          const report = { ...provenance, provisioning_attempt_id: attempt };
          let before = await rows.findById(branch.branch_id);
          const userToken = server.headers(owner.user_id).authorization.slice(7);
          for (const token of [
            userToken,
            await issue(outsider.user_id),
            await issue(owner.user_id, generateId()),
            await issue(owner.user_id, branch.branch_id, 'stale'),
            await runWithTenantContext(tenantId, () =>
              tokens.generateCommandToken('git.branch.add', owner.user_id, branch.branch_id)
            ),
            await issue(owner.user_id, branch.branch_id, attempt, 'foreign-tenant' as TenantID),
            await issue(owner.user_id, branch.branch_id, attempt, tenantId, 'git.clone'),
            await runWithTenantContext(tenantId, () =>
              tokens.generateToken('task-session', owner.user_id, {
                branchId: branch.branch_id,
                taskId: 'task',
              })
            ),
          ])
            expect((await patch(token, report)).ok).toBe(false);
          expect(await rows.findById(branch.branch_id)).toEqual(before);
          // Manager without file-write authority is not a source resolver either.
          await setTestBranchUserRole(raw, branch.branch_id, outsider.user_id, 'manager', 'read');
          before = await rows.findById(branch.branch_id);
          expect((await patch(await issue(outsider.user_id), report)).ok).toBe(false);
          for (const data of [
            provenance, // even equal values cannot enter generic update
            { ...report, provisioning_attempt_id: 'stale' },
            { ...report, path: '/injected' },
            { ...report, filesystem_status: 'ready' },
            { ...report, base_sha: 'invalid' },
            {
              ...report,
              base_source: { name: 'main', remote_url: 'https://user:secret@example.test/repo' },
            },
            { ...report, provisioning_operation: 'restore' },
          ])
            expect((await patch(payload.sessionToken, data)).ok).toBe(false);
          expect(await rows.findById(branch.branch_id)).toEqual(before);
        }
        const writes: Array<{ status: unknown; provenance: boolean }> = [];
        server.app.service('branches').hooks({
          after: {
            patch: [
              (context) => {
                if (context.id === branch.branch_id)
                  writes.push({
                    status: context.result.filesystem_status,
                    provenance: !Array.isArray(context.data) && !!context.data?.base_sha,
                  });
                return context;
              },
            ],
          },
        });
        if (kind === 'clone') {
          const rejected = await handleGitBranchAdd(
            {
              ...payload,
              daemonUrl: server.url,
              sessionToken: await issue(owner.user_id, branch.branch_id, 'stale'),
            },
            {}
          );
          expect(rejected.success).toBe(false);
          await expect(stat(branch.path)).rejects.toMatchObject({ code: 'ENOENT' });
          expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('creating');
          expect(writes).toEqual([]);
        }
        const result = await handleGitBranchAdd({ ...payload, daemonUrl: server.url }, {});
        expect(result, JSON.stringify(result)).toMatchObject({ success: true });
        // The actual success callback must not enter post-failure reconciliation.
        vi.mocked(spawnExecutorFireAndForget).mock.calls.at(-1)![1]?.onExit?.(0, { mode: 'local' });
        const ready = await rows.findById(branch.branch_id);
        expect(ready).toMatchObject({ filesystem_status: 'ready', base_sha: sha });
        expect(writes).toEqual([
          { status: 'creating', provenance: true },
          { status: 'ready', provenance: false },
        ]);
        expect(
          (await patch(payload.sessionToken, { ...provenance, provisioning_attempt_id: attempt }))
            .ok
        ).toBe(false);
        expect(await readFile(join(branch.path, 'IDENTITY.md'), 'utf8')).toBe(
          'Disposable template persona'
        );
        if (kind === 'home') {
          expect(ready?.custom_context?.teammate).toMatchObject({ localHome: true });
          expect(await simpleGit(branch.path).getRemotes()).toEqual([]);
          expect(ready?.base_source?.remote_url).toBe(TEAMMATE_FRAMEWORK_REPO_URL);
        }
        // Retry after an interrupted terminal acknowledgement adopts the marked
        // checkout. The old signed token cannot spoof the replacement generation.
        await rows.update(branch.branch_id, { filesystem_status: 'failed' });
        const retry = await rows.claimForProvisioning(branch.branch_id, generateId());
        const retryId = retry.branch.provisioning_attempt_id!;
        expect(
          (await patch(payload.sessionToken, { ...provenance, provisioning_attempt_id: retryId }))
            .ok
        ).toBe(false);
        expect(
          (
            await patch(payload.sessionToken, {
              filesystem_status: 'ready',
              provisioning_attempt_id: retryId,
            })
          ).ok
        ).toBe(false);
        expect(
          (await patch(payload.sessionToken, { ...provenance, provisioning_attempt_id: attempt }))
            .ok
        ).toBe(false);
        writes.length = 0;
        expect(
          await handleGitBranchAdd(
            {
              ...payload,
              daemonUrl: server.url,
              sessionToken: await issue(owner.user_id, branch.branch_id, retryId),
              params: {
                ...payload.params,
                provisioningAttemptId: retryId,
                allowExistingCheckout: true,
              },
            },
            {}
          )
        ).toMatchObject({ success: true });
        expect(writes).toEqual([{ status: 'ready', provenance: false }]);

        // Recovery must preserve local-only history rather than resolve the base
        // again. For worktrees, remove only this fixture's checkout, retain its ref.
        const local = simpleGit(branch.path);
        await local.addConfig('user.name', 'Fixture');
        await local.addConfig('user.email', 'fixture@example.test');
        await writeFile(join(branch.path, 'private-work'), 'Unpushed work');
        await local.add('.');
        await local.commit('unpublished');
        const unpushed = (await local.revparse('HEAD')).trim();
        if (kind === 'worktree') await git.raw(['worktree', 'remove', branch.path]);
        await rows.update(branch.branch_id, { filesystem_status: 'deleted' });
        const recovery = await rows.claimForProvisioning(branch.branch_id, generateId(), {
          restore: true,
        });
        const restoreId = recovery.branch.provisioning_attempt_id!;
        const restoreToken = await issue(owner.user_id, branch.branch_id, restoreId);
        expect(
          (await patch(restoreToken, { ...provenance, provisioning_attempt_id: restoreId })).ok
        ).toBe(false);
        writes.length = 0;
        expect(
          await handleGitBranchAdd(
            {
              ...payload,
              daemonUrl: server.url,
              sessionToken: restoreToken,
              params: { ...payload.params, provisioningAttemptId: restoreId, restoreMode: true },
            },
            {}
          )
        ).toMatchObject({ success: true });
        expect(writes).toEqual([{ status: 'ready', provenance: false }]);
        expect((await simpleGit(branch.path).revparse('HEAD')).trim()).toBe(unpushed);
        expect((await rows.findById(branch.branch_id))?.base_sha).toBe(sha);
      }
    } finally {
      await server.close();
      await Promise.all(fixturePaths.map((path) => rm(path, { recursive: true, force: true })));
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000
);
