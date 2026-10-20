import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, Session, SessionID, TaskID, UserID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from './auth/executor-session-token.js';
import type { RegisterHooksContext } from './register-hooks.js';

const config = {
  database: { dialect: 'sqlite' },
  multi_tenancy: { mode: 'static', static_tenant_id: DEFAULT_STATIC_TENANT_ID },
  daemon: { mcpEnabled: false },
  execution: {},
} as RegisterHooksContext['config'];
const tenant = { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'static' as const };

dbTest(
  "an executor's terminal Task patch publishes the committed Session, not its pre-commit auth cache",
  async ({ db: rawDb }) => {
    const owner = await new UsersRepository(rawDb).create({
      user_id: generateId() as UserID,
      email: 'terminal-publication@example.test',
      name: 'Terminal publication',
      role: 'member',
    });
    const repo = await new RepoRepository(rawDb).create({
      repo_id: generateId() as UUID,
      slug: `terminal-publication-${generateId()}`,
      name: 'Terminal publication',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/terminal-publication.git',
      local_path: `/tmp/terminal-publication-${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(rawDb).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'terminal-publication',
      ref: 'main',
      branch_unique_id: 9_300_101,
      path: `/tmp/terminal-publication-branch-${generateId()}`,
      created_by: owner.user_id,
    });
    const sessionsRepository = new SessionRepository(rawDb);
    const session = await sessionsRepository.create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      created_by: owner.user_id,
      agentic_tool: 'codex',
      sdk_home_scope: 'branch',
      title: 'Titled, so auto-title publishes nothing',
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    });

    const tasksRepository = new TaskRepository(rawDb);
    const task = await tasksRepository.createPending({
      task_id: generateId() as TaskID,
      session_id: session.session_id,
      created_by: owner.user_id,
      full_prompt: 'Finish this turn.',
      status: TaskStatus.QUEUED,
    });
    expect(
      await tasksRepository.claimDispatchAndProjectSession(task.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).toMatchObject({ outcome: 'claimed' });
    await tasksRepository.connectExecutor(task.task_id);
    expect(await sessionsRepository.findById(session.session_id)).toMatchObject({
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
    });

    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'terminal-session-publication' });
    const server = await boardMetadataTestApp(db, config, false, false, true, async (app) => {
      Object.assign(app.service('sessions'), {
        triggerQueueProcessing: vi.fn(async () => undefined),
      });
    });
    const published: Session[] = [];
    server.app.service('sessions').on('patched', (patched: Session) => {
      if (patched.session_id === session.session_id) published.push(patched);
    });
    // The executor's own transport request: its auth hooks cache the RUNNING Session on params.
    const executorParams = {
      provider: 'rest',
      authenticated: true,
      user: owner,
      tenant,
      authentication: {
        strategy: 'jwt',
        accessToken: 'executor-access-token',
        payload: {
          type: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          session_id: session.session_id,
          task_id: task.task_id,
          branch_id: branch.branch_id,
          sub: owner.user_id,
          tenant_id: DEFAULT_STATIC_TENANT_ID,
        },
      },
    } as never;

    try {
      await runWithTenantDatabaseScope(db, DEFAULT_STATIC_TENANT_ID, () =>
        server.app
          .service('tasks')
          .patch(
            task.task_id,
            { status: TaskStatus.COMPLETED, completed_at: '2026-10-15T12:00:00.000Z' },
            executorParams
          )
      );

      expect(await sessionsRepository.findById(session.session_id)).toMatchObject({
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ status: SessionStatus.IDLE, ready_for_prompt: true });
    } finally {
      await server.close();
    }
  },
  30_000
);
