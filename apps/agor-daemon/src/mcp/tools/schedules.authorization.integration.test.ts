/**
 * Schedule authorization through the hook chain `registerHooks` installs.
 *
 * A schedule spawns unattended sessions on its branch on every tick, so
 * creating or editing one is branch management, not ordinary session use.
 * These tests drive the MCP tools and the REST transport against the real
 * schedules service to pin that a Collaborator cannot plant or re-arm one.
 */

import {
  BranchRepository,
  CapabilityPolicyRepository,
  type Database,
  generateId,
  RepoRepository,
  ScheduleRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import {
  type Branch,
  type BranchID,
  type CapabilityPolicyPresetId,
  capabilityPolicyPresetCapabilities,
  type Schedule,
  type User,
  type UserID,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { type RegisterHooksContext, registerHooks } from '../../register-hooks.js';
import { createSchedulesService } from '../../services/schedules.js';
import type { McpContext } from '../server.js';
import { registerScheduleTools } from './schedules.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

type BranchRole = Extract<CapabilityPolicyPresetId, 'viewer' | 'collaborator' | 'manager'>;

async function seedBranch(db: Database) {
  const users = new UsersRepository(db);
  const owner = await users.create({ email: `owner-${generateId()}@example.com`, role: 'member' });
  const member = (role: string) =>
    users.create({ email: `${role}-${generateId()}@example.com`, role: 'member' });
  const manager = await member('manager');
  const collaborator = await member('collaborator');
  const viewer = await member('viewer');
  const outsider = await member('outsider');
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `schedule-authz-${generateId()}`,
    name: 'Schedule authz',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'owner-branch',
    ref: 'owner-branch',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: owner.user_id,
  });
  const grants: Array<[User, BranchRole]> = [
    [manager, 'manager'],
    [collaborator, 'collaborator'],
    [viewer, 'viewer'],
  ];
  await setBranchRoles(db, branch, owner, grants);
  return { owner, manager, collaborator, viewer, outsider, branch };
}

async function setBranchRoles(
  db: Database,
  branch: Branch,
  owner: User,
  grants: Array<[User, BranchRole]>
) {
  const policies = new CapabilityPolicyRepository(db);
  const current = await policies.getBranchPolicy(branch.branch_id);
  const config = structuredClone(current.override_config!);
  config.access.sharing_mode = 'shared';
  config.access.entries = grants.map(([user, preset]) => {
    const fsAccess = preset === 'viewer' ? 'none' : 'read';
    return {
      entry_id: generateId(),
      principal: { principal_type: 'user' as const, user_id: user.user_id as UserID },
      preset,
      capabilities: capabilityPolicyPresetCapabilities('branch_access', preset, fsAccess) ?? [],
      fs_access: fsAccess,
    };
  });
  await policies.replaceBranchPolicy(
    branch.branch_id,
    { ...current, override_config: config },
    owner.user_id as UserID
  );
}

function createApp(db: Database) {
  const scopedDb = db as unknown as TenantScopeAwareDatabase;
  const app = feathers() as Application;
  app.publish = () => app;
  app.use('schedules', createSchedulesService(scopedDb));
  const branchRows = new BranchRepository(db);
  const inert = () => ({
    async find() {
      return [];
    },
    async get() {
      return {};
    },
    async create(data: unknown) {
      return data;
    },
    async patch(_id: unknown, data: unknown) {
      return data;
    },
    async remove() {
      return {};
    },
  });
  app.use('branches', {
    ...inert(),
    async get(id: string) {
      return branchRows.findById(id);
    },
  } as never);
  for (const path of ['users', 'messages', 'repos', 'sessions', 'leaderboard', 'tasks']) {
    app.use(path, inert() as never);
  }
  registerHooks({
    db: scopedDb,
    app,
    config: {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'default' },
      execution: { unix_user_mode: 'simple' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'schedule-authz-integration-secret',
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: branchRows,
    usersRepository: new UsersRepository(db),
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
    deployment: { mode: 'standalone' } as RegisterHooksContext['deployment'],
  });
  return app;
}

function mcpTools(app: Application, db: Database, user: User) {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const ctx: McpContext = {
    app,
    db: db as unknown as McpContext['db'],
    userId: user.user_id as UserID,
    sessionId: undefined,
    authenticatedUser: user,
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: user.user_id, email: user.email, role: user.role },
      tenant: { tenant_id: 'default', source: 'static' },
    } as McpContext['baseServiceParams'],
  };
  registerScheduleTools(server, ctx);
  return (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    return handler(args);
  };
}

function restParams(user: User) {
  return {
    provider: 'rest',
    authenticated: true,
    user: { user_id: user.user_id, email: user.email, role: user.role },
    tenant: { tenant_id: 'default', source: 'static' },
  } as never;
}

const createArgs = (branchId: BranchID) => ({
  branchId,
  name: 'Every minute',
  cron_expression: '* * * * *',
  timezone_mode: 'utc',
  prompt: 'Scheduled prompt',
  agentic_tool_config: { agentic_tool: 'claude-code' },
  enabled: true,
});

async function seedSchedule(db: Database, branchId: BranchID, createdBy: User, enabled = true) {
  return new ScheduleRepository(db).create({
    branch_id: branchId,
    created_by: createdBy.user_id,
    name: 'Seeded schedule',
    cron_expression: '0 * * * *',
    timezone_mode: 'utc',
    prompt: 'Seeded prompt',
    enabled,
    retention: 0,
    allow_concurrent_runs: false,
    agentic_tool_config: { agentic_tool: 'claude-code' },
  });
}

const parsed = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text) as Schedule;

describe('schedule creation requires branch Manager authority', () => {
  dbTest('refuses a Collaborator over MCP and REST', async ({ db }) => {
    const { collaborator, branch } = await seedBranch(db);
    const app = createApp(db);
    const call = mcpTools(app, db, collaborator);

    await expect(call('agor_schedules_create', createArgs(branch.branch_id))).rejects.toThrow(
      /'all' permission/
    );
    const { branchId, ...rest } = createArgs(branch.branch_id);
    await expect(
      app
        .service('schedules')
        .create({ ...rest, branch_id: branchId } as never, restParams(collaborator))
    ).rejects.toThrow(/'all' permission/);
    expect(await new ScheduleRepository(db).findAll()).toHaveLength(0);
  });

  dbTest('refuses viewers and callers without branch access', async ({ db }) => {
    const { viewer, outsider, branch } = await seedBranch(db);
    const app = createApp(db);

    for (const user of [viewer, outsider]) {
      const { branchId, ...rest } = createArgs(branch.branch_id);
      await expect(
        app.service('schedules').create({ ...rest, branch_id: branchId } as never, restParams(user))
      ).rejects.toThrow(/permission/);
    }
    expect(await new ScheduleRepository(db).findAll()).toHaveLength(0);
  });

  dbTest('admits the branch owner and a branch Manager', async ({ db }) => {
    const { owner, manager, branch } = await seedBranch(db);
    const app = createApp(db);

    for (const user of [owner, manager]) {
      const created = parsed(
        await mcpTools(app, db, user)('agor_schedules_create', createArgs(branch.branch_id))
      );
      expect(created).toMatchObject({ branch_id: branch.branch_id, created_by: user.user_id });
    }
    expect(await new ScheduleRepository(db).findAll()).toHaveLength(2);
  });
});

describe('superadmin schedule handling', () => {
  dbTest('creates only with real Manager access but may still edit for ops', async ({ db }) => {
    const { owner, branch } = await seedBranch(db);
    const superadmin = await new UsersRepository(db).create({
      email: `superadmin-${generateId()}@example.com`,
      role: 'superadmin',
    });
    const ownersSchedule = await seedSchedule(db, branch.branch_id, owner, false);
    const call = mcpTools(createApp(db), db, superadmin);

    await expect(call('agor_schedules_create', createArgs(branch.branch_id))).rejects.toThrow(
      /'all' permission/
    );
    const updated = parsed(
      await call('agor_schedules_patch', { scheduleId: ownersSchedule.schedule_id, prompt: 'Ops' })
    );
    expect(updated).toMatchObject({ prompt: 'Ops', created_by: owner.user_id });
  });
});

describe('schedule edits require branch Manager authority', () => {
  dbTest('refuses a Collaborator re-arming or rewriting their own schedule', async ({ db }) => {
    const { collaborator, branch } = await seedBranch(db);
    const schedule = await seedSchedule(db, branch.branch_id, collaborator, false);
    const app = createApp(db);
    const call = mcpTools(app, db, collaborator);

    for (const change of [
      { enabled: true },
      { prompt: 'Replaced prompt' },
      { cron_expression: '* * * * *' },
      { agentic_tool_config: { agentic_tool: 'codex' } },
    ]) {
      await expect(
        call('agor_schedules_patch', { scheduleId: schedule.schedule_id, ...change })
      ).rejects.toThrow(/'all' permission/);
    }
    await expect(
      app
        .service('schedules')
        .patch(schedule.schedule_id, { enabled: true }, restParams(collaborator))
    ).rejects.toThrow(/'all' permission/);
    expect(await new ScheduleRepository(db).findById(schedule.schedule_id)).toMatchObject({
      enabled: false,
      prompt: 'Seeded prompt',
    });
  });

  dbTest('refuses a Collaborator deleting a schedule', async ({ db }) => {
    const { collaborator, branch } = await seedBranch(db);
    const schedule = await seedSchedule(db, branch.branch_id, collaborator);
    const call = mcpTools(createApp(db), db, collaborator);

    await expect(
      call('agor_schedules_delete', { scheduleId: schedule.schedule_id })
    ).rejects.toThrow(/'all' permission/);
    expect(await new ScheduleRepository(db).findById(schedule.schedule_id)).not.toBeNull();
  });

  dbTest('keeps schedules running as their creator, even for a Manager', async ({ db }) => {
    const { owner, manager, branch } = await seedBranch(db);
    const ownersSchedule = await seedSchedule(db, branch.branch_id, owner);
    const managersSchedule = await seedSchedule(db, branch.branch_id, manager, false);
    const call = mcpTools(createApp(db), db, manager);

    await expect(
      call('agor_schedules_patch', { scheduleId: ownersSchedule.schedule_id, prompt: 'Hijack' })
    ).rejects.toThrow(/schedules you created/);
    const updated = parsed(
      await call('agor_schedules_patch', {
        scheduleId: managersSchedule.schedule_id,
        enabled: true,
        prompt: 'Updated by its Manager creator',
      })
    );
    expect(updated).toMatchObject({ enabled: true, prompt: 'Updated by its Manager creator' });
  });

  dbTest('refuses an edit after the creator is demoted to Collaborator', async ({ db }) => {
    const { owner, manager, collaborator, viewer, branch } = await seedBranch(db);
    const schedule = await seedSchedule(db, branch.branch_id, manager, false);
    await setBranchRoles(db, branch, owner, [
      [manager, 'collaborator'],
      [collaborator, 'collaborator'],
      [viewer, 'viewer'],
    ]);
    const call = mcpTools(createApp(db), db, manager);

    await expect(
      call('agor_schedules_patch', { scheduleId: schedule.schedule_id, enabled: true })
    ).rejects.toThrow(/'all' permission/);
    expect((await new ScheduleRepository(db).findById(schedule.schedule_id))?.enabled).toBe(false);
  });
});

describe('schedule reads follow branch visibility', () => {
  dbTest('hides schedules and prompts from callers who cannot view the branch', async ({ db }) => {
    const { owner, viewer, outsider, branch } = await seedBranch(db);
    const schedule = await seedSchedule(db, branch.branch_id, owner);
    const app = createApp(db);

    const outsiderCall = mcpTools(app, db, outsider);
    await expect(
      outsiderCall('agor_schedules_get', { scheduleId: schedule.schedule_id })
    ).rejects.toThrow(/permission/);
    const outsiderList = JSON.parse(
      (await outsiderCall('agor_schedules_list', { limit: 25, offset: 0 })).content[0].text
    );
    expect(outsiderList.data ?? outsiderList).toEqual([]);

    const viewerList = JSON.parse(
      (await mcpTools(app, db, viewer)('agor_schedules_list', { limit: 25, offset: 0 })).content[0]
        .text
    );
    expect((viewerList.data ?? viewerList).map((s: Schedule) => s.schedule_id)).toEqual([
      schedule.schedule_id,
    ]);
  });
});

describe('schedule occurrence identity is scheduler-owned', () => {
  dbTest('refuses sessions that impersonate a run of another schedule', async ({ db }) => {
    const { owner, collaborator, branch } = await seedBranch(db);
    const schedule = await seedSchedule(db, branch.branch_id, owner);
    const sessions = createApp(db).service('sessions');
    const forged = {
      schedule_id: schedule.schedule_id,
      scheduled_run_at: Date.parse('2030-01-01T00:00:00Z'),
      scheduled_from_branch: true,
    };

    await expect(
      sessions.create(
        { branch_id: branch.branch_id, agentic_tool: 'claude-code', ...forged } as never,
        restParams(collaborator)
      )
    ).rejects.toThrow(/server-managed/);
    await expect(
      sessions.create(
        {
          branch_id: branch.branch_id,
          agentic_tool: 'claude-code',
          custom_context: { scheduled_run: { rendered_prompt: 'Forged' } },
        } as never,
        restParams(collaborator)
      )
    ).rejects.toThrow(/server-managed/);
    await expect(
      sessions.patch(
        generateId(),
        { schedule_id: schedule.schedule_id } as never,
        {
          ...(restParams(collaborator) as object),
          provider: 'mcp',
        } as never
      )
    ).rejects.toThrow(/server-managed/);
  });
});
