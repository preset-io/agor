import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
  isInitialLoadDebugEnabled,
  syncInitialLoadDebugFlagFromUrl,
} from './initialLoadDebug';

const originalUrl = window.location.href;

afterEach(() => {
  window.history.replaceState({}, '', originalUrl);
  window.localStorage.clear();
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.restoreAllMocks();
});

describe('initial load debug flag', () => {
  it('persists when debugLoad=1 is present', () => {
    window.history.replaceState({}, '', '/?debugLoad=1');

    expect(syncInitialLoadDebugFlagFromUrl()).toBe(true);
    expect(window.localStorage.getItem('agor.debug.initialLoad')).toBe('1');
  });

  it('removes the persisted flag when debugLoad=0 is present', () => {
    window.localStorage.setItem('agor.debug.initialLoad', '1');
    window.history.replaceState({}, '', '/?debugLoad=0');

    expect(syncInitialLoadDebugFlagFromUrl()).toBe(false);
    expect(window.localStorage.getItem('agor.debug.initialLoad')).toBeNull();
  });

  it('uses the persisted flag when the URL has no override', () => {
    window.localStorage.setItem('agor.debug.initialLoad', '1');
    window.history.replaceState({}, '', '/boards');

    expect(isInitialLoadDebugEnabled()).toBe(true);
  });
});

describe('initial load debug timer', () => {
  it('captures fetch status, counts, stage transitions, and exposes the latest payload', async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);

    const timer = createInitialLoadDebugTimer([{ key: 'sessions', label: 'Sessions' }]);
    timer.markStage('fetching');
    timer.startFetchPhase();
    await timer.track('sessions', Promise.resolve([{}, {}]));
    timer.endFetchPhase();
    timer.markStage('indexing');
    timer.startIndexing();
    timer.endIndexing();
    timer.markStage('idle');

    const timings = timer.finish('success');

    expect(timings.status).toBe('success');
    expect(timings.fetches).toMatchObject([
      { key: 'sessions', label: 'Sessions', count: 2, status: 'success' },
    ]);
    expect(timings.stageTransitions.map((transition) => transition.stage)).toEqual([
      'fetching',
      'indexing',
      'idle',
    ]);
    expect(
      (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
        .__AGOR_INITIAL_LOAD_TIMINGS__
    ).toBe(timings);
  });

  it('records fetch errors without swallowing them', async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);

    const timer = createInitialLoadDebugTimer([{ key: 'branches', label: 'Branches' }]);

    await expect(timer.track('branches', Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );

    const timings = timer.finish('error', new Error('boom'));
    expect(timings).toMatchObject({ status: 'error', error: 'boom' });
    expect(timings.fetches).toMatchObject([
      { key: 'branches', label: 'Branches', count: null, status: 'error', error: 'boom' },
    ]);
  });
});
