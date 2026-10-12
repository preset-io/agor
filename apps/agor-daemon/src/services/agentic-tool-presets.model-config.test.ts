import { AgenticToolPresetRepository, generateId, UsersRepository } from '@agor/core/db';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AgenticToolPresetsService } from './agentic-tool-presets';

describe('AgenticToolPresetsService exact model configuration', () => {
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

describe('Codex plugin preset preference', () => {
  dbTest('persists true/false and rejects non-booleans before writing', async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `plugin-owner-${generateId()}@example.com`,
      name: 'Plugins',
    });
    const service = new AgenticToolPresetsService(db);
    const created = await service.create(
      { tool: 'codex', name: 'Plugins', configuration: { codexIncludePlugins: true } },
      { user: owner } as never
    );
    expect(created.configuration.codexIncludePlugins).toBe(true);
    expect(
      (
        await service.patch(created.preset_id, { configuration: { codexIncludePlugins: false } }, {
          user: owner,
        } as never)
      ).configuration.codexIncludePlugins
    ).toBe(false);
    for (const value of ['false', null, 0, [], {}]) {
      await expect(
        service.patch(
          created.preset_id,
          { configuration: { codexIncludePlugins: value } } as never,
          { user: owner } as never
        )
      ).rejects.toThrow('codexIncludePlugins must be a boolean');
    }
    expect((await service.get(created.preset_id)).configuration.codexIncludePlugins).toBe(false);
  });
});
