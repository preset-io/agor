import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useIdentityGuardedAsync } from './useIdentityGuardedAsync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drain the microtask queue so settled work()s run their guarded continuations.
const flush = () => act(async () => {});

describe('useIdentityGuardedAsync', () => {
  it('resolves run() to work()’s value while the identity is unchanged', async () => {
    const { result } = renderHook(() => useIdentityGuardedAsync([1]));
    const work = deferred<string>();
    const onResult = vi.fn();

    result.current.run(() => work.promise).then(onResult);
    work.resolve('verdict');
    await flush();

    expect(onResult).toHaveBeenCalledWith('verdict');
  });

  it('propagates work()’s rejection while the identity is unchanged', async () => {
    const { result } = renderHook(() => useIdentityGuardedAsync([1]));
    const work = deferred<string>();
    const onError = vi.fn();

    result.current.run(() => work.promise).catch(onError);
    const boom = new Error('transport failure');
    work.reject(boom);
    await flush();

    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('never settles a run() whose identity swapped before work() resolved', async () => {
    const { result, rerender } = renderHook(({ id }) => useIdentityGuardedAsync([id]), {
      initialProps: { id: 1 },
    });
    const work = deferred<string>();
    const onSettled = vi.fn();

    result.current.run(() => work.promise).then(onSettled, onSettled);
    rerender({ id: 2 });
    work.resolve('stale verdict');
    await flush();

    // The swap invalidated the call: its continuation must never run, so it can
    // neither commit a stale verdict nor clear the replacement's spinner.
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('never settles a run() when the component unmounts before work() resolves', async () => {
    const { result, unmount } = renderHook(() => useIdentityGuardedAsync([1]));
    const work = deferred<string>();
    const onSettled = vi.fn();

    result.current.run(() => work.promise).then(onSettled, onSettled);
    unmount();
    work.resolve('post-teardown');
    await flush();

    expect(onSettled).not.toHaveBeenCalled();
  });

  it('tags each call with its own generation — an older in-flight call is dropped even after a newer one starts', async () => {
    const { result, rerender } = renderHook(({ id }) => useIdentityGuardedAsync([id]), {
      initialProps: { id: 1 },
    });

    // Call A under identity 1, still in flight when the identity swaps to 2.
    const workA = deferred<string>();
    const onA = vi.fn();
    result.current.run(() => workA.promise).then(onA, onA);

    rerender({ id: 2 });

    // Call B under identity 2, started AFTER the swap.
    const workB = deferred<string>();
    const onB = vi.fn();
    result.current.run(() => workB.promise).then(onB, onB);

    // A resolves last, but belongs to the superseded identity — it must not
    // commit (a shared generation would falsely mark it current here).
    workA.resolve('A');
    await flush();
    expect(onA).not.toHaveBeenCalled();

    // B owns the live identity and commits normally.
    workB.resolve('B');
    await flush();
    expect(onB).toHaveBeenCalledWith('B');
  });

  it('supersedes an older in-flight run with a newer one under an unchanged identity', async () => {
    const { result } = renderHook(() => useIdentityGuardedAsync([1]));

    // Two overlapping runs against the SAME identity (e.g. a stale probe still
    // in flight when a re-probe fires after a successful sign-in). The older one
    // must never commit even if it resolves last — newest-wins.
    const first = deferred<string>();
    const onFirst = vi.fn();
    result.current.run(() => first.promise).then(onFirst, onFirst);

    const second = deferred<string>();
    const onSecond = vi.fn();
    result.current.run(() => second.promise).then(onSecond, onSecond);

    first.resolve('stale verdict');
    await flush();
    expect(onFirst).not.toHaveBeenCalled();

    second.resolve('fresh verdict');
    await flush();
    expect(onSecond).toHaveBeenCalledWith('fresh verdict');
  });

  it('fires onIdentityChange on mount and on every identity change, not on a same-identity render', () => {
    const onIdentityChange = vi.fn();
    const { rerender } = renderHook(({ id }) => useIdentityGuardedAsync([id], onIdentityChange), {
      initialProps: { id: 1 },
    });

    expect(onIdentityChange).toHaveBeenCalledTimes(1); // mount

    rerender({ id: 2 });
    expect(onIdentityChange).toHaveBeenCalledTimes(2);

    rerender({ id: 2 }); // no change
    expect(onIdentityChange).toHaveBeenCalledTimes(2);

    rerender({ id: 3 });
    expect(onIdentityChange).toHaveBeenCalledTimes(3);
  });

  it('isCurrent() reports whether the identity held since the last run()', () => {
    const { result, rerender } = renderHook(({ id }) => useIdentityGuardedAsync([id]), {
      initialProps: { id: 1 },
    });

    result.current.run(() => Promise.resolve('x'));
    expect(result.current.isCurrent()).toBe(true);

    rerender({ id: 2 });
    expect(result.current.isCurrent()).toBe(false);
  });
});
