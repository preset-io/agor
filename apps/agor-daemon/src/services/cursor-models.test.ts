import { runWithTenantContext } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  isTenantAgenticToolEnabled: vi.fn().mockResolvedValue(true),
  resolveApiKey: vi.fn(),
}));

const cursorMocks = vi.hoisted(() => ({
  modelsList: vi.fn(),
}));

vi.mock('@agor/core/config', () => configMocks);
vi.mock('@cursor/sdk', () => ({
  Cursor: {
    models: {
      list: cursorMocks.modelsList,
    },
  },
}));

import { CursorModelsService } from './cursor-models.js';

describe('CursorModelsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the live model list with the server-reported default', async () => {
    configMocks.resolveApiKey.mockResolvedValue({ apiKey: 'cursor-key', source: 'user' });
    cursorMocks.modelsList.mockResolvedValue([
      { id: 'other-model', displayName: 'Other Model' },
      { id: 'composer-latest', displayName: 'Composer Latest' },
    ]);

    const service = new CursorModelsService({ run: vi.fn() } as never);
    const result = await runWithTenantContext('tenant-test', () =>
      service.find({ user: { user_id: 'user-id' } } as never)
    );

    expect(result.default).toBe('composer-latest');
    expect(result.source).toBe('dynamic');
    expect(result.models.map((model) => model.id)).toEqual(['other-model', 'composer-latest']);
  });

  it('falls back to the static model list when the SDK call fails', async () => {
    configMocks.resolveApiKey.mockResolvedValue({ apiKey: 'cursor-key', source: 'user' });
    cursorMocks.modelsList.mockRejectedValue(new Error('boom'));

    const service = new CursorModelsService({ run: vi.fn() } as never);
    const result = await runWithTenantContext('tenant-test', () =>
      service.find({ user: { user_id: 'user-id' } } as never)
    );

    expect(result).toMatchObject({
      default: 'composer-latest',
      source: 'static',
      models: [{ id: 'composer-latest', source: 'static' }],
    });
  });
});
