import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, UserID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

dbTest(
  'binds a spawned child callback to the child owner, not the parent owner',
  async ({ db }) => {
    const users = new UsersRepository(db);
    const parentOwner = await users.create({
      email: `spawn-parent-${generateId()}@example.com`,
      name: 'Parent owner',
    });
    const caller = await users.create({
      email: `spawn-caller-${generateId()}@example.com`,
      name: 'Shared-session caller',
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `spawn-callback-${generateId()}`,
      name: 'Spawn callback',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/spawn-callback.git',
      local_path: '/tmp/spawn-callback',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'spawn-callback',
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: '/tmp/spawn-callback',
      created_by: parentOwner.user_id,
    });
    const parent = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: parentOwner.user_id,
      sdk_home_scope: 'branch',
      genealogy: { children: [] },
    });

    const app = {
      service: (path: string) => {
        if (path === 'users') return { get: (id: string) => users.findById(id as UserID) };
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as Application;
    const service = new SessionsService(db, app);
    // Shared-session spawns resolve the child to the prompting caller.
    vi.spyOn(
      service as unknown as { resolveChildIdentity: () => Promise<unknown> },
      'resolveChildIdentity'
    ).mockResolvedValue({ created_by: caller.user_id, unix_username: null });

    const child = (await service.spawn(parent.session_id, { prompt: 'Delegate' })) as Session;

    expect(child.created_by).toBe(caller.user_id);
    expect(child.callback_config).toMatchObject({
      callback_session_id: parent.session_id,
      callback_created_by: caller.user_id,
    });
  }
);
