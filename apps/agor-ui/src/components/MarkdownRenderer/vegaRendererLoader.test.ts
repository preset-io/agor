import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { loadVegaRenderer, VEGA_RENDERER_LOAD_TIMEOUT_MS } from './vegaRendererLoader';

describe('loadVegaRenderer', () => {
  it('surfaces a rejected lazy component chunk', async () => {
    await expect(loadVegaRenderer(() => Promise.reject(new Error('chunk failed')))).rejects.toThrow(
      'chunk failed'
    );
  });

  it('rejects a stalled lazy component load after its separate timeout', async () => {
    vi.useFakeTimers();
    try {
      const result = loadVegaRenderer(() => new Promise(() => undefined));
      const assertion = expect(result).rejects.toThrow(/could not be loaded in time/);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(VEGA_RENDERER_LOAD_TIMEOUT_MS);
      });
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
