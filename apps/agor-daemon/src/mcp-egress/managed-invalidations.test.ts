import { describe, expect, it, vi } from 'vitest';
import { synchronizeManagedInvalidations } from './managed-invalidations.js';

const incarnation = 'R'.repeat(43);
const item = (cursor: string, workspace = 'tenant-a') => ({
  cursor,
  workspace_id: workspace,
  recovery_incarnation: incarnation,
  subject: null,
  handle: null,
  reason: 'security_disabled' as const,
  epoch: cursor,
});
const page = (cursor: string, items = [item(cursor)], complete = true) => ({
  protocol_version: 1,
  recovery_incarnation: incarnation,
  snapshot_required: false,
  snapshot_complete: complete,
  next_cursor: cursor,
  items,
});
function fixture() {
  const options: Parameters<typeof synchronizeManagedInvalidations>[0] = {
    recoveryIncarnation: incarnation,
    signal: new AbortController().signal,
    request: vi.fn(async () => page('2')),
    readCheckpoint: async () => ({ status: 'ready', cursor: '1' }),
    requireSnapshot: vi.fn(async () => true),
    applyPage: vi.fn(async () => true),
  };
  return options;
}
describe('atomic managed invalidation reconciliation', () => {
  it('passes the entire multiworkspace page to one tenant-bound atomic CAS', async () => {
    const options = fixture();
    const mixed = page('3', [item('2'), item('3', 'tenant-b')]);
    options.request = vi.fn(async () => mixed);
    await synchronizeManagedInvalidations(options);
    expect(options.applyPage).toHaveBeenCalledExactlyOnceWith('1', mixed, { snapshot: false });
    expect(options.request).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '1', snapshot: false }),
      options.signal
    );
  });
  it('commits gap evidence before fetching a full snapshot, stages each page atomically', async () => {
    const options = fixture();
    const gap = { ...page('1', []), snapshot_required: true, snapshot_complete: false };
    options.request = vi
      .fn()
      .mockResolvedValueOnce(gap)
      .mockResolvedValueOnce(page('2', [item('2')], false))
      .mockResolvedValueOnce(page('3'));
    await synchronizeManagedInvalidations(options);
    expect(options.applyPage).toHaveBeenNthCalledWith(1, '1', gap, { snapshot: false });
    expect(options.applyPage).toHaveBeenNthCalledWith(2, null, page('2', [item('2')], false), {
      snapshot: true,
    });
    expect(options.applyPage).toHaveBeenNthCalledWith(3, '2', page('3'), { snapshot: true });
    expect(options.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: null, snapshot: true }),
      options.signal
    );
  });
  it('restarts incomplete snapshots from zero without losing known tombstones', async () => {
    const options = fixture();
    options.readCheckpoint = async () => ({ status: 'snapshot_staging', cursor: '8' });
    await synchronizeManagedInvalidations(options);
    expect(options.requireSnapshot).toHaveBeenCalledExactlyOnceWith('8');
    expect(options.request).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null, snapshot: true }),
      options.signal
    );
    expect(options.applyPage).toHaveBeenCalledWith(null, page('2'), { snapshot: true });
  });
  it('stops after failed atomic persistence or a losing CAS', async () => {
    for (const applyPage of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error('DB unavailable');
      }),
    ]) {
      const options = fixture();
      options.applyPage = applyPage;
      await expect(synchronizeManagedInvalidations(options)).rejects.toThrow();
      expect(options.request).toHaveBeenCalledOnce();
    }
  });
  it('cannot reset a concurrently advanced snapshot checkpoint', async () => {
    const options = fixture();
    options.readCheckpoint = async () => ({ status: 'snapshot_required', cursor: '1' });
    options.requireSnapshot = vi.fn(async () => false);
    await expect(synchronizeManagedInvalidations(options)).rejects.toThrow();
    expect(options.request).not.toHaveBeenCalled();
  });
  it.each([
    { ...page('2'), recovery_incarnation: 'X'.repeat(43) },
    page('2', [item('3')]),
    page('0', []),
    page('2', [item('2'), item('2')]),
  ])('refuses invalid incarnation or cursor evidence', async (bad) => {
    const options = fixture();
    options.request = vi.fn(async () => bad);
    await expect(synchronizeManagedInvalidations(options)).rejects.toThrow();
    expect(options.applyPage).not.toHaveBeenCalled();
  });
});
