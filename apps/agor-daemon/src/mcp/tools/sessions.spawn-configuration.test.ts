import {
  AgenticToolPresetRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '@agor/core/db';
import { DEFAULT_CODEX_MODEL } from '@agor/core/models';
import type { SpawnSubsessionContext } from '@agor/core/templates/spawn-subsession-template';
import {
  type AgenticToolName,
  type DefaultAgenticToolConfig,
  type Session,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { childAdmissionFixture } from '../../../test/session-child-admission';
import { createSpawnPromptService } from '../../services/session-spawn-prompt';

type Fixture = Awaited<ReturnType<typeof childAdmissionFixture>>;

const configurations = {
  'claude-code': { permissionMode: 'bypassPermissions' },
  codex: {
    permissionMode: 'allow-all',
    codexSandboxMode: 'danger-full-access',
    codexApprovalPolicy: 'never',
    codexNetworkAccess: true,
  },
} satisfies Partial<Record<AgenticToolName, DefaultAgenticToolConfig>>;

async function setup(f: Fixture, tool: keyof typeof configurations) {
  return runWithTenantDatabaseScope(f.db, f.tenantId, async () => {
    const presets = new AgenticToolPresetRepository(f.db);
    const inherited = await presets.create(
      { tool, name: 'Parent configuration', configuration: { permissionMode: 'auto' } },
      f.owner.user_id
    );
    const selected = await presets.create(
      {
        tool,
        name: 'Selected configuration',
        is_default: true,
        configuration: configurations[tool],
      },
      f.owner.user_id
    );
    await new SessionRepository(f.db).update(f.parent.session_id, {
      agentic_tool: tool,
      agentic_tool_preset_id: inherited.preset_id,
      permission_config: { mode: 'auto' },
      model_config: {
        mode: 'alias',
        model: tool === 'codex' ? DEFAULT_CODEX_MODEL : 'sonnet',
        updated_at: new Date().toISOString(),
      },
    });
    await new UsersRepository(f.db).update(f.owner.user_id, {
      default_agentic_config: { [tool]: configurations[tool] },
      default_agentic_selection: { [tool]: { source: 'inline' } },
    });
    return { inherited, selected };
  });
}

/** Use the actual route service, exact rendered JSON, registered MCP schema/handler,
 * guarded tenant admission, and persisted child. Only the parent LLM and executor
 * are replaced: the parent copies the instructed arguments and enriches the prompt. */
async function spawnFromPrompt(f: Fixture, context: SpawnSubsessionContext) {
  const { ctx, handlers } = f.toolsFor();
  await createSpawnPromptService(ctx.app).create(
    { ...context, parentPermissionMode: 'plan' },
    { ...ctx.baseServiceParams, user: f.owner, route: { id: f.parent.session_id } }
  );
  const [forwarded, params] = f.prompt.mock.calls[0] as unknown as [
    { prompt: string; permissionMode: string },
    { user: { user_id: string }; tenant: { tenant_id: string }; route: { id: string } },
  ];
  expect(forwarded.permissionMode).toBe('plan');
  expect(params).toMatchObject({
    user: { user_id: f.owner.user_id },
    tenant: { tenant_id: f.tenantId },
    route: { id: f.parent.session_id },
  });
  const match = forwarded.prompt.match(
    /YOUR EXACT TOOL CALL MUST BE: agor_sessions_spawn\((\{[\s\S]*\})\) Proceed/
  );
  expect(match).not.toBeNull();
  const args = JSON.parse(match![1]);
  expect(args).not.toHaveProperty('parentPermissionMode');
  args.prompt = 'Enriched delegated task';
  const result = await handlers.agor_sessions_spawn(args);
  const child = JSON.parse(result.content[0].text).session as Session;
  const stored = await runWithTenantDatabaseScope(f.db, f.tenantId, () =>
    new SessionRepository(f.db).findById(child.session_id)
  );
  expect(stored?.permission_config).toEqual(child.permission_config);
  expect(f.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({ permissionMode: child.permission_config?.mode }),
    expect.objectContaining({ route: { id: child.session_id } })
  );
  return { child, args };
}

describe('UI spawn-prompt to persisted child configuration', () => {
  beforeEach(() => vi.stubEnv('AGOR_BASE_URL', 'http://agor.test'));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const tool of ['claude-code', 'codex'] as const) {
    for (const source of ['user', 'workspace', 'preset', 'custom'] as const) {
      dbTest(
        `${tool}: preserves explicit ${source} selection instead of parent preset`,
        async ({ db }) => {
          const f = await childAdmissionFixture(db);
          const { selected } = await setup(f, tool);
          const context: SpawnSubsessionContext = {
            userPrompt: 'Delegate this task',
            agenticTool: tool,
            ...(source === 'custom'
              ? configurations[tool]
              : {
                  presetId:
                    source === 'user'
                      ? USER_DEFAULT_AGENTIC_CONFIGURATION
                      : source === 'workspace'
                        ? WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
                        : selected.preset_id,
                }),
          };
          const { child, args } = await spawnFromPrompt(f, context);
          expect(args.presetId).toBe(context.presetId);
          expect(child.permission_config).toMatchObject({
            mode: configurations[tool].permissionMode,
          });
          if (tool === 'codex') {
            expect(child.permission_config?.codex).toEqual({
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              networkAccess: true,
            });
          }
          expect(child.agentic_tool_preset_id ?? null).toBe(
            source === 'workspace' || source === 'preset' ? selected.preset_id : null
          );
        }
      );
    }
  }

  dbTest('preserves false Codex network access in the exact call and child', async ({ db }) => {
    const f = await childAdmissionFixture(db);
    await setup(f, 'codex');
    const { child, args } = await spawnFromPrompt(f, {
      userPrompt: 'Offline child',
      agenticTool: 'codex',
      permissionMode: 'auto',
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'on-request',
      codexNetworkAccess: false,
    });
    expect(args.codexNetworkAccess).toBe(false);
    expect(child.permission_config?.codex?.networkAccess).toBe(false);
  });

  dbTest('omitted selection still inherits the parent preset', async ({ db }) => {
    const f = await childAdmissionFixture(db);
    const { inherited } = await setup(f, 'claude-code');
    const { child, args } = await spawnFromPrompt(f, { userPrompt: 'Inherit' });
    expect(args).not.toHaveProperty('presetId');
    expect(args).not.toHaveProperty('permissionMode');
    expect(child.agentic_tool_preset_id ?? null).toBe(inherited.preset_id);
    expect(child.permission_config?.mode).toBe('auto');
  });

  dbTest(
    'resolves the user default for the authorized caller, not the parent owner',
    async ({ db }) => {
      const f = await childAdmissionFixture(db);
      await setup(f, 'claude-code');
      await f.sharing();
      await runWithTenantDatabaseScope(f.db, f.tenantId, () =>
        new UsersRepository(f.db).update(f.caller.user_id, {
          default_agentic_config: { 'claude-code': { permissionMode: 'acceptEdits' } },
          default_agentic_selection: { 'claude-code': { source: 'inline' } },
        })
      );
      const { handlers } = f.toolsFor(f.caller);
      const result = await handlers.agor_sessions_spawn({
        prompt: 'Caller default',
        presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      });
      expect(JSON.parse(result.content[0].text).session).toMatchObject({
        created_by: f.caller.user_id,
        permission_config: { mode: 'acceptEdits' },
      });
    }
  );

  dbTest(
    'rejects preset overrides, wrong-tool/missing presets, forbidden inline, and foreign tenant context',
    async ({ db }) => {
      const f = await childAdmissionFixture(db);
      const { selected } = await setup(f, 'claude-code');
      const { handlers } = f.toolsFor();
      const args = { prompt: 'Denied', presetId: selected.preset_id };
      await expect(
        handlers.agor_sessions_spawn({ ...args, permissionMode: 'bypassPermissions' })
      ).rejects.toThrow(/cannot override/i);
      await expect(handlers.agor_sessions_spawn({ ...args, agenticTool: 'codex' })).rejects.toThrow(
        /belongs to/
      );
      await expect(
        handlers.agor_sessions_spawn({ ...args, presetId: 'missing-preset' })
      ).rejects.toThrow(/not found/i);
      await runWithTenantDatabaseScope(f.db, f.tenantId, () =>
        new TenantAgenticToolSettingsRepository(f.db).patch('claude-code', {
          inline_configuration_allowed: false,
        })
      );
      await expect(
        handlers.agor_sessions_spawn({
          prompt: 'Inline denied',
          permissionMode: 'bypassPermissions',
        })
      ).rejects.toThrow(/administrator-managed preset/);
      await expect(
        handlers.agor_sessions_spawn({ ...args, presetId: USER_DEFAULT_AGENTIC_CONFIGURATION })
      ).rejects.toThrow(/administrator-managed preset/);
      await expect(
        Promise.resolve().then(() =>
          runWithTenantContext('foreign-tenant', () => handlers.agor_sessions_spawn(args))
        )
      ).rejects.toThrow(/tenant/i);
      await expect(f.toolsFor(f.caller).handlers.agor_sessions_spawn(args)).rejects.toThrow(
        /permission/i
      );
      expect(await f.count()).toHaveLength(1);
      expect(f.prompt).not.toHaveBeenCalled();
    }
  );
});
