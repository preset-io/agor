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
  const order: string[] = [];
  const options: Parameters<typeof synchronizeManagedInvalidations>[0] = {
    recoveryIncarnation: incarnation,
    allowedWorkspaces: new Set(['tenant-a']),
    signal: new AbortController().signal,
    request: vi.fn(async () => page('2')),
    readCursor: async () => '1',
    persistInvalidations: vi.fn(async (items) => {
      order.push(`persist:${items.map((i) => i.cursor)}`);
    }),
    advanceCursor: vi.fn(async (_old, next) => {
      order.push(`advance:${next}`);
      return true;
    }),
  };
  return { options, order };
}
describe('durable managed invalidation reconciliation', () => {
  it('persists invalidations before cursor advance and sends no token/permit operation', async () => {
    const { options, order } = fixture();
    await synchronizeManagedInvalidations(options);
    expect(order).toEqual(['persist:2', 'advance:2']);
    expect(options.request).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '1', snapshot: false, limit: 100 }),
      options.signal
    );
  });
  it('requires a complete full snapshot after a gap and never advances a partial snapshot', async () => {
    const { options, order } = fixture();
    options.request = vi
      .fn()
      .mockResolvedValueOnce({
        ...page('1', []),
        snapshot_required: true,
        snapshot_complete: false,
      })
      .mockResolvedValueOnce(page('2', [item('2')], false))
      .mockResolvedValueOnce(page('3'));
    await synchronizeManagedInvalidations(options);
    expect(order).toEqual(['persist:2', 'persist:3', 'advance:3']);
    expect(options.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshot: true, cursor: null }),
      options.signal
    );
    expect(options.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ snapshot: true, cursor: '2' }),
      options.signal
    );
  });
  it('does not acknowledge failed persistence, and a losing cursor CAS cannot overwrite a peer', async () => {
    const { options } = fixture();
    options.persistInvalidations = vi.fn(async () => {
      throw new Error('DB unavailable');
    });
    await expect(synchronizeManagedInvalidations(options)).rejects.toThrow();
    expect(options.advanceCursor).not.toHaveBeenCalled();
    const peer = fixture();
    peer.options.advanceCursor = vi.fn(async () => false);
    await expect(synchronizeManagedInvalidations(peer.options)).rejects.toThrow();
    expect(peer.options.advanceCursor).toHaveBeenCalledExactlyOnceWith('1', '2');
  });
  it.each([
    page('2', [item('2', 'tenant-b')]),
    { ...page('2'), recovery_incarnation: 'X'.repeat(43) },
    page('2', [item('3')]),
    page('0', []),
    page('1', [], false),
  ])(
    'denies foreign scope, old incarnation and invalid pagination without persistence',
    async (response) => {
      const { options } = fixture();
      options.request = vi.fn(async () => response);
      await expect(synchronizeManagedInvalidations(options)).rejects.toThrow();
      expect(options.persistInvalidations).not.toHaveBeenCalled();
      expect(options.advanceCursor).not.toHaveBeenCalled();
    }
  );
});
