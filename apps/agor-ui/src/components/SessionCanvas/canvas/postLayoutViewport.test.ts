import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import {
  arrangeBoardViewportMode,
  consumeSettledPostLayoutViewport,
  createPostLayoutViewportIntent,
  decidePostLayoutViewport,
  layoutPositionsMatch,
  layoutSnapshotsMatch,
  PostLayoutViewportCoordinator,
  snapshotLayoutNodes,
} from './postLayoutViewport';

const viewport = { left: 0, top: 0, right: 1200, bottom: 800 };
const viewportPixels = { width: 1200, height: 800 };

function intent(overrides: Partial<Parameters<typeof decidePostLayoutViewport>[0]['intent']> = {}) {
  return {
    source: 'user' as const,
    boardId: 'board-1',
    scope: 'selection' as const,
    mode: 'smart' as const,
    before: [{ id: 'one', x: 100, y: 100, width: 300, height: 200 }],
    after: [{ id: 'one', x: 700, y: 500, width: 300, height: 200 }],
    ...overrides,
  };
}

describe('post-layout viewport policy', () => {
  it('maps the Arrange board checkbox directly to fit or preserve mode', () => {
    expect(arrangeBoardViewportMode(true)).toBe('fit');
    expect(arrangeBoardViewportMode(false)).toBe('preserve');
  });

  it('fits a materially changed user layout when its affected bounds are clipped', () => {
    expect(
      decidePostLayoutViewport({
        intent: intent({ after: [{ id: 'one', x: 1050, y: 650, width: 300, height: 200 }] }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'clipped', padding: 0.16 });
  });

  it('does not fit auto/realtime work or an already-comfortable explicit result', () => {
    for (const source of ['auto', 'realtime'] as const) {
      expect(
        decidePostLayoutViewport({
          intent: intent({ source }),
          viewport,
          viewportPixels,
          zoom: 1,
        })
      ).toMatchObject({ fit: false, reason: 'not-user' });
    }
    expect(
      decidePostLayoutViewport({
        intent: intent({ after: [{ id: 'one', x: 400, y: 250, width: 300, height: 200 }] }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: false, reason: 'comfortable' });
  });

  it('does not refit a repeated no-op or sub-grid geometry noise', () => {
    const rect = { id: 'one', x: 100, y: 100, width: 300, height: 200 };
    expect(
      decidePostLayoutViewport({
        intent: intent({
          before: [rect],
          after: [{ ...rect, x: rect.x + 7.9 }],
        }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: false, reason: 'no-material-change' });
  });

  it('fits a comfortably visible result only when its current scale is impractically small', () => {
    expect(
      decidePostLayoutViewport({
        intent: intent({ after: [{ id: 'one', x: 500, y: 350, width: 80, height: 40 }] }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'scale' });
  });

  it('fits an impractically large board result with board-scoped padding', () => {
    expect(
      decidePostLayoutViewport({
        intent: intent({
          scope: 'board',
          after: [{ id: 'one', x: 50, y: 250, width: 1100, height: 200 }],
        }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'scale', padding: 0.12 });
  });

  it('makes the explicit fit/preserve gate override material-change and comfort heuristics', () => {
    const unchanged = [{ id: 'one', x: 100, y: 100, width: 300, height: 200 }];
    expect(
      decidePostLayoutViewport({
        intent: intent({ scope: 'board', mode: 'fit', before: unchanged, after: unchanged }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'fit-requested', padding: 0.12 });

    expect(
      decidePostLayoutViewport({
        intent: intent({
          scope: 'board',
          mode: 'preserve',
          after: [{ id: 'one', x: 2000, y: 1600, width: 300, height: 200 }],
        }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: false, reason: 'preserve-requested', padding: 0.12 });
  });

  it('never activates explicit fit semantics for automatic or realtime sources', () => {
    for (const source of ['auto', 'realtime'] as const) {
      expect(
        decidePostLayoutViewport({
          intent: intent({ source, mode: 'fit' }),
          viewport,
          viewportPixels,
          zoom: 1,
        })
      ).toMatchObject({ fit: false, reason: 'not-user' });
    }
  });
});

describe('post-layout viewport coordinator', () => {
  const currentNodes: Node[] = [
    { id: 'one', position: { x: 100, y: 100 }, width: 300, height: 200, data: {} },
    {
      id: 'locked',
      position: { x: 700, y: 500 },
      width: 200,
      height: 120,
      data: { locked: true },
    },
  ];
  const explicitBoardIntent = createPostLayoutViewportIntent({
    source: 'user',
    boardId: 'board-1',
    scope: 'board',
    mode: 'fit',
    beforeNodes: currentNodes,
    afterNodes: currentNodes,
    affectedNodeIds: ['one', 'locked'],
  });
  const settle = (coordinator: PostLayoutViewportCoordinator, token: number) =>
    consumeSettledPostLayoutViewport({
      coordinator,
      token,
      currentNodes,
      viewport,
      viewportPixels,
      zoom: 1,
      reducedMotion: false,
    });

  it('consumes a checked unchanged Arrange exactly once with the full board scope', () => {
    const coordinator = new PostLayoutViewportCoordinator();
    const token = coordinator.begin();
    expect(coordinator.queue(explicitBoardIntent, token)).toBeDefined();

    expect(settle(coordinator, token)).toMatchObject({
      nodes: [expect.objectContaining({ id: 'one' }), expect.objectContaining({ id: 'locked' })],
      padding: 0.12,
      duration: 300,
    });
    expect(settle(coordinator, token)).toBeNull();
  });

  it('consumes unchecked material and unchanged Arrange requests without a camera result', () => {
    for (const after of [
      explicitBoardIntent.after,
      explicitBoardIntent.after.map((rect) =>
        rect.id === 'one' ? { ...rect, x: rect.x + 800 } : rect
      ),
    ]) {
      const coordinator = new PostLayoutViewportCoordinator();
      const token = coordinator.begin();
      coordinator.queue({ ...explicitBoardIntent, mode: 'preserve', after }, token);
      expect(settle(coordinator, token)).toBeNull();
      expect(settle(coordinator, token)).toBeNull();
    }
  });

  it('does not double-fit when an explicit request replaces the smart-fit policy', () => {
    const coordinator = new PostLayoutViewportCoordinator();
    const token = coordinator.begin();
    coordinator.queue(
      {
        ...explicitBoardIntent,
        before: explicitBoardIntent.before.map((rect) =>
          rect.id === 'one' ? { ...rect, x: -900 } : rect
        ),
      },
      token
    );
    expect(settle(coordinator, token)).not.toBeNull();
    expect(settle(coordinator, token)).toBeNull();
  });

  it('rejects stale positions and tokens canceled by a pan or newer layout intent', () => {
    const staleCoordinator = new PostLayoutViewportCoordinator();
    const staleToken = staleCoordinator.begin();
    staleCoordinator.queue(
      {
        ...explicitBoardIntent,
        after: explicitBoardIntent.after.map((rect) =>
          rect.id === 'one' ? { ...rect, x: rect.x + 40 } : rect
        ),
      },
      staleToken
    );
    expect(settle(staleCoordinator, staleToken)).toBeNull();
    expect(staleCoordinator.peek(staleToken)).toBeUndefined();

    const canceledCoordinator = new PostLayoutViewportCoordinator();
    const canceledToken = canceledCoordinator.begin();
    canceledCoordinator.cancel();
    expect(canceledCoordinator.queue(explicitBoardIntent, canceledToken)).toBeUndefined();

    const supersededCoordinator = new PostLayoutViewportCoordinator();
    const olderToken = supersededCoordinator.begin();
    const newerToken = supersededCoordinator.begin();
    expect(supersededCoordinator.queue(explicitBoardIntent, olderToken)).toBeUndefined();
    expect(supersededCoordinator.queue(explicitBoardIntent, newerToken)).toBeDefined();
  });

  it('uses no animation when reduced motion is requested', () => {
    const coordinator = new PostLayoutViewportCoordinator();
    const token = coordinator.begin();
    coordinator.queue(explicitBoardIntent, token);
    expect(
      consumeSettledPostLayoutViewport({
        coordinator,
        token,
        currentNodes,
        viewport,
        viewportPixels,
        zoom: 1,
        reducedMotion: true,
      })
    ).toMatchObject({ duration: 0 });
  });
});

describe('post-layout viewport snapshots', () => {
  it('resolves nested nodes from the planned parent geometry instead of stale positionAbsolute', () => {
    const nodes: Node[] = [
      { id: 'zone', position: { x: 500, y: 300 }, width: 600, height: 400, data: {} },
      {
        id: 'child',
        parentId: 'zone',
        position: { x: 40, y: 80 },
        positionAbsolute: { x: 120, y: 140 },
        width: 200,
        height: 100,
        data: {},
      },
    ];
    expect(snapshotLayoutNodes(nodes, ['child'])).toEqual([
      { id: 'child', x: 540, y: 380, width: 200, height: 100 },
    ]);
  });

  it('rejects stale settled bounds before a fit can run', () => {
    const before: Node[] = [
      { id: 'one', position: { x: 0, y: 0 }, width: 200, height: 100, data: {} },
    ];
    const after: Node[] = [
      { id: 'one', position: { x: 600, y: 0 }, width: 200, height: 100, data: {} },
    ];
    const request = createPostLayoutViewportIntent({
      source: 'user',
      boardId: 'board-1',
      scope: 'selection',
      beforeNodes: before,
      afterNodes: after,
      affectedNodeIds: ['one'],
    });
    expect(layoutSnapshotsMatch(request.after, snapshotLayoutNodes(after, ['one']))).toBe(true);
    expect(
      layoutSnapshotsMatch(
        request.after,
        snapshotLayoutNodes([{ ...after[0], position: { x: 640, y: 0 } }], ['one'])
      )
    ).toBe(false);
    expect(
      layoutPositionsMatch(
        request.after,
        snapshotLayoutNodes([{ ...after[0], width: 240, height: 140 }], ['one'])
      )
    ).toBe(true);
    expect(
      layoutPositionsMatch(
        request.after,
        snapshotLayoutNodes([{ ...after[0], position: { x: 640, y: 0 } }], ['one'])
      )
    ).toBe(false);
  });
});
