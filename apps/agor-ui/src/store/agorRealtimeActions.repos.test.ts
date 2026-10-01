import type { Repo } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoCreated, repoPatched } from './agorRealtimeActions';
import { agorStore } from './agorStore';

const placeholder = {
  repo_id: 'repo-fw',
  slug: 'preset-io/agor-teammate',
  clone_status: 'cloning',
  last_updated: '2026-10-01T12:00:00.000Z',
} as Repo;

const at = (second: number) => `2026-10-01T12:00:0${second}.000Z`;

beforeEach(() => {
  agorStore.getState().reset();
});

describe('repo realtime events', () => {
  // Older executors patch metadata (still `cloning`) then `ready`; delivery order is not guaranteed (#2941).
  it('keeps a ready clone when the earlier cloning patch arrives last', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, clone_status: 'ready', local_path: '/fw', last_updated: at(2) });
    repoPatched({ ...placeholder, local_path: '/fw', last_updated: at(1) });

    expect(agorStore.getState().repoById.get('repo-fw')?.clone_status).toBe('ready');
  });

  it('keeps a ready clone when a same-millisecond cloning patch arrives last', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, clone_status: 'ready', last_updated: at(1) });
    repoPatched({ ...placeholder, local_path: '/fw', last_updated: at(1) });

    expect(agorStore.getState().repoById.get('repo-fw')?.clone_status).toBe('ready');
  });

  it('drops any older patch, not only clone-status regressions', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, clone_status: 'ready', last_updated: at(2) });
    repoPatched({ ...placeholder, clone_status: 'failed', last_updated: at(1) });
    repoPatched({ ...placeholder, clone_status: 'ready', name: 'Old name', last_updated: at(1) });

    expect(agorStore.getState().repoById.get('repo-fw')).toMatchObject({
      clone_status: 'ready',
      last_updated: at(2),
    });
    expect(agorStore.getState().repoById.get('repo-fw')?.name).toBeUndefined();
  });

  it('applies a newer cloning patch to a finished row', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, clone_status: 'failed', last_updated: at(1) });
    repoPatched({ ...placeholder, last_updated: at(2) });

    expect(agorStore.getState().repoById.get('repo-fw')?.clone_status).toBe('cloning');
  });

  it('applies in-order clone progress and later ready-row updates', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, local_path: '/fw', last_updated: at(1) });
    repoPatched({ ...placeholder, clone_status: 'ready', local_path: '/fw', last_updated: at(2) });
    repoPatched({ ...placeholder, clone_status: 'ready', name: 'Framework', last_updated: at(3) });

    expect(agorStore.getState().repoById.get('repo-fw')).toMatchObject({
      clone_status: 'ready',
      name: 'Framework',
    });
  });
});
