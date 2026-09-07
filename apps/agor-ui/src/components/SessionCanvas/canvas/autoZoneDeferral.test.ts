import { describe, expect, it, vi } from 'vitest';
import { AUTO_ZONE_INTERACTION_DEFER_MS, AutoZoneDeferral } from './autoZoneDeferral';

describe('AutoZoneDeferral', () => {
  it('uses a rolling one-minute deadline for continued interaction', () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const deferral = new AutoZoneDeferral();

    deferral.defer('zone-1', ready);
    vi.advanceTimersByTime(AUTO_ZONE_INTERACTION_DEFER_MS / 2);
    deferral.defer('zone-1', ready);
    vi.advanceTimersByTime(AUTO_ZONE_INTERACTION_DEFER_MS / 2 + 1);
    expect(ready).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AUTO_ZONE_INTERACTION_DEFER_MS / 2 - 1);
    expect(ready).toHaveBeenCalledTimes(1);
    deferral.dispose();
    vi.useRealTimers();
  });

  it('cancels a pending tidy when an Auto Zone is demoted', () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const deferral = new AutoZoneDeferral();
    deferral.defer('zone-1', ready);
    deferral.cancel('zone-1');

    vi.runAllTimers();
    expect(ready).not.toHaveBeenCalled();
    deferral.dispose();
    vi.useRealTimers();
  });
});
