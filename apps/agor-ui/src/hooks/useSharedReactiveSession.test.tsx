import type { AgorClient } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSharedReactiveSession } from './useSharedReactiveSession';

const { retain, release, handle } = vi.hoisted(() => {
  const handle = {
    state: { error: null, terminal: false },
    subscribe: vi.fn(() => () => {}),
    ready: vi.fn(async () => {}),
  };
  return { retain: vi.fn(() => handle), release: vi.fn(), handle };
});
vi.mock('@agor-live/client', () => ({
  retainReactiveSession: retain,
  releaseReactiveSession: release,
}));

beforeEach(() => vi.clearAllMocks());

it('uses lean history without an environment flag or caller override', () => {
  const client = {} as AgorClient;
  const { result, unmount } = renderHook(() => useSharedReactiveSession(client, 'session-id'));
  expect(retain).toHaveBeenCalledWith(client, 'session-id', {
    taskHydration: 'lean',
    cacheScope: 'session',
  });
  expect(result.current.handle).toBe(handle);
  unmount();
  expect(release).toHaveBeenCalledWith(client, 'session-id', {
    taskHydration: 'lean',
    cacheScope: 'session',
  });
});

it('does not bootstrap an inactive conversation', () => {
  const { result } = renderHook(() =>
    useSharedReactiveSession({} as AgorClient, 'session-id', { enabled: false })
  );
  expect(retain).not.toHaveBeenCalled();
  expect(result.current.handle).toBeNull();
});
