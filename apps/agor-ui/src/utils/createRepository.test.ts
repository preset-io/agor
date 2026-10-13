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
    showLoading: vi.fn(),
    showSuccess: vi.fn(),
    showWarning: vi.fn(),
  };
  const apply = vi.fn();
  const run = (options = {}) => createRepository(client, data, options, notify, apply);
  return { run, create, notify, apply, repos, listeners, client };
}

describe('repository notifications', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('background HTTP failure rejects without any toast or leaked raw diagnostic', async () => {
    const h = harness();
    h.create.mockRejectedValueOnce(new Error('Permanently delete branches first: token:secret'));
    await expect(h.run({ silent: true })).rejects.toThrow('Permanently delete');
    for (const fn of Object.values(h.notify)) expect(fn).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('background async clone failure stays in repo status, without toasts', async () => {
    const h = harness();
    await h.run({ silent: true });
    expect(h.apply).toHaveBeenCalledWith(row('cloning'));
    h.listeners.get('patched')?.({
      ...row('failed'),
      clone_error: { category: 'auth_failed', exit_code: 1, message: 'secret raw stderr' },
    });
    for (const fn of Object.values(h.notify)) expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('explicit permission failure has contextual copy, not raw stderr', async () => {
    const h = harness();
    h.create.mockRejectedValueOnce({ code: 403, message: 'token:secret' });
    await expect(h.run()).rejects.toMatchObject({ code: 403 });
    expect(h.notify.showError).toHaveBeenCalledWith(
      expect.stringContaining('check your access'),
      expect.anything()
    );
    expect(JSON.stringify(h.notify.showError.mock.calls)).not.toContain('secret');
  });
  it('exists while cloning is not success and hydrates a missed placeholder', async () => {
    const h = harness('cloning', 'exists');
    await h.run();
    expect(h.apply).toHaveBeenCalledWith(row('cloning'));
    expect(h.notify.showSuccess).not.toHaveBeenCalled();
    expect(h.notify.showWarning).not.toHaveBeenCalled();
    h.listeners.get('patched')?.(row('ready'));
    expect(h.notify.showSuccess).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a delayed failure from the previous clone generation', async () => {
    const h = harness();
    h.repos.get.mockResolvedValue({ ...row('cloning'), clone_generation: 2 });
    await h.run();
    h.listeners.get('patched')?.({ ...row('failed'), clone_generation: 1 });
    expect(h.notify.showError).not.toHaveBeenCalled();
    h.listeners.get('patched')?.({ ...row('ready'), clone_generation: 2 });
    expect(h.notify.showSuccess).toHaveBeenCalledTimes(1);
  });

  it('retains a terminal event received before hydration returns a pending snapshot', async () => {
    const h = harness();
    h.repos.get.mockImplementation(async () => {
      h.listeners.get('patched')?.({ ...row('ready'), clone_generation: 2 });
      return { ...row('cloning'), clone_generation: 2 };
    });
    await h.run();
    expect(h.apply).toHaveBeenCalledWith({ ...row('ready'), clone_generation: 2 });
    expect(h.notify.showSuccess).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed row returned on registration is never reported as success', async () => {
    const h = harness('failed');
    await h.run();
    expect(h.notify.showSuccess).not.toHaveBeenCalled();
    expect(h.notify.showError).toHaveBeenCalledTimes(1);
  });
  it('does not hydrate or notify after authenticated owner replacement', async () => {
    const h = harness('ready');
    let current = true;
    h.repos.get.mockImplementation(async () => {
      current = false;
      return row('ready');
    });
    await h.run({ silent: true, shouldApply: () => current });
    expect(h.apply).not.toHaveBeenCalled();
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
