import type { Branch } from '@agor-live/client';
import { act, render, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMaps } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomePage } from './HomePage';
import {
  asDesktop,
  comment,
  ME,
  recent,
  renderHome,
  resetHome,
  seed,
  session,
  stableProps,
  teammate,
  wrap,
} from './testUtils';

// HomePage's body is the only caller; counting it counts HomePage renders.
// Its effect counts HomePage mounts.
const homeRenders = vi.hoisted(() => ({ count: 0, mounts: 0 }));
vi.mock('../../hooks/useIdleReady', async () => {
  const { useEffect } = await import('react');
  return {
    useIdleReady: () => {
      homeRenders.count += 1;
      useEffect(() => {
        homeRenders.mounts += 1;
      }, []);
      return true;
    },
  };
});

// Counts title reads per session: every session row render reads its title once.
const titleReads = vi.hoisted(() => new Map<string, number>());
vi.mock('../../utils/sessionTitle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/sessionTitle')>();
  return {
    ...actual,
    getSessionDisplayTitle: (...args: Parameters<typeof actual.getSessionDisplayTitle>) => {
      const id = args[0].session_id;
      titleReads.set(id, (titleReads.get(id) ?? 0) + 1);
      return actual.getSessionDisplayTitle(...args);
    },
  };
});

beforeEach(() => {
  resetHome();
  homeRenders.count = 0;
  homeRenders.mounts = 0;
});

describe('HomePage re-render isolation', () => {
  const mine = session('mine');
  const theirs = session('theirs', { created_by: 'someone-else' });

  function renderCounting() {
    seed({ sessions: [mine, theirs], comments: [comment('c1')], branches: [teammate('t', 'b')] });
    const commits = { count: 0 };
    renderHome({}, () => {
      commits.count += 1;
    });
    commits.count = 0;
    return commits;
  }

  it('mounts once on desktop, so its effects fire once', async () => {
    asDesktop();
    seed({ sessions: [session('idle')] });
    renderHome();
    await screen.findByText('Session idle');
    expect(homeRenders.mounts).toBe(1);
  });

  it('re-renders nothing for a session patch outside its previews', () => {
    const commits = renderCounting();
    act(() => {
      agorStore.setState(buildSessionMaps([mine, { ...theirs, title: 'streamed token' }]));
    });
    expect(commits.count).toBe(0);
    act(() => {
      agorStore.setState(buildSessionMaps([{ ...mine, title: 'Renamed' }, theirs]));
    });
    expect(commits.count).toBeGreaterThan(0);
    expect(screen.getByText('Renamed')).toBeInTheDocument();
  });

  it('re-renders nothing for comment or branch patches that change nothing shown', () => {
    const commits = renderCounting();
    act(() => {
      const commentById = new Map(agorStore.getState().commentById);
      commentById.set('other', comment('other', { content: 'unrelated', created_by: 'x' }));
      agorStore.setState({ commentById });
    });
    act(() => {
      const branchById = new Map(agorStore.getState().branchById);
      branchById.set('unrelated', { branch_id: 'unrelated', name: 'u' } as Branch);
      agorStore.setState({ branchById });
    });
    expect(commits.count).toBe(0);
  });

  it('re-renders only the preview row whose session changed', () => {
    const others = ['b', 'c'].map((id) => session(id, { last_updated: recent(10) }));
    seed({ sessions: [mine, ...others] });
    renderHome();
    titleReads.clear();
    act(() => {
      agorStore.setState(buildSessionMaps([{ ...mine, title: 'Renamed' }, ...others]));
    });
    expect(screen.getByText('Renamed')).toBeInTheDocument();
    expect(titleReads.get('mine')).toBeGreaterThan(0);
    expect(titleReads.get('b')).toBeUndefined();
    expect(titleReads.get('c')).toBeUndefined();
  });

  it('bails out of a parent re-render when its props are stable', () => {
    seed({ sessions: [mine] });
    let bump = () => {};
    function Parent() {
      const [, setTick] = useState(0);
      useLayoutEffect(() => {
        bump = () => setTick((t) => t + 1);
      });
      return <HomePage {...stableProps} />;
    }
    render(wrap(<Parent />));
    const baseline = homeRenders.count;
    act(() => bump());
    expect(homeRenders.count).toBe(baseline);
  });

  it('stays quiet on a 7k-session tenant when someone else streams', () => {
    const sessions = Array.from({ length: 7000 }, (_, i) =>
      session(`s${i}`, {
        created_by: i % 10 ? `user-${i % 20}` : ME,
        branch_id: `b-${i % 400}`,
        status: i % 9 === 0 ? 'running' : 'idle',
        last_updated: recent(i),
      })
    );
    seed({ sessions });
    const commits = { count: 0 };
    renderHome({}, () => {
      commits.count += 1;
    });
    commits.count = 0;
    const patched = buildSessionMaps(
      sessions.map((s, i) => (i === 3 ? { ...s, title: 'streamed token' } : s))
    );
    const started = performance.now();
    act(() => agorStore.setState(patched));
    const elapsed = performance.now() - started;
    console.info(`[home-perf] 7k-session store patch → Home commit: ${elapsed.toFixed(1)}ms`);
    expect(commits.count).toBe(0);
  });
});
