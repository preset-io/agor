import { AgenticToolPresetRepository, generateId, UsersRepository } from '@agor/core/db';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AgenticToolPresetsService } from './agentic-tool-presets';

describe('AgenticToolPresetsService exact model configuration', () => {
  dbTest('rejects presets for the built-in workload at the service boundary', async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `preset-owner-${generateId()}@example.com`,
      name: 'Preset owner',
    });

    await expect(
      new AgenticToolPresetsService(db).create(
        { tool: 'workload', name: 'Not configurable', configuration: {} },
        { user: owner } as never
      )
    ).rejects.toThrow('workload does not support presets');
    expect(await new AgenticToolPresetRepository(db).find('workload')).toHaveLength(0);
  });

  dbTest('rejects incomplete OpenCode presets before persistence', async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `preset-owner-${generateId()}@example.com`,
      name: 'Preset owner',
    });
    const service = new AgenticToolPresetsService(db);

    await expect(
      service.create(
        {
          tool: 'opencode',
          name: 'Incomplete',
          configuration: { modelConfig: { mode: 'exact', model: 'gpt-test' } },
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/provider and model/i);
    expect(await new AgenticToolPresetRepository(db).find()).toHaveLength(0);
  });

  dbTest('normalizes and persists a complete exact OpenCode pair', async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `preset-owner-${generateId()}@example.com`,
      name: 'Preset owner',
    });
    const created = await new AgenticToolPresetsService(db).create(
      {
        tool: 'opencode',
        name: 'Exact',
        configuration: {
          modelConfig: { mode: 'alias', provider: 'openai', model: 'gpt-test' },
        },
      },
      { user: owner } as never
    );

    expect(created.configuration.modelConfig).toMatchObject({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-test',
    });
  });
});
