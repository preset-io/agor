// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted zone palette fixtures
import type { AgorClient, Board, BoardComment, User } from '@agor-live/client';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import 'reactflow/dist/style.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { captureLoadLifetime } from '../../store/loadLifetime';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { boardScopeKey } from '../../store/scopeMerge';
import { boardCoverage } from '../../test/userScopeCoverage';
import SessionCanvas from './SessionCanvas';

const zone = (x: number, label: string) => ({
  type: 'zone' as const,
  x,
  y: 0,
  width: 580,
  height: 1400,
  label,
  borderColor: '#1677ff',
  backgroundColor: '#1677ff1a',
});
const board = {
  board_id: 'phone-board',
  name: 'Phone board',
  objects: { 'zone-second': zone(640, 'Second'), 'zone-first': zone(0, 'First') },
} as unknown as Board;

const renderPhoneCanvas = () =>
  render(
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <div style={{ width: 390, height: 600 }}>
        <SessionCanvas readOnly board={board} branches={[]} client={null} height="100%" />
      </div>
    </ConnectionProvider>
  );

const viewport = (container: HTMLElement) => {
  const transform = container.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
  const [, x, y, zoom] =
    transform?.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/) ?? [];
  return { x: Number(x), y: Number(y), zoom: Number(zoom) };
};

beforeEach(() => {
  sessionStorage.clear();
  agorStore.setState({ ...EMPTY_MAPS });
});
afterEach(cleanup);

describe('SessionCanvas view-only first view', () => {
  it('opens fitted to the width of the first zone, from its top, at a readable zoom', async () => {
    const { container } = renderPhoneCanvas();
    await waitFor(() => expect(viewport(container).zoom).toBeLessThan(0.7));
    const { x, y, zoom } = viewport(container);
    expect(zoom).toBeGreaterThanOrEqual(0.6);
    // The first zone's left and top edges sit just inside the screen; the second starts off it.
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(30);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(60);
    expect(x + 640 * zoom).toBeGreaterThan(390);
  });

  it('returns to the viewport remembered for the board', async () => {
    sessionStorage.setItem(
      'agor:canvas-viewport:phone-board',
      JSON.stringify({ x: -120, y: -80, zoom: 0.9 })
    );
    const { container } = renderPhoneCanvas();
    await waitFor(() => expect(viewport(container)).toEqual({ x: -120, y: -80, zoom: 0.9 }));
  });
});

describe('SessionCanvas view-only chrome', () => {
  it('does not mount the minimap or the edit controls', async () => {
    const { container } = renderPhoneCanvas();
    await waitFor(() => expect(container.querySelector('.react-flow__viewport')).not.toBeNull());
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
    expect(container.querySelector('.react-flow__controls')).toBeNull();
  });
});

describe('SessionCanvas view-only comment pins', () => {
  const owner = { user_id: 'pin-owner', role: 'member' } as User;
  const pin = {
    comment_id: 'pin-1',
    board_id: board.board_id,
    created_by: owner.user_id,
    content: 'Mine',
    resolved: false,
    position: { absolute: { x: 40, y: 40 } },
    created_at: '2026-09-01T00:00:00.000Z',
  } as unknown as BoardComment;
  // Any write: a pin drop saves through `board-comments/:id/reposition`.create.
  const save = vi.fn(async (...args: unknown[]) => args.at(-1));
  const client = {
    service: () => ({
      patch: save,
      create: save,
      find: async () => ({ data: [], capabilities: [] }),
      get: async () => ({ capabilities: [] }),
      on: vi.fn(),
      off: vi.fn(),
    }),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    io: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), volatile: { emit: vi.fn() } },
  } as unknown as AgorClient;

  beforeEach(() => {
    save.mockClear();
    setRealtimeAuthorityScope('pin-owner:member:1');
    // An authenticated owner on a loaded board: only `readOnly` stands between them and a drag.
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([[owner.user_id, owner]]),
      commentById: new Map([[pin.comment_id, pin]]),
      coverage: new Map([
        [
          boardScopeKey(board.board_id),
          boardCoverage('loaded', captureLoadLifetime() ?? undefined),
        ],
      ]),
    });
  });
  afterEach(() => setRealtimeAuthorityScope(null));

  /** Drags the owned pin across the pane; returns its transform before and after. */
  async function dragPin(readOnly: boolean) {
    save.mockClear();
    const { container } = render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <div style={{ width: 390, height: 600 }}>
          <SessionCanvas
            readOnly={readOnly}
            board={board}
            branches={[]}
            client={client}
            currentUserId={owner.user_id}
            height="100%"
          />
        </div>
      </ConnectionProvider>
    );
    const node = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-id="comment-pin-1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // Let the first-view fit settle before pointer input.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const before = node.style.transform;
    // React Flow marks a draggable node `nopan`.
    const draggable = node.classList.contains('nopan');
    const pane = container.querySelector<HTMLElement>('.react-flow__pane')!;
    // Drop 80px right and down of the pin, clear of the minimap and controls.
    const pinRect = node.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const targetPosition = {
      x: pinRect.left - paneRect.left + pinRect.width / 2 + 80,
      y: pinRect.top - paneRect.top + pinRect.height / 2 + 80,
    };
    await act(async () => userEvent.dragAndDrop(node, pane, { targetPosition }));
    return { before, draggable, after: () => node.style.transform };
  }

  it('drags and saves an owned pin on an editable canvas (control)', async () => {
    const { draggable } = await dragPin(false);
    expect(draggable).toBe(true);
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('does not move an owned pin on a view-only canvas', async () => {
    const { before, draggable, after } = await dragPin(true);
    expect(draggable).toBe(false);
    expect(after()).toBe(before);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(save).not.toHaveBeenCalled();
  });
});
