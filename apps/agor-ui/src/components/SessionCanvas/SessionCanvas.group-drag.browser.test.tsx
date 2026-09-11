/**
 * Real React Flow/Chromium regression for selected-zone drag persistence.
 *
 * The jsdom component suite drives the production callbacks directly so it
 * can deterministically cover debounce/realtime races. This smoke keeps the
 * library integration honest: browser pointer input must make React Flow pass
 * all selected movable zones through SessionCanvas's real drag-stop path.
 */
import type { AgorClient, Board, User } from '@agor-live/client';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import SessionCanvas from './SessionCanvas';

afterEach(cleanup);

const CURRENT_USER = {
  user_id: 'fictional-drag-owner',
  username: 'fictional-drag-owner',
  role: 'member',
} as User;

beforeEach(() => {
  __setAuthConfigForTests({ requireAuth: false }, { branchRbac: false });
  agorStore.setState({ userById: new Map([[CURRENT_USER.user_id, CURRENT_USER]]) });
});

describe('SessionCanvas selected-zone drag (real browser)', () => {
  it('commits all three React Flow drag items in one board-layout request', async () => {
    // The configured desktop project owns this spatial smoke; narrower projects
    // still load the file to prove it remains importable at every breakpoint.
    if (window.innerWidth < 900) return;

    let durableBoard = {
      board_id: 'fictional-browser-board',
      objects: {
        'zone-a': { type: 'zone', x: 40, y: 60, width: 220, height: 180, label: 'Alpha' },
        'zone-b': { type: 'zone', x: 360, y: 80, width: 280, height: 220, label: 'Beta' },
        'zone-c': { type: 'zone', x: 180, y: 380, width: 340, height: 160, label: 'Gamma' },
        fixed: { type: 'zone', x: 700, y: 400, width: 180, height: 140, label: 'Fixed' },
      },
    } as unknown as Board;
    const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
      const updates = payload.objects as NonNullable<Board['objects']>;
      durableBoard = {
        ...durableBoard,
        objects: Object.fromEntries(
          Object.entries(durableBoard.objects ?? {}).map(([objectId, object]) => [
            objectId,
            updates[objectId] ? { ...object, ...updates[objectId] } : object,
          ])
        ),
      } as Board;
      return {
        board: durableBoard,
        placements: [],
        changed: true,
        changed_object_ids: Object.keys(updates),
        changed_placement_ids: [],
      };
    });
    const client = {
      service: vi.fn(() => ({
        patch,
        find: vi.fn().mockResolvedValue({ capabilities: ['board.edit'] }),
      })),
    } as unknown as AgorClient;
    const renderBoard = () =>
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={durableBoard}
            client={client}
            branches={[]}
            currentUserId={CURRENT_USER.user_id}
            height={760}
          />
        </ConnectionProvider>
      );
    let view = renderBoard();

    const node = (id: string) =>
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    await waitFor(() => expect(node('zone-a')).toBeTruthy());
    const user = userEvent.setup();
    const viewport = () => document.querySelector<HTMLElement>('.react-flow__viewport');
    const initialTransform = viewport()?.style.transform;
    await act(async () =>
      user.wheel(document.querySelector('.react-flow__pane')!, { direction: 'down' })
    );
    await waitFor(() => expect(viewport()?.style.transform).not.toBe(initialTransform));
    await act(async () => user.click(node('zone-a')!));
    await act(async () => user.keyboard('{Control>}'));
    await act(async () => user.click(node('zone-b')!));
    await act(async () => user.click(node('zone-c')!));
    await act(async () => user.keyboard('{/Control}'));
    await waitFor(() =>
      expect(
        ['zone-a', 'zone-b', 'zone-c'].every((id) => node(id)?.classList.contains('selected'))
      ).toBe(true)
    );
    await act(async () =>
      user.dragAndDrop(node('zone-a')!, document.querySelector('.react-flow__pane')!)
    );

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const payload = patch.mock.calls[0]?.[1] as {
      _action: string;
      objects: Record<string, { x: number; y: number }>;
      placements: object;
    };
    expect(payload._action).toBe('applyLayout');
    expect(Object.keys(payload.objects).sort()).toEqual(['zone-a', 'zone-b', 'zone-c']);
    expect(payload.placements).toEqual({});
    const delta = {
      x: payload.objects['zone-a'].x - 40,
      y: payload.objects['zone-a'].y - 60,
    };
    expect(delta.x || delta.y).not.toBe(0);
    expect(payload.objects['zone-b']).toMatchObject({ x: 360 + delta.x, y: 80 + delta.y });
    expect(payload.objects['zone-c']).toMatchObject({ x: 180 + delta.x, y: 380 + delta.y });
    expect(payload.objects.fixed).toBeUndefined();

    // Settle beyond the production debounce, then reconstruct the canvas from
    // durable data (the same read path used by reload and a second consumer).
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const beforeSecond = Object.fromEntries(
      ['zone-a', 'zone-b', 'zone-c'].map((id) => {
        const zone = durableBoard.objects?.[id];
        return [id, { x: zone?.x ?? 0, y: zone?.y ?? 0 }];
      })
    );
    const { fixed: _fixed, ...repeatObjects } = durableBoard.objects ?? {};
    durableBoard = { ...durableBoard, objects: repeatObjects } as Board;
    view.unmount();
    view = renderBoard();
    await waitFor(() => expect(node('zone-a')).toBeTruthy());

    // Exercise a second real pointer gesture after durable reconstruction at
    // a different canvas zoom.
    const reloadTransform = viewport()?.style.transform;
    await act(async () =>
      user.wheel(document.querySelector('.react-flow__pane')!, { direction: 'up', times: 2 })
    );
    await waitFor(() => expect(viewport()?.style.transform).not.toBe(reloadTransform));
    patch.mockClear();
    await act(async () => user.click(node('zone-a')!));
    await act(async () => user.keyboard('{Control>}'));
    await act(async () => user.click(node('zone-b')!));
    await act(async () => user.click(node('zone-c')!));
    await act(async () => user.keyboard('{/Control}'));
    await act(async () => user.dragAndDrop(node('zone-a')!, node('zone-c')!));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const repeatedPayload = patch.mock.calls[0]?.[1] as {
      objects: Record<string, { x: number; y: number }>;
    };
    expect(Object.keys(repeatedPayload.objects).sort()).toEqual(['zone-a', 'zone-b', 'zone-c']);
    const repeatedDelta = {
      x: repeatedPayload.objects['zone-a'].x - beforeSecond['zone-a'].x,
      y: repeatedPayload.objects['zone-a'].y - beforeSecond['zone-a'].y,
    };
    expect(repeatedDelta.x || repeatedDelta.y).not.toBe(0);
    expect(repeatedPayload.objects['zone-b']).toMatchObject({
      x: beforeSecond['zone-b'].x + repeatedDelta.x,
      y: beforeSecond['zone-b'].y + repeatedDelta.y,
    });
    expect(repeatedPayload.objects['zone-c']).toMatchObject({
      x: beforeSecond['zone-c'].x + repeatedDelta.x,
      y: beforeSecond['zone-c'].y + repeatedDelta.y,
    });
    expect(repeatedPayload.objects.fixed).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    view.unmount();
    renderBoard();
    await waitFor(() => expect(node('zone-a')).toBeTruthy());
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
