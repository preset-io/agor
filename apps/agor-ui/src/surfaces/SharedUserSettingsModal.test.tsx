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
    const onUpdateUser = vi.fn(() => updatePending.promise);
    const onRefreshCurrentUser = vi.fn(async (_shouldApply: () => boolean) => {});
    const onReopenOnboarding = vi.fn(() => restartPending.promise);
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

  it('passes the exact operation guard through an in-flight current-user refresh', async () => {
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
});
