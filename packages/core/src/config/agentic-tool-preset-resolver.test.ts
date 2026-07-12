import { beforeAll, describe, expect } from 'vitest';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
} from '../db/repositories';
import { dbTest } from '../db/test-helpers';
import { type UserID, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION } from '../types';
import {
  assertInlineAgenticConfigurationAllowed,
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
});
