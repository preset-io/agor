/**
 * PostgreSQL integration for live MCP reprojection fencing and correlated fanout filters.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/task-mcp-reprojection-ha.postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, SessionID, TaskID, UUID } from '../types/id';
import { TaskStatus } from '../types/task';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  MCPServerRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from './repositories';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 9_000_000;

interface TenantSeed {
  tenantId: string;
  userId: UUID;
  branchId: BranchID;
  sessionId: SessionID;
}

async function seedTenant(db: Database, label: string): Promise<TenantSeed> {
  const tenantId = `task-mcp-${label}-${generateId()}`;
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}@example.com`,
      name: `Task MCP ${label}`,
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: tenantId,
      name: `Task MCP ${label}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/task-mcp.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: tenantId,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'claude-code',
    });
    return {
      tenantId,
      userId: user.user_id as UUID,
      branchId: branch.branch_id,
      sessionId: session.session_id,
    };
  });
}

function taskInput(
  seed: Pick<TenantSeed, 'sessionId' | 'userId'>,
  overrides: Record<string, unknown> = {}
) {
  return {
    task_id: generateId() as TaskID,
    session_id: seed.sessionId,
    created_by: seed.userId,
    full_prompt: 'PostgreSQL MCP reprojection probe',
    status: TaskStatus.RUNNING,
    executor_connected_at: new Date().toISOString(),
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: new Date().toISOString(),
    },
    git_state: { ref_at_start: 'main', sha_at_start: 'mcp-reprojection' },
    tool_use_count: 0,
    ...overrides,
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Task MCP reprojection HA (PostgreSQL)',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(dbA) || !isPostgresDatabase(dbB)) {
        throw new Error('PostgreSQL test requires PostgreSQL');
      }
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    it('serializes claim, immutable projection bind, validation, and settlement across connections', async () => {
      const seed = await seedTenant(dbA, 'cas');
      const task = await runWithTenantDatabaseScope(dbA, seed.tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        const task = await tasks.create(taskInput(seed));
        await tasks.recordMCPRecovery(task.task_id, () => ({
          generation: 1,
          code: 'stale_capability',
          status: 'refresh_requested',
          task_id: task.task_id,
          session_id: seed.sessionId,
          provider: {
            mode: 'in_place',
            transport_reload: true,
            retries_unstarted_call: false,
          },
          action: 'reconnect_mcp',
          message: 'Refresh PostgreSQL authority.',
          observed_at: new Date().toISOString(),
          request_id: 'pg-request',
          provider_dispatch: 'not_started',
        }));
        return task;
      });
      const claim = {
        sessionId: seed.sessionId,
        principalUserId: seed.userId,
        requestId: 'pg-request',
        expectedGeneration: 1,
        fingerprint: 'pg-request-fingerprint',
      };
      const inTenant = <T>(db: Database, work: (tasks: TaskRepository) => Promise<T>) =>
        runWithTenantDatabaseScope(db, seed.tenantId, (scoped) => work(new TaskRepository(scoped)));

      const claims = await Promise.all([
        inTenant(dbA, (tasks) => tasks.claimMCPReprojection(task.task_id, claim)),
        inTenant(dbB, (tasks) => tasks.claimMCPReprojection(task.task_id, claim)),
      ]);
      expect(claims.map(({ outcome }) => outcome).sort()).toEqual(['claimed', 'duplicate']);

      const binds = await Promise.all([
        inTenant(dbA, (tasks) =>
          tasks.bindMCPReprojectionAuthority(task.task_id, {
            ...claim,
            authorityFingerprints: ['authority-a'],
          })
        ),
        inTenant(dbB, (tasks) =>
          tasks.bindMCPReprojectionAuthority(task.task_id, {
            ...claim,
            authorityFingerprints: ['authority-b'],
          })
        ),
      ]);
      expect(binds.map(({ outcome }) => outcome).sort()).toEqual(['bound', 'stale']);
      const boundTask = await inTenant(dbA, (tasks) => tasks.findById(task.task_id));
      const installedAuthority =
        boundTask?.metadata?.mcp_reprojection_claim?.authority_fingerprints?.[0];
      expect(['authority-a', 'authority-b']).toContain(installedAuthority);
      await expect(
        inTenant(dbB, (tasks) => tasks.validateMCPReprojectionClaim(task.task_id, claim))
      ).resolves.toMatchObject({ outcome: 'current' });
      await expect(
        inTenant(dbB, (tasks) =>
          tasks.bindMCPReprojectionAuthority(task.task_id, {
            ...claim,
            authorityFingerprints: [installedAuthority!],
          })
        )
      ).resolves.toMatchObject({ outcome: 'bound' });

      const settlements = await Promise.all([
        inTenant(dbA, (tasks) => tasks.settleMCPReprojection(task.task_id, { ...claim, ok: true })),
        inTenant(dbB, (tasks) => tasks.settleMCPReprojection(task.task_id, { ...claim, ok: true })),
      ]);
      expect(settlements.map(({ outcome }) => outcome).sort()).toEqual(['settled', 'stale']);
      const settled = settlements.find(({ outcome }) => outcome === 'settled')!.task;
      expect(settled.metadata?.mcp_recovery).toBeUndefined();
      expect(settled.metadata?.mcp_recovery_settled_authority_fingerprints).toEqual([
        installedAuthority,
      ]);
      expect(settled.metadata?.mcp_recovery_settled_projection_fingerprint).toBeDefined();
    });

    it('executes correlated attachment and principal predicates with PostgreSQL booleans', async () => {
      const seed = await seedTenant(dbA, 'filters');
      await runWithTenantDatabaseScope(dbA, seed.tenantId, async (scoped) => {
        const users = new UsersRepository(scoped);
        const collaborator = await users.create({
          email: `collaborator-${generateId()}@example.com`,
          name: 'MCP collaborator',
        });
        const sessions = new SessionRepository(scoped);
        const collaboratorSession = await sessions.create({
          session_id: generateId() as SessionID,
          branch_id: seed.branchId,
          created_by: collaborator.user_id,
          agentic_tool: 'claude-code',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `pg-filter-${generateId()}`,
          transport: 'http',
          url: 'https://example.invalid/mcp',
          auth: { type: 'none' },
          scope: 'session',
          source: 'user',
          enabled: true,
        });
        const attachments = new SessionMCPServerRepository(scoped);
        await attachments.addServer(seed.sessionId, server.mcp_server_id);
        await attachments.addServer(collaboratorSession.session_id, server.mcp_server_id);
        await attachments.toggleServer(collaboratorSession.session_id, server.mcp_server_id, false);

        const tasks = new TaskRepository(scoped);
        const target = await tasks.create(
          taskInput(seed, { created_by: collaborator.user_id, full_prompt: 'target' })
        );
        await tasks.create(taskInput(seed, { full_prompt: 'owner task' }));
        await tasks.create(
          taskInput(
            { sessionId: collaboratorSession.session_id, userId: seed.userId },
            { full_prompt: 'disabled attachment' }
          )
        );
        await tasks.create(taskInput(seed, { status: TaskStatus.COMPLETED }));

        const filtered = await tasks.findActiveMCPRefreshPage({
          attachedServerId: server.mcp_server_id,
          authorityUserId: collaborator.user_id,
          credentialUserId: collaborator.user_id,
          limit: 100,
        });
        expect(filtered.tasks.map(({ task_id }) => task_id)).toEqual([target.task_id]);

        const disabled = await tasks.findActiveMCPRefreshPage({
          sessionId: collaboratorSession.session_id,
          attachedServerId: server.mcp_server_id,
          credentialUserId: seed.userId,
          limit: 100,
        });
        expect(disabled.tasks).toEqual([]);

        const ownerAuthority = await tasks.findActiveMCPRefreshPage({
          sessionId: seed.sessionId,
          authorityUserId: seed.userId,
          limit: 100,
        });
        expect(ownerAuthority.tasks).toHaveLength(1);
      });
    });
  }
);
