import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import {
  BranchRepository,
  CapabilityPolicyRepository,
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
import { dbTest, setTestBranchUserRole } from '../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';
import type { TasksService } from './services/tasks.js';
import { completionCallbackTaskId } from './utils/durable-task-id.js';

const config = {
  database: { dialect: 'sqlite' },
  multi_tenancy: { mode: 'static', static_tenant_id: DEFAULT_STATIC_TENANT_ID },
  daemon: { mcpEnabled: false },
  execution: {},
} as RegisterHooksContext['config'];
const tenant = { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'static' as const };

dbTest(
  'external writes cannot choose the callback principal that runs the callback task',
  async ({ db: rawDb }) => {
    const usersRepository = new UsersRepository(rawDb);
    const attacker = await usersRepository.create({
      user_id: generateId() as UserID,
      email: 'callback-attacker@example.test',
      name: 'Callback attacker',
      role: 'member',
    });
    const victim = await usersRepository.create({
      user_id: generateId() as UserID,
      email: 'callback-victim@example.test',
      name: 'Callback victim',
      role: 'member',
    });

    const repo = await new RepoRepository(rawDb).create({
      repo_id: generateId() as UUID,
      slug: `callback-principal-${generateId()}`,
      name: 'Callback principal',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/callback-principal.git',
      local_path: `/tmp/callback-principal-${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(rawDb).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'callback-principal',
      ref: 'main',
      branch_unique_id: 9_300_001,
      path: `/tmp/callback-principal-branch-${generateId()}`,
      created_by: attacker.user_id,
    });

    // The victim can prompt the attacker's shared branch-home sessions, which
    // is what made a forged victim principal pass runtime admission.
    const policies = new CapabilityPolicyRepository(rawDb);
    await policies.setWorkspacePreferences({ session_sharing_enabled: true }, attacker.user_id);
    await setTestBranchUserRole(
      rawDb,
      branch.branch_id,
      victim.user_id,
      'collaborator',
      'read',
      attacker.user_id
    );
    const branchPolicy = await policies.getBranchPolicy(branch.branch_id);
    const branchOverride = structuredClone(branchPolicy.override_config);
    if (!branchOverride) throw new Error('Expected branch policy override');
    branchOverride.allow_shared_session_prompts = true;
    await policies.replaceBranchPolicy(
      branch.branch_id,
      { ...branchPolicy, override_config: branchOverride },
      attacker.user_id
    );

    const sessionsRepository = new SessionRepository(rawDb);
    const createSession = (readyForPrompt: boolean) =>
      sessionsRepository.create({
        session_id: generateId() as SessionID,
        branch_id: branch.branch_id,
        created_by: attacker.user_id,
        agentic_tool: 'codex',
        sdk_home_scope: 'branch',
        status: SessionStatus.IDLE,
        ready_for_prompt: readyForPrompt,
      });
    const targetSession = await createSession(false);
    const childSession = await createSession(true);

    const tasksRepository = new TaskRepository(rawDb);
    const childTask = await tasksRepository.createPending({
      task_id: generateId() as TaskID,
      session_id: childSession.session_id,
      created_by: attacker.user_id,
      full_prompt: 'Complete normally so the configured callback fires.',
      status: TaskStatus.QUEUED,
    });
    expect(
      await tasksRepository.claimDispatchAndProjectSession(childTask.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).toMatchObject({ outcome: 'claimed' });
    await tasksRepository.connectExecutor(childTask.task_id);

    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'callback-principal' });
    const triggerQueueProcessing = vi.fn(async () => undefined);
    const server = await boardMetadataTestApp(db, config, false, false, true, async (app) => {
      Object.assign(app.service('sessions'), { triggerQueueProcessing });
    });
    const asAttacker = {
      provider: 'rest',
      authenticated: true,
      user: attacker,
      tenant,
    } as never;
    const patchCallback = (sessionId: SessionID, callback_config: Record<string, unknown>) =>
      server.app.service('sessions').patch(sessionId, { callback_config }, asAttacker);
    const storedCallback = async (sessionId: SessionID) =>
      (await sessionsRepository.findById(sessionId))?.callback_config;

    try {
      const attackerPrompt = 'Callback template chosen by the target session manager.';
      await patchCallback(targetSession.session_id, { enabled: true, template: attackerPrompt });

      await patchCallback(childSession.session_id, {
        enabled: true,
        callback_session_id: targetSession.session_id,
        callback_created_by: victim.user_id,
        callback_mode: 'once',
        include_last_message: false,
        include_original_prompt: false,
      });
      expect(await storedCallback(childSession.session_id)).toMatchObject({
        callback_session_id: targetSession.session_id,
        callback_created_by: attacker.user_id,
      });

      // Re-pointing only the principal, without touching the target, is discarded too.
      await patchCallback(childSession.session_id, { callback_created_by: victim.user_id });
      expect(await storedCallback(childSession.session_id)).toMatchObject({
        callback_created_by: attacker.user_id,
      });

      // External create stamps the caller as well.
      const created = (await server.app.service('sessions').create(
        {
          branch_id: branch.branch_id,
          agentic_tool: 'codex',
          status: SessionStatus.IDLE,
          callback_config: {
            enabled: true,
            callback_session_id: targetSession.session_id,
            callback_created_by: victim.user_id,
          },
        },
        asAttacker
      )) as Session;
      expect(await storedCallback(created.session_id)).toMatchObject({
        callback_created_by: attacker.user_id,
      });

      const tasksService = server.app.service('tasks') as unknown as TasksService;
      Object.assign(tasksService, { autoTitleSession: vi.fn(async () => undefined) });
      await runWithTenantDatabaseScope(db, DEFAULT_STATIC_TENANT_ID, () =>
        tasksService.patch(
          childTask.task_id,
          { status: TaskStatus.COMPLETED, completed_at: '2026-10-07T12:00:00.000Z' },
          {
            provider: undefined,
            tenant: { tenant_id: DEFAULT_STATIC_TENANT_ID, source: 'explicit' },
            suppressTerminalQueueProcessing: true,
          }
        )
      );

      const callbackTaskId = completionCallbackTaskId(childTask.task_id, targetSession.session_id);
      expect(await tasksRepository.findById(callbackTaskId)).toMatchObject({
        session_id: targetSession.session_id,
        created_by: attacker.user_id,
        full_prompt: attackerPrompt,
        status: TaskStatus.QUEUED,
        metadata: { is_agor_callback: true, queued_by_user_id: attacker.user_id },
      });

      await sessionsRepository.update(targetSession.session_id, {
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
      expect(
        await tasksRepository.claimDispatchAndProjectSession(callbackTaskId, TaskStatus.QUEUED, {
          status: TaskStatus.DISPATCHING,
        })
      ).toMatchObject({ outcome: 'claimed' });
      expect(await tasksRepository.bindExecutorLaunchAuthority(callbackTaskId)).toMatchObject({
        principal_user_id: attacker.user_id,
        session_id: targetSession.session_id,
      });
    } finally {
      await server.close();
    }
  },
  30_000
);
