import { act, render, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStorage } from './useLocalStorage';

const KEY = 'agor:test-local-storage';

describe('useLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('syncs updates to other mounted hooks in the same tab', () => {
    const first = renderHook(() => useLocalStorage<string>(KEY, 'recent'));
    const second = renderHook(() => useLocalStorage<string>(KEY, 'recent'));

    act(() => first.result.current[1]('oldest'));

    expect(first.result.current[0]).toBe('oldest');
    expect(second.result.current[0]).toBe('oldest');
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toBe('oldest');
  });

  it('falls back to the initial value for malformed stored JSON', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.localStorage.setItem(KEY, '{not-json');

    const { result } = renderHook(() => useLocalStorage<string>(KEY, 'recent'));

    expect(result.current[0]).toBe('recent');
    expect(consoleError).toHaveBeenCalled();
  });

  it('does not trigger a setState-in-render warning when a sibling hook shares the key', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function Writer() {
      const [, setValue] = useLocalStorage<string>(KEY, 'recent');
      const [, setTick] = useState(0);
      useEffect(() => {
        // Queue an unrelated update first so the writer's fiber already has
        // pending work when setValue runs. That defeats React's eager-state
        // bailout, forcing the state updater to execute during the render
        // phase — the same condition under which a side effect dispatched
        // from inside the updater would call a sibling's setState mid-render.
        setTick((tick) => tick + 1);
        setValue('written');
      }, [setValue]);
      return null;
    }

    function Reader() {
      const [value] = useLocalStorage<string>(KEY, 'recent');
      return <span>{value}</span>;
    }

    act(() => {
      render(
        <>
          <Writer />
          <Reader />
        </>
      );
    });

    const offendingCalls = consoleError.mock.calls.filter((callArgs) =>
      callArgs.some(
        (arg) => typeof arg === 'string' && arg.includes('while rendering a different component')
      )
    );
    expect(offendingCalls).toEqual([]);
  });
});
