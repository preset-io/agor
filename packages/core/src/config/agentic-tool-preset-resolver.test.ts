import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
import { dbTest } from '../db/test-helpers';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  type UserID,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '../types';
import {
  assertInlineAgenticConfigurationAllowed,
  presetConfigurationToSessionPatch,
  resolveAgenticConfigurationReference,
  resolveAgenticToolPreset,
} from './agentic-tool-preset-resolver';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'agentic-tool-preset-resolver-test-secret';
});

describe('agentic tool preset resolution', () => {
  dbTest('resolves live configuration and rejects cross-tool references', async ({ db }) => {
    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'codex', name: 'Codex governed', configuration: { codexNetworkAccess: false } },
      '00000000-0000-7000-8000-000000000001' as UserID
    );
    await expect(resolveAgenticToolPreset(db, 'codex', preset.preset_id)).resolves.toMatchObject({
      preset_id: preset.preset_id,
    });
    await expect(resolveAgenticToolPreset(db, 'claude-code', preset.preset_id)).rejects.toThrow(
      /belongs to codex/
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

  dbTest('missing workspace default fails closed when presets are required', async ({ db }) => {
    await new TenantAgenticToolSettingsRepository(db).patch('codex', {
      inline_configuration_allowed: false,
    });
    await expect(
      resolveAgenticConfigurationReference(db, 'codex', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
    ).rejects.toThrow(/requires an administrator-managed preset/);
  });

  it('materializes a complete replacement when preset fields are removed', () => {
    const configured = presetConfigurationToSessionPatch('codex', {
      modelConfig: { mode: 'exact', model: 'gpt-5.4' },
      codexSandboxMode: 'danger-full-access',
      codexApprovalPolicy: 'never',
    });
    expect(configured).toMatchObject({
      model_config: { model: 'gpt-5.4' },
      permission_config: {
        codex: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      },
    });

    const cleared = presetConfigurationToSessionPatch('cursor', {});
    expect(cleared).toEqual({
      model_config: null,
      permission_config: expect.any(Object),
    });
  });
});
