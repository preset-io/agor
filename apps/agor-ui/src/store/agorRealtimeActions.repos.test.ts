import type { AgorClient, Repo } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from '../utils/createRepository';
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
  it.each(['ready', 'failed'] as const)(
    'preserves a realtime %s outcome received before clone hydration returns',
    async (clone_status) => {
      const cloning = { ...placeholder, clone_generation: 2 };
      const terminal = { ...cloning, clone_status };
      const client = {
        service: (name: string) =>
          name === 'repos/clone'
            ? { create: async () => ({ status: 'pending', repo_id: cloning.repo_id }) }
            : {
                get: async () => {
                  // The global subscription receives the terminal event while GET
                  // is still returning the earlier snapshot from the same attempt.
                  repoPatched(terminal);
                  return cloning;
                },
              },
      } as unknown as AgorClient;
      const notify = { showInfo: vi.fn(), showError: vi.fn(), showWarning: vi.fn() };
      await createRepository(
        client,
        {
          slug: cloning.slug,
          url: 'https://example.invalid/framework.git',
          default_branch: 'main',
        },
        {},
        notify,
        repoPatched
      );
      expect(agorStore.getState().repoById.get(cloning.repo_id)).toEqual(terminal);
      expect(notify.showInfo).toHaveBeenCalledTimes(1);
      expect(notify.showError).not.toHaveBeenCalled();
      expect(notify.showWarning).not.toHaveBeenCalled();
    }
  );

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
