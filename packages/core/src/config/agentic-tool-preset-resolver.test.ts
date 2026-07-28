import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
import { dbTest } from '../db/test-helpers';
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

  dbTest('missing workspace default fails closed when presets are required', async ({ db }) => {
    await new TenantAgenticToolSettingsRepository(db).patch('codex', {
      inline_configuration_allowed: false,
    });
    await expect(
      resolveAgenticConfigurationReference(db, 'codex', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
    ).rejects.toThrow(/requires an administrator-managed preset/);
  });

  dbTest(
    'materializes source → same-tool parent → execution owner → system without overlays',
    async ({ db }) => {
      const owner = await new UsersRepository(db).create({
        email: `materializer-owner-${Date.now()}-${Math.random()}@example.com`,
        name: 'Execution owner',
        default_agentic_config: {
          codex: {
            modelConfig: { mode: 'exact', model: 'owner-model' },
            codexNetworkAccess: true,
          },
        },
      });

      const result = await materializeAgenticToolConfiguration(db, {
        tool: 'codex',
        source: {
          configuration: {
            permissionMode: 'ask',
            codexSandboxMode: 'workspace-write',
          },
        },
        parent: {
          agentic_tool: 'codex',
          model_config: {
            mode: 'exact',
            model: 'parent-model',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          permission_config: {
            mode: 'auto',
            codex: {
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              networkAccess: false,
            },
          },
        },
        executionOwnerId: owner.user_id as UserID,
        now: new Date('2026-01-02T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
        agentic_tool_preset_id: null,
        model_config: { model: 'parent-model' },
        permission_config: {
          mode: 'ask',
          codex: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'never',
            networkAccess: false,
          },
        },
      });
    }
  );

  dbTest('blocks cross-tool parent inheritance', async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `materializer-cross-tool-${Date.now()}-${Math.random()}@example.com`,
      name: 'Execution owner',
      default_agentic_config: {
        codex: { modelConfig: { mode: 'exact', model: 'owner-codex-model' } },
      },
    });

    const result = await materializeAgenticToolConfiguration(db, {
      tool: 'codex',
      source: { configuration: {} },
      parent: {
        agentic_tool: 'claude-code',
        model_config: {
          mode: 'alias',
          model: 'claude-parent-model',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        permission_config: { mode: 'bypassPermissions' },
      },
      executionOwnerId: owner.user_id as UserID,
    });

    expect(result.model_config?.model).toBe('owner-codex-model');
    expect(result.permission_config.mode).toBe('allow-all');
  });

  dbTest('keeps a selected preset as a live reference', async ({ db }) => {
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'codex',
        name: 'Live preset',
        configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
      '00000000-0000-7000-8000-000000000001' as UserID
    );

    await expect(
      materializeAgenticToolConfiguration(db, {
        tool: 'codex',
        source: { reference: preset.preset_id },
      })
    ).resolves.toMatchObject({
      agentic_tool_preset_id: preset.preset_id,
      model_config: { model: 'gpt-5.4' },
    });
  });

  dbTest('rejects mixed reference and inline intent', async ({ db }) => {
    await expect(
      materializeAgenticToolConfiguration(db, {
        tool: 'codex',
        source: {
          reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
          configuration: { permissionMode: 'ask' },
        },
      } as never)
    ).rejects.toThrow(/reference.*inline/i);
  });
});
