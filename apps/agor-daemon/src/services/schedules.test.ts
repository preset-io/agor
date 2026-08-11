import {
  AgenticToolPresetRepository,
  BranchRepository,
  generateId,
  RepoRepository,
  ScheduleRepository,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  BranchID,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleCreateData,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type ScheduleParams, SchedulesService } from './schedules';

const LEGACY_WORKSPACE_DEFAULT = '___workspace_default___';

async function setupContext(db: ConstructorParameters<typeof SchedulesService>[0]) {
  const users = new UsersRepository(db);
  const creator = await users.create({
    email: `schedule-service-creator-${generateId()}@example.com`,
    name: 'Schedule creator',
    default_agentic_config: {
      codex: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
    },
  });
  const caller = await users.create({
    email: `schedule-service-caller-${generateId()}@example.com`,
    name: 'Schedule caller',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `schedule-service-${generateId()}`,
    name: 'Schedule service test repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'schedule-service-test',
    ref: 'schedule-service-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: creator.user_id,
  });
  return { creator, caller, branch };
}

function scheduleData(branchId: BranchID, config: ScheduleAgenticToolConfig): ScheduleCreateData {
  return {
    branch_id: branchId,
    name: 'Default config schedule',
    cron_expression: '0 * * * *',
    timezone_mode: 'utc',
    prompt: 'Run',
    agentic_tool_config: config,
  };
}

function params(user: unknown, schedule?: Schedule): ScheduleParams {
  return { user, ...(schedule ? { schedule } : {}) } as ScheduleParams;
}

describe('SchedulesService default configuration references', () => {
  it('does not convert unexpected database failures into bad requests', async () => {
    const databaseFailure = new Error('database unavailable');
    const db = {
      select: () => {
        throw databaseFailure;
      },
    } as unknown as ConstructorParameters<typeof SchedulesService>[0];
    const service = new SchedulesService(db);

    await expect(
      service.create({
        branch_id: '00000000-0000-7000-8000-000000000010' as BranchID,
        name: 'Unavailable preset',
        cron_expression: '0 * * * *',
        timezone_mode: 'utc',
        prompt: 'Run',
        agentic_tool_config: {
          agentic_tool: 'codex',
          preset_id:
            '00000000-0000-7000-8000-000000000001' as Schedule['agentic_tool_config']['preset_id'],
        },
      })
    ).rejects.toBe(databaseFailure);
  });

  for (const [input, expected] of [
    [USER_DEFAULT_AGENTIC_CONFIGURATION, USER_DEFAULT_AGENTIC_CONFIGURATION],
    [WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
    [LEGACY_WORKSPACE_DEFAULT, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
  ] as const) {
    dbTest(`persists ${input} as canonical reference`, async ({ db }) => {
      const { creator, branch } = await setupContext(db);
      const service = new SchedulesService(db);

      const created = await service.create(
        scheduleData(branch.branch_id, {
          agentic_tool: 'codex',
          preset_id: input as Schedule['agentic_tool_config']['preset_id'],
        }),
        params(creator)
      );

      expect(created.agentic_tool_config).toMatchObject({
        agentic_tool: 'codex',
        configuration_reference: expected,
        model_config: expect.objectContaining({
          mode: expect.any(String),
          model: expect.any(String),
        }),
      });
    });
  }

  dbTest('validates a patched user default as the schedule creator', async ({ db }) => {
    const { creator, caller, branch } = await setupContext(db);
    const scheduleRepo = new ScheduleRepository(db);
    const existing = await scheduleRepo.create({
      ...scheduleData(branch.branch_id, {
        agentic_tool: 'codex',
      }),
      created_by: creator.user_id,
    });
    const service = new SchedulesService(db);
    const missingCaller = { ...caller, user_id: generateId() };

    const patched = await service.patch(
      existing.schedule_id,
      {
        agentic_tool_config: {
          agentic_tool: 'codex',
          configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      },
      params(missingCaller, existing)
    );

    expect(patched.agentic_tool_config.configuration_reference).toBe(
      USER_DEFAULT_AGENTIC_CONFIGURATION
    );
  });

  dbTest('persists a validated concrete preset ID', async ({ db }) => {
    const { creator, branch } = await setupContext(db);
    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'codex', name: 'Concrete preset', configuration: {} },
      creator.user_id as UserID
    );
    const service = new SchedulesService(db);

    const created = await service.create(
      scheduleData(branch.branch_id, {
        agentic_tool: 'codex',
        preset_id: preset.preset_id,
      }),
      params(creator)
    );

    expect(created.agentic_tool_config.preset_id).toBe(preset.preset_id);
  });

  dbTest('rejects mixed default and inline sources as a bad request', async ({ db }) => {
    const { creator, branch } = await setupContext(db);
    const service = new SchedulesService(db);

    await expect(
      service.create(
        scheduleData(branch.branch_id, {
          agentic_tool: 'codex',
          configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
          model_config: { mode: 'exact', model: 'gpt-5.4' },
        }),
        params(creator)
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });

  dbTest('rejects an incomplete inline OpenCode pair before persistence', async ({ db }) => {
    const { creator, branch } = await setupContext(db);
    const service = new SchedulesService(db);

    await expect(
      service.create(
        scheduleData(branch.branch_id, {
          agentic_tool: 'opencode',
          model_config: { mode: 'exact', provider: 'openai', model: '' },
        }),
        params(creator)
      )
    ).rejects.toThrow(/provider and model/i);
    expect(await new ScheduleRepository(db).findAll()).toHaveLength(0);
  });

  dbTest('resolves the exact OpenCode pair from the schedule creator', async ({ db }) => {
    const { branch } = await setupContext(db);
    const creator = await new UsersRepository(db).create({
      email: `opencode-schedule-${generateId()}@example.com`,
      name: 'OpenCode schedule creator',
      default_agentic_config: {
        opencode: {
          modelConfig: {
            mode: 'exact',
            provider: 'openai',
            model: 'gpt-test',
          },
        },
      },
    });
    const service = new SchedulesService(db);

    const created = await service.create(
      scheduleData(branch.branch_id, { agentic_tool: 'opencode' }),
      params(creator)
    );

    expect(created.agentic_tool_config).toMatchObject({
      agentic_tool: 'opencode',
      model_config: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-test',
        updated_at: expect.any(String),
      },
    });
  });

  dbTest('rejects multi-patch of a configuration source', async ({ db }) => {
    const { creator } = await setupContext(db);
    const service = new SchedulesService(db);

    await expect(
      service.patch(
        null,
        {
          agentic_tool_config: {
            agentic_tool: 'codex',
            configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
          },
        },
        params(creator)
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });
});
