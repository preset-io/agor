import { feathers } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import { DrizzleService, type Repository } from '../adapters/drizzle.js';
import { patchUnlessRemoved } from './patch-unless-removed.js';

interface Widget {
  id: string;
  name: string;
}

function missingWidgetRepository(): Repository<Widget> {
  return {
    create: vi.fn(),
    findById: vi.fn(async () => null),
    findAll: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

describe('patchUnlessRemoved', () => {
  it('tolerates a real DrizzleService deletion race', async () => {
    const app = feathers();
    app.use(
      'widgets',
      new DrizzleService<Widget>(missingWidgetRepository(), {
        id: 'id',
        resourceType: 'Widget',
      }) as never
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      patchUnlessRemoved(app, 'widgets', 'missing-widget', { name: 'late update' }, 'Widget')
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('was deleted mid-execution'));
    log.mockRestore();
  });

  it('does not swallow unrelated patch failures', async () => {
    const failure = new Error('database unavailable');
    const app = {
      service: () => ({ patch: vi.fn(async () => Promise.reject(failure)) }),
    };

    await expect(
      patchUnlessRemoved(app as never, 'widgets', 'widget-1', { name: 'update' }, 'Widget')
    ).rejects.toBe(failure);
  });
});
