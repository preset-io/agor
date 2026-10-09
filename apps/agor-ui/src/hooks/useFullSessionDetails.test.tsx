import type { AgorClient, Session } from '@agor-live/client';
import { SESSION_LIST_ROW_SHAPE } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { useFullSessionDetails } from './useFullSessionDetails';

const fullRow = {
  session_id: 's-1',
  custom_context: { scheduled_run: { schedule_id: 'sched-1' } },
} as unknown as Session;
const leanRow = {
  session_id: 's-1',
  custom_context: {},
  read_shape: SESSION_LIST_ROW_SHAPE,
} as unknown as Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clientWith(get: (id: string) => Promise<Session>): AgorClient {
  return { service: () => ({ get }) } as unknown as AgorClient;
}

function renderDetails(client: AgorClient, initialRow: Session, timeoutMs?: number) {
  let authGeneration = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      {children}
    </ConnectionProvider>
  );
  const hook = renderHook(
    ({ row }: { row: Session }) => useFullSessionDetails(client, row, true, timeoutMs),
    { wrapper, initialProps: { row: initialRow } }
  );
  return {
    ...hook,
    reauth(row: Session) {
      authGeneration += 1;
      hook.rerender({ row });
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('useFullSessionDetails', () => {
  it('becomes ready from a full store row that arrives while the fetch is pending', async () => {
    const pending = deferred<Session>();
    const { result, rerender } = renderDetails(
      clientWith(() => pending.promise),
      leanRow
    );
    expect(result.current.status).toBe('loading');

    rerender({ row: fullRow });
    expect(result.current).toMatchObject({ status: 'ready', session: fullRow });

    // The dropped fetch failing later does not turn it back into an error.
    await act(async () => pending.reject(new Error('late failure')));
    rerender({ row: leanRow });
    expect(result.current).toMatchObject({ status: 'ready', session: fullRow });
  });

  it('becomes ready from a full store row after the fetch timed out or failed', async () => {
    vi.useFakeTimers();
    const timedOut = renderDetails(
      clientWith(() => new Promise<Session>(() => {})),
      leanRow,
      1_000
    );
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(timedOut.result.current.status).toBe('error');
    timedOut.rerender({ row: fullRow });
    expect(timedOut.result.current).toMatchObject({ status: 'ready', session: fullRow });
    vi.useRealTimers();

    const failed = renderDetails(
      clientWith(() => Promise.reject(new Error('denied'))),
      leanRow
    );
    await waitFor(() => expect(failed.result.current.status).toBe('error'));
    failed.rerender({ row: fullRow });
    expect(failed.result.current).toMatchObject({ status: 'ready', session: fullRow });
    failed.rerender({ row: leanRow });
    expect(failed.result.current).toMatchObject({ status: 'ready', session: fullRow });
  });

  it('restarts a fetch that is still pending when the socket re-authenticates', async () => {
    const first = deferred<Session>();
    const get = vi
      .fn<(id: string) => Promise<Session>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(fullRow);
    const { result, reauth } = renderDetails(clientWith(get), leanRow);
    expect(result.current.status).toBe('loading');

    reauth(leanRow);
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: 'ready', session: fullRow })
    );
    expect(get).toHaveBeenCalledTimes(2);

    // The attempt made under the old auth failing afterwards is ignored.
    await act(async () => first.reject(new Error('unauthenticated')));
    expect(result.current).toMatchObject({ status: 'ready', session: fullRow });
  });

  it('retries a failed fetch when the socket re-authenticates', async () => {
    const get = vi
      .fn<(id: string) => Promise<Session>>()
      .mockRejectedValueOnce(new Error('unauthenticated'))
      .mockResolvedValueOnce(fullRow);
    const { result, reauth } = renderDetails(clientWith(get), leanRow);
    await waitFor(() => expect(result.current.status).toBe('error'));

    reauth(leanRow);
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: 'ready', session: fullRow })
    );
  });
});
