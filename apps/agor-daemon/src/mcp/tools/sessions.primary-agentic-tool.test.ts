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
      const configuration: DefaultAgenticToolConfig = {
        permissionMode: 'allow-all',
        modelConfig: { mode: 'alias', model: DEFAULT_CODEX_MODEL, effort: 'high' },
        codexSandboxMode: 'danger-full-access',
        codexApprovalPolicy: 'never',
        codexNetworkAccess: false,
        codexIncludePlugins: true,
      };
      const preset = await runWithTenantDatabaseScope(f.db, f.tenantId, async () => {
        const preset = await new AgenticToolPresetRepository(f.db).create(
          { tool: 'codex', name: 'Primary tool defaults', is_default: true, configuration },
          f.owner.user_id
        );
        await new UsersRepository(f.db).update(f.owner.user_id, {
          primary_agentic_tool: 'codex',
          default_agentic_config: { codex: configuration },
          default_agentic_selection: {
            codex: source === 'preset' ? { source, preset_id: preset.preset_id } : { source },
          },
        });
        return preset;
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
        model_config: { model: DEFAULT_CODEX_MODEL, effort: 'high' },
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
        source === 'inline' ? null : preset.preset_id
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
