import type { Repo } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoCreated, repoPatched } from './agorRealtimeActions';
import { agorStore } from './agorStore';

const placeholder = {
  repo_id: 'repo-fw',
  slug: 'preset-io/agor-teammate',
  clone_status: 'cloning',
} as Repo;

beforeEach(() => {
  agorStore.getState().reset();
});

describe('repo realtime events', () => {
  // Older executors patch metadata (still `cloning`) then `ready`; delivery order is not guaranteed (#2941).
  it('keeps a ready clone when the earlier cloning patch arrives last', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, clone_status: 'ready', local_path: '/repos/fw' });
    repoPatched({ ...placeholder, clone_status: 'cloning', local_path: '/repos/fw' });

    expect(agorStore.getState().repoById.get('repo-fw')?.clone_status).toBe('ready');
  });

  it('keeps a failed clone when a stale cloning patch arrives last', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, clone_status: 'failed' });
    repoPatched(placeholder);

    expect(agorStore.getState().repoById.get('repo-fw')?.clone_status).toBe('failed');
  });

  it('accepts an in-place retry and rejects delayed reports from the previous generation', () => {
    repoCreated({ ...placeholder, clone_status: 'failed', clone_generation: 1 });
    repoPatched({ ...placeholder, clone_generation: 2 });
    expect(agorStore.getState().repoById.get('repo-fw')?.clone_status).toBe('cloning');
    repoPatched({ ...placeholder, clone_status: 'failed', clone_generation: 1 });
    repoPatched({ ...placeholder, clone_status: 'ready', clone_generation: 2 });
    repoPatched({ ...placeholder, clone_status: 'failed', clone_generation: 1 });
    repoPatched({ ...placeholder, clone_generation: 2 });
    expect(agorStore.getState().repoById.get('repo-fw')).toMatchObject({
      clone_status: 'ready',
      clone_generation: 2,
    });
  });

  it('applies in-order clone progress and later ready-row updates', () => {
    repoCreated(placeholder);
    repoPatched({ ...placeholder, local_path: '/repos/fw' });
    repoPatched({ ...placeholder, clone_status: 'ready', local_path: '/repos/fw' });
    repoPatched({ ...placeholder, clone_status: 'ready', name: 'Teammate framework' });

    expect(agorStore.getState().repoById.get('repo-fw')).toMatchObject({
      clone_status: 'ready',
      name: 'Teammate framework',
    });
  });
});
