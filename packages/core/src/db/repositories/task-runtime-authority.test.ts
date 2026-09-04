import type { BranchID, SessionSdkHomeScope, Task, UserID, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { tasks as tasksTable } from '../schema';
import { ownedDbTest as dbTest, setTestBranchUserRole } from '../test-helpers';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository, type TaskRuntimeAuthorityScope } from './tasks';
import { UsersRepository } from './users';

let branchUnique = (Date.now() % 1_000_000) + 7_000_000;

interface RuntimeSeed {
  ownerId: UserID;
  actorId: UserID;
  sessionOwnerId: UserID;
  sessionSdkHomeScope: SessionSdkHomeScope;
  branchId: BranchID;
  task: Task;
  tasks: TaskRepository;
  authority: TaskRuntimeAuthorityScope;
}

interface RuntimeSeedOptions {
  actorRole?: 'member' | 'superadmin';
  sessionOwner?: 'actor' | 'branch_owner';
  sessionSdkHomeScope?: SessionSdkHomeScope;
  allowForeignSessionSharing?: boolean;
}

async function setForeignSessionSharing(
  db: Database,
  branchId: BranchID,
  actorId: UserID,
  enabled: boolean
): Promise<void> {
  const policies = new CapabilityPolicyRepository(db);
  await policies.setWorkspacePreferences({ session_sharing_enabled: true }, actorId);
  const current = await policies.getBranchPolicy(branchId);
  const config = structuredClone(current.override_config);
  if (!config) throw new Error('Expected an override Branch policy');
  config.allow_shared_session_prompts = enabled;
  await policies.replaceBranchPolicy(branchId, { ...current, override_config: config }, actorId);
}

async function seedRuntime(
  db: Database,
  floor: 'read' | 'write' = 'write',
  options: RuntimeSeedOptions = {}
): Promise<RuntimeSeed> {
  const users = new UsersRepository(db);
  const owner = await users.create({
    user_id: generateId() as UserID,
    email: `${generateId()}-authority-owner@example.com`,
    name: 'Authority owner',
  });
  const actor = await users.create({
    user_id: generateId() as UserID,
    email: `${generateId()}-authority-actor@example.com`,
    name: 'Authority actor',
    role: options.actorRole ?? 'member',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `runtime-authority-${generateId()}`,
    name: 'Runtime authority',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/runtime-authority.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'runtime-authority',
    ref: 'main',
    branch_unique_id: branchUnique++,
    path: `/tmp/${generateId()}`,
    created_by: owner.user_id,
  });
  await setTestBranchUserRole(
    db,
    branch.branch_id,
    actor.user_id,
    'collaborator',
    floor,
    owner.user_id
  );
  const sessionOwnerId = options.sessionOwner === 'branch_owner' ? owner.user_id : actor.user_id;
  if (options.allowForeignSessionSharing) {
    await setForeignSessionSharing(db, branch.branch_id, actor.user_id, true);
  }
  const sessionSdkHomeScope =
    options.sessionSdkHomeScope ?? (sessionOwnerId === actor.user_id ? 'execution_home' : 'branch');
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    created_by: sessionOwnerId,
    agentic_tool: 'codex',
    sdk_home_scope: sessionSdkHomeScope,
  });
  const tasks = new TaskRepository(db);
  const task = await tasks.create({
    task_id: generateId(),
    session_id: session.session_id,
    created_by: actor.user_id as UUID,
    full_prompt: 'runtime authority probe',
    status: TaskStatus.DISPATCHING,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: '2026-08-28T00:00:00.000Z',
    },
    git_state: { ref_at_start: 'main', sha_at_start: 'authority' },
    tool_use_count: 0,
  });
  const launch = await tasks.bindExecutorLaunchAuthority(task.task_id);
  expect(launch.fs_access).toBe(floor);
  await tasks.connectExecutor(task.task_id, new Date('2026-08-28T00:00:01.000Z'));
  return {
    ownerId: owner.user_id,
    actorId: actor.user_id,
    sessionOwnerId,
    sessionSdkHomeScope,
    branchId: branch.branch_id,
    task,
    tasks,
    authority: {
      token_fingerprint: 'b'.repeat(64),
      principal_user_id: actor.user_id,
      session_id: session.session_id,
      branch_id: branch.branch_id,
      standalone_token_current: true,
    },
  };
}

async function expectDeniedWithoutHeartbeatRefresh(
  seed: RuntimeSeed,
  reason:
    | 'token_revoked'
    | 'principal_unavailable'
    | 'branch_capability_revoked'
    | 'filesystem_access_revoked'
) {
  const before = await seed.tasks.findById(seed.task.task_id);
  const result = await seed.tasks.reportRuntimeTelemetry(
    seed.task.task_id,
    seed.authority,
    undefined,
    new Date('2026-08-28T00:00:10.000Z')
  );
  const after = await seed.tasks.findById(seed.task.task_id);
  expect(result).toMatchObject({ outcome: 'authorization_revoked', reason });
  expect(after?.last_executor_heartbeat_at).toBe(before?.last_executor_heartbeat_at);
}

describe('Task runtime heartbeat authority (SQLite)', () => {
  dbTest(
    'continues with the exact current principal, capability, and launch floor',
    async ({ db }) => {
      const seed = await seedRuntime(db, 'write');
      await expect(
        seed.tasks.reportRuntimeTelemetry(
          seed.task.task_id,
          seed.authority,
          undefined,
          new Date('2026-08-28T00:00:10.000Z')
        )
      ).resolves.toMatchObject({
        outcome: 'continued',
        task: { last_executor_heartbeat_at: '2026-08-28T00:00:10.000Z' },
      });
    }
  );

  dbTest('keeps superadmin runtime authority at the normalized policy access', async ({ db }) => {
    const seed = await seedRuntime(db, 'read', { actorRole: 'superadmin' });
    const branches = new BranchRepository(db);
    const branch = await branches.findById(seed.branchId);
    if (!branch) throw new Error('Expected seeded Branch');

    const [canonicalAccess, canonicalPrompt] = await Promise.all([
      branches.resolveUserAccess(branch, seed.actorId),
      branches.resolveSessionPromptAuthority(
        seed.branchId,
        seed.actorId,
        seed.sessionOwnerId,
        seed.sessionSdkHomeScope
      ),
    ]);
    expect(canonicalAccess.fs_access).toBe('read');
    expect(canonicalPrompt.allowed).toBe(true);
    await expect(
      seed.tasks.reportRuntimeTelemetry(seed.task.task_id, seed.authority)
    ).resolves.toMatchObject({ outcome: 'continued' });

    const stored = await select(db, { data: tasksTable.data })
      .from(tasksTable)
      .where(eq(tasksTable.task_id, seed.task.task_id))
      .one();
    expect(stored?.data.executor_launch_fs_access_floor).toBe('read');
  });

  dbTest('revokes a superadmin runtime when foreign-session sharing is removed', async ({ db }) => {
    const seed = await seedRuntime(db, 'read', {
      actorRole: 'superadmin',
      sessionOwner: 'branch_owner',
      allowForeignSessionSharing: true,
    });
    await expect(
      seed.tasks.reportRuntimeTelemetry(seed.task.task_id, seed.authority)
    ).resolves.toMatchObject({ outcome: 'continued' });

    await setForeignSessionSharing(db, seed.branchId, seed.actorId, false);
    await expect(
      new BranchRepository(db).resolveSessionPromptAuthority(
        seed.branchId,
        seed.actorId,
        seed.sessionOwnerId,
        seed.sessionSdkHomeScope
      )
    ).resolves.toMatchObject({ allowed: false });
    await expectDeniedWithoutHeartbeatRefresh(seed, 'branch_capability_revoked');
  });

  dbTest('denies foreign execution-home sessions even when sharing is enabled', async ({ db }) => {
    await expect(
      seedRuntime(db, 'read', {
        sessionOwner: 'branch_owner',
        sessionSdkHomeScope: 'execution_home',
        allowForeignSessionSharing: true,
      })
    ).rejects.toThrow('Authorization to launch this task is unavailable');
  });

  dbTest('denies a removed/deactivated principal without refreshing liveness', async ({ db }) => {
    const seed = await seedRuntime(db);
    await new UsersRepository(db).delete(seed.actorId);
    await expectDeniedWithoutHeartbeatRefresh(seed, 'principal_unavailable');
  });

  dbTest('denies application-capability revocation without refreshing liveness', async ({ db }) => {
    const seed = await seedRuntime(db);
    await setTestBranchUserRole(db, seed.branchId, seed.actorId, 'viewer', 'write', seed.ownerId);
    await expectDeniedWithoutHeartbeatRefresh(seed, 'branch_capability_revoked');
  });

  dbTest('denies write -> read/none and read -> none filesystem demotions', async ({ db }) => {
    for (const [floor, current] of [
      ['write', 'read'],
      ['write', 'none'],
      ['read', 'none'],
    ] as const) {
      const seed = await seedRuntime(db, floor);
      await setTestBranchUserRole(
        db,
        seed.branchId,
        seed.actorId,
        'collaborator',
        current,
        seed.ownerId
      );
      await expectDeniedWithoutHeartbeatRefresh(seed, 'filesystem_access_revoked');
    }
  });

  dbTest('does not widen an already-bound read launch after an access increase', async ({ db }) => {
    const seed = await seedRuntime(db, 'read');
    await setTestBranchUserRole(
      db,
      seed.branchId,
      seed.actorId,
      'collaborator',
      'write',
      seed.ownerId
    );
    await expect(
      seed.tasks.reportRuntimeTelemetry(seed.task.task_id, seed.authority)
    ).resolves.toMatchObject({ outcome: 'continued' });

    const stored = await select(db, { data: tasksTable.data })
      .from(tasksTable)
      .where(eq(tasksTable.task_id, seed.task.task_id))
      .one();
    expect(stored?.data.executor_launch_fs_access_floor).toBe('read');

    // A connected runtime cannot be rebound at all. Its original read floor
    // remains the only projection consumed by the heartbeat comparison.
    await expect(seed.tasks.bindExecutorLaunchAuthority(seed.task.task_id, {})).rejects.toThrow(
      'not awaiting executor launch authority'
    );
  });

  dbTest(
    'rejects wrong principal, Session, or Branch scope without stopping the runtime',
    async ({ db }) => {
      const seed = await seedRuntime(db);
      for (const mismatch of [
        { principal_user_id: generateId() },
        { session_id: generateId() },
        { branch_id: generateId() },
      ]) {
        await expect(
          seed.tasks.reportRuntimeTelemetry(seed.task.task_id, {
            ...seed.authority,
            ...mismatch,
          })
        ).resolves.toMatchObject({ outcome: 'scope_mismatch' });
      }
      await expect(seed.tasks.findById(seed.task.task_id)).resolves.toMatchObject({
        status: TaskStatus.RUNNING,
        last_executor_heartbeat_at: '2026-08-28T00:00:01.000Z',
      });
    }
  );

  dbTest('denies a stale or revoked task credential', async ({ db }) => {
    const seed = await seedRuntime(db);
    seed.authority.standalone_token_current = false;
    await expectDeniedWithoutHeartbeatRefresh(seed, 'token_revoked');
  });

  dbTest(
    'fails closed when an older live runtime has no trustworthy launch floor',
    async ({ db }) => {
      const seed = await seedRuntime(db);
      const legacy = await seed.tasks.create({
        ...seed.task,
        task_id: generateId(),
        status: TaskStatus.RUNNING,
        executor_connected_at: '2026-08-28T00:00:01.000Z',
        last_executor_heartbeat_at: '2026-08-28T00:00:01.000Z',
      });
      await expect(
        seed.tasks.reportRuntimeTelemetry(legacy.task_id, {
          ...seed.authority,
          token_fingerprint: 'd'.repeat(64),
        })
      ).resolves.toMatchObject({
        outcome: 'authorization_revoked',
        reason: 'launch_authority_missing',
      });
    }
  );
});
