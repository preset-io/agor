import {
  AgenticToolPresetRepository,
  BranchRepository,
  generateId,
  RepoRepository,
  ScheduleRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { resolveSessionDefaults } from '@agor/core/sessions';
import type { Branch, Schedule, Session, UserID } from '@agor/core/types';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  materializeScheduleAgenticToolConfig,
  renderSchedulePrompt,
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
  return { creator, schedule };
}

function createSchedulerApp(db: SchedulerDb) {
  const sessions = new SessionRepository(db);
  const createSession = vi.fn((data: Partial<Session>, _params?: unknown) => sessions.create(data));
  const prompt = vi.fn(async () => ({}));
  const app = {
    service: (path: string) => {
      if (path === 'sessions') return { create: createSession, remove: vi.fn() };
      if (path === '/sessions/:id/prompt') return { create: prompt };
      throw new Error(`Unexpected service: ${path}`);
    },
  } as unknown as ConstructorParameters<typeof SchedulerService>[1];
  return { app, createSession, prompt };
}

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
      preset_id: preset.preset_id,
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    });

    await presets.patch(
      preset.preset_id,
      { configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.5' } } },
      creator.user_id as UserID
    );

    await expect(materializeScheduleAgenticToolConfig(db, schedule)).resolves.toMatchObject({
      preset_id: preset.preset_id,
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
    const config: Schedule['agentic_tool_config'] = {
      agentic_tool: 'codex',
      permission_mode: 'plan',
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    };

    await expect(
      materializeScheduleAgenticToolConfig(db, makeSchedule({ agentic_tool_config: config }))
    ).resolves.toEqual(config);
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
    const { app, createSession, prompt } = createSchedulerApp(db);
    const scheduler = new SchedulerService(db, app);

    await scheduler.executeScheduleNow({
      scheduleId: schedule.schedule_id,
      triggeredBy: creator.user_id,
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0][0]).toMatchObject({
      created_by: creator.user_id,
      agentic_tool: 'codex',
      agentic_tool_preset_id: undefined,
      model_config: { mode: 'exact', model: 'gpt-5.4' },
    });
    expect(createSession.mock.calls[0][1]).toEqual({ _agenticConfigResolved: true });
    expect(prompt).toHaveBeenCalledOnce();
  });

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
    const { app, createSession } = createSchedulerApp(db);
    const expected = resolveSessionDefaults({ agenticTool: 'codex', user: null });

    await new SchedulerService(db, app).executeScheduleNow({
      scheduleId: schedule.schedule_id,
      triggeredBy: creator.user_id,
    });

    expect(createSession.mock.calls[0][0]).toMatchObject({
      permission_config: expected.permission_config,
      model_config: {
        ...expected.model_config,
        updated_at: expect.any(String),
      },
    });
    expect(createSession.mock.calls[0][0].model_config?.model).not.toBe('stale-user-model');
  });

  dbTest(
    'rejects a corrupted mixed source before creating or prompting a session',
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
      const { app, createSession, prompt } = createSchedulerApp(db);

      await expect(
        new SchedulerService(db, app).executeScheduleNow({
          scheduleId: schedule.schedule_id,
          triggeredBy: creator.user_id,
        })
      ).rejects.toThrow(/cannot contain.*inline/i);
      expect(createSession).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    }
  );
});
