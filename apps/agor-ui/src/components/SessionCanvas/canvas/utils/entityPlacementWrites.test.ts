import type { Board } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { EntityPlacementWrites } from './entityPlacementWrites';

describe('EntityPlacementWrites.cancel', () => {
  it('drops a queued move so it is never sent', () => {
    const invalidate = vi.fn();
    const writes = new EntityPlacementWrites(invalidate);
    const intent = writes.queue('branch-1', undefined, { board_id: 'board-1' } as Board);

    writes.cancel('branch-1');

    expect(writes.current(intent)).toBe(false);
    expect(writes.preserves('branch-1')).toBe(false);
    expect(invalidate).toHaveBeenCalledWith('branch-1');
    writes.cancel('branch-1');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
