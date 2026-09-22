import type { AgorClient, Session } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useSessionUsage } from './useSessionUsage';

it('loads session totals once independently of paging and refreshes after task changes/reconnect', async () => {
  const listeners = new Map<string, (value?: unknown) => void>();
  const get = vi.fn().mockResolvedValue({ usage_summary: { cost: 20, total: 600 } });
  const service = {
    get,
    on: (event: string, fn: () => void) => listeners.set(event, fn),
    off: vi.fn(),
  };
  const io = { on: (event: string, fn: () => void) => listeners.set(event, fn), off: vi.fn() };
  const client = { service: () => service, io } as unknown as AgorClient;
  const { result, rerender, unmount } = renderHook(() => useSessionUsage(client, 'session', true));
  await waitFor(() => expect(result.current?.cost).toBe(20));
  rerender();
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('session', { query: { include_usage: true } });
  get.mockResolvedValue({ usage_summary: { cost: 21, total: 630 } });
  act(() => listeners.get('patched')!({ session_id: 'session' }));
  await waitFor(() => expect(result.current?.cost).toBe(21));
  act(() => listeners.get('connect')!());
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  unmount();
  expect(service.off).toHaveBeenCalledTimes(4);
});

it('fences old-session results and refreshes once more when a task changes during the request', async () => {
  const listeners = new Map<string, (value?: unknown) => void>();
  const releases: ((session: Partial<Session>) => void)[] = [];
  const get = vi.fn(() => new Promise<Partial<Session>>((resolve) => releases.push(resolve)));
  const service = {
    get,
    on: (event: string, fn: () => void) => listeners.set(event, fn),
    off: vi.fn(),
  };
  const client = {
    service: () => service,
    io: { on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  const { result, rerender } = renderHook(({ id }) => useSessionUsage(client, id, true), {
    initialProps: { id: 'old' },
  });
  rerender({ id: 'new' });
  act(() => listeners.get('patched')!({ session_id: 'new' }));
  await act(async () => {
    releases[0]({ usage_summary: { cost: 999 } as Session['usage_summary'] });
    releases[1]({ usage_summary: { cost: 1 } as Session['usage_summary'] });
  });
  expect(result.current).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(3);
  await act(async () => releases[2]({ usage_summary: { cost: 2 } as Session['usage_summary'] }));
  expect(result.current?.cost).toBe(2);
});
