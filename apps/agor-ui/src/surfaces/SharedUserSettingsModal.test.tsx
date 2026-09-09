import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import type { OnboardingReopenMode } from '../utils/onboardingLifecycle';

type CapturedProps = {
  onUpdate: (
    userId: string,
    updates: UpdateUserInput,
    shouldApply?: () => boolean
  ) => Promise<void>;
  onReopenOnboarding?: (mode: OnboardingReopenMode, shouldApply?: () => boolean) => Promise<void>;
};

let captured: CapturedProps | null = null;
vi.mock('../components/SettingsModal', () => ({
  UserSettingsModal: (props: CapturedProps) => {
    captured = props;
    return null;
  },
}));

import { SharedUserSettingsModal } from './SharedUserSettingsModal';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const user = {
  user_id: 'member-a',
  email: 'member-a@example.test',
  role: 'member',
} as User;
const client = {} as AgorClient;

function view(generation: number, children: ReactNode) {
  return (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: generation,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      {children}
    </ConnectionProvider>
  );
}

describe('SharedUserSettingsModal authority fencing', () => {
  beforeEach(() => {
    captured = null;
  });

  it('drops refresh and restart continuations from the previous auth generation', async () => {
    const updatePending = deferred();
    const restartPending = deferred();
    const onUpdateUser = vi.fn<CapturedProps['onUpdate']>(() => updatePending.promise);
    const onRefreshCurrentUser = vi.fn(async (_shouldApply: () => boolean) => {});
    const onReopenOnboarding = vi.fn<NonNullable<CapturedProps['onReopenOnboarding']>>(
      () => restartPending.promise
    );
    const modal = (
      <SharedUserSettingsModal
        open
        user={user}
        client={client}
        onClose={vi.fn()}
        onUpdateUser={onUpdateUser}
        onRefreshCurrentUser={onRefreshCurrentUser}
        onReopenOnboarding={onReopenOnboarding}
      />
    );
    const rendered = render(view(3, modal));
    const pendingUpdate = captured!.onUpdate('member-a', { name: 'A draft' }, () => true);
    const pendingRestart = captured!.onReopenOnboarding!('restart', () => true);
    expect(onUpdateUser).toHaveBeenCalledOnce();
    expect(onReopenOnboarding).toHaveBeenCalledOnce();
    expect(onReopenOnboarding.mock.calls[0]?.[0]).toBe('restart');

    rendered.rerender(view(4, modal));
    await act(async () => {
      updatePending.resolve();
      restartPending.resolve();
      await Promise.all([pendingUpdate, pendingRestart]);
    });

    expect(onRefreshCurrentUser).not.toHaveBeenCalled();
    const updateGuard = onUpdateUser.mock.calls[0]?.[2];
    const restartGuard = onReopenOnboarding.mock.calls[0]?.[1];
    expect(updateGuard?.()).toBe(false);
    expect(restartGuard?.()).toBe(false);
  });

  it('keeps an in-flight current-user refresh fenced to its authority', async () => {
    const refreshPending = deferred();
    let refreshGuard: (() => boolean) | undefined;
    const onRefreshCurrentUser = vi.fn((shouldApply: () => boolean) => {
      refreshGuard = shouldApply;
      return refreshPending.promise;
    });
    const modal = (
      <SharedUserSettingsModal
        open
        user={user}
        client={client}
        onClose={vi.fn()}
        onUpdateUser={vi.fn(async () => {})}
        onRefreshCurrentUser={onRefreshCurrentUser}
      />
    );
    const rendered = render(view(8, modal));
    const pendingUpdate = captured!.onUpdate('member-a', { name: 'A draft' }, () => true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(onRefreshCurrentUser).toHaveBeenCalledOnce();
    expect(refreshGuard?.()).toBe(true);

    rendered.rerender(view(9, modal));
    expect(refreshGuard?.()).toBe(false);
    await act(async () => {
      refreshPending.resolve();
      await pendingUpdate;
    });
  });
  it('serializes each patch and refresh pair and continues after a failed write', async () => {
    const firstRefresh = deferred();
    const calls: string[] = [];
    const onUpdateUser = vi.fn<CapturedProps['onUpdate']>(
      async (_id: string, updates: UpdateUserInput) => {
        calls.push(`patch:${updates.name}`);
        if (updates.name === 'rejected') throw new Error('denied');
      }
    );
    const onRefreshCurrentUser = vi.fn(async () => {
      calls.push('refresh');
      if (onRefreshCurrentUser.mock.calls.length === 1) await firstRefresh.promise;
    });
    render(
      view(
        1,
        <SharedUserSettingsModal
          open
          user={user}
          client={client}
          onClose={vi.fn()}
          onUpdateUser={onUpdateUser}
          onRefreshCurrentUser={onRefreshCurrentUser}
        />
      )
    );
    const first = captured!.onUpdate(user.user_id, { name: 'first' }, () => true);
    const second = captured!.onUpdate(user.user_id, { name: 'rejected' }, () => true);
    const rejected = expect(second).rejects.toThrow('denied');
    const third = captured!.onUpdate(user.user_id, { name: 'third' }, () => true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual(['patch:first', 'refresh']);
    await act(async () => {
      firstRefresh.resolve();
      await first;
      await rejected;
      await third;
    });
    expect(calls).toEqual(['patch:first', 'refresh', 'patch:rejected', 'patch:third', 'refresh']);
  });

  it('refreshes a persisted self-edit after the dialog closes, but not under a new authority', async () => {
    const pendingPatch = deferred();
    let dialogCurrent = true;
    const refresh = vi.fn(async (shouldApply: () => boolean) => {
      expect(shouldApply()).toBe(true);
    });
    const onUpdateUser = vi
      .fn<CapturedProps['onUpdate']>()
      .mockImplementationOnce(() => pendingPatch.promise)
      .mockResolvedValue(undefined);
    const modal = (
      <SharedUserSettingsModal
        open
        user={user}
        client={client}
        onClose={vi.fn()}
        onUpdateUser={onUpdateUser}
        onRefreshCurrentUser={refresh}
      />
    );
    const rendered = render(view(1, modal));
    const oldUpdate = captured!.onUpdate(user.user_id, { name: 'old' }, () => dialogCurrent);
    dialogCurrent = false;
    await act(async () => {
      pendingPatch.resolve();
      await oldUpdate;
    });
    expect(refresh).toHaveBeenCalledOnce();

    const held = deferred();
    onUpdateUser.mockImplementationOnce(() => held.promise);
    const obsolete = captured!.onUpdate(user.user_id, { name: 'obsolete' }, () => true);
    rendered.rerender(view(2, modal));
    await act(async () => {
      await captured!.onUpdate(user.user_id, { name: 'current' }, () => true);
    });
    // The replacement authority did not wait for the obsolete mutation.
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      held.resolve();
      await obsolete;
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
