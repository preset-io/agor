import { createRestClient } from '@agor/core/api';
import {
  BranchRepository,
  type Database,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import type { RegisterHooksContext } from '../src/register-hooks.js';
import { boardMetadataTestApp } from './board-metadata-app.js';

export async function seedQueue(db: Database) {
  const owner = await new UsersRepository(db).create({
    email: `${generateId()}@queue.test`,
    role: 'member',
  });
  const stranger = await new UsersRepository(db).create({
    email: `${generateId()}@queue.test`,
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    slug: `queue-${generateId()}`,
    name: 'Queue',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/queue.git',
    local_path: '/tmp/queue-test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: 'Queue',
    ref: 'main',
    path: `/tmp/${generateId()}`,
    branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
    created_by: owner.user_id,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    created_by: owner.user_id,
    agentic_tool: 'codex',
    status: SessionStatus.IDLE,
    ready_for_prompt: true,
  });
  const tasks = new TaskRepository(db);
  const enqueue = (prompt: string) =>
    tasks.createPending({
      session_id: session.session_id,
      full_prompt: prompt,
      created_by: owner.user_id,
      status: TaskStatus.QUEUED,
    });
  const active = await enqueue('active');
  await tasks.claimDispatchAndProjectSession(active.task_id, TaskStatus.QUEUED, {
    status: TaskStatus.DISPATCHING,
  });
  await tasks.connectExecutor(active.task_id);
  const queued = [];
  for (const prompt of ['a', 'b', 'c']) queued.push(await enqueue(prompt));
  return {
    owner,
    stranger,
    branch,
    session,
    active: (await tasks.findById(active.task_id))!,
    queued,
  };
}

export async function queueTestServer(
  db: Parameters<typeof boardMetadataTestApp>[0],
  postgres = false
) {
  return boardMetadataTestApp(
    db,
    {
      database: { dialect: postgres ? 'postgresql' : 'sqlite' },
      multi_tenancy: postgres
        ? {
            mode: 'required_from_auth',
            auth_claim: 'tenant_id',
            filesystem_isolation_enabled: true,
          }
        : { mode: 'static', tenant_id: 'default' },
      execution: {},
    } as RegisterHooksContext['config'],
    false,
    true,
    true
  );
}

export async function queueClient(
  server: Awaited<ReturnType<typeof queueTestServer>>,
  userId: ReturnType<typeof generateId>,
  tenant?: string
) {
  const client = await createRestClient(server.url);
  await client.authenticate({
    strategy: 'jwt',
    accessToken: server.headers(userId, tenant).authorization.slice(7),
  });
  return client.service('tasks');
}
