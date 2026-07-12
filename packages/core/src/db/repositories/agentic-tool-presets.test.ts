import { describe, expect } from 'vitest';
import type { UserID } from '../../types';
import { dbTest } from '../test-helpers';
import { AgenticToolPresetRepository } from './agentic-tool-presets';

describe('AgenticToolPresetRepository', () => {
  dbTest('stores and resolves live typed configuration', async ({ db }) => {
    const repository = new AgenticToolPresetRepository(db);
    const actor = '00000000-0000-7000-8000-000000000001' as UserID;
    const created = await repository.create(
      {
        tool: 'codex',
        name: 'Governed Codex',
        configuration: {
          modelConfig: { model: 'gpt-5.4', effort: 'high' },
          codexSandboxMode: 'workspace-write',
          codexApprovalPolicy: 'on-request',
        },
      },
      actor
    );

    await repository.patch(
      created.preset_id,
      { configuration: { ...created.configuration, codexNetworkAccess: true } },
      actor
    );

    await expect(repository.findById(created.preset_id)).resolves.toMatchObject({
      tool: 'codex',
      name: 'Governed Codex',
      configuration: { codexNetworkAccess: true },
    });
  });

  dbTest('maintains at most one default per tool', async ({ db }) => {
    const repository = new AgenticToolPresetRepository(db);
    const actor = '00000000-0000-7000-8000-000000000001' as UserID;
    const first = await repository.create(
      { tool: 'codex', name: 'First', configuration: {}, is_default: true },
      actor
    );
    const second = await repository.create(
      { tool: 'codex', name: 'Second', configuration: {}, is_default: true },
      actor
    );
    await expect(repository.findById(first.preset_id)).resolves.toMatchObject({
      is_default: false,
    });
    await expect(repository.findDefault('codex')).resolves.toMatchObject({
      preset_id: second.preset_id,
      is_default: true,
    });
  });
});
