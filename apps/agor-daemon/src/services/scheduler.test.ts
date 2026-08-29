import {
  AgenticToolPresetRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  MCPServerRepository,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionMCPServerRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { resolveSessionDefaults } from '@agor/core/sessions';
import type { Branch, Schedule, Session, Task, UserID } from '@agor/core/types';
import {
  capabilityPolicyPresetCapabilities,
  SessionStatus,
  TaskStatus,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { describe, expect, it, type MockInstance, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  materializeScheduleAgenticToolConfig,
  renderSchedulePrompt,
  type ScheduleNotReadyError,
  SchedulerService,
} from './scheduler';

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'b' as Branch['branch_id'],
    repo_id: 'r',
    name: 'feat-auth',
    ref: 'feat-auth',
    new_branch: true,
    needs_attention: false,
    archived: false,
    last_used: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'u',
    path: '/tmp/feat-auth',
    issue_url: 'https://github.com/org/repo/issues/42',
    pull_request_url: 'https://github.com/org/repo/pull/7',
    notes: 'wip notes',
    custom_context: { team: 'platform' },
    ...overrides,
  } as Branch;
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    schedule_id: 'sched-1' as Schedule['schedule_id'],
    branch_id: 'b' as Schedule['branch_id'],
    name: 'Hourly heartbeat',
    cron_expression: '0 * * * *',
    timezone_mode: 'utc',
    prompt: 'noop',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'u' as Schedule['created_by'],
    ...overrides,
  };
}

const NOW = Date.parse('2026-05-24T15:00:00Z');

type SchedulerDb = ConstructorParameters<typeof SchedulerService>[0];
type CreateUserData = Parameters<UsersRepository['create']>[0];

async function seedRunnableSchedule(
  db: SchedulerDb,
  creatorData: CreateUserData,
  agenticToolConfig: Schedule['agentic_tool_config']
) {
  const creator = await new UsersRepository(db).create(creatorData);
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `scheduler-spawn-${generateId()}`,
    name: 'Scheduler spawn test',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'scheduler-spawn-test',
    ref: 'scheduler-spawn-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: creator.user_id,
  });
  const schedule = await new ScheduleRepository(db).create({
    branch_id: branch.branch_id,
    created_by: creator.user_id,
    name: 'Runtime default',
    cron_expression: '0 * * * *',
    timezone_mode: 'utc',
    prompt: 'Run now',
    enabled: true,
    retention: 0,
    allow_concurrent_runs: false,
    agentic_tool_config: agenticToolConfig,
  });
  return { branch, creator, schedule };
}

function createSchedulerApp(db: SchedulerDb) {
  const sessions = new SessionRepository(db);
  const workIdentity = { instanceId: 'test-daemon', bootId: 'test-boot' } as const;
  const sessionEvent = vi.fn();
  const removeSession = vi.fn(async (id: string) => {
    await sessions.delete(id);
  });
  const prompt = vi.fn(
    async (data: { prompt: string; idempotencyTaskId: string }, params: any) =>
      ({
        task_id: data.idempotencyTaskId,
        session_id: params.route.id,
        status: TaskStatus.DISPATCHING,
        full_prompt: data.prompt,
      }) as Task
  );
  const app = {
    get: (name: string) => (name === 'distributedWorkIdentity' ? workIdentity : undefined),
    service: (path: string) => {
      if (path === 'sessions') {
        return {
          emit: sessionEvent,
          patch: (id: string, data: Partial<Session>) => sessions.update(id, data),
          remove: removeSession,
        };
      }
      if (path === '/sessions/:id/prompt') return { create: prompt };
      if (path === 'session-mcp-servers') return { emit: vi.fn() };
      throw new Error(`Unexpected service: ${path}`);
    },
  } as unknown as ConstructorParameters<typeof SchedulerService>[1];
  return { app, prompt, removeSession, sessionEvent, workIdentity };
}

describe('scheduler HA occurrence recovery', () => {
  const killStages = [
    'afterSessionAdmission',
    'afterMcpAttachments',
    'afterPromptDispatch',
    'afterRetention',
    'afterMetadata',
  ] as const;

  dbTest('uses the application-owned diagnostic identity across consumers', async ({ db }) => {
    const { app, workIdentity } = createSchedulerApp(db);
    const first = new SchedulerService(db, app);
    const second = new SchedulerService(db, app);
    const readIdentity = (scheduler: SchedulerService) =>
      (
        scheduler as unknown as {
          config: { workIdentity: typeof workIdentity };
        }
      ).config.workIdentity;

    expect(readIdentity(first)).toBe(workIdentity);
    expect(readIdentity(second)).toBe(workIdentity);
  });

  for (const stage of killStages) {
    dbTest(`recovers a replacement scheduler killed at ${stage}`, async ({ db }) => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      try {
        const { creator, schedule } = await seedRunnableSchedule(
          db,
          {
            email: `scheduler-recovery-${stage}-${Math.random()}@example.com`,
            name: 'Schedule creator',
          },
          { agentic_tool: 'claude-code' }
        );
        const mcpServer = await new MCPServerRepository(db).create({
          name: `scheduler-recovery-${stage}-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          scope: 'global',
          source: 'user',
          enabled: true,
        });
        await new ScheduleRepository(db).update(schedule.schedule_id, {
          mcp_server_ids: [mcpServer.mcp_server_id],
        });
        const { app, prompt } = createSchedulerApp(db);
        let killed = false;
        const crash = async () => {
          if (killed) return;
          killed = true;
          throw new Error(`simulated kill at ${stage}`);
        };
        const first = new SchedulerService(db, app, {
          testHooks: { [stage]: crash },
          workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
        });
        await expect(
          first.executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        ).rejects.toThrow(`simulated kill at ${stage}`);

        const replacement = new SchedulerService(db, app, {
          workIdentity: { instanceId: 'daemon-b', bootId: 'boot-b' },
        });
        const recovered = await replacement.executeScheduleNow({
          scheduleId: schedule.schedule_id,
          triggeredBy: creator.user_id,
        });

        const sessions = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
        expect(sessions).toHaveLength(1);
        expect(recovered.session_id).toBe(sessions[0].session_id);
        expect(await new SessionMCPServerRepository(db).count(recovered.session_id)).toBe(1);
        const taskIds = prompt.mock.calls.map((call) => call[0].idempotencyTaskId);
        expect(new Set(taskIds).size).toBeLessThanOrEqual(1);
        const updated = await new ScheduleRepository(db).findById(schedule.schedule_id);
        expect(updated?.last_run_session_id).toBe(recovered.session_id);
      } finally {
        nowSpy.mockRestore();
      }
    });
  }

  dbTest('background recovery is independent of cron grace and manual retry', async ({ db }) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-late-recovery-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code' }
      );
      const { app, prompt } = createSchedulerApp(db);
      const killed = new SchedulerService(db, app, {
        tenantId: 'default',
        testHooks: {
          afterSessionAdmission: () => {
            throw new Error('simulated process death');
          },
        },
      });
      await expect(
        killed.executeScheduleNow({
          scheduleId: schedule.schedule_id,
          triggeredBy: creator.user_id,
        })
      ).rejects.toThrow('simulated process death');

      nowSpy.mockReturnValue(NOW + 10 * 60_000);
      const replacement = new SchedulerService(db, app, { tenantId: 'default' });
      await (
        replacement as unknown as {
          tick(): Promise<unknown>;
        }
      ).tick();

      expect(prompt).toHaveBeenCalledOnce();
      const [session] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
      expect(
        await new SessionRepository(db).isScheduledInitializationComplete(session.session_id)
      ).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  dbTest(
    'already-dispatched recovery does not reload mutable creator launch state',
    async ({ db }) => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      let creatorLookup: MockInstance<UsersRepository['findById']> | undefined;
      try {
        const { creator, schedule } = await seedRunnableSchedule(
          db,
          {
            email: `scheduler-durable-recovery-${Math.random()}@example.com`,
            name: 'Schedule creator',
          },
          { agentic_tool: 'claude-code' }
        );
        await new ScheduleRepository(db).update(schedule.schedule_id, { enabled: false });
        const initialTaskId = generateId();
        const session = await new SessionRepository(db).create({
          session_id: generateId(),
          branch_id: schedule.branch_id,
          created_by: creator.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          scheduled_from_branch: true,
          scheduled_run_at: NOW,
          schedule_id: schedule.schedule_id,
          custom_context: {
            scheduled_run: {
              rendered_prompt: 'already durably dispatching',
              run_index: 1,
              initial_task_id: initialTaskId,
              schedule_config_snapshot: {
                schedule_id: schedule.schedule_id,
                cron: schedule.cron_expression,
                timezone: 'UTC',
                retention: schedule.retention,
                allow_concurrent_runs: schedule.allow_concurrent_runs,
                mcp_server_ids: [],
              },
            },
          },
        });
        const tasks = new TaskRepository(db);
        const pending = await tasks.createPending({
          task_id: initialTaskId,
          session_id: session.session_id,
          full_prompt: 'already durably dispatching',
          created_by: creator.user_id,
          status: TaskStatus.CREATED,
        });
        await tasks.claimDispatchAndProjectSession(pending.task_id, TaskStatus.CREATED, {
          status: TaskStatus.DISPATCHING,
          started_at: new Date(NOW).toISOString(),
          message_range: {
            start_index: 0,
            end_index: 1,
            start_timestamp: new Date(NOW).toISOString(),
          },
        });

        creatorLookup = vi
          .spyOn(UsersRepository.prototype, 'findById')
          .mockRejectedValue(new Error('durable recovery must not reload the creator'));
        const { app, prompt } = createSchedulerApp(db);
        await (
          new SchedulerService(db, app, { tenantId: 'default' }) as unknown as {
            tick(): Promise<unknown>;
          }
        ).tick();

        expect(creatorLookup).not.toHaveBeenCalled();
        expect(prompt).toHaveBeenCalledOnce();
        expect(prompt.mock.calls[0][1].user).toBeUndefined();
        expect(
          await new SessionRepository(db).isScheduledInitializationComplete(session.session_id)
        ).toBe(true);
      } finally {
        creatorLookup?.mockRestore();
        nowSpy.mockRestore();
      }
    }
  );

  dbTest('recovers an admitted occurrence after its schedule is deleted', async ({ db }) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-deleted-recovery-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code' }
      );
      const initialTaskId = generateId();
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: schedule.branch_id,
        created_by: creator.user_id,
        agentic_tool: 'claude-code',
        status: 'idle',
        scheduled_from_branch: true,
        scheduled_run_at: NOW,
        schedule_id: schedule.schedule_id,
        custom_context: {
          scheduled_run: {
            rendered_prompt: 'prompt preserved before schedule deletion',
            run_index: 1,
            initial_task_id: initialTaskId,
            schedule_config_snapshot: {
              schedule_id: schedule.schedule_id,
              cron: schedule.cron_expression,
              timezone: 'UTC',
              retention: schedule.retention,
              allow_concurrent_runs: schedule.allow_concurrent_runs,
              mcp_server_ids: [],
            },
          },
        },
      });
      await new ScheduleRepository(db).delete(schedule.schedule_id);

      expect((await new SessionRepository(db).findById(session.session_id))?.schedule_id).toBe(
        undefined
      );
      const { app, prompt } = createSchedulerApp(db);
      await (
        new SchedulerService(db, app, { tenantId: 'default' }) as unknown as {
          tick(): Promise<unknown>;
        }
      ).tick();

      expect(prompt).toHaveBeenCalledOnce();
      expect(prompt.mock.calls[0][0]).toMatchObject({
        prompt: 'prompt preserved before schedule deletion',
        idempotencyTaskId: initialTaskId,
      });
      expect(
        await new SessionRepository(db).isScheduledInitializationComplete(session.session_id)
      ).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  dbTest('five concurrent scheduler instances create one occurrence', async ({ db }) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-five-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code' }
      );
      const { app, prompt, sessionEvent } = createSchedulerApp(db);
      const schedulers = Array.from(
        { length: 5 },
        (_, index) =>
          new SchedulerService(db, app, {
            workIdentity: { instanceId: `daemon-${index}`, bootId: `boot-${index}` },
          })
      );

      const sessions = await Promise.all(
        schedulers.map((scheduler) =>
          scheduler.executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        )
      );

      expect(new Set(sessions.map((session) => session.session_id)).size).toBe(1);
      expect(await new SessionRepository(db).findByScheduleId(schedule.schedule_id)).toHaveLength(
        1
      );
      expect(new Set(prompt.mock.calls.map((call) => call[0].idempotencyTaskId)).size).toBe(1);
      expect(sessionEvent.mock.calls.filter(([event]) => event === 'created')).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  dbTest('cron and manual triggers in the same minute share one occurrence', async ({ db }) => {
    const collisionNow = NOW + 30_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(collisionNow);
    try {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-collision-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code' }
      );
      const { app } = createSchedulerApp(db);
      const cron = new SchedulerService(db, app);
      const manual = new SchedulerService(db, app);

      await Promise.all([
        (
          cron as unknown as {
            processSchedule(schedule: Schedule, now: number): Promise<void>;
          }
        ).processSchedule(schedule, collisionNow),
        manual.executeScheduleNow({
          scheduleId: schedule.schedule_id,
          triggeredBy: creator.user_id,
        }),
      ]);

      expect(await new SessionRepository(db).findByScheduleId(schedule.schedule_id)).toHaveLength(
        1
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  dbTest('allow_concurrent_runs=false treats incomplete initialization as busy', async ({ db }) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-busy-init-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code' }
      );
      await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: schedule.branch_id,
        created_by: creator.user_id,
        agentic_tool: 'claude-code',
        status: 'idle',
        scheduled_from_branch: true,
        scheduled_run_at: NOW - 60_000,
        schedule_id: schedule.schedule_id,
      });
      const { app } = createSchedulerApp(db);

      await expect(
        new SchedulerService(db, app).executeScheduleNow({
          scheduleId: schedule.schedule_id,
          triggeredBy: creator.user_id,
        })
      ).rejects.toMatchObject({ code: 'schedule_busy' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  dbTest(
    'diagnoses an unusable snapshotted MCP server and does not poison future runs',
    async ({ db }) => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      try {
        const { creator, schedule } = await seedRunnableSchedule(
          db,
          { email: `scheduler-owner-${generateId()}@example.test`, name: 'Schedule creator' },
          { agentic_tool: 'claude-code' }
        );
        const other = await new UsersRepository(db).create({
          email: `scheduler-other-${generateId()}@example.test`,
          name: 'Other owner',
        });
        const privateServer = await new MCPServerRepository(db).create({
          name: `scheduler-private-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          args: [],
          scope: 'session',
          source: 'user',
          enabled: true,
          owner_user_id: other.user_id,
        });
        await new ScheduleRepository(db).update(schedule.schedule_id, {
          mcp_server_ids: [privateServer.mcp_server_id],
        });
        const { app, prompt } = createSchedulerApp(db);
        const scheduler = new SchedulerService(db, app);

        await expect(
          scheduler.executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        ).rejects.toThrow('Scheduled occurrence initialization failed');

        const [poison] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
        expect(poison).toMatchObject({
          status: SessionStatus.FAILED,
          scheduler_init_failure_code: 'mcp_server_not_usable',
          scheduler_init_failure_stage: 'mcp_attachment',
          scheduler_init_attempt_count: 1,
        });
        expect(poison.scheduler_init_retry_at).toBeUndefined();
        expect(
          await new SessionRepository(db).isScheduledInitializationComplete(poison.session_id)
        ).toBe(false);
        expect(prompt).not.toHaveBeenCalled();

        await new ScheduleRepository(db).update(schedule.schedule_id, { mcp_server_ids: [] });
        nowSpy.mockReturnValue(NOW + 60_000);
        await expect(
          scheduler.executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        ).resolves.toBeDefined();
        expect(await new SessionRepository(db).findByScheduleId(schedule.schedule_id)).toHaveLength(
          2
        );
        expect(prompt).toHaveBeenCalledOnce();
      } finally {
        nowSpy.mockRestore();
      }
    }
  );

  dbTest(
    'persists bounded retry backoff for transient prompt admission failure',
    async ({ db }) => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      try {
        const { creator, schedule } = await seedRunnableSchedule(
          db,
          { email: `scheduler-retry-${generateId()}@example.test`, name: 'Schedule creator' },
          { agentic_tool: 'claude-code' }
        );
        const { app, prompt } = createSchedulerApp(db);
        prompt.mockRejectedValueOnce(new Error('temporary prompt boundary outage'));
        const scheduler = new SchedulerService(db, app, { tenantId: 'default' });

        await expect(
          scheduler.executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        ).rejects.toThrow('Scheduled occurrence initialization failed');

        const [session] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
        expect(session).toMatchObject({
          status: SessionStatus.IDLE,
          scheduler_init_failure_code: 'initialization_transient',
          scheduler_init_failure_stage: 'prompt_admission',
          scheduler_init_attempt_count: 1,
        });
        const retryAt = Date.parse(session.scheduler_init_retry_at!);
        expect(retryAt).toBeGreaterThan(0);

        await expect(
          scheduler.executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        ).rejects.toMatchObject({ code: 'schedule_initialization_retry_pending' });
        expect(prompt).toHaveBeenCalledOnce();

        await (scheduler as unknown as { tick(): Promise<unknown> }).tick();
        expect(prompt).toHaveBeenCalledOnce();

        nowSpy.mockReturnValue(retryAt);
        const eligible = await new SessionRepository(db).findIncompleteScheduledRefs(
          10,
          undefined,
          {
            eligibleAt: retryAt,
          }
        );
        expect(eligible.map((ref) => ref.session_id)).toContain(session.session_id);
        await (
          scheduler as unknown as {
            recoverIncompleteSession(
              sessionId: Session['session_id'],
              scheduledRunAt: number,
              now: number
            ): Promise<void>;
          }
        ).recoverIncompleteSession(session.session_id, session.scheduled_run_at!, retryAt);
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(
          await new SessionRepository(db).isScheduledInitializationComplete(session.session_id)
        ).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
    }
  );

  dbTest(
    'allow_concurrent_runs=false does not treat a completed no-task history row as busy',
    async ({ db }) => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      try {
        const { creator, schedule } = await seedRunnableSchedule(
          db,
          {
            email: `scheduler-complete-history-${Math.random()}@example.com`,
            name: 'Schedule creator',
          },
          { agentic_tool: 'claude-code' }
        );
        const sessions = new SessionRepository(db);
        const historical = await sessions.create({
          session_id: generateId(),
          branch_id: schedule.branch_id,
          created_by: creator.user_id,
          agentic_tool: 'claude-code',
          status: 'idle',
          scheduled_from_branch: true,
          scheduled_run_at: NOW - 60_000,
          schedule_id: schedule.schedule_id,
        });
        await sessions.markScheduledInitializationComplete(historical.session_id);
        const { app } = createSchedulerApp(db);

        await expect(
          new SchedulerService(db, app).executeScheduleNow({
            scheduleId: schedule.schedule_id,
            triggeredBy: creator.user_id,
          })
        ).resolves.toBeDefined();
        expect(await sessions.findByScheduleId(schedule.schedule_id)).toHaveLength(2);
      } finally {
        nowSpy.mockRestore();
      }
    }
  );

  dbTest('fails closed when a schedule creator loses Collaborator access', async ({ db }) => {
    const { branch, creator: owner } = await seedRunnableSchedule(
      db,
      {
        email: `scheduler-owner-${Math.random()}@example.com`,
        name: 'Branch owner',
      },
      { agentic_tool: 'claude-code' }
    );
    const collaborator = await new UsersRepository(db).create({
      email: `scheduler-revoked-${Math.random()}@example.com`,
      name: 'Revoked schedule creator',
    });
    const policies = new CapabilityPolicyRepository(db);
    const current = await policies.getBranchPolicy(branch.branch_id);
    const collaboratorConfig = structuredClone(current.override_config!);
    collaboratorConfig.access.sharing_mode = 'shared';
    collaboratorConfig.access.entries = [
      {
        entry_id: generateId(),
        principal: { principal_type: 'user', user_id: collaborator.user_id },
        preset: 'collaborator',
        capabilities:
          capabilityPolicyPresetCapabilities('branch_access', 'collaborator', 'read') ?? [],
        fs_access: 'read',
      },
    ];
    const granted = await policies.replaceBranchPolicy(
      branch.branch_id,
      { ...current, override_config: collaboratorConfig },
      owner.user_id
    );
    const schedule = await new ScheduleRepository(db).create({
      branch_id: branch.branch_id,
      created_by: collaborator.user_id,
      name: 'Revoked creator schedule',
      cron_expression: '0 * * * *',
      timezone_mode: 'utc',
      prompt: 'Must not run',
      enabled: true,
      retention: 0,
      allow_concurrent_runs: false,
      agentic_tool_config: { agentic_tool: 'claude-code' },
    });

    const viewerConfig = structuredClone(granted.override_config!);
    viewerConfig.access.entries[0] = {
      ...viewerConfig.access.entries[0],
      preset: 'viewer',
      capabilities: capabilityPolicyPresetCapabilities('branch_access', 'viewer') ?? [],
      fs_access: 'none',
    };
    await policies.replaceBranchPolicy(
      branch.branch_id,
      { ...granted, override_config: viewerConfig },
      owner.user_id
    );

    const { app, prompt } = createSchedulerApp(db);
    await expect(
      new SchedulerService(db, app, { appRbacEnabled: true }).executeScheduleNow({
        scheduleId: schedule.schedule_id,
        triggeredBy: collaborator.user_id,
      })
    ).rejects.toMatchObject<ScheduleNotReadyError>({ code: 'schedule_permission_revoked' });
    expect(prompt).not.toHaveBeenCalled();
  });

  dbTest('retention defers active overflow occurrences until they are terminal', async ({ db }) => {
    const { creator, schedule: createdSchedule } = await seedRunnableSchedule(
      db,
      {
        email: `scheduler-retention-active-${Math.random()}@example.com`,
        name: 'Schedule creator',
      },
      { agentic_tool: 'claude-code' }
    );
    const schedule = await new ScheduleRepository(db).update(createdSchedule.schedule_id, {
      retention: 1,
    });
    const sessions = new SessionRepository(db);
    const olderActive = await sessions.create({
      session_id: generateId(),
      branch_id: schedule.branch_id,
      created_by: creator.user_id,
      agentic_tool: 'claude-code',
      status: SessionStatus.RUNNING,
      scheduled_from_branch: true,
      scheduled_run_at: NOW - 60_000,
      schedule_id: schedule.schedule_id,
    });
    const newest = await sessions.create({
      session_id: generateId(),
      branch_id: schedule.branch_id,
      created_by: creator.user_id,
      agentic_tool: 'claude-code',
      status: SessionStatus.COMPLETED,
      scheduled_from_branch: true,
      scheduled_run_at: NOW,
      schedule_id: schedule.schedule_id,
    });
    await sessions.markScheduledInitializationComplete(olderActive.session_id);
    await sessions.markScheduledInitializationComplete(newest.session_id);
    const { app, removeSession } = createSchedulerApp(db);
    const scheduler = new SchedulerService(db, app);

    await (
      scheduler as unknown as { enforceRetentionPolicy(schedule: Schedule): Promise<void> }
    ).enforceRetentionPolicy(schedule);
    expect(removeSession).not.toHaveBeenCalled();
    expect(await sessions.findById(olderActive.session_id)).not.toBeNull();

    await sessions.update(olderActive.session_id, { status: SessionStatus.COMPLETED });
    await (
      scheduler as unknown as { enforceRetentionPolicy(schedule: Schedule): Promise<void> }
    ).enforceRetentionPolicy(schedule);
    expect(removeSession).toHaveBeenCalledWith(olderActive.session_id, { provider: undefined });
    expect(await sessions.findById(olderActive.session_id)).toBeNull();
  });
});

describe('renderSchedulePrompt', () => {
  it('renders {{branch.*}} fields (canonical names)', () => {
    const out = renderSchedulePrompt(
      'Working on {{branch.name}} ({{branch.ref}}) — issue: {{branch.issue_url}}',
      makeBranch(),
      makeSchedule(),
      NOW
    );
    expect(out).toBe(
      'Working on feat-auth (feat-auth) — issue: https://github.com/org/repo/issues/42'
    );
  });

  it('renders {{worktree.*}} as a v0.19 backwards-compat alias of {{branch.*}}', () => {
    // Pre-rename schedule prompts authored against the v0.19 names must
    // keep working. The alias contract is shared with the env-template
    // context in handlebars-helpers.ts and the zone-trigger context in
    // zone-trigger-context.ts — bug-for-bug consistency across all three.
    const branch = makeBranch();
    const schedule = makeSchedule();
    const branchPrompt = renderSchedulePrompt(
      'b:{{branch.name}}|{{branch.ref}}|{{branch.issue_url}}|{{branch.notes}}|{{branch.custom_context.team}}',
      branch,
      schedule,
      NOW
    );
    const worktreePrompt = renderSchedulePrompt(
      'b:{{worktree.name}}|{{worktree.ref}}|{{worktree.issue_url}}|{{worktree.notes}}|{{worktree.custom_context.team}}',
      branch,
      schedule,
      NOW
    );
    expect(worktreePrompt).toBe(branchPrompt);
    expect(worktreePrompt).toBe(
      'b:feat-auth|feat-auth|https://github.com/org/repo/issues/42|wip notes|platform'
    );
  });

  it('exposes {{schedule.*}} for cron + scheduled-time substitutions', () => {
    const out = renderSchedulePrompt(
      'Cron={{schedule.cron}}, fires_at={{schedule.scheduled_time}}, name={{schedule.name}}',
      makeBranch(),
      makeSchedule({ name: 'Daily summary', cron_expression: '0 9 * * *' }),
      NOW
    );
    expect(out).toBe(`Cron=0 9 * * *, fires_at=${new Date(NOW).toISOString()}, name=Daily summary`);
  });

  it('falls back to the raw template when rendering throws', () => {
    // A Handlebars syntax error must not crash the scheduler tick — the
    // raw template gets handed to the agent so the user can see the bug
    // in their prompt instead of a silent skipped run.
    const out = renderSchedulePrompt('{{#if}} broken', makeBranch(), makeSchedule(), NOW);
    expect(out).toBe('{{#if}} broken');
  });
});

describe('materializeScheduleAgenticToolConfig', () => {
  dbTest(
    'rejects deferred materialization through a retained foreign tenant scope',
    async ({ db }) => {
      const guardedDb = createTenantScopedDatabaseProxy(db);
      await runWithTenantDatabaseScope(guardedDb, 'tenant-a', async (tenantADb) => {
        await expect(
          runWithTenantContext('tenant-b', () =>
            runWithTenantDatabaseScope(tenantADb, undefined, (tenantBDb) =>
              materializeScheduleAgenticToolConfig(
                tenantBDb,
                makeSchedule({ agentic_tool_config: { agentic_tool: 'codex' } })
              )
            )
          )
        ).rejects.toThrow(/tenant.*scope|scope.*tenant/i);
      });
    }
  );

  dbTest('follows the schedule creator user default on every run', async ({ db }) => {
    const users = new UsersRepository(db);
    const creator = await users.create({
      email: `scheduler-default-${Date.now()}-${Math.random()}@example.com`,
      name: 'Schedule creator',
      default_agentic_config: {
        codex: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
    });
    const schedule = makeSchedule({
      created_by: creator.user_id,
      agentic_tool_config: {
        agentic_tool: 'codex',
        configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
      },
    });

    const first = await materializeScheduleAgenticToolConfig(db, schedule);
    expect(first).toMatchObject({
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    });
    expect(first.preset_id).toBeUndefined();

    await users.update(creator.user_id, {
      default_agentic_config: {
        codex: { modelConfig: { mode: 'exact', model: 'gpt-5.5' } },
      },
    });

    const second = await materializeScheduleAgenticToolConfig(db, schedule);
    expect(second).toMatchObject({
      model_config: { mode: 'exact', model: 'gpt-5.5' },
    });
    expect(second.preset_id).toBeUndefined();
  });

  dbTest('materializes the current workspace preset as a concrete live preset', async ({ db }) => {
    const creator = await new UsersRepository(db).create({
      email: `scheduler-workspace-${Date.now()}-${Math.random()}@example.com`,
      name: 'Schedule creator',
    });
    const presets = new AgenticToolPresetRepository(db);
    const preset = await presets.create(
      {
        tool: 'codex',
        name: 'Workspace default',
        is_default: true,
        configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
      creator.user_id as UserID
    );
    const schedule = makeSchedule({
      created_by: creator.user_id,
      agentic_tool_config: {
        agentic_tool: 'codex',
        configuration_reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      },
    });

    await expect(materializeScheduleAgenticToolConfig(db, schedule)).resolves.toMatchObject({
      configuration_reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    });

    await presets.patch(
      preset.preset_id,
      { configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.5' } } },
      creator.user_id as UserID
    );

    await expect(materializeScheduleAgenticToolConfig(db, schedule)).resolves.toMatchObject({
      configuration_reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      model_config: { mode: 'exact', model: 'gpt-5.5' },
    });
  });

  dbTest('materializes an explicit preset without changing its source', async ({ db }) => {
    const creator = await new UsersRepository(db).create({
      email: `scheduler-preset-${Date.now()}-${Math.random()}@example.com`,
      name: 'Schedule creator',
    });
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'codex',
        name: 'Explicit preset',
        configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
      creator.user_id as UserID
    );

    await expect(
      materializeScheduleAgenticToolConfig(
        db,
        makeSchedule({
          created_by: creator.user_id,
          agentic_tool_config: { agentic_tool: 'codex', preset_id: preset.preset_id },
        })
      )
    ).resolves.toMatchObject({
      preset_id: preset.preset_id,
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    });
  });

  dbTest('keeps a concrete inline schedule configuration inline', async ({ db }) => {
    const creator = await new UsersRepository(db).create({
      email: `scheduler-inline-${generateId()}@example.com`,
      name: 'Schedule creator',
    });
    const config: Schedule['agentic_tool_config'] = {
      agentic_tool: 'codex',
      permission_mode: 'plan',
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    };

    await expect(
      materializeScheduleAgenticToolConfig(
        db,
        makeSchedule({ created_by: creator.user_id, agentic_tool_config: config })
      )
    ).resolves.toMatchObject({
      agentic_tool: 'codex',
      permission_mode: 'ask',
      model_config: { mode: 'exact', model: 'gpt-5.4', updated_at: expect.any(String) },
    });
  });

  dbTest('materializes before the shared spawn path creates a session', async ({ db }) => {
    const { creator, schedule } = await seedRunnableSchedule(
      db,
      {
        email: `scheduler-spawn-${Date.now()}-${Math.random()}@example.com`,
        name: 'Schedule creator',
        default_agentic_config: {
          codex: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
        },
      },
      {
        agentic_tool: 'codex',
        configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
      }
    );
    const { app, prompt } = createSchedulerApp(db);
    const scheduler = new SchedulerService(db, app);

    await scheduler.executeScheduleNow({
      scheduleId: schedule.schedule_id,
      triggeredBy: creator.user_id,
    });

    const [created] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
    expect(created).toMatchObject({
      created_by: creator.user_id,
      agentic_tool: 'codex',
      agentic_tool_preset_id: undefined,
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    });
    expect(prompt).toHaveBeenCalledOnce();
  });

  dbTest('stamps and adopts branch SDK state for a fresh scheduled session', async ({ db }) => {
    const { branch, creator, schedule } = await seedRunnableSchedule(
      db,
      {
        email: `scheduler-sdk-home-${Date.now()}-${Math.random()}@example.com`,
        name: 'Schedule creator',
      },
      { agentic_tool: 'claude-code' }
    );
    const { app } = createSchedulerApp(db);
    const scheduler = new SchedulerService(db, app, { sdkHomeMode: 'per_branch' });

    await scheduler.executeScheduleNow({
      scheduleId: schedule.schedule_id,
      triggeredBy: creator.user_id,
    });

    const [created] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
    expect(created.sdk_home_scope).toBe('branch');
    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: 'per_branch',
    });
  });

  dbTest(
    'passes preset provenance and canonical config when My default selects a preset',
    async ({ db }) => {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-preset-default-${Date.now()}-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        {
          agentic_tool: 'codex',
          configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
        }
      );
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'codex',
          name: 'Selected user default',
          configuration: {
            permissionMode: 'bypassPermissions',
            codexSandboxMode: 'danger-full-access',
            codexApprovalPolicy: 'never',
            codexNetworkAccess: true,
            modelConfig: { mode: 'exact', model: 'gpt-5.4' },
          },
        },
        creator.user_id as UserID
      );
      await new UsersRepository(db).update(creator.user_id, {
        default_agentic_selection: {
          codex: { source: 'preset', preset_id: preset.preset_id },
        },
      });
      const { app, prompt } = createSchedulerApp(db);

      await new SchedulerService(db, app).executeScheduleNow({
        scheduleId: schedule.schedule_id,
        triggeredBy: creator.user_id,
      });

      const [created] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
      expect({
        agentic_tool_preset_id: created.agentic_tool_preset_id,
        permission_config: created.permission_config,
        model_config: created.model_config,
      }).toEqual({
        agentic_tool_preset_id: preset.preset_id,
        permission_config: {
          mode: 'allow-all',
          codex: {
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'never',
            networkAccess: true,
          },
        },
        model_config: {
          mode: 'exact',
          model: 'gpt-5.4',
          updated_at: expect.any(String),
        },
      });
      expect(prompt).toHaveBeenCalledOnce();
    }
  );

  dbTest('uses system fallbacks after a user default selects workspace default', async ({ db }) => {
    const { creator, schedule } = await seedRunnableSchedule(
      db,
      {
        email: `scheduler-stale-default-${Date.now()}-${Math.random()}@example.com`,
        name: 'Schedule creator',
        default_agentic_selection: { codex: { source: 'workspace_default' } },
        default_agentic_config: {
          codex: {
            permissionMode: 'bypassPermissions',
            codexSandboxMode: 'danger-full-access',
            codexApprovalPolicy: 'never',
            modelConfig: { mode: 'exact', model: 'stale-user-model' },
          },
        },
      },
      {
        agentic_tool: 'codex',
        configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
      }
    );
    const { app } = createSchedulerApp(db);
    const expected = resolveSessionDefaults({ agenticTool: 'codex', user: null });

    await new SchedulerService(db, app).executeScheduleNow({
      scheduleId: schedule.schedule_id,
      triggeredBy: creator.user_id,
    });

    const [created] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
    expect(created).toMatchObject({
      permission_config: expected.permission_config,
      model_config: {
        ...expected.model_config,
        updated_at: expect.any(String),
      },
    });
    expect(created.model_config?.model).not.toBe('stale-user-model');
  });

  dbTest(
    're-materializes a deferred reference instead of trusting its stored snapshot',
    async ({ db }) => {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-corrupt-${Date.now()}-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        {
          agentic_tool: 'codex',
          configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
          model_config: { mode: 'exact', model: 'gpt-5.4' },
        }
      );
      const { app, prompt } = createSchedulerApp(db);

      await new SchedulerService(db, app).executeScheduleNow({
        scheduleId: schedule.schedule_id,
        triggeredBy: creator.user_id,
      });
      const [created] = await new SessionRepository(db).findByScheduleId(schedule.schedule_id);
      expect(created.model_config?.model).not.toBe('gpt-5.4');
      expect(prompt).toHaveBeenCalledOnce();
    }
  );

  dbTest(
    'returns an actionable compatibility error for a manual historical CLI schedule',
    async ({ db }) => {
      const { creator, schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-legacy-manual-${Date.now()}-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code-cli' }
      );
      const { app, prompt } = createSchedulerApp(db);

      const run = new SchedulerService(db, app).executeScheduleNow({
        scheduleId: schedule.schedule_id,
        triggeredBy: creator.user_id,
      });

      await expect(run).rejects.toMatchObject({
        name: 'ScheduleNotReadyError',
        code: 'schedule_agentic_tool_removed',
      } satisfies Partial<ScheduleNotReadyError>);
      expect(await new SessionRepository(db).findByScheduleId(schedule.schedule_id)).toHaveLength(
        0
      );
      expect(prompt).not.toHaveBeenCalled();
    }
  );

  dbTest(
    'advances a historical CLI cron cursor without recording or creating a run',
    async ({ db }) => {
      const { schedule } = await seedRunnableSchedule(
        db,
        {
          email: `scheduler-legacy-cron-${Date.now()}-${Math.random()}@example.com`,
          name: 'Schedule creator',
        },
        { agentic_tool: 'claude-code-cli' }
      );
      const { app, prompt } = createSchedulerApp(db);
      const scheduler = new SchedulerService(db, app);
      const cronNow = NOW + 30_000;

      await expect(
        (
          scheduler as unknown as {
            processSchedule(schedule: Schedule, now: number): Promise<void>;
          }
        ).processSchedule(schedule, cronNow)
      ).rejects.toMatchObject({
        name: 'ScheduleNotReadyError',
        code: 'schedule_agentic_tool_removed',
      } satisfies Partial<ScheduleNotReadyError>);

      const updated = await new ScheduleRepository(db).findById(schedule.schedule_id);
      expect(updated?.next_run_at).toBeGreaterThan(cronNow);
      expect(updated?.last_run_at).toBeUndefined();
      expect(updated?.last_run_session_id).toBeUndefined();
      expect(await new SessionRepository(db).findByScheduleId(schedule.schedule_id)).toHaveLength(
        0
      );
      expect(prompt).not.toHaveBeenCalled();
    }
  );
});
