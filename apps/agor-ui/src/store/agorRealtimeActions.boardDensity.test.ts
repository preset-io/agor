import type { BoardEntityObject } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markBoardLoaded } from '../test/userScopeCoverage';
import { boardObjectPatched } from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { setRealtimeAuthorityScope } from './realtimeBatch';

const placement = (compact: boolean): BoardEntityObject =>
  ({
    object_id: 'placement-card-1',
    board_id: 'board-1',
    card_id: 'card-1',
    entity_type: 'card',
    position: { x: 20, y: 40 },
    compact,
    created_at: '2026-09-01T00:00:00.000Z',
  }) as BoardEntityObject;

beforeEach(() => {
  agorStore.getState().reset();
  // Realtime placement events apply only to a board partition loaded under
  // the current realtime authority.
  setRealtimeAuthorityScope('user-1:member:1');
  markBoardLoaded('board-1');
});
afterEach(() => setRealtimeAuthorityScope(null));

describe('generic card density realtime', () => {
  it('updates both placement indexes and keeps a repeated echo reference-stable', () => {
    const expanded = placement(false);
    agorStore.getState().replaceMaps({
      boardObjectById: new Map([[expanded.object_id, expanded]]),
      boardObjectsByBoardId: new Map([['board-1', [expanded]]]),
    });

    const collapsed = placement(true);
    boardObjectPatched(collapsed);
    const afterCollapse = agorStore.getState();
    expect(afterCollapse.boardObjectById.get(collapsed.object_id)?.compact).toBe(true);
    expect(afterCollapse.boardObjectsByBoardId.get('board-1')?.[0]?.compact).toBe(true);

    const stableMap = afterCollapse.boardObjectById;
    boardObjectPatched({ ...collapsed });
    expect(agorStore.getState().boardObjectById).toBe(stableMap);
  });
});
