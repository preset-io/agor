import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';
import { useSessionUsage } from './useSessionUsage';

it('fetches only when opened, retries errors and fetches fresh after reopening', async () => {
  const get = vi.fn().mockResolvedValue({ usage_summary: { cost: 20 } });
  const client = { service: () => ({ get }) } as unknown as AgorClient;
  const { result, rerender } = renderHook(({ open }) => useSessionUsage(client, 'session', open), {
    initialProps: { open: false },
  });
  expect(get).not.toHaveBeenCalled();
  rerender({ open: true });
  await waitFor(() => expect(result.current.usage?.cost).toBe(20));
  rerender({ open: true });
  expect(get).toHaveBeenCalledTimes(1);
  rerender({ open: false });
  expect(result.current.usage).toBeUndefined();
  get.mockRejectedValueOnce(new Error('failed'));
  rerender({ open: true });
  await waitFor(() => expect(result.current.error).toBeTruthy());
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.usage?.cost).toBe(20));
  expect(get).toHaveBeenCalledTimes(3);
});

it('fences previous session and credential results', async () => {
  const releases: ((value: unknown) => void)[] = [];
  const get = vi.fn(() => new Promise((resolve) => releases.push(resolve)));
  const client = { service: () => ({ get }) } as unknown as AgorClient;
  const { result, rerender } = renderHook(({ id }) => useSessionUsage(client, id, true), {
    initialProps: { id: 'old' },
  });
  rerender({ id: 'new' });
  act(() => window.dispatchEvent(new Event(TOKENS_REFRESHED_EVENT)));
  await act(async () => {
    releases[0]({ usage_summary: { cost: 999 } });
    releases[1]({ usage_summary: { cost: 999 } });
  });
  expect(result.current.usage).toBeUndefined();
  await act(async () => releases[2]({ usage_summary: { cost: 2 } }));
  expect(result.current.usage?.cost).toBe(2);
});
