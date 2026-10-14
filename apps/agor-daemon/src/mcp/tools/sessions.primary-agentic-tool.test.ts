import {
  AgenticToolPresetRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { DEFAULT_CODEX_MODEL } from '@agor/core/models';
import type { DefaultAgenticToolConfig, Session } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { childAdmissionFixture } from '../../../test/session-child-admission';

describe('MCP create primary tool configuration materialization', () => {
  beforeEach(() => vi.stubEnv('AGOR_BASE_URL', 'http://agor.test'));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  dbTest(
    'rejects another tenant context before reading preferences or creating a session',
    async ({ db }) => {
      const f = await childAdmissionFixture(db);
      await runWithTenantDatabaseScope(f.db, f.tenantId, () =>
        new UsersRepository(f.db).update(f.owner.user_id, { primary_agentic_tool: 'codex' })
      );
      const { handlers } = f.toolsFor();
      await expect(async () =>
        runWithTenantContext('foreign-tenant', () =>
          handlers.agor_sessions_create({ branchId: f.branch.branch_id, parentSessionId: null })
        )
      ).rejects.toThrow(/tenant/i);
      expect(await f.count()).toHaveLength(1);
      expect(f.prompt).not.toHaveBeenCalled();
    }
  );

  for (const source of ['inline', 'preset', 'workspace_default'] as const) {
    dbTest(`materializes the primary tool's ${source} configuration`, async ({ db }) => {
      const f = await childAdmissionFixture(db);
      const configuration = {
        permissionMode: 'allow-all',
        modelConfig: { mode: 'alias', model: DEFAULT_CODEX_MODEL, effort: 'high' },
        codexSandboxMode: 'danger-full-access',
        codexApprovalPolicy: 'never',
        codexNetworkAccess: false,
        codexIncludePlugins: true,
      } satisfies DefaultAgenticToolConfig;
      // Distinct values and preset IDs make a wrong-source resolution observable.
      const configurations = {
        inline: configuration,
        preset: {
          ...configuration,
          modelConfig: { ...configuration.modelConfig, effort: 'medium' },
        },
        workspace_default: {
          ...configuration,
          modelConfig: { ...configuration.modelConfig, effort: 'low' },
        },
      } satisfies Record<typeof source, DefaultAgenticToolConfig>;
      const presets = await runWithTenantDatabaseScope(f.db, f.tenantId, async () => {
        const repository = new AgenticToolPresetRepository(f.db);
        const selected = await repository.create(
          {
            tool: 'codex',
            name: 'Selected preset',
            is_default: false,
            configuration: configurations.preset,
          },
          f.owner.user_id
        );
        const workspace = await repository.create(
          {
            tool: 'codex',
            name: 'Workspace default',
            is_default: true,
            configuration: configurations.workspace_default,
          },
          f.owner.user_id
        );
        await new UsersRepository(f.db).update(f.owner.user_id, {
          primary_agentic_tool: 'codex',
          default_agentic_config: { codex: configuration },
          default_agentic_selection: {
            codex: source === 'preset' ? { source, preset_id: selected.preset_id } : { source },
          },
        });
        return { selected, workspace };
      });
      const { handlers } = f.toolsFor();
      // The caller session uses Claude; fresh create must not inherit its tool/config.
      const response = await handlers.agor_sessions_create({
        branchId: f.branch.branch_id,
        parentSessionId: null,
      });
      const session = JSON.parse(response.content[0].text).session as Session;
      expect(session).toMatchObject({
        agentic_tool: 'codex',
        created_by: f.owner.user_id,
        model_config: configurations[source].modelConfig,
        permission_config: {
          mode: 'allow-all',
          codex: {
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'never',
            networkAccess: false,
            includePlugins: true,
          },
        },
      });
      expect(session.agentic_tool_preset_id ?? null).toBe(
        source === 'inline'
          ? null
          : source === 'preset'
            ? presets.selected.preset_id
            : presets.workspace.preset_id
      );
      expect((await f.count()).find((row) => row.session_id === session.session_id)).toMatchObject({
        agentic_tool: session.agentic_tool,
        model_config: session.model_config,
        permission_config: session.permission_config,
        agentic_tool_preset_id: session.agentic_tool_preset_id,
      });
      expect(f.prompt).not.toHaveBeenCalled();
    });
  }
});
