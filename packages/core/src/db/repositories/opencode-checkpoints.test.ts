import type { OpenCodeCheckpointManifest, Task, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { opencodeCheckpointAttempts } from '../schema';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointRepository } from './opencode-checkpoints';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const OWNER = 'test-user';
const OTHER = 'other-user';
let branchCounter = 1;

async function createSession(
  db: Database,
  agenticTool: 'opencode' | 'codex' = 'opencode',
  owner = OWNER,
  sdkHomeScope: 'execution_home' | 'branch' = 'execution_home'
) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `checkpoints-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'test-branch',
    ref: 'main',
    branch_unique_id: branchCounter++,
    path: '/tmp/test/branch',
    created_by: owner as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: agenticTool,
    created_by: owner as UUID,
    sdk_home_scope: sdkHomeScope,
  });
  return session.session_id;
}

async function createOther(db: Database) {
  await new UsersRepository(db).create({
    user_id: OTHER as UUID,
    email: `other-${generateId()}@example.com`,
    name: 'Other',
  });
}

async function runningTask(db: Database, sessionId: string, owner = OWNER): Promise<Task> {
  const taskRepo = new TaskRepository(db);
  const created = await taskRepo.create({
    task_id: generateId(),
    session_id: sessionId as UUID,
    created_by: owner,
    full_prompt: 'Continue',
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
  });
  const connection = await taskRepo.connectExecutor(created.task_id);
  if (!connection) throw new Error('executor connection failed');
  return connection.task;
}

function manifestFor(task: Task, nativeSessionId = 'ses_native'): OpenCodeCheckpointManifest {
  return {
    version: 1,
    taskId: task.task_id,
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 4096,
    openCodeSessionId: nativeSessionId,
    openCodeVersion: '1.18.31',
  };
}

async function complete(db: Database, task: Task, holderId: string, manifest: unknown) {
  return new TaskRepository(db).updateFromExecutor(
    task.task_id,
    { status: TaskStatus.COMPLETED },
    { holderId, manifest }
  );
}

async function rows(db: Database, sessionId: string) {
  return (await select(db)
    .from(opencodeCheckpointAttempts)
    .where(eq(opencodeCheckpointAttempts.session_id, sessionId))
    .all()) as Array<typeof opencodeCheckpointAttempts.$inferSelect>;
}

/** Run one successful turn and return its manifest. */
async function turn(
  db: Database,
  sessionId: string,
  nativeSessionId = 'ses_native',
  owner = OWNER
) {
  const task = await runningTask(db, sessionId, owner);
  const holder = generateId();
  const admission = await new OpenCodeCheckpointRepository(db).begin(task.task_id, holder, owner);
  if (admission.outcome !== 'admitted') throw new Error('expected admission');
  const manifest = manifestFor(task, nativeSessionId);
  await complete(db, task, holder, manifest);
  return { task, holder, admission, manifest };
}

describe('OpenCodeCheckpointRepository', () => {
  dbTest('accepts each completed turn and hands the next turn its input', async ({ db }) => {
    const sessionId = await createSession(db);
    const first = await turn(db, sessionId);
    expect(first.admission).toMatchObject({ outcome: 'admitted', input: null });

    const second = await turn(db, sessionId);
    expect(second.admission).toMatchObject({ outcome: 'admitted', input: first.manifest });

    const states = Object.fromEntries((await rows(db, sessionId)).map((r) => [r.task_id, r.state]));
    expect(states).toEqual({
      [first.task.task_id]: 'superseded',
      [second.task.task_id]: 'accepted',
    });
  });

  dbTest('admits one holder per Task and replays the same admission', async ({ db }) => {
    const sessionId = await createSession(db);
    const prior = await turn(db, sessionId);
    const task = await runningTask(db, sessionId);
    const repo = new OpenCodeCheckpointRepository(db);
    const holder = generateId();

    const admitted = await repo.begin(task.task_id, holder, OWNER);
    await expect(repo.begin(task.task_id, holder, OWNER)).resolves.toEqual(admitted);
    await expect(repo.begin(task.task_id, generateId(), OWNER)).resolves.toEqual({
      outcome: 'duplicate',
    });
    expect(admitted).toMatchObject({ input: prior.manifest });
  });

  dbTest('refuses begin for another actor, another tool, or an inactive Task', async ({ db }) => {
    const repo = new OpenCodeCheckpointRepository(db);
    const sessionId = await createSession(db);
    const task = await runningTask(db, sessionId);
    await expect(repo.begin(task.task_id, generateId(), 'someone-else')).rejects.toThrow(
      /not active for this prompter/
    );

    const codexTask = await runningTask(db, await createSession(db, 'codex'));
    await expect(repo.begin(codexTask.task_id, generateId(), OWNER)).rejects.toThrow(
      /not active for this prompter/
    );

    await new TaskRepository(db).updateFromExecutor(task.task_id, { status: TaskStatus.FAILED });
    await expect(repo.begin(task.task_id, generateId(), OWNER)).rejects.toThrow(
      /not active for this prompter/
    );
  });

  dbTest('refuses completion from a stale holder or for another Task', async ({ db }) => {
    const sessionId = await createSession(db);
    const task = await runningTask(db, sessionId);
    const holder = generateId();
    await new OpenCodeCheckpointRepository(db).begin(task.task_id, holder, OWNER);

    await expect(complete(db, task, generateId(), manifestFor(task))).rejects.toThrow(
      /holder is not admitted/
    );
    const other = await runningTask(db, sessionId);
    await expect(complete(db, task, holder, manifestFor(other))).rejects.toThrow(
      /does not describe this Task/
    );
    await expect(
      new TaskRepository(db).updateFromExecutor(
        task.task_id,
        { status: TaskStatus.FAILED },
        { holderId: holder, manifest: manifestFor(task) }
      )
    ).rejects.toThrow(/only with completion/);
    expect((await new TaskRepository(db).findById(task.task_id))?.status).toBe(TaskStatus.RUNNING);
  });

  dbTest('refuses a turn whose input is no longer the accepted checkpoint', async ({ db }) => {
    const sessionId = await createSession(db);
    await turn(db, sessionId);
    const stale = await runningTask(db, sessionId);
    const staleHolder = generateId();
    await new OpenCodeCheckpointRepository(db).begin(stale.task_id, staleHolder, OWNER);
    // A later turn wins after the stale one began (e.g. it was force-failed and retried).
    await new TaskRepository(db).updateFromExecutor(stale.task_id, { status: TaskStatus.FAILED });
    await turn(db, sessionId);

    const resumed = await runningTask(db, sessionId);
    const holder = generateId();
    await new OpenCodeCheckpointRepository(db).begin(resumed.task_id, holder, OWNER);
    await expect(complete(db, resumed, holder, manifestFor(resumed, 'ses_other'))).rejects.toThrow(
      /different native session/
    );
    await expect(complete(db, stale, staleHolder, manifestFor(stale))).rejects.toThrow(
      /not connected and executor-writable/
    );
  });

  dbTest(
    'lists only unrestorable attempts for cleanup and forgets them once deleted',
    async ({ db }) => {
      const repo = new OpenCodeCheckpointRepository(db);
      const sessionId = await createSession(db);
      const first = await turn(db, sessionId);
      const failed = await runningTask(db, sessionId);
      await repo.begin(failed.task_id, generateId(), OWNER);
      await new TaskRepository(db).updateFromExecutor(failed.task_id, {
        status: TaskStatus.FAILED,
      });
      const second = await turn(db, sessionId);

      const deletedSession = await createSession(db);
      const orphan = await turn(db, deletedSession);
      await new SessionRepository(db).delete(deletedSession);

      const current = await runningTask(db, sessionId);
      const holder = generateId();
      const admission = await repo.begin(current.task_id, holder, OWNER);
      if (admission.outcome !== 'admitted') throw new Error('expected admission');
      expect(admission.input).toEqual(second.manifest);
      expect(admission.cleanup).toEqual(
        expect.arrayContaining([
          { sessionId, taskId: first.task.task_id },
          { sessionId, taskId: failed.task_id },
          { sessionId: deletedSession, taskId: orphan.task.task_id },
        ])
      );
      expect(admission.cleanup).toHaveLength(3);

      await expect(
        repo.acknowledgeCleanup(current.task_id, generateId(), admission.cleanup)
      ).rejects.toThrow(/admitted holder/);
      await repo.acknowledgeCleanup(current.task_id, holder, [
        ...admission.cleanup,
        { sessionId, taskId: second.task.task_id },
      ]);
      const remaining = await rows(db, sessionId);
      expect(remaining.map((row) => row.task_id).sort()).toEqual(
        [second.task.task_id, current.task_id].sort()
      );
      expect(await rows(db, deletedSession)).toEqual([]);
    }
  );

  dbTest('refuses to complete an admitted turn without its sealed checkpoint', async ({ db }) => {
    const sessionId = await createSession(db);
    const task = await runningTask(db, sessionId);
    await new OpenCodeCheckpointRepository(db).begin(task.task_id, generateId(), OWNER);

    await expect(
      new TaskRepository(db).updateFromExecutor(task.task_id, { status: TaskStatus.COMPLETED })
    ).rejects.toThrow(/requires its sealed checkpoint/);
  });

  dbTest('never lists or forgets another owner attempts', async ({ db }) => {
    await createOther(db);
    const otherSession = await createSession(db, 'opencode', OTHER);
    const theirs = await turn(db, otherSession, 'ses_other', OTHER);
    await turn(db, otherSession, 'ses_other', OTHER);

    const mine = await runningTask(db, await createSession(db));
    const holder = generateId();
    const repo = new OpenCodeCheckpointRepository(db);
    const admission = await repo.begin(mine.task_id, holder, OWNER);
    expect(admission).toMatchObject({ cleanup: [] });

    await repo.acknowledgeCleanup(mine.task_id, holder, [
      { sessionId: otherSession, taskId: theirs.task.task_id },
    ]);
    expect((await rows(db, otherSession)).map((row) => row.task_id)).toContain(theirs.task.task_id);
  });
  dbTest(
    'continues a branch-home Session across prompters, never an execution-home one',
    async ({ db }) => {
      await createOther(db);
      const shared = await createSession(db, 'opencode', OWNER, 'branch');
      const first = await turn(db, shared);
      const second = await turn(db, shared, 'ses_native', OTHER);
      expect(second.admission).toMatchObject({ input: first.manifest });
      const third = await turn(db, shared);
      expect(third.admission).toMatchObject({ input: second.manifest });

      const privateTask = await runningTask(db, await createSession(db), OTHER);
      await expect(
        new OpenCodeCheckpointRepository(db).begin(privateTask.task_id, generateId(), OTHER)
      ).rejects.toThrow(/not active for this prompter/);
    }
  );

  dbTest('cleans each checkpoint store only from a Job that mounts it', async ({ db }) => {
    await createOther(db);
    const repo = new OpenCodeCheckpointRepository(db);
    const shared = await createSession(db, 'opencode', OWNER, 'branch');
    const sharedFirst = await turn(db, shared);
    await turn(db, shared, 'ses_native', OTHER);
    const privateSession = await createSession(db);
    const privateFirst = await turn(db, privateSession);
    await turn(db, privateSession);

    // A collaborator's branch-home turn cleans the Session's superseded attempt from any prompter.
    const sharedTask = await runningTask(db, shared, OTHER);
    const sharedAdmission = await repo.begin(sharedTask.task_id, generateId(), OTHER);
    expect(sharedAdmission).toMatchObject({
      cleanup: [{ sessionId: shared, taskId: sharedFirst.task.task_id }],
    });

    // The owner's execution-home turn never lists branch-home attempts it cannot reach.
    const privateTask = await runningTask(db, privateSession);
    const privateHolder = generateId();
    const privateAdmission = await repo.begin(privateTask.task_id, privateHolder, OWNER);
    expect(privateAdmission).toMatchObject({
      cleanup: [{ sessionId: privateSession, taskId: privateFirst.task.task_id }],
    });
    await repo.acknowledgeCleanup(privateTask.task_id, privateHolder, [
      { sessionId: shared, taskId: sharedFirst.task.task_id },
    ]);
    expect((await rows(db, shared)).map((row) => row.task_id)).toContain(sharedFirst.task.task_id);
  });
});
