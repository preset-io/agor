import type { AgorClient, Repo } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from './createRepository';

const data = {
  slug: 'synthetic/framework',
  url: 'https://example.invalid/framework.git',
  default_branch: 'main',
};
const row = (clone_status: Repo['clone_status']) =>
  ({ repo_id: 'synthetic-repo', slug: data.slug, clone_status }) as Repo;
function harness(status: Repo['clone_status'] = 'cloning', resultStatus = 'pending') {
  const listeners = new Map<string, (repo: Repo) => void>();
  const repos = {
    on: vi.fn((event: string, cb: (repo: Repo) => void) => listeners.set(event, cb)),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
    get: vi.fn(async () => row(status)),
  };
  const create = vi.fn(async () => ({ status: resultStatus, repo_id: 'synthetic-repo' }));
  const client = {
    service: (name: string) => (name === 'repos' ? repos : { create }),
    io: { on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  const notify = {
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  };
  const apply = vi.fn();
  const run = (options = {}) => createRepository(client, data, options, notify, apply);
  return { run, create, notify, apply, repos, listeners, client };
}

describe('repository request notifications', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['cloning', 'ready', 'failed'] as const)(
    'acknowledges acceptance, not the %s outcome, without listeners or timers',
    async (status) => {
      const h = harness(status);
      await h.run();
      expect(h.apply).toHaveBeenCalledWith(row(status));
      expect(h.notify.showInfo).toHaveBeenCalledWith(
        expect.stringContaining('Repository clone started'),
        expect.objectContaining({ duration: 3 })
      );
      expect(h.notify.showError).not.toHaveBeenCalled();
      expect(h.repos.on).not.toHaveBeenCalled();
      expect(h.client.io.on).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(120_000);
      expect(h.notify.showWarning).not.toHaveBeenCalled();
      expect(h.notify.showInfo).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['cloning', 'ready'] as const)(
    'does not claim an existing %s repo was started',
    async (status) => {
      const h = harness(status, 'exists');
      await h.run();
      expect(h.notify.showInfo).toHaveBeenCalledWith(
        expect.stringContaining('already registered'),
        expect.objectContaining({ duration: 3 })
      );
    }
  );

  it('rejects request failures with safe remediation so the form can stay open', async () => {
    const h = harness();
    h.create.mockRejectedValueOnce({ code: 403, message: 'token:secret' });
    await expect(h.run()).rejects.toMatchObject({ code: 403 });
    expect(h.notify.showError).toHaveBeenCalledWith(
      expect.stringContaining('check your access'),
      expect.anything()
    );
    expect(JSON.stringify(h.notify.showError.mock.calls)).not.toContain('secret');
    expect(h.notify.showInfo).not.toHaveBeenCalled();
  });

  it('does not turn a hydration failure into a rejected clone request', async () => {
    const h = harness();
    h.repos.get.mockRejectedValueOnce(new Error('secret diagnostic'));
    await expect(h.run()).resolves.toMatchObject({ status: 'pending' });
    expect(h.notify.showError).not.toHaveBeenCalled();
    expect(h.notify.showWarning).toHaveBeenCalledWith(
      expect.stringContaining('status could not be refreshed'),
      expect.objectContaining({ duration: 4 })
    );
    expect(h.apply).not.toHaveBeenCalled();
  });

  it.each(['request', 'hydration'] as const)(
    'suppresses all effects when Settings closes or authority changes during %s',
    async (phase) => {
      const h = harness();
      let current = true;
      if (phase === 'request') {
        h.create.mockImplementationOnce(async () => {
          current = false;
          return { status: 'pending', repo_id: 'synthetic-repo' };
        });
      } else {
        h.repos.get.mockImplementationOnce(async () => {
          current = false;
          return row('ready');
        });
      }
      await h.run({ shouldApply: () => current });
      expect(h.apply).not.toHaveBeenCalled();
      for (const fn of Object.values(h.notify)) expect(fn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['request', 'hydration'] as const)(
    'suppresses stale-authority rejection during %s',
    async (phase) => {
      const h = harness();
      let current = true;
      const rejectAfterInvalidation = async () => {
        current = false;
        throw new Error('obsolete request diagnostic');
      };
      if (phase === 'request') h.create.mockImplementationOnce(rejectAfterInvalidation);
      else h.repos.get.mockImplementationOnce(rejectAfterInvalidation);
      await expect(h.run({ shouldApply: () => current })).resolves.toBeUndefined();
      expect(h.apply).not.toHaveBeenCalled();
      for (const fn of Object.values(h.notify)) expect(fn).not.toHaveBeenCalled();
    }
  );

  it('keeps a background hydration failure silent after acceptance', async () => {
    const h = harness();
    h.repos.get.mockRejectedValueOnce(new Error('synthetic hydration failure'));
    await expect(h.run({ silent: true })).resolves.toMatchObject({ status: 'pending' });
    expect(h.apply).not.toHaveBeenCalled();
    for (const fn of Object.values(h.notify)) expect(fn).not.toHaveBeenCalled();
  });

  it('background success and failure remain silent', async () => {
    const h = harness('failed');
    await h.run({ silent: true });
    h.create.mockRejectedValueOnce(new Error('synthetic request failure'));
    await expect(h.run({ silent: true })).rejects.toThrow('synthetic request failure');
    for (const fn of Object.values(h.notify)) expect(fn).not.toHaveBeenCalled();
  });

  it('offline prefetch rejects quietly rather than claiming success', async () => {
    const h = harness();
    await expect(createRepository(null, data, { silent: true }, h.notify, h.apply)).rejects.toThrow(
      'Client not connected'
    );
    expect(h.notify.showError).not.toHaveBeenCalled();
  });
});
