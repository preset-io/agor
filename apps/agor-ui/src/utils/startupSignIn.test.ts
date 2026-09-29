import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadModule() {
  vi.resetModules();
  return import('./startupSignIn');
}

describe('afterStartupSignInDispatched', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for the sign-in dispatch, then one more macrotask', async () => {
    const { afterStartupSignInDispatched, markStartupSignInDispatched } = await loadModule();
    const done = vi.fn();
    void afterStartupSignInDispatched().then(done);

    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();

    markStartupSignInDispatched();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled(); // the sign-in's own microtasks go first
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after the cap so chunks never stall', async () => {
    const { afterStartupSignInDispatched } = await loadModule();
    const done = vi.fn();
    void afterStartupSignInDispatched(1500).then(done);

    await vi.advanceTimersByTimeAsync(1499);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // the cap
    await vi.runAllTimersAsync(); // the trailing macrotask
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('resolves promptly once sign-in has already been dispatched', async () => {
    const { afterStartupSignInDispatched, markStartupSignInDispatched } = await loadModule();
    markStartupSignInDispatched();
    const done = vi.fn();
    void afterStartupSignInDispatched().then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
