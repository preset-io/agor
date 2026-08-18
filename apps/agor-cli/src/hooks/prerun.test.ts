import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/config', () => ({ loadConfig: vi.fn() }));
vi.mock('../lib/local-context.js', () => ({ assertLocalContextUnlocked: vi.fn() }));

import { loadConfig } from '@agor/core/config';
import { assertLocalContextUnlocked } from '../lib/local-context.js';
import hook from './prerun';

const config = {
  daemon: { deployment_id: '019c1234-5678-7123-8123-123456789abc' },
};

async function runHook(commandId: string) {
  await hook.call(
    {} as ThisParameterType<typeof hook>,
    { Command: { id: commandId } } as Parameters<typeof hook>[0]
  );
}

describe('CLI context prerun hook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadConfig).mockResolvedValue(config);
  });

  it('guards local commands before their implementation runs', async () => {
    vi.mocked(assertLocalContextUnlocked).mockRejectedValue(
      new Error('Local administration is locked')
    );

    await expect(runHook('doctor')).rejects.toThrow('Local administration is locked');
    expect(assertLocalContextUnlocked).toHaveBeenCalledWith(config);
  });

  it('does not apply the local guard to connected commands', async () => {
    await runHook('user:list');

    expect(loadConfig).not.toHaveBeenCalled();
    expect(assertLocalContextUnlocked).not.toHaveBeenCalled();
  });

  it('leaves daemon lifecycle commands to their effective-config-aware guard', async () => {
    await runHook('daemon:stop');

    expect(loadConfig).not.toHaveBeenCalled();
    expect(assertLocalContextUnlocked).not.toHaveBeenCalled();
  });
});
