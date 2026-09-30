import type { AgorClient, Branch, User } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import {
  type PrimaryAssistantSendOptions,
  usePrimaryAssistantSend,
} from './usePrimaryAssistantSend';

const goToSession = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({ goToSession }),
}));

const ada = { branch_id: 'branch-ada', name: 'ada', board_id: 'board-ada' } as unknown as Branch;
const grace = { branch_id: 'branch-grace', name: 'grace' } as unknown as Branch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function clientResolving(getPrimaryTeammate: () => Promise<Branch | null>) {
  return { service: () => ({ getPrimaryTeammate }) } as unknown as AgorClient;
}

const wrapper = ({ children }: { children: ReactNode }) => <AntApp>{children}</AntApp>;

type Props = Partial<PrimaryAssistantSendOptions>;

function renderSend(initial: Props = {}) {
  const create = vi.fn<
    (config: NewSessionConfig, boardId: string) => Promise<SessionCreationResult | null>
  >(async () => ({ sessionId: 'session-new' }));
  const onSent = vi.fn();
  const client = clientResolving(async () => ada);
  const view = renderHook(
    (props: Props) =>
      usePrimaryAssistantSend({
        client,
        currentUser: { user_id: 'user-a' } as User,
        onCreateSession: create,
        buildConfig: (branch) => ({ branch_id: branch.branch_id }) as unknown as NewSessionConfig,
        onSent,
        ...props,
      }),
    { wrapper, initialProps: initial }
  );
  // Later props layer over the initial ones, as a parent re-render would.
  const rerender = (next: Props) => view.rerender({ ...initial, ...next });
  return { ...view, rerender, create, onSent };
}

describe('usePrimaryAssistantSend', () => {
  beforeEach(() => goToSession.mockClear());

  it('creates one session for two rapid sends', async () => {
    const creation = deferred<SessionCreationResult | null>();
    const onCreateSession = vi.fn(() => creation.promise);
    const { result } = renderSend({ onCreateSession });
    await waitFor(() => expect(result.current.primaryBranch).toBe(ada));

    act(() => {
      void result.current.send('background');
      void result.current.send('open');
    });
    await waitFor(() => expect(result.current.submitting).toBe('background'));
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    await act(async () => creation.resolve({ sessionId: 'session-new' }));
    expect(result.current.submitting).toBeNull();
  });

  it('opens the session through onOpenSession when given, instead of navigating', async () => {
    const onOpenSession = vi.fn();
    const { result } = renderSend({ onOpenSession });
    await waitFor(() => expect(result.current.primaryBranch).toBe(ada));

    await act(() => result.current.send('open'));
    expect(onOpenSession).toHaveBeenCalledWith('session-new');
    expect(goToSession).not.toHaveBeenCalled();
  });

  it('does not send while the primary is resolving or failed to resolve, but an explicit teammate can', async () => {
    const resolve = deferred<Branch | null>();
    const { result, create, rerender } = renderSend({
      client: clientResolving(() => resolve.promise),
    });
    expect(result.current.resolving).toBe(true);
    await act(() => result.current.send('open'));
    expect(create).not.toHaveBeenCalled();
    expect(result.current.pendingSend).toBeNull();

    await act(() => result.current.send('background', grace));
    expect(create).toHaveBeenCalledWith({ branch_id: 'branch-grace' }, '');

    rerender({ client: clientResolving(() => Promise.reject(new Error('offline'))) });
    await waitFor(() => expect(result.current.resolveFailed).toBe(true));
    await act(() => result.current.send('open'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.current.pendingSend).toBeNull();
  });

  it("never sends to the previous caller's primary after an identity change", async () => {
    const { result, create, rerender } = renderSend();
    await waitFor(() => expect(result.current.primaryBranch).toBe(ada));

    // No client for the new caller, so the old branch lingers without a re-resolve.
    rerender({ client: null, currentUser: { user_id: 'user-b' } as User });
    expect(result.current.primaryBranch).toBe(ada);
    await act(() => result.current.send('open'));
    expect(create).not.toHaveBeenCalled();
    expect(result.current.pendingSend).toBe('open');
  });

  it('releases an in-flight send and a held send when the identity changes', async () => {
    const creation = deferred<SessionCreationResult | null>();
    const onCreateSession = vi
      .fn<(config: NewSessionConfig, boardId: string) => Promise<SessionCreationResult | null>>()
      .mockReturnValueOnce(creation.promise)
      .mockResolvedValue({ sessionId: 'session-b' });
    const { result, rerender, onSent } = renderSend({ onCreateSession });
    await waitFor(() => expect(result.current.primaryBranch).toBe(ada));

    act(() => void result.current.send('background'));
    await waitFor(() => expect(result.current.submitting).toBe('background'));

    rerender({ currentUser: { user_id: 'user-b' } as User });
    expect(result.current.submitting).toBeNull();
    await waitFor(() => expect(result.current.resolving).toBe(false));

    await act(() => result.current.send('open'));
    expect(onCreateSession).toHaveBeenCalledTimes(2);
    expect(goToSession).toHaveBeenCalledWith('session-b');

    await act(async () => creation.resolve({ sessionId: 'session-stale' }));
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(goToSession).not.toHaveBeenCalledWith('session-stale');
  });

  it('drops a held send when the identity changes', async () => {
    const { result, rerender } = renderSend({ client: clientResolving(async () => null) });
    await waitFor(() => expect(result.current.resolving).toBe(false));
    await act(() => result.current.send('open'));
    expect(result.current.pendingSend).toBe('open');

    rerender({ client: clientResolving(async () => null), currentUser: { user_id: 'b' } as User });
    expect(result.current.pendingSend).toBeNull();
  });

  it('resumes a held send on pick with the latest mode, then clears it', async () => {
    const onOpenSession = vi.fn();
    const { result, create } = renderSend({
      client: clientResolving(async () => null),
      onOpenSession,
    });
    await waitFor(() => expect(result.current.resolving).toBe(false));
    await act(() => result.current.send('background'));
    // Held from an earlier render: it must still resume with the latest mode.
    const pick = result.current.pick;
    await act(() => result.current.send('open'));

    await act(async () => pick(grace));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(onOpenSession).toHaveBeenCalledWith('session-new');
    expect(result.current.pendingSend).toBeNull();
    expect(result.current.primaryBranch).toBe(grace);
  });

  it('keeps send, pick and clearPendingSend stable across renders', async () => {
    const { result, rerender } = renderSend();
    const first = result.current;
    await waitFor(() => expect(result.current.primaryBranch).toBe(ada));
    rerender({ currentBoardId: 'board-other' });
    expect(result.current.send).toBe(first.send);
    expect(result.current.pick).toBe(first.pick);
    expect(result.current.clearPendingSend).toBe(first.clearPendingSend);
  });
});
