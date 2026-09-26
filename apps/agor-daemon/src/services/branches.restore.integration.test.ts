import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgorClient, createClient } from '@agor/core/api';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  BoardRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticationService } from '@agor/core/feathers';
import type { Branch, BranchID, HookContext, TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { runBranchWorkspaceFiles } from '../../../../packages/executor/src/commands/branch-cleanup';
import { handleBranchFilesystemStatus } from '../../../../packages/executor/src/commands/files';
import { handleGitBranchAdd } from '../../../../packages/executor/src/commands/git';
import { createGit } from '../../../../packages/executor/src/git/index';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import { getOrCreateExecutorConnectionRevocationFence } from '../auth/executor-connection-admission';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy';
import { initMcpTokens } from '../mcp/tokens';
import type { RegisterHooksContext } from '../register-hooks';
import { configureResolvedConfigSlice } from '../utils/build-resolved-config-slice';
import type { BoardObjectsService } from './board-objects';
import type { BranchesService } from './branches';
import { ExecutorGitEnvironmentService } from './executor-git-environment';
import { ReposService } from './repos';
import { SessionTokenService } from './session-token-service';
import { SessionsService } from './sessions';

const executions: Promise<unknown>[] = [];
// Only replace process dispatch: real executor handlers use real authenticated
// Socket.IO, production hooks, real repositories, and disposable Git files.
vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn((payload) => handleBranchFilesystemStatus(payload, {})),
  spawnExecutor: vi.fn((payload) => {
    executions.push(handleGitBranchAdd(payload, {}));
  }),
  spawnExecutorFireAndForget: vi.fn((payload) => {
    executions.push(handleGitBranchAdd(payload, {}));
  }),
}));

const tenantId = 'restore-test' as TenantID;
const tenant = { tenant_id: tenantId, source: 'explicit' as const };

for (const scenario of [
  'archived',
  'spawned',
  'active-cleaned',
  'active-concurrent',
  'active-caller',
  'active-rollback',
  'board-admission-rollback',
  'board-admission-success',
  'board-post-admission-rollback',
  'active-delegated',
  'stale-registration',
  'interrupted',
  'deleted-git',
  'retained-ahead',
  'missing-retained-ahead',
  'missing-retained-local',
  'clone',
  'foreign-origin',
  'invalid-link',
  'invalid-backlink',
  'foreign-owner',
  'missing-git',
  'wrong-ref',
  'local-home',
  'missing-home',
  'missing-workspace',
] as const) {
  dbTest(`archive clean → restore → new session: ${scenario}`, async ({ db: raw }) => {
    const root = await mkdtemp(join(tmpdir(), 'agor-restore-'));
    const base = join(root, 'base');
    const path = join(root, 'home');
    await mkdir(base);
    const { git } = createGit(base);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.test');
    await writeFile(join(base, '.gitignore'), 'build/\n');
    await git.add('.');
    await git.commit('fixture');
    await git.raw(['worktree', 'add', '-b', 'home', path]);
    const retained = scenario.includes('retained');
    let remote: string | undefined;
    if (scenario.endsWith('ahead')) {
      remote = join(root, 'remote.git');
      await mkdir(remote);
      await createGit(remote).git.init(true);
      await git.addRemote('origin', remote);
      await git.push('origin', 'main');
      await git.push('origin', 'home');
    }
    await writeFile(join(path, 'personal.md'), 'irreplaceable memory');
    if (retained) {
      await createGit(path).git.add('personal.md');
      await createGit(path).git.commit('retain personal history');
    }
    const retainedSha = (await createGit(path).git.revparse(['HEAD'])).trim();
    await mkdir(join(path, 'build'));
    await writeFile(join(path, 'build', 'ignored'), 'build output');
    const user = await new UsersRepository(raw).create({
      email: 'restore@example.test',
      role: 'member',
    });
    const repo = await new RepoRepository(raw).create({
      name: 'Restore',
      slug: 'fixture/restore',
      repo_type: 'local',
      local_path: base,
      default_branch: 'main',
      ...(remote ? { remote_url: remote } : {}),
    });
    const rows = new BranchRepository(raw);
    const branch = await rows.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'home',
      ref: 'home',
      path,
      branch_unique_id: 1,
      created_by: user.user_id,
      filesystem_status: 'ready',
    });
    const maintenance = new BranchMaintenanceRepository(raw);
    const workspace = new BranchWorkspaceOperationRepository(raw);
    const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
    const deadlineAt = Date.now() + 60_000;
    await workspace.prepare(
      claim,
      {
        operation_id: claim.operation_id,
        action: 'archive',
        filesystem_action: 'cleaned',
        status: 'accepted',
        requested_by: user.user_id,
        requested_at: new Date().toISOString(),
        deadline_at: new Date(deadlineAt).toISOString(),
      },
      { repo_id: repo.repo_id, repo_path: base, path }
    );
    await workspace.archiveMetadata(claim);
    const executionId = await maintenance.beginExecution(claim);
    await maintenance.claimExecution(claim, executionId);
    expect(
      await runBranchWorkspaceFiles({
        command: 'branch.archive',
        daemonUrl: 'http://unused.test',
        sessionToken: 'unused',
        params: {
          branchId: branch.branch_id,
          operationId: claim.operation_id,
          generation: claim.generation,
          executionId,
          deadlineAt,
          filesystemAction: 'cleaned',
          cwd: path,
          principalBranchAccess: 'write',
          cleanup: { command: 'git clean -fdX' },
        },
      })
    ).toBe('succeeded');
    await workspace.finish(claim, executionId, 'succeeded');
    expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('cleaned');
    await expect(readFile(join(path, 'build', 'ignored'))).rejects.toThrow();
    if (scenario.startsWith('active')) await rows.update(branch.branch_id, { archived: false });
    if (scenario === 'invalid-link')
      await writeFile(join(path, '.git'), `gitdir: ${join(root, 'missing-git-dir')}\n`);
    if (scenario === 'invalid-backlink' || scenario === 'foreign-owner') {
      const gitDir = (await createGit(path).git.revparse(['--absolute-git-dir'])).trim();
      await writeFile(
        join(gitDir, scenario === 'invalid-backlink' ? 'gitdir' : 'agor-branch-id'),
        scenario === 'invalid-backlink'
          ? `${join(root, 'unrelated', '.git')}\n`
          : `${generateId()}\n`
      );
    }
    if (scenario === 'missing-git') await rm(join(path, '.git'));
    if (scenario === 'wrong-ref') await createGit(path).git.checkoutLocalBranch('different');
    if (scenario === 'local-home' || scenario === 'missing-home') {
      await rows.update(branch.branch_id, {
        storage_mode: 'clone',
        custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture', localHome: true } },
      });
      await rm(join(path, '.git'));
    }
    if (scenario === 'missing-home' || scenario === 'missing-workspace')
      await rm(path, { recursive: true });
    if (scenario === 'stale-registration') await rm(path, { recursive: true });
    if (scenario.startsWith('missing-retained')) await git.raw(['worktree', 'remove', path]);
    if (scenario === 'deleted-git') {
      await git.raw(['worktree', 'remove', '--force', path]);
      await git.addRemote('origin', base);
    }
    if (scenario === 'clone' || scenario === 'foreign-origin') {
      await git.raw(['worktree', 'remove', '--force', path]);
      await createGit(root).git.clone(base, path);
      await createGit(path).git.checkout('home');
      await writeFile(join(path, 'personal.md'), 'irreplaceable memory');
      await rows.update(branch.branch_id, { storage_mode: 'clone' });
      await new RepoRepository(raw).update(repo.repo_id, { remote_url: base });
      if (scenario === 'foreign-origin')
        await createGit(path).git.remote(['set-url', 'origin', join(root, 'foreign')]);
    }
    const shouldFail = [
      'foreign-origin',
      'invalid-link',
      'invalid-backlink',
      'foreign-owner',
      'missing-git',
      'wrong-ref',
      'missing-home',
      'missing-workspace',
      'stale-registration',
    ].includes(scenario);
    const db = createTenantScopedDatabaseProxy(raw, {
      label: 'restore-integration',
      requireScope: true,
    });
    const config = {
      database: { dialect: 'sqlite' },
      execution:
        scenario === 'active-delegated'
          ? { unix_user_mode: 'delegated', executor_command_template: 'fixture-launcher {user_id}' }
          : {},
      multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
    } as RegisterHooksContext['config'];
    const tokens = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { startCleanupTimer: false }
    );
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig(config) });
    tokens.setJwtSecret('board-metadata-disposable-test-secret');
    const server = await boardMetadataTestApp(db, config, true, false, false, async (app) => {
      Object.assign(app, { sessionTokenService: tokens });
      (app.service('authentication') as unknown as AuthenticationService).register(
        'jwt',
        new RuntimeJWTStrategy({
          sessionTokenService: tokens,
          multiTenancy: resolveMultiTenancyConfig(config),
          executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
        })
      );
      await app.unuse('repos');
      app.use('repos', new ReposService(db, app));
      await app.unuse('sessions');
      app.use('sessions', new SessionsService(db, app));
      app.use('executor-git-environment', new ExecutorGitEnvironmentService(db));
    });
    // Dispatch resolves its endpoint from production config; the test transport
    // overrides only the destination, never credentials or permission checks.
    const dispatch = await import('../utils/spawn-executor');
    vi.mocked(dispatch.requestExecutor).mockImplementation((payload) =>
      handleBranchFilesystemStatus({ ...payload, daemonUrl: server.url } as never, {})
    );
    configureResolvedConfigSlice(config);
    const realDispatch =
      await vi.importActual<typeof import('../utils/spawn-executor')>('../utils/spawn-executor');
    let interruptedExit: ((code: number | null) => void) | undefined;
    let interruptOnce = scenario === 'interrupted';
    for (const fn of [dispatch.spawnExecutor, dispatch.spawnExecutorFireAndForget]) {
      vi.mocked(fn).mockImplementation((payload, options) => {
        if (scenario === 'spawned') {
          // Real child + CLI + authenticated socket acknowledgement, not an
          // in-process handler. No claim of sandbox containment: this production
          // provisioning payload has no cwd and is currently unwrapped.
          executions.push(
            new Promise<void>((resolve, reject) => {
              const originalPath = process.env.AGOR_EXECUTOR_PATH;
              process.env.AGOR_EXECUTOR_PATH = fileURLToPath(
                new URL('../../../../packages/executor/src/cli.ts', import.meta.url)
              );
              try {
                realDispatch.spawnExecutorFireAndForget(
                  { ...payload, daemonUrl: server.url },
                  {
                    ...options,
                    preparedEnv: {
                      ...process.env,
                      NODE_OPTIONS: '--import tsx --conditions=source',
                    },
                    onExit: (code, context) => {
                      void options?.onExit?.(code, context);
                      if (code === 0) resolve();
                      else reject(new Error(`Real executor exited ${code}`));
                    },
                  }
                );
              } finally {
                if (originalPath === undefined) delete process.env.AGOR_EXECUTOR_PATH;
                else process.env.AGOR_EXECUTOR_PATH = originalPath;
              }
            })
          );
          return undefined as never;
        }
        if (interruptOnce) {
          interruptOnce = false;
          interruptedExit = (code) => {
            void options?.onExit?.(code, { mode: 'local' });
          };
          return undefined as never;
        }
        executions.push(handleGitBranchAdd({ ...payload, daemonUrl: server.url } as never, {}));
        return undefined as never;
      });
    }
    const observers: AgorClient[] = [];
    try {
      const sessions = server.app.service('sessions') as unknown as SessionsService;
      await runWithTenantContext(tenantId, async () => {
        const repos = server.app.service('repos') as unknown as ReposService;
        const outsider = await new UsersRepository(raw).create({
          email: 'outsider@example.test',
          role: 'member',
        });
        await expect(
          repos.retryBranchProvisioning(
            branch.branch_id,
            { user: outsider, tenant },
            !scenario.startsWith('active')
          )
        ).rejects.toThrow();
        await expect(
          repos.retryBranchProvisioning(branch.branch_id, { tenant }, true)
        ).rejects.toThrow();
        if (scenario.startsWith('board-')) {
          const boards = new BoardRepository(raw);
          const source = await boards.create({ name: 'Source', created_by: user.user_id });
          const destination = await boards.create({
            name: 'Destination',
            created_by: user.user_id,
          });
          await rows.update(branch.branch_id, { board_id: source.board_id });
          const objects = server.app.service('board-objects') as unknown as BoardObjectsService;
          const placement = await objects.create({
            board_id: source.board_id,
            branch_id: branch.branch_id,
            position: { x: 10, y: 20 },
          });
          const observe = async (userId: typeof user.user_id) => {
            const client = createClient(server.url, false, {
              reconnectionAttempts: 0,
              socketAuthentication: {
                accessToken: server.headers(userId).authorization.slice('Bearer '.length),
              },
            });
            observers.push(client);
            await new Promise<void>((resolve, reject) => {
              client.io.once('connect', resolve);
              client.io.once('connect_error', reject);
              client.io.connect();
            });
            const events: Branch[] = [];
            client.service('branches').on('patched', (value) => events.push(value));
            return events;
          };
          const delivered = await observe(user.user_id);
          const denied = await observe(outsider.user_id);
          // Positive control: authenticated delivery through production hooks,
          // tenant channels and branch RBAC, not just an internal emit listener.
          await (server.app.service('branches') as unknown as BranchesService).patch(
            branch.branch_id,
            { notes: 'control' },
            {
              user,
              tenant,
            }
          );
          await vi.waitFor(() => expect(delivered).toHaveLength(1));
          expect(denied).toHaveLength(0);
          delivered.length = 0;
          const settleDelivery = () => new Promise((resolve) => setTimeout(resolve, 75));
          const patched = vi.fn<(value: Branch, hook: HookContext) => void>();
          server.app.service('branches').on('patched', patched);
          if (scenario !== 'board-admission-rollback') {
            const unarchive = () =>
              (server.app.service('branches') as unknown as BranchesService).unarchive(
                branch.branch_id,
                { boardId: destination.board_id },
                { user, tenant }
              );
            const admission = () =>
              runWithTenantDatabaseTransaction(db, tenantId, async () => {
                await unarchive();
                // The explicit-board move nests in this transaction. Both its
                // creating event and executor dispatch must await outer commit.
                await settleDelivery();
                expect(delivered, 'no authenticated delivery before commit').toHaveLength(0);
                expect(patched).not.toHaveBeenCalled();
                expect(executions).toHaveLength(0);
                if (scenario === 'board-post-admission-rollback')
                  throw new Error('rollback after admission');
              });
            if (scenario === 'board-post-admission-rollback') {
              await expect(admission()).rejects.toThrow('rollback after admission');
              await settleDelivery();
              expect(delivered).toHaveLength(0);
              expect(patched).not.toHaveBeenCalled();
              expect(executions).toHaveLength(0);
              expect(await rows.findById(branch.branch_id)).toMatchObject({
                board_id: source.board_id,
                archived: true,
                filesystem_status: 'cleaned',
              });
            } else {
              await admission();
              const moved = patched.mock.calls.filter(
                ([value]) => value.filesystem_status === 'cleaned'
              );
              expect(moved).toHaveLength(1);
              expect(moved[0][0]).toMatchObject({
                board_id: destination.board_id,
                archived: true,
              });
              const creating = patched.mock.calls.filter(
                ([value]) => value.filesystem_status === 'creating'
              );
              expect(creating).toHaveLength(1);
              expect(creating[0]).toEqual([
                expect.objectContaining({
                  branch_id: branch.branch_id,
                  board_id: destination.board_id,
                  archived: false,
                }),
                expect.objectContaining({
                  path: 'branches',
                  params: expect.objectContaining({ tenant }),
                }),
              ]);
              expect(executions).toHaveLength(1);
              await Promise.all(executions.splice(0));
              // A board move intentionally evicts user sockets after commit.
              // Move + creating arrive first; readiness is available on refresh.
              await vi.waitFor(() =>
                expect(observers.every((client) => !client.io.connected)).toBe(true)
              );
              expect(delivered).toHaveLength(2);
              expect(patched.mock.calls.map(([value]) => value.filesystem_status)).toEqual([
                'cleaned',
                'creating',
                'ready',
              ]);
              expect(delivered.map((value) => value.filesystem_status)).toEqual([
                'cleaned',
                'creating',
              ]);
              expect(delivered.every((value) => value.board_id === destination.board_id)).toBe(
                true
              );
              expect(await rows.findById(branch.branch_id)).toMatchObject({
                board_id: destination.board_id,
                archived: false,
                filesystem_status: 'ready',
              });
            }
            expect(denied).toHaveLength(0);
            const finalPlacement = await runWithTenantDatabaseScope(db, tenantId, () =>
              objects.findByBranchId(branch.branch_id)
            );
            if (scenario === 'board-post-admission-rollback') {
              expect(finalPlacement).toMatchObject({
                object_id: placement.object_id,
                board_id: source.board_id,
                position: { x: 10, y: 20 },
              });
            } else {
              // Moving recreates placement; rollback alone preserves its identity.
              expect(finalPlacement).toMatchObject({
                branch_id: branch.branch_id,
                board_id: destination.board_id,
              });
              expect(finalPlacement?.object_id).not.toBe(placement.object_id);
            }
            return;
          }
          const session = await new SessionRepository(raw).create({
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'codex',
          });
          await new TaskRepository(raw).create({
            session_id: session.session_id,
            created_by: user.user_id,
            status: 'queued',
          });
          const before = await rows.findById(branch.branch_id);
          await expect(
            (server.app.service('branches') as unknown as BranchesService).unarchive(
              branch.branch_id,
              { boardId: destination.board_id },
              { user, tenant }
            )
          ).rejects.toThrow('unfinished tasks');
          expect(await rows.findById(branch.branch_id)).toMatchObject({
            board_id: source.board_id,
            archived: true,
            filesystem_status: 'cleaned',
            archived_at: before?.archived_at,
            archived_by: before?.archived_by,
          });
          expect(
            await runWithTenantDatabaseScope(db, tenantId, () =>
              objects.findByBranchId(branch.branch_id)
            )
          ).toMatchObject({
            object_id: placement.object_id,
            board_id: source.board_id,
            position: { x: 10, y: 20 },
          });
          await settleDelivery();
          expect(delivered, 'no authenticated delivery on admission rollback').toHaveLength(0);
          expect(denied).toHaveLength(0);
          expect(executions).toHaveLength(0);
          expect(patched).not.toHaveBeenCalled();
          return;
        }
        if (scenario === 'active-delegated') {
          await new UsersRepository(raw).update(outsider.user_id, {
            unix_username: 'manager-home',
          });
          Object.assign(outsider, { unix_username: 'manager-home' });
          await setTestBranchUserRole(
            raw,
            branch.branch_id,
            outsider.user_id,
            'manager',
            'write',
            user.user_id
          );
        }
        if (scenario === 'active-cleaned') {
          for (const [role, access] of [
            ['manager', 'read'],
            ['collaborator', 'write'],
          ] as const) {
            await setTestBranchUserRole(
              raw,
              branch.branch_id,
              outsider.user_id,
              role,
              access,
              user.user_id
            );
            await expect(
              repos.retryBranchProvisioning(branch.branch_id, { user: outsider, tenant })
            ).rejects.toThrow();
          }
        }
        expect(executions).toHaveLength(0);
        for (const patch of [
          { filesystem_status: 'ready' },
          { provisioning_attempt_id: 'forged' },
          { provisioning_operation: 'create' },
          { provisioning_operation: 'restore' },
        ]) {
          const spoof = await fetch(`${server.url}/branches/${branch.branch_id}`, {
            method: 'PATCH',
            headers: server.headers(user.user_id),
            body: JSON.stringify(patch),
          });
          expect(spoof.ok).toBe(false);
        }
        if (scenario === 'active-caller') {
          await setTestBranchUserRole(
            raw,
            branch.branch_id,
            outsider.user_id,
            'manager',
            'write',
            user.user_id
          );
        }
        if (scenario === 'active-rollback') {
          await expect(
            runWithTenantDatabaseTransaction(db, tenantId, async () => {
              await repos.retryBranchProvisioning(branch.branch_id, { user, tenant });
              expect(executions).toHaveLength(0);
              throw new Error('fixture rollback');
            })
          ).rejects.toThrow('fixture rollback');
          expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('cleaned');
          expect(executions).toHaveLength(0);
        }
        if (scenario === 'active-concurrent') {
          const attempts = await Promise.allSettled([
            repos.retryBranchProvisioning(branch.branch_id, { user, tenant }),
            repos.retryBranchProvisioning(branch.branch_id, { user, tenant }),
          ]);
          expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
          expect(executions).toHaveLength(1);
          expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({
            reason: { data: { code: 'BRANCH_PROVISIONING_IN_PROGRESS' } },
          });
        } else if (scenario.startsWith('active')) {
          await repos.retryBranchProvisioning(branch.branch_id, {
            user: ['active-caller', 'active-delegated'].includes(scenario) ? outsider : user,
            tenant,
          });
          if (scenario === 'active-delegated') {
            expect(dispatch.spawnExecutorFireAndForget).toHaveBeenLastCalledWith(
              expect.objectContaining({
                params: expect.objectContaining({
                  userId: outsider.user_id,
                  branchId: branch.branch_id,
                  principalBranchAccess: 'write',
                }),
              }),
              expect.objectContaining({
                delegatedHomeKey: 'manager-home',
                templateVariables: expect.objectContaining({
                  user_id: outsider.user_id,
                  branch_id: branch.branch_id,
                }),
              })
            );
          }
          if (scenario === 'active-caller')
            expect(dispatch.spawnExecutorFireAndForget).toHaveBeenLastCalledWith(
              expect.objectContaining({
                params: expect.objectContaining({ userId: outsider.user_id }),
              }),
              expect.anything()
            );
        } else {
          await (server.app.service('branches') as unknown as BranchesService).unarchive(
            branch.branch_id,
            undefined,
            { user, tenant }
          );
        }
        if (scenario === 'interrupted') {
          expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('creating');
          await expect(
            repos.retryBranchProvisioning(branch.branch_id, { user, tenant })
          ).rejects.toThrow('in progress');
          expect(interruptedExit).toBeTypeOf('function');
          interruptedExit!(9);
          await vi.waitFor(async () =>
            expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('failed')
          );
          await repos.retryBranchProvisioning(branch.branch_id, { user, tenant });
        }
        await Promise.all(executions.splice(0));
        if (shouldFail) {
          const failed = await rows.findById(branch.branch_id);
          expect(failed?.filesystem_status).toBe('failed');
          expect(failed?.error_message).toBeTruthy();
          if (scenario === 'stale-registration')
            expect(failed?.error_message).toContain('target-scoped repair');
          await expect(
            sessions.create(
              {
                branch_id: branch.branch_id,
                created_by: user.user_id,
                agentic_tool: 'claude-code',
              },
              { user, tenant }
            )
          ).rejects.toMatchObject({ data: { code: 'BRANCH_PROVISIONING_FAILED' } });
          return;
        }
        const session = await sessions.create(
          { branch_id: branch.branch_id, created_by: user.user_id, agentic_tool: 'claude-code' },
          { user, tenant }
        );
        expect(session.branch_id).toBe(branch.branch_id);
        // Baseline fails here: unarchive returned success but cleaned survived.
        expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('ready');
        expect((await rows.findById(branch.branch_id))?.archived_at).toBeUndefined();
        expect((await rows.findById(branch.branch_id))?.archived_by).toBeUndefined();
      });
      if (retained) {
        expect((await git.revparse(['refs/heads/home'])).trim()).toBe(retainedSha);
        expect((await createGit(path).git.revparse(['HEAD'])).trim()).toBe(retainedSha);
      }
      if (
        scenario === 'missing-home' ||
        scenario === 'missing-workspace' ||
        scenario === 'stale-registration'
      ) {
        await expect(readFile(join(path, 'personal.md'))).rejects.toThrow();
        await expect(import('node:fs/promises').then(({ lstat }) => lstat(path))).rejects.toThrow();
      } else if (scenario !== 'deleted-git')
        expect(await readFile(join(path, 'personal.md'), 'utf8')).toBe('irreplaceable memory');
    } finally {
      for (const client of observers) client.io.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
