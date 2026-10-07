import type { CardWithType } from '@agor-live/client';
import { act, render, renderHook, screen } from '@testing-library/react';
import { type ReactNode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { cardCreated } from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import {
  captureBoardWriteTicket,
  hasBoardWriteTicketEnded,
  isBoardWriteTicketCurrent,
} from '../store/boardMutationGuard';
import { publishConnectionSnapshot, withdrawConnectionSnapshot } from '../store/connectionSnapshot';
import { captureLoadLifetime } from '../store/loadLifetime';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { boardScopeKey } from '../store/scopeMerge';
import { CONNECTED, Providers, withTestAuthority } from '../test/harness';
import { boardCoverage } from '../test/userScopeCoverage';
import { useBoardMutationGuard } from './useBoardMutationGuard';

const BOARD = 'board-guard';
const OTHER = 'board-other';

const connection = (overrides: Partial<{ connected: boolean; authGeneration: number }> = {}) => ({
  ...CONNECTED,
  ...overrides,
});

withTestAuthority(null);

function load(boardId = BOARD) {
  agorStore.getState().setCoverage(boardScopeKey(boardId), boardCoverage());
}

function unload() {
  agorStore.getState().resetBoardPartitions();
}

describe('board write tickets', () => {
  const publisher = {};
  const owner = { alive: true };
  const capture = (requirePartition: boolean) =>
    captureBoardWriteTicket(BOARD, { requirePartition, owner });

  beforeEach(() => {
    owner.alive = true;
    publishConnectionSnapshot(publisher, connection());
  });
  afterEach(() => withdrawConnectionSnapshot(publisher));

  it('captures nothing for an unloaded board unless the write needs no partition', () => {
    expect(capture(true)).toBe(null);
    agorStore.getState().setCoverage(boardScopeKey(BOARD), boardCoverage('loading'));
    expect(capture(true)).toBe(null);
    expect(isBoardWriteTicketCurrent(capture(false))).toBe(true);
  });

  it('a ticket from before an unload is never current again, even after the board reloads', () => {
    load();
    const ticket = capture(true);
    expect(isBoardWriteTicketCurrent(ticket)).toBe(true);
    unload();
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    load();
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(isBoardWriteTicketCurrent(capture(true))).toBe(true);
  });

  it('a membership update keeps a ticket current; a reload ends it', () => {
    setRealtimeAuthorityScope('guard:member:1');
    agorStore
      .getState()
      .setCoverage(boardScopeKey(BOARD), boardCoverage('loaded', captureLoadLifetime()!));
    const ticket = capture(true);
    const before = agorStore.getState().coverage.get(boardScopeKey(BOARD));
    // A card created live on the board joins its membership.
    cardCreated({ card_id: 'k-live', board_id: BOARD } as CardWithType);
    const after = agorStore.getState().coverage.get(boardScopeKey(BOARD));
    expect(after).not.toBe(before);
    expect(after?.members?.cards?.has('k-live')).toBe(true);
    expect(isBoardWriteTicketCurrent(ticket)).toBe(true);
    expect(hasBoardWriteTicketEnded(ticket)).toBe(false);
    // A reload is a new generation.
    load();
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(hasBoardWriteTicketEnded(ticket)).toBe(true);
  });

  it('a re-authentication or an unusable connection ends a ticket', () => {
    load();
    const ticket = capture(false);
    publishConnectionSnapshot(publisher, connection({ connected: false }));
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(capture(false)).toBe(null);
    publishConnectionSnapshot(publisher, connection({ authGeneration: 2 }));
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(isBoardWriteTicketCurrent(capture(false))).toBe(true);
  });

  it("an owner's end ends its tickets", () => {
    load();
    const ticket = capture(true);
    owner.alive = false;
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(capture(true)).toBe(null);
  });

  it("a ticket ends for good on an unload or its owner's end, not on a disconnect", () => {
    load();
    const ticket = capture(true);
    const unpartitioned = capture(false);
    publishConnectionSnapshot(publisher, connection({ connected: false }));
    expect(hasBoardWriteTicketEnded(ticket)).toBe(false);
    expect(hasBoardWriteTicketEnded(unpartitioned)).toBe(false);
    unload();
    expect(hasBoardWriteTicketEnded(ticket)).toBe(true);
    expect(hasBoardWriteTicketEnded(unpartitioned)).toBe(false);
    owner.alive = false;
    expect(hasBoardWriteTicketEnded(unpartitioned)).toBe(true);
    expect(hasBoardWriteTicketEnded(null)).toBe(true);
  });

  it('a re-authentication ends a ticket for good, partitioned or not', () => {
    load();
    const ticket = capture(true);
    const unpartitioned = capture(false);
    publishConnectionSnapshot(publisher, connection({ authGeneration: 2 }));
    expect(hasBoardWriteTicketEnded(ticket)).toBe(true);
    expect(hasBoardWriteTicketEnded(unpartitioned)).toBe(true);
    // Disconnected under the new generation: still ended.
    publishConnectionSnapshot(publisher, connection({ connected: false, authGeneration: 2 }));
    expect(hasBoardWriteTicketEnded(unpartitioned)).toBe(true);
  });
});

describe('useBoardMutationGuard', () => {
  function renderGuard(
    initial: { boardId?: string; allowed?: boolean; connected?: boolean },
    options: { requirePartition?: boolean } = {}
  ) {
    let props = { boardId: BOARD, allowed: true, connected: true, ...initial };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Providers connection={connection({ connected: props.connected })}>{children}</Providers>
    );
    const view = renderHook(() => useBoardMutationGuard(props.boardId, props.allowed, options), {
      wrapper,
    });
    return {
      ...view,
      update(next: Partial<typeof props>) {
        props = { ...props, ...next };
        view.rerender();
      },
    };
  }

  it('reports canMutate only for a loaded, allowed, connected board', () => {
    const view = renderGuard({});
    expect(view.result.current.canMutate).toBe(false);
    expect(view.result.current.capture()).toBe(null);
    act(() => load());
    expect(view.result.current.canMutate).toBe(true);
    view.update({ allowed: false });
    expect(view.result.current.canMutate).toBe(false);
    expect(view.result.current.capture()).toBe(null);
    view.update({ allowed: true, connected: false });
    expect(view.result.current.canMutate).toBe(false);
  });

  it('never dispatches a write whose ticket went stale across an unload and reload', async () => {
    act(() => load());
    const view = renderGuard({});
    const ticket = view.result.current.capture();
    expect(ticket).not.toBe(null);
    act(() => unload());
    act(() => load());
    expect(view.result.current.canMutate).toBe(true);
    const dispatch = vi.fn(async () => {});
    let sent: boolean | undefined;
    await act(async () => {
      sent = await view.result.current.write(ticket, dispatch, 'Board reloaded; not saved.');
    });
    expect(sent).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await screen.findByText('Board reloaded; not saved.')).toBeTruthy();
  });

  it('rechecks the live permission, connection and board at dispatch time', async () => {
    act(() => load());
    act(() => load(OTHER));
    const view = renderGuard({});
    const ticket = view.result.current.capture();
    const dispatch = vi.fn(async () => {});
    await act(async () => {
      expect(await view.result.current.write(ticket, dispatch)).toBe(true);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    for (const change of [{ allowed: false }, { connected: false }, { boardId: OTHER }]) {
      view.update({ boardId: BOARD, allowed: true, connected: true, ...change });
      expect(view.result.current.isCurrent(ticket)).toBe(false);
    }
    view.update({ boardId: BOARD, allowed: true, connected: true });
    expect(view.result.current.isCurrent(ticket)).toBe(true);
  });

  it.each([true, false])(
    'ends every ticket when the guard unmounts (requirePartition: %s)',
    async (requirePartition) => {
      act(() => load());
      const view = renderGuard({}, { requirePartition });
      const ticket = view.result.current.capture();
      expect(view.result.current.isCurrent(ticket)).toBe(true);
      const { isCurrent, write } = view.result.current;
      view.unmount();
      // Nothing else changed: same board lifetime, connection and generation.
      expect(isCurrent(ticket)).toBe(false);
      const dispatch = vi.fn(async () => {});
      await act(async () => {
        expect(await write(ticket, dispatch)).toBe(false);
      });
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it('judges a held ticket against the connection published now, not the last render', () => {
    act(() => load());
    const view = renderGuard({}, { requirePartition: false });
    const ticket = view.result.current.capture();
    const { isCurrent, capture } = view.result.current;
    // Another provider (the app after a re-authentication) publishes generation 2.
    render(
      <ConnectionProvider value={connection({ authGeneration: 2 })}>
        <div />
      </ConnectionProvider>
    );
    expect(isCurrent(ticket)).toBe(false);
    // Its owner still renders generation 1: nothing is captured until both agree.
    expect(capture()).toBe(null);
  });
});

describe('useBoardMutationGuard unmount commit', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  let previousActEnvironment: unknown;

  beforeEach(() => {
    // Real scheduling: a default-priority unmount commits, then React runs
    // its passive effects in a later task. `act` would flush them at once.
    previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = false;
  });
  afterEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
  });

  it('no write passes once the unmount has committed, even before passive cleanup runs', async () => {
    load();
    let guard: ReturnType<typeof useBoardMutationGuard> | null = null;
    function Guarded() {
      guard = useBoardMutationGuard(BOARD, true);
      return <span data-testid="guarded" />;
    }
    const dispatch = vi.fn(async () => {});
    const outcomes: boolean[] = [];
    let ticket: ReturnType<ReturnType<typeof useBoardMutationGuard>['capture']> = null;
    let removedFromDom = false;
    // Runs in the commit that removes `Guarded`, after its DOM is gone: a
    // microtask from here lands before React's passive effects.
    function Probe({ show }: { show: boolean }) {
      useLayoutEffect(() => {
        if (show || !guard) return;
        const held = guard;
        removedFromDom = !container.querySelector('[data-testid="guarded"]');
        queueMicrotask(() => {
          void held.write(ticket, dispatch).then((sent) => outcomes.push(sent));
        });
      }, [show]);
      return null;
    }
    const tree = (show: boolean) => (
      <Providers>
        {show && <Guarded />}
        <Probe show={show} />
      </Providers>
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      root.render(tree(true));
      await settle();
      ticket = guard!.capture();
      expect(guard!.isCurrent(ticket)).toBe(true);

      root.render(tree(false)); // default priority: not a discrete event
      await settle();

      expect(removedFromDom).toBe(true);
      expect(outcomes).toEqual([false]);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      container.remove();
    }
  });
});
