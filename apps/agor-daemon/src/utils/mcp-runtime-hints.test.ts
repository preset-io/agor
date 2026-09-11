import { randomUUID } from 'node:crypto';
import * as coreDb from '@agor/core/db';
import {
  BranchRepository,
  type Database,
  RepoRepository,
  SessionRepository,
  setMCPEgressGatewayMode,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { mcpRuntimeProviderCapability } from '@agor/core/mcp';
import { TaskStatus, type UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  degradeMcpRuntimeRecoveryForDirectMode,
  didMcpPrincipalRoleChange,
  isMcpRuntimeRecoveryEnabled,
  scheduleMcpRuntimeHint,
} from './mcp-runtime-hints.js';

const provider = mcpRuntimeProviderCapability('claude-code');

async function seedRunningTask(db: Database) {
  const user = await new UsersRepository(db).create({
    email: `${randomUUID()}@example.test`,
    name: 'MCP runtime hint owner',
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: randomUUID() as UUID,
    slug: `mcp-runtime-${randomUUID()}`,
    name: 'MCP runtime hint test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/repo.git',
    local_path: `/tmp/${randomUUID()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: randomUUID(),
    repo_id: repo.repo_id,
    name: 'mcp-runtime-hint-test',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${randomUUID()}`,
    created_by: user.user_id as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: randomUUID(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    created_by: user.user_id,
  });
  const taskRepository = new TaskRepository(db);
  const task = await taskRepository.create({
    task_id: randomUUID(),
    session_id: session.session_id,
    created_by: user.user_id,
    full_prompt: 'exercise direct-mode recovery rollback',
    status: TaskStatus.RUNNING,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: new Date().toISOString(),
    },
    git_state: { ref_at_start: 'main', sha_at_start: 'test' },
    tool_use_count: 0,
  });
  await taskRepository.recordMCPRecovery(task.task_id, () => ({
    generation: 7,
    code: 'stale_capability',
    status: 'refresh_requested',
    task_id: task.task_id,
    session_id: session.session_id,
    provider,
    action: 'reconnect_mcp',
    message: 'Reconnect MCP.',
    observed_at: new Date().toISOString(),
    request_id: randomUUID(),
    refresh_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    provider_dispatch: 'not_started',
  }));
  return { task, user };
}

describe('MCP runtime recovery rollout modes', () => {
  for (const mode of ['off', 'observe'] as const) {
    dbTest(
      `${mode} mode degrades pending mediated recovery to truthful next-turn state`,
      async ({ db }) => {
        const { task, user } = await seedRunningTask(db);
        if (mode === 'observe') await setMCPEgressGatewayMode(db, mode, user.user_id);

        expect(await isMcpRuntimeRecoveryEnabled(db)).toBe(false);
        const result = await degradeMcpRuntimeRecoveryForDirectMode(db, task.task_id, provider);

        expect(result.changed).toBe(true);
        expect(result.task.metadata?.mcp_recovery).toMatchObject({
          generation: 8,
          status: 'action_required',
          action: 'retry_next_turn',
        });
        expect(result.task.metadata?.mcp_recovery?.request_id).toBeUndefined();
        expect(result.task.metadata?.mcp_recovery?.refresh_deadline_at).toBeUndefined();

        const failed = await new TaskRepository(db).recordMCPRecovery(task.task_id, (current) => ({
          ...current!,
          generation: 9,
          status: 'action_required',
          code: 'provider_refresh_failed',
          action: 'reconnect_mcp',
          request_id: randomUUID(),
        }));
        expect(failed.metadata?.mcp_recovery?.action).toBe('reconnect_mcp');
        const failedResult = await degradeMcpRuntimeRecoveryForDirectMode(
          db,
          task.task_id,
          provider
        );
        expect(failedResult.task.metadata?.mcp_recovery).toMatchObject({
          generation: 10,
          status: 'action_required',
          action: 'retry_next_turn',
        });
      }
    );
  }

  for (const mode of ['compatibility', 'enforced'] as const) {
    dbTest(`${mode} mode retains pending mediated recovery`, async ({ db }) => {
      const { task, user } = await seedRunningTask(db);
      await setMCPEgressGatewayMode(db, mode, user.user_id);

      expect(await isMcpRuntimeRecoveryEnabled(db)).toBe(true);
      const result = await degradeMcpRuntimeRecoveryForDirectMode(db, task.task_id, provider);

      expect(result.changed).toBe(false);
      expect(result.task.metadata?.mcp_recovery).toMatchObject({
        generation: 7,
        status: 'refresh_requested',
        action: 'reconnect_mcp',
      });
    });
  }
});

describe('MCP runtime hint containment', () => {
  it('signals principal authority only for an actual role transition', () => {
    expect(didMcpPrincipalRoleChange({ role: 'member' }, 'member', 'member')).toBe(false);
    expect(didMcpPrincipalRoleChange({ name: 'Updated' }, 'member', 'admin')).toBe(false);
    expect(didMcpPrincipalRoleChange({ role: 'admin' }, 'member', 'admin')).toBe(true);
  });

  it('contains a synchronous tenant-scope setup throw from the scheduled body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(coreDb, 'runWithoutTenantDatabaseScope').mockImplementationOnce(() => {
      throw new Error('SECRET_SYNC_SCOPE_FAILURE');
    });
    const work = vi.fn(async () => undefined);

    scheduleMcpRuntimeHint({} as TenantScopeAwareDatabase, 'tenant-a', 'test_sync_throw', work);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[MCP Runtime] event=hint_failed code=test_sync_throw')
    );
    expect(work).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_SYNC_SCOPE_FAILURE');
  });
});
