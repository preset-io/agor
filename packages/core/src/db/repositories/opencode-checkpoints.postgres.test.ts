import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UUID } from '../../types/id';
import { TaskStatus } from '../../types/task';
import { createDatabase, type Database } from '../client';
import { select } from '../database-wrapper';
import { runMigrations } from '../migrate';
import { opencodeCheckpointAttempts } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointRepository } from './opencode-checkpoints';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'OpenCode checkpoint ledger under PostgreSQL RLS',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await runMigrations(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    async function seedSession(scoped: Database) {
      const owner = await new UsersRepository(scoped).create({
        email: `${crypto.randomUUID()}@example.test`,
        role: 'member',
      });
      const repo = await new RepoRepository(scoped).create({
        repo_id: generateId(),
        slug: `checkpoints-${generateId()}`,
        name: 'Checkpoints',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/checkpoints.git',
        local_path: '/tmp/checkpoints',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'checkpoints',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        path: '/tmp/checkpoints/branch',
        created_by: owner.user_id,
      });
      const session = await new SessionRepository(scoped).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: owner.user_id,
      });
      return { ownerId: owner.user_id as string, sessionId: session.session_id as string };
    }

    async function turn(scoped: Database, ownerId: string, sessionId: string) {
      const tasks = new TaskRepository(scoped);
      const created = await tasks.create({
        task_id: generateId(),
        session_id: sessionId as UUID,
        created_by: ownerId,
        full_prompt: 'Continue',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
      });
      await tasks.connectExecutor(created.task_id);
      const holder = generateId();
      const admission = await new OpenCodeCheckpointRepository(scoped).begin(
        created.task_id,
        holder,
        ownerId
      );
      const manifest = {
        version: 1 as const,
        taskId: created.task_id,
        digest: `sha256:${'b'.repeat(64)}`,
        bytes: 2048,
        openCodeSessionId: 'ses_pg',
        openCodeVersion: '1.18.31',
      };
      await tasks.updateFromExecutor(
        created.task_id,
        { status: TaskStatus.COMPLETED },
        { holderId: holder, manifest }
      );
      return { admission, manifest };
    }

    it('accepts turns in order and keeps one tenant from seeing another', async () => {
      const tenantA = `checkpoints-${crypto.randomUUID()}`;
      const tenantB = `checkpoints-${crypto.randomUUID()}`;
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const { ownerId, sessionId } = await seedSession(scoped);
        const first = await turn(scoped, ownerId, sessionId);
        const second = await turn(scoped, ownerId, sessionId);
        expect(first.admission).toMatchObject({ outcome: 'admitted', input: null });
        expect(second.admission).toMatchObject({ outcome: 'admitted', input: first.manifest });
        const states = (await select(scoped).from(opencodeCheckpointAttempts).all()) as Array<{
          state: string;
        }>;
        expect(states.map((row) => row.state).sort()).toEqual(['accepted', 'superseded']);
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(await select(scoped).from(opencodeCheckpointAttempts).all()).toEqual([]);
      });
    });
  }
);
