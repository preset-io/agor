import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TTL_MS,
  accessScope,
  peekAccess,
  readAccess,
  resetAccessCacheForTests,
} from './accessCache';

const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Fills every in-flight slot with reads that settle on `release()`. */
function occupySlots(client: object) {
  const blockers = Array.from({ length: 4 }, deferred);
  const reads = blockers.map((d, i) => readAccess(client, 's', `busy${i}`, () => d.promise));
  return {
    release: async () => {
      for (const d of blockers) d.resolve(true);
      await Promise.all(reads);
    },
  };
}

beforeEach(() => resetAccessCacheForTests());

afterEach(() => {
  vi.useRealTimers();
});

describe('readAccess', () => {
  it('reads each key once per client and scope, and forgets on a new scope', async () => {
    const client = {};
    const read = vi.fn(async () => true);
    await Promise.all([
      readAccess(client, 'u:1', 'branch:a', read),
      readAccess(client, 'u:1', 'branch:a', read),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(peekAccess(client, 'u:1', 'branch:a')).toBe(true);
    expect(peekAccess(client, 'u:2', 'branch:a')).toBeUndefined();
    await readAccess(client, 'u:2', 'branch:a', read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(peekAccess({}, 'u:2', 'branch:a')).toBeUndefined();
  });

  it('retries after a failed read', async () => {
    const client = {};
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false);
    await expect(readAccess(client, 's', 'k', read)).rejects.toThrow('offline');
    expect(peekAccess(client, 's', 'k')).toBeUndefined();
    expect(await readAccess(client, 's', 'k', read)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps at most four reads in flight', async () => {
    const client = {};
    const pending = Array.from({ length: 6 }, deferred);
    let started = 0;
    const reads = pending.map((d, i) =>
      readAccess(client, 's', `k${i}`, () => {
        started++;
        return d.promise;
      })
    );
    await flush();
    expect(started).toBe(4);
    pending[0].resolve(true);
    await reads[0];
    await flush();
    expect(started).toBe(5);
    for (const d of pending) d.resolve(true);
    await Promise.all(reads);
    expect(started).toBe(6);
  });

  it('never starts a queued read whose caller aborted, and rejects it with AbortError', async () => {
    const client = {};
    const slots = occupySlots(client);
    const controller = new AbortController();
    const read = vi.fn(async () => true);
    const queued = readAccess(client, 's', 'k', read, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await slots.release();
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(peekAccess(client, 's', 'k')).toBeUndefined();

    // The abandoned read frees its key: the next caller reads afresh.
    expect(await readAccess(client, 's', 'k', read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects at once when the signal has already aborted', async () => {
    const read = vi.fn(async () => true);
    await expect(
      readAccess({}, 's', 'k', read, { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps a shared read alive while another caller still waits', async () => {
    const client = {};
    const slots = occupySlots(client);
    const read = vi.fn(async () => true);
    const leaving = new AbortController();
    const first = readAccess(client, 's', 'k', read, { signal: leaving.signal });
    const second = readAccess(client, 's', 'k', read, { signal: new AbortController().signal });
    leaving.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await slots.release();
    expect(await second).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('drops reads still queued for a scope that has since changed', async () => {
    const client = {};
    const slots = occupySlots(client);
    await flush();
    const read = vi.fn(async () => true);
    const stale = expect(readAccess(client, 'u:1', 'k', read)).rejects.toMatchObject({
      name: 'AbortError',
    });
    // A new sign-in replaces the scope before the queued read starts.
    const next = readAccess(client, 'u:2', 'other', async () => true);
    await slots.release();
    await stale;
    expect(read).not.toHaveBeenCalled();
    expect(await next).toBe(true);
  });

  it('peeks without changing the scope, so a stale render keeps the live answers', async () => {
    const client = {};
    await readAccess(client, 'u:2', 'k', async () => true);
    expect(peekAccess(client, 'u:1', 'k')).toBeUndefined();
    expect(peekAccess(client, 'u:2', 'k')).toBe(true);
  });

  it('scopes answers to the role too, so a demotion re-reads without a new sign-in', () => {
    const admin = { user_id: 'u', role: 'admin' };
    expect(accessScope(admin, 1)).toBe(accessScope({ ...admin }, 1));
    expect(accessScope({ ...admin, role: 'member' }, 1)).not.toBe(accessScope(admin, 1));
    expect(accessScope(admin, 2)).not.toBe(accessScope(admin, 1));
  });

  it('answers from cache until the TTL, then re-reads while peek keeps the last answer', async () => {
    vi.useFakeTimers();
    const client = {};
    const read = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await readAccess(client, 's', 'k', read)).toBe(true);
    vi.advanceTimersByTime(ACCESS_TTL_MS - 1);
    expect(await readAccess(client, 's', 'k', read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    const refreshed = readAccess(client, 's', 'k', read);
    expect(peekAccess(client, 's', 'k')).toBe(true);
    expect(await refreshed).toBe(false);
    expect(peekAccess(client, 's', 'k')).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
