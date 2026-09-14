import type { UserPreferences } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeferredOnboardingPreferences,
  buildRestartedOnboardingPreferences,
  buildResumedOnboardingPreferences,
  createOnboardingWriteQueue,
  isOnboardingDeferred,
} from './onboardingLifecycle';

describe('onboarding deferral preferences', () => {
  it('merges into the latest preferences without marking completion or losing progress', () => {
    const preferences = buildDeferredOnboardingPreferences(
      {
        audio: { enabled: true, chime: 'gentle-chime', volume: 0.5, minDurationSeconds: 0 },
        onboarding: { boardId: 'board-1', goals: ['status-updates'] },
      },
      '2026-08-28T22:00:00.000Z',
      { boardId: 'board-candidate', teammateDisplayName: 'Ada' }
    );

    expect(preferences).toMatchObject({
      onboarding: {
        boardId: 'board-candidate',
        goals: ['status-updates'],
        teammateDisplayName: 'Ada',
        deferredAt: '2026-08-28T22:00:00.000Z',
      },
    });
    expect(isOnboardingDeferred(preferences)).toBe(true);
  });

  it('does not treat absent or malformed markers as durable deferral', () => {
    expect(isOnboardingDeferred(undefined)).toBe(false);
    expect(isOnboardingDeferred({ onboarding: {} })).toBe(false);
    expect(isOnboardingDeferred({ onboarding: { deferredAt: undefined } })).toBe(false);
    expect(isOnboardingDeferred({ onboarding: { deferredAt: '  ' } })).toBe(false);
  });

  it('resumes by clearing only deferredAt and preserving resource identity', () => {
    expect(
      buildResumedOnboardingPreferences({
        mainBoardId: 'board-main',
        onboarding: {
          deferredAt: '2026-08-28T22:00:00.000Z',
          boardId: 'board-candidate',
          branchId: 'branch-existing',
          teammateDisplayName: 'Ada',
        },
      })
    ).toEqual({
      mainBoardId: 'board-main',
      onboarding: {
        boardId: 'board-candidate',
        branchId: 'branch-existing',
        teammateDisplayName: 'Ada',
      },
    });
  });

  it('restarts only when explicitly asked by clearing wizard progress', () => {
    expect(
      buildRestartedOnboardingPreferences({
        mainBoardId: 'board-main',
        onboarding: {
          deferredAt: '2026-08-28T22:00:00.000Z',
          boardId: 'board-candidate',
        },
      })
    ).toEqual({ mainBoardId: 'board-main' });
  });
});

describe('onboarding owner write queue', () => {
  it('waits for an issued progress patch before deferral and fences later active writes', async () => {
    const queue = createOnboardingWriteQueue();
    const owner = {};
    let current = true;
    let release!: () => void;
    let preferences: UserPreferences = { onboarding: {} };
    const started = vi.fn();
    const progress = queue(
      owner,
      () => current,
      async () => {
        const snapshot = preferences;
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        preferences = { ...snapshot, onboarding: { branchId: 'saved-branch' } };
      }
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    current = false; // synchronous dismissal
    const late = vi.fn(async () => undefined);
    const skipped = queue(owner, () => current, late);
    const deferred = queue(
      owner,
      () => true,
      async () => {
        preferences = buildDeferredOnboardingPreferences(preferences, 'later');
      }
    );
    release();
    await Promise.all([progress, skipped, deferred]);
    expect(preferences).toMatchObject({
      onboarding: { branchId: 'saved-branch', deferredAt: 'later' },
    });
    expect(late).not.toHaveBeenCalled();
  });
  it('does not run a queued mutation after authenticated owner replacement', async () => {
    const queue = createOnboardingWriteQueue();
    const write = vi.fn(async () => undefined);
    await queue({}, () => false, write);
    expect(write).not.toHaveBeenCalled();
  });
});
