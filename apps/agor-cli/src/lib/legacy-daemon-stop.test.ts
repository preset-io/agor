import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmLegacyManagedDaemonStop } from './legacy-daemon-stop';

describe('confirmLegacyManagedDaemonStop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never signals or approves a legacy PID non-interactively merely because Agor responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ service: 'agor-daemon' }),
      })
    );

    await expect(confirmLegacyManagedDaemonStop(4242, 'http://localhost:3030')).rejects.toThrow(
      'cannot be verified automatically'
    );
  });

  it('refuses when the configured endpoint is not recognizably Agor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) })
    );

    await expect(confirmLegacyManagedDaemonStop(4242, 'http://localhost:3030')).rejects.toThrow(
      'no Agor daemon was found'
    );
  });
});
