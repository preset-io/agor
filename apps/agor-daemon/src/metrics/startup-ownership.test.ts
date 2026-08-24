import { describe, expect, it, vi } from 'vitest';
import { NOOP_METRICS } from './noop.js';
import { runWithStartupMetricsOwner } from './startup-ownership.js';

describe('startup metrics ownership', () => {
  it('closes the exporter exactly once when startup fails after initialization', async () => {
    const close = vi.fn(async () => undefined);
    const metrics = { ...NOOP_METRICS, enabled: true, close };
    const startupError = new Error('database initialization failed');

    await expect(
      runWithStartupMetricsOwner(async (ownMetrics) => {
        ownMetrics(metrics);
        throw startupError;
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledOnce();
  });

  it('transfers ownership on successful startup without closing', async () => {
    const close = vi.fn(async () => undefined);
    const metrics = { ...NOOP_METRICS, enabled: true, close };

    await runWithStartupMetricsOwner(async (ownMetrics) => {
      ownMetrics(metrics);
    });

    expect(close).not.toHaveBeenCalled();
  });

  it('preserves the startup error when exporter cleanup also fails', async () => {
    const closeError = new Error('close failed');
    const metrics = {
      ...NOOP_METRICS,
      enabled: true,
      close: vi.fn(async () => {
        throw closeError;
      }),
    };
    const startupError = new Error('route registration failed');
    const report = vi.fn();

    await expect(
      runWithStartupMetricsOwner(async (ownMetrics) => {
        ownMetrics(metrics);
        throw startupError;
      }, report)
    ).rejects.toBe(startupError);

    expect(metrics.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(closeError);
  });
});
