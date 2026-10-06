import type { AgorClient } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSharedReactiveSession } from './useSharedReactiveSession';

const { retain, release, handle, handleFor } = vi.hoisted(() => {
  const make = (state: Record<string, unknown>) => ({
    state: { error: null, terminal: false, ...state },
    subscribe: vi.fn(() => () => {}),
    ready: vi.fn(async () => {}),
  });
  const handle = make({});
  const handles = new Map<string, ReturnType<typeof make>>();
  const handleFor = (sessionId: string, state: Record<string, unknown>) =>
    handles.set(sessionId, make({ sessionId, ...state }));
  return {
    retain: vi.fn((_client: unknown, sessionId: string) => handles.get(sessionId) ?? handle),
    release: vi.fn(),
    handle,
    handleFor,
  };
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

it("never shows the previous session's context-window projection after a switch", () => {
  handleFor('session-a', {
    latestContextWindow: { task_id: 'turn-a', computed_context_window: 7 },
  });
  handleFor('session-b', {});
  const client = {} as AgorClient;
  const { result, rerender } = renderHook(({ id }) => useSharedReactiveSession(client, id), {
    initialProps: { id: 'session-a' },
  });
  expect(result.current.state?.latestContextWindow?.task_id).toBe('turn-a');
  rerender({ id: 'session-b' });
  expect(result.current.state?.latestContextWindow).toBeUndefined();
});
