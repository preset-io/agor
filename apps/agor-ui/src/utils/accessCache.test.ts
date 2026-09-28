import { describe, expect, it, vi } from 'vitest';
import { peekAccess, readAccess } from './accessCache';

const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(4);
    pending[0].resolve(true);
    await reads[0];
    await Promise.resolve();
    expect(started).toBe(5);
    for (const d of pending) d.resolve(true);
    await Promise.all(reads);
    expect(started).toBe(6);
  });
});
