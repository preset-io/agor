import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
import {
  createTenantScopedDatabaseProxy,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '../db/tenant-scope';
import { dbTest } from '../db/test-helpers';
import {
  type AgenticToolModelConfigurationPolicy,
  resolveModelConfig,
} from '../models/resolve-config';
import {
  isAgenticToolDefaultConfigurationReference,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  type UserID,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '../types';
import {
  AgenticConfigurationResolutionError,
  assertInlineAgenticConfigurationAllowed,
  materializeAgenticToolConfiguration,
  resolveAgenticConfigurationReference,
  resolveAgenticToolPreset,
} from './agentic-tool-preset-resolver';

const exactPairPolicy = {
  missingSelectionError: 'Select an OpenCode provider and model.',
  resolveSources: (sources, options) => {
    const selected = sources.find((source) => source?.provider || source?.model);
    if (!selected?.provider || !selected.model) return undefined;
    return resolveModelConfig({ ...selected, mode: 'exact' }, options);
  },
  isResolved: (input) =>
    input?.mode === 'exact' && Boolean(input.provider && input.model && input.updated_at),
} satisfies AgenticToolModelConfigurationPolicy;

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'agentic-tool-preset-resolver-test-secret';
});

describe('agentic tool preset resolution', () => {
  it('uses one canonical pair of reserved default references', () => {
    expect(USER_DEFAULT_AGENTIC_CONFIGURATION).toBe('__user_default__');
    expect(WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION).toBe('__workspace_default__');
    expect(isAgenticToolDefaultConfigurationReference(USER_DEFAULT_AGENTIC_CONFIGURATION)).toBe(
      true
    );
    expect(
      isAgenticToolDefaultConfigurationReference(WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
    ).toBe(true);
    expect(isAgenticToolDefaultConfigurationReference('workspace-default')).toBe(false);
  });

  dbTest('resolves live configuration and rejects cross-tool references', async ({ db }) => {
    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'codex', name: 'Codex governed', configuration: { codexNetworkAccess: false } },
      '00000000-0000-7000-8000-000000000001' as UserID
    );
    await expect(resolveAgenticToolPreset(db, 'codex', preset.preset_id)).resolves.toMatchObject({
      preset_id: preset.preset_id,
    });
    await expect(resolveAgenticToolPreset(db, 'claude-code', preset.preset_id)).rejects.toThrow(
      AgenticConfigurationResolutionError
    );
  });

  dbTest('inline policy fails closed', async ({ db }) => {
    await new TenantAgenticToolSettingsRepository(db).patch('codex', {
      inline_configuration_allowed: false,
    });
    await expect(assertInlineAgenticConfigurationAllowed(db, 'codex')).rejects.toThrow(
      /requires an administrator-managed preset/
    );
  });

  dbTest('resolves the workspace default to a concrete live preset', async ({ db }) => {
    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'codex', name: 'Default Codex', configuration: {}, is_default: true },
      '00000000-0000-7000-8000-000000000001' as UserID
    );
    await expect(
      resolveAgenticConfigurationReference(db, 'codex', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
    ).resolves.toMatchObject({ preset: { preset_id: preset.preset_id } });
  });

  dbTest(
    'falls back to built-in inline defaults when no workspace preset exists',
    async ({ db }) => {
      await expect(
        resolveAgenticConfigurationReference(db, 'codex', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
      ).resolves.toEqual({ configuration: {} });
    }
  );

  dbTest('resolves a fresh user implicit default through the built-in fallback', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: `preset-default-${Date.now()}-${Math.random()}@example.com`,
      name: 'Fresh User',
    });
    await expect(
      resolveAgenticConfigurationReference(
        db,
        'codex',
        USER_DEFAULT_AGENTIC_CONFIGURATION,
        user.user_id as UserID
      )
    ).resolves.toEqual({ configuration: {} });
  });

  dbTest('resolves the user default inline configuration', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: `preset-user-default-${Date.now()}-${Math.random()}@example.com`,
      name: 'Configured User',
      default_agentic_config: {
        codex: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
    });
    await expect(
      resolveAgenticConfigurationReference(
        db,
        'codex',
        USER_DEFAULT_AGENTIC_CONFIGURATION,
        user.user_id as UserID
      )
    ).resolves.toEqual({
      configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
    });
  });

  dbTest('materializes the exact pair selected by the execution owner', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: `materialized-default-${Date.now()}-${Math.random()}@example.com`,
      name: 'Configured User',
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        },
      },
    });

    await expect(
      materializeAgenticToolConfiguration(db, {
        tool: 'opencode',
        source: { reference: USER_DEFAULT_AGENTIC_CONFIGURATION },
        executionOwnerId: user.user_id as UserID,
        modelConfiguration: exactPairPolicy,
      })
    ).resolves.toMatchObject({
      model_config: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
    });
  });

  dbTest(
    'keeps referenced agent configuration atomic without taking ownership of MCP selection',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `materialized-atomic-${Date.now()}-${Math.random()}@example.com`,
        name: 'Configured User',
        default_agentic_config: {
          codex: {
            permissionMode: 'ask',
            modelConfig: { model: 'owner-model' },
          },
        },
        default_mcp_server_ids: ['owner-mcp'],
      });
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'codex',
          name: 'Atomic Codex',
          configuration: {
            permissionMode: 'auto',
            modelConfig: { model: 'preset-model' },
          },
        },
        user.user_id as UserID
      );

      const materialized = await materializeAgenticToolConfiguration(db, {
        tool: 'codex',
        source: { reference: preset.preset_id },
        executionOwner: user,
        parent: {
          agentic_tool: 'codex',
          permission_config: { mode: 'allow-all' },
          model_config: {
            mode: 'alias',
            model: 'parent-model',
            updated_at: new Date().toISOString(),
          },
        },
      });

      expect(materialized).toMatchObject({
        agentic_tool_preset_id: preset.preset_id,
        permission_config: { mode: 'auto' },
        model_config: { model: 'preset-model' },
      });
      expect(materialized).not.toHaveProperty('mcp_server_ids');
    }
  );

  dbTest('rejects a preloaded execution owner with a mismatched subject', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: `materialized-owner-${Date.now()}-${Math.random()}@example.com`,
      name: 'Configured User',
    });

    await expect(
      materializeAgenticToolConfiguration(db, {
        tool: 'codex',
        source: { configuration: {} },
        executionOwnerId: '00000000-0000-7000-8000-000000000099' as UserID,
        executionOwner: user,
      })
    ).rejects.toThrow(/execution owner does not match/i);
  });

  dbTest('missing workspace default fails closed when presets are required', async ({ db }) => {
    await new TenantAgenticToolSettingsRepository(db).patch('codex', {
      inline_configuration_allowed: false,
    });
    await expect(
      resolveAgenticConfigurationReference(db, 'codex', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
    ).rejects.toThrow(/requires an administrator-managed preset/);
  });

  dbTest(
    'does not let an incomplete referenced preset borrow owner or parent defaults',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `atomic-preset-${Date.now()}-${Math.random()}@example.com`,
        name: 'Configured User',
        default_agentic_config: {
          opencode: {
            modelConfig: { mode: 'exact', provider: 'owner', model: 'owner-model' },
          },
        },
      });
      const preset = await new AgenticToolPresetRepository(db).create(
        { tool: 'opencode', name: 'Incomplete', configuration: {} },
        user.user_id as UserID
      );

      await expect(
        materializeAgenticToolConfiguration(db, {
          tool: 'opencode',
          source: { reference: preset.preset_id },
          executionOwnerId: user.user_id as UserID,
          parent: {
            agentic_tool: 'opencode',
            permission_config: { mode: 'default' },
            model_config: {
              mode: 'exact',
              provider: 'parent',
              model: 'parent-model',
              updated_at: new Date().toISOString(),
            },
          },
          modelConfiguration: exactPairPolicy,
          modelFallback: { mode: 'exact', provider: 'fallback', model: 'fallback-model' },
        })
      ).rejects.toThrow(/provider and model/i);
    }
  );

  dbTest(
    'does not let a missing workspace default borrow the execution owner default',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `atomic-workspace-${Date.now()}-${Math.random()}@example.com`,
        name: 'Configured User',
        default_agentic_config: {
          opencode: {
            modelConfig: { mode: 'exact', provider: 'owner', model: 'owner-model' },
          },
        },
      });

      await expect(
        materializeAgenticToolConfiguration(db, {
          tool: 'opencode',
          source: { reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION },
          executionOwnerId: user.user_id as UserID,
          modelConfiguration: exactPairPolicy,
        })
      ).rejects.toThrow(/provider and model/i);
    }
  );

  dbTest(
    'rejects preset materialization through a retained foreign tenant scope',
    async ({ db }) => {
      const preset = await new AgenticToolPresetRepository(db).create(
        { tool: 'codex', name: 'Tenant A preset', configuration: {} },
        '00000000-0000-7000-8000-000000000001' as UserID
      );

      const guardedDb = createTenantScopedDatabaseProxy(db);
      await runWithTenantDatabaseScope(guardedDb, 'tenant-a', async (tenantADb) => {
        await expect(
          runWithTenantContext('tenant-b', () =>
            runWithTenantDatabaseScope(tenantADb, undefined, (tenantBDb) =>
              materializeAgenticToolConfiguration(tenantBDb, {
                tool: 'codex',
                source: { reference: preset.preset_id },
              })
            )
          )
        ).rejects.toThrow(/tenant.*scope|scope.*tenant/i);
      });
    }
  );
});
