import type { Repo } from '@agor-live/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOnboardingFrameworkRepo } from './ensureOnboardingFrameworkRepo';

const row = (clone_status: Repo['clone_status']) =>
  ({
    repo_id: 'synthetic',
    slug: 'preset-io/agor-teammate',
    remote_url: 'https://github.com/preset-io/agor-teammate.git',
    clone_status,
  }) as Repo;
function harness(status?: Repo['clone_status']) {
  let server = status ? [row(status)] : [];
  const store = new Map<string, Repo>();
  const options = {
    getRepoById: () => store,
    subscribe: () => () => {},
    fetchRepos: vi.fn(async () => server),
    applyRepo: vi.fn((repo: Repo) => {
      store.set(repo.repo_id, repo);
    }),
    createRepo: vi.fn(async () => {
      server = [row('ready')];
    }),
    isCurrent: vi.fn(() => true),
    deadlineMs: 100,
    finalReadMs: 10,
  };
  return {
    options,
    store,
    setServer: (repos: Repo[]) => {
      server = repos;
    },
  };
}

describe('required onboarding repository step', () => {
  afterEach(() => vi.useRealTimers());
  it.each([undefined, 'failed'] as const)(
    'sets up/retries %s and discovers a missed row',
    async (status) => {
      const h = harness(status);
      await expect(ensureOnboardingFrameworkRepo(h.options)).resolves.toMatchObject({
        clone_status: 'ready',
      });
      expect(h.options.createRepo).toHaveBeenCalledTimes(1);
      expect(h.store.get('synthetic')?.clone_status).toBe('ready');
    }
  );
  it('repeated completion uses ready server metadata without re-cloning', async () => {
    const h = harness('ready');
    await ensureOnboardingFrameworkRepo(h.options);
    await ensureOnboardingFrameworkRepo(h.options);
    expect(h.options.createRepo).not.toHaveBeenCalled();
  });
  it('permission errors block completion with actionable, sanitized copy', async () => {
    const h = harness();
    h.options.createRepo.mockRejectedValueOnce({ code: 403, message: 'sensitive server details' });
    await expect(ensureOnboardingFrameworkRepo(h.options)).rejects.toThrow('check your access');
  });
  it('a failed retry is blocking, not best-effort success', async () => {
    const h = harness('failed');
    h.options.createRepo.mockImplementation(async () => {});
    await expect(ensureOnboardingFrameworkRepo(h.options)).rejects.toThrow('could not be prepared');
  });
  it('a still-running clone is not restarted or declared ready at the deadline', async () => {
    vi.useFakeTimers();
    const h = harness('cloning');
    const check = expect(ensureOnboardingFrameworkRepo(h.options)).rejects.toThrow(
      'still being prepared'
    );
    await vi.advanceTimersByTimeAsync(120);
    await check;
    expect(h.options.createRepo).not.toHaveBeenCalled();
  });
  it.each(['read', 'registration'] as const)(
    'bounds a stalled %s request without claiming success',
    async (phase) => {
      vi.useFakeTimers();
      const h = harness();
      if (phase === 'read') h.options.fetchRepos.mockReturnValue(new Promise(() => {}));
      else h.options.createRepo.mockReturnValue(new Promise(() => {}));
      const check = expect(ensureOnboardingFrameworkRepo(h.options)).rejects.toThrow(
        'may still be running'
      );
      await vi.advanceTimersByTimeAsync(120);
      await check;
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('a response for the prior authenticated owner cannot seed the new owner store', async () => {
    const h = harness('ready');
    h.options.fetchRepos.mockImplementation(async () => {
      h.options.isCurrent.mockReturnValue(false);
      return [row('ready')];
    });
    await expect(ensureOnboardingFrameworkRepo(h.options)).resolves.toBeUndefined();
    expect(h.options.applyRepo).not.toHaveBeenCalled();
    expect(h.options.createRepo).not.toHaveBeenCalled();
  });
});
