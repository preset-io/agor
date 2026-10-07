import type {
  AgorClient,
  Board,
  BoardEntityObject,
  Branch,
  CardWithType,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { boardObjectPatched, sessionPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { captureLoadLifetime } from '../../store/loadLifetime';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { boardScopeKey } from '../../store/scopeMerge';
import { CONNECTED, deferred } from '../../test/harness';
import { boardCoverage } from '../../test/userScopeCoverage';
import { ZoneNode } from './canvas/BoardObjectNodes';
import { MarkdownNode } from './canvas/MarkdownNode';
import SessionCanvas from './SessionCanvas';

interface FlowNode {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  positionAbsolute?: { x: number; y: number };
  width?: number;
  height?: number;
  zIndex?: number;
}

interface CapturedFlowProps {
  nodes: FlowNode[];
  onNodesChange?: (changes: unknown[]) => void;
  onNodeDragStart?: (event: unknown, node: FlowNode) => void;
  onNodeDrag?: (event: unknown, node: FlowNode) => void;
  onNodeDragStop?: (event: unknown, node: FlowNode) => void;
}

let flowProps: CapturedFlowProps | null = null;

const { copySpy } = vi.hoisted(() => ({ copySpy: vi.fn(async (_text: string) => true) }));
vi.mock('../../utils/clipboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/clipboard')>()),
  copyToClipboard: copySpy,
}));

vi.mock('reactflow', async () => {
  const React = await import('react');
  return {
    Background: () => null,
    Controls: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ControlButton: ({ children, ...props }: { children?: ReactNode }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    MiniMap: () => null,
    NodeResizer: () => null,
    ReactFlow: (
      props: CapturedFlowProps & { children?: ReactNode; onInit?: (value: unknown) => void }
    ) => {
      flowProps = props;
      React.useEffect(() => {
        props.onInit?.({
          fitView: vi.fn(),
          getNode: (id: string) => flowProps?.nodes.find((node) => node.id === id),
          getNodes: () => flowProps?.nodes ?? [],
          getZoom: () => 1,
          getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
          screenToFlowPosition: (position: { x: number; y: number }) => position,
        });
      }, []);
      return <div data-testid="react-flow">{props.children}</div>;
    },
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useNodesState: (initial: FlowNode[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
  };
});

vi.mock('../BranchCard', () => ({
  __esModule: true,
  default: () => <div />,
}));

let triggerPickerExecute: ((params: Record<string, unknown>) => Promise<void>) | null = null;
vi.mock('./canvas/ZoneTriggerModal', () => ({
  ZoneTriggerModal: ({
    open,
    onExecute,
  }: {
    open: boolean;
    onExecute: (params: Record<string, unknown>) => Promise<void>;
  }) => {
    if (open) triggerPickerExecute = onExecute;
    return open ? <div data-testid="zone-trigger-picker" /> : null;
  },
}));

const BOARD_ID = 'board-placement-fixture';
const BRANCH_ID = 'branch-example-feature';
const IMPLEMENTING_ZONE_ID = 'zone-implementing';
const REVIEWING_ZONE_ID = 'zone-reviewing';

const branch = {
  branch_id: BRANCH_ID,
  repo_id: 'repo-1',
  board_id: BOARD_ID,
  name: 'example-feature',
  archived: false,
} as unknown as Branch;

const repo = {
  repo_id: 'repo-1',
  name: 'example',
  slug: 'example/project',
} as unknown as Repo;

const board = {
  board_id: BOARD_ID,
  name: 'Disposable placement geometry fixture',
  objects: {
    [IMPLEMENTING_ZONE_ID]: {
      type: 'zone',
      x: 1740,
      y: 80,
      width: 1100,
      height: 720,
      label: 'Implementing',
    },
    [REVIEWING_ZONE_ID]: {
      type: 'zone',
      x: 2890,
      y: 80,
      width: 740,
      height: 720,
      label: 'Reviewing',
    },
    'artifact-large': {
      type: 'artifact',
      x: 1600,
      y: 1320,
      width: 1800,
      height: 1000,
      artifact_id: 'artifact-1',
    },
  },
  created_at: '2026-09-01T00:00:00.000Z',
  last_updated: '2026-09-01T00:00:00.000Z',
  created_by: 'user-1',
  url: 'http://localhost/ui/b/example/',
  archived: false,
} as unknown as Board;

const implementingPlacement = {
  object_id: 'board-object-branch',
  board_id: BOARD_ID,
  branch_id: BRANCH_ID,
  entity_type: 'branch',
  zone_id: IMPLEMENTING_ZONE_ID,
  position: { x: 20, y: 100 },
  size: { width: 500, height: 180 },
} as unknown as BoardEntityObject;

const card = {
  card_id: 'card-1',
  board_id: BOARD_ID,
  title: 'Independent pending placement',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  archived: false,
} as unknown as CardWithType;

const reviewingCardPlacement = {
  object_id: 'board-object-card',
  board_id: BOARD_ID,
  card_id: card.card_id,
  entity_type: 'card',
  zone_id: REVIEWING_ZONE_ID,
  position: { x: 80, y: 480 },
  size: { width: 380, height: 120 },
} as unknown as BoardEntityObject;

// Board edits need board.edit; an admin has it without a policy read.
const adminUser = { user_id: 'user-admin', role: 'admin' } as unknown as User;

/**
 * The fixture board's partition, loaded under the current lifetime: it holds
 * the board's rows, so realtime writes to them are admitted.
 */
const loadedPartition = () => boardCoverage('loaded', captureLoadLifetime() ?? undefined);

/** A (re)load of the fixture board's partition: a new partition lifetime. */
function markFixtureLoaded() {
  agorStore.getState().setCoverage(boardScopeKey(BOARD_ID), loadedPartition());
}

function currentNode(id: string): FlowNode {
  const node = flowProps?.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Missing React Flow node ${id}`);
  return node;
}

interface CanvasOptions {
  /** Mount inside antd's `App` (default), as its modals and messages need. */
  app?: boolean;
  branches?: Branch[];
  connection?: Parameters<typeof ConnectionProvider>[0]['value'];
}

function canvasUi(
  client: AgorClient,
  canvasBoard: Board,
  { app = true, branches = [branch], connection = CONNECTED }: CanvasOptions
) {
  const ui = (
    <ConnectionProvider value={connection}>
      <SessionCanvas
        currentUserId={adminUser.user_id}
        board={canvasBoard}
        client={client}
        branches={branches}
      />
    </ConnectionProvider>
  );
  return app ? <App>{ui}</App> : ui;
}

/** Mount the canvas as the admin; `rerenderBoard` keeps its tree and options. */
function renderCanvas(client: AgorClient, canvasBoard: Board = board, options: CanvasOptions = {}) {
  const view = render(canvasUi(client, canvasBoard, options));
  return {
    ...view,
    rerenderBoard: (next: Board, overrides: CanvasOptions = {}) =>
      view.rerender(canvasUi(client, next, { ...options, ...overrides })),
  };
}

/** Drag node `id` to `positionAbsolute`, as React Flow reports a drag. */
function drag(id: string, positionAbsolute: { x: number; y: number }) {
  act(() => {
    const node = { ...currentNode(id), positionAbsolute };
    flowProps?.onNodeDragStart?.({}, node);
    flowProps?.onNodeDrag?.({}, node);
    flowProps?.onNodeDragStop?.({}, node);
  });
}

/** Resize zones (`[id, width, height]` each), as React Flow reports it. */
function resize(...zones: Array<[string, number, number]>) {
  act(() => {
    flowProps?.onNodesChange?.(
      zones.map(([id, width, height]) => ({
        type: 'dimensions',
        id,
        dimensions: { width, height },
      }))
    );
  });
}

describe('SessionCanvas authoritative zone placement reconciliation', () => {
  beforeEach(() => {
    flowProps = null;
    setRealtimeAuthorityScope(`${adminUser.user_id}:admin:1`);
    agorStore.setState({
      ...EMPTY_MAPS,
      repoById: new Map([[repo.repo_id, repo]]),
      branchById: new Map([[BRANCH_ID, branch]]),
      cardById: new Map([[card.card_id, card]]),
      userById: new Map([[adminUser.user_id, adminUser]]),
      boardObjectsByBoardId: new Map([[BOARD_ID, [implementingPlacement, reviewingCardPlacement]]]),
      // Structural edits need the board's partition loaded (see `boardReady`).
      coverage: new Map([[boardScopeKey(BOARD_ID), loadedPartition()]]),
    });
  });

  it('persists no move on a board whose partition is not loaded (lean record, no zones)', async () => {
    vi.useFakeTimers();
    // A reconnect unloaded this board; its cached placement is pinned to a
    // zone, but the lean record has no zone geometry to drop it into.
    agorStore.setState({ coverage: new Map() });
    const leanBoard = { ...board, objects: undefined } as unknown as Board;
    const patch = vi.fn(async () => implementingPlacement);
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client, leanBoard, { app: false });
    await act(async () => {});
    expect((currentNode(BRANCH_ID) as FlowNode & { draggable?: boolean }).draggable).toBe(false);
    drag(BRANCH_ID, { x: 1800, y: 200 });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-syncing-pill')).toHaveTextContent('read-only');
  });

  it('sends no zone, annotation or unpin write while the board is not loaded (cached full record)', async () => {
    vi.useFakeTimers();
    // Reauth: every partition was reset, but the full record is still cached.
    agorStore.setState({ coverage: new Map() });
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client);
    await act(async () => {});
    const zone = currentNode(IMPLEMENTING_ZONE_ID) as FlowNode & {
      data: { onUpdate: (id: string, data: unknown) => Promise<unknown>; canEdit: boolean };
    };
    expect(zone.data.canEdit).toBe(false);
    await act(async () => {
      await zone.data.onUpdate(IMPLEMENTING_ZONE_ID, {
        ...board.objects?.[IMPLEMENTING_ZONE_ID],
        label: 'Edited',
      });
    });
    // A queued zone resize.
    resize([IMPLEMENTING_ZONE_ID, 2000, 900]);
    // Unpinning the pinned branch.
    const branchNode = currentNode(BRANCH_ID) as FlowNode & {
      data: { onUnpin?: (id: string) => Promise<void> };
    };
    await act(async () => {
      await branchNode.data.onUnpin?.(BRANCH_ID);
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it.each(['unload', 'unload-reload'])(
    'drops a zone resize queued before an %s (the reload no longer has the zone)',
    async (change) => {
      vi.useFakeTimers();
      const patch = vi.fn(async () => ({}));
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      const view = renderCanvas(client);
      await act(async () => {});
      resize([IMPLEMENTING_ZONE_ID, 2000, 900]);
      // Inside the 500 ms debounce. The zone was deleted while the board was
      // unloaded, so a reloaded record no longer has it.
      act(() => agorStore.getState().resetBoardPartitions());
      if (change === 'unload-reload') {
        const { [IMPLEMENTING_ZONE_ID]: _deleted, ...remaining } = board.objects ?? {};
        const reloaded = { ...board, objects: remaining } as Board;
        act(() => {
          agorStore.setState({ boardById: new Map([[BOARD_ID, reloaded]]) });
          markFixtureLoaded();
        });
        view.rerenderBoard(reloaded);
      }
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(patch).not.toHaveBeenCalled();
    }
  );

  it.each(['unload', 'unload-reload'])(
    'drops a pending move queued before an %s',
    async (change) => {
      vi.useFakeTimers();
      const patch = vi.fn(async () => implementingPlacement);
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      renderCanvas(client);
      await act(async () => {});
      drag(BRANCH_ID, { x: 1800, y: 200 });
      // A reconnect unloads the board inside the 500 ms save debounce.
      act(() => agorStore.getState().resetBoardPartitions());
      if (change === 'unload-reload') act(() => markFixtureLoaded());
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(patch).not.toHaveBeenCalled();
    }
  );

  it('stops a resize batch at the next zone when the board unloads during a PATCH', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const patch = vi.fn(async () => {
      if (patch.mock.calls.length === 1) await pending.promise;
      return {};
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client);
    await act(async () => {});
    resize([IMPLEMENTING_ZONE_ID, 2000, 900], [REVIEWING_ZONE_ID, 900, 900]);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(patch).toHaveBeenCalledTimes(1);
    act(() => agorStore.getState().resetBoardPartitions());
    act(() => markFixtureLoaded());
    await act(async () => {
      pending.resolve();
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it.each(['unload', 'unload-reload'])(
    'a zone-trigger picker opened before an %s dispatches nothing',
    async (change) => {
      vi.useFakeTimers();
      triggerPickerExecute = null;
      agorStore.setState({
        boardObjectsByBoardId: new Map([[BOARD_ID, [{ ...implementingPlacement, zone_id: null }]]]),
      });
      const triggerBoard = {
        ...board,
        objects: {
          ...board.objects,
          [IMPLEMENTING_ZONE_ID]: {
            ...board.objects?.[IMPLEMENTING_ZONE_ID],
            trigger: { behavior: 'show_picker', prompt_template: 'Review this fixture.' },
          },
        },
      } as Board;
      const patch = vi.fn(async () => ({}));
      const create = vi.fn(async () => ({ session_id: 'session-new' }));
      const prompt = vi.fn(async () => ({}));
      const client = {
        service: vi.fn(() => ({ patch, create })),
        sessions: { prompt },
      } as unknown as AgorClient;
      renderCanvas(client, triggerBoard);
      await act(async () => {});
      drag(BRANCH_ID, { x: 1800, y: 200 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(501);
      });
      expect(screen.getByTestId('zone-trigger-picker')).toBeTruthy();
      expect(triggerPickerExecute).not.toBeNull();
      act(() => agorStore.getState().resetBoardPartitions());
      if (change === 'unload-reload') act(() => markFixtureLoaded());
      create.mockClear();
      await act(async () => {
        await triggerPickerExecute?.({
          sessionId: 'new',
          action: 'prompt',
          renderedTemplate: 'Review this fixture.',
          agent: 'claude-code',
        });
      });
      expect(create).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    }
  );

  it('a double-clicked zone-trigger picker runs its trigger once', async () => {
    vi.useFakeTimers();
    triggerPickerExecute = null;
    agorStore.setState({
      boardObjectsByBoardId: new Map([[BOARD_ID, [{ ...implementingPlacement, zone_id: null }]]]),
    });
    const triggerBoard = {
      ...board,
      objects: {
        ...board.objects,
        [IMPLEMENTING_ZONE_ID]: {
          ...board.objects?.[IMPLEMENTING_ZONE_ID],
          trigger: { behavior: 'show_picker', prompt_template: 'Review this fixture.' },
        },
      },
    } as Board;
    const patch = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({ session_id: 'session-new' }));
    const prompt = vi.fn(async () => ({}));
    const client = {
      service: vi.fn(() => ({ patch, create })),
      sessions: { prompt },
    } as unknown as AgorClient;
    renderCanvas(client, triggerBoard);
    await act(async () => {});
    drag(BRANCH_ID, { x: 1800, y: 200 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(screen.getByTestId('zone-trigger-picker')).toBeTruthy();
    create.mockClear();
    // The session create is in flight when the second click arrives.
    let releaseCreate: () => void = () => {};
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCreate = () => resolve({ session_id: 'session-new' });
        })
    );
    const params = {
      sessionId: 'new',
      action: 'prompt',
      renderedTemplate: 'Review this fixture.',
      agent: 'claude-code',
    };
    await act(async () => {
      const first = triggerPickerExecute?.(params);
      const second = triggerPickerExecute?.(params);
      await Promise.resolve();
      releaseCreate();
      await Promise.all([first, second]);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  // A reconnect resync resets every partition and marks the displayed board
  // loaded in one synchronous step: no render ever sees the board unloaded.
  const resyncReload = () =>
    act(() => {
      agorStore.getState().resetBoardPartitions();
      markFixtureLoaded();
    });

  it('drops a markdown note save whose editor opened before a resync reload', async () => {
    const noteBoard = {
      ...board,
      objects: {
        ...board.objects,
        'markdown-1': { type: 'markdown', x: 0, y: 0, width: 300, content: 'Old note' },
      },
    } as Board;
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client, noteBoard);
    await act(async () => {});
    const note = currentNode('markdown-1') as FlowNode & {
      data: { onEdit: (id: string, content: string, width: number) => void };
    };
    act(() => note.data.onEdit('markdown-1', 'Old note', 300));
    expect(await screen.findByText('Edit Markdown Note')).toBeTruthy();
    resyncReload();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(patch).not.toHaveBeenCalled();
    expect(await screen.findByText(/reloaded while the note was open/)).toBeTruthy();
  });

  it('drops a comment placed before a resync reload', async () => {
    const create = vi.fn(async () => ({}));
    const client = {
      service: vi.fn(() => ({ create, patch: vi.fn(), find: vi.fn(async () => []) })),
    } as unknown as AgorClient;
    renderCanvas(client);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    act(() => {
      (flowProps as unknown as { onPaneClick: (event: unknown) => void }).onPaneClick({
        clientX: 50,
        clientY: 60,
      });
    });
    fireEvent.change(await screen.findByPlaceholderText(/Add a comment/), {
      target: { value: 'Pinned to a zone that may be gone' },
    });
    resyncReload();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    });
    expect(create).not.toHaveBeenCalled();
  });

  /** Every `boards.patch` the canvas sent with `_action`, in order. */
  const boardPatches = (patch: ReturnType<typeof vi.fn>) =>
    patch.mock.calls
      .map((call) => call[1] as { _action?: string; objectId?: string; objectData?: unknown })
      .filter((data) => data?._action);

  /** A board-object node rendered on its own, as React Flow would. */
  const renderNode = (node: ReactNode) => {
    const ui = (child: ReactNode) => (
      <App>
        <ConnectionProvider value={CONNECTED}>{child}</ConnectionProvider>
      </App>
    );
    const view = render(ui(node));
    return { ...view, rerenderNode: (next: ReactNode) => view.rerender(ui(next)) };
  };

  it('a new zone label editor opened before the first ack never saves across a reload', async () => {
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const canvas = renderCanvas(client);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add Zone' }));
    const surface = screen.getByTestId('react-flow');
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, buttons: 1 });
    fireEvent.pointerMove(surface, { clientX: 400, clientY: 400, buttons: 1 });
    fireEvent.pointerUp(surface, { clientX: 400, clientY: 400 });
    const created = boardPatches(patch).find((data) => data._action === 'upsertObject');
    const zoneId = created?.objectId as string;
    expect(zoneId).toMatch(/^zone-/);
    type ZoneData = Parameters<typeof ZoneNode>[0]['data'];
    const zoneData = () => (currentNode(zoneId) as FlowNode & { data: ZoneData }).data;

    // The optimistic node: the label editor opens before the realtime ack.
    const node = renderNode(<ZoneNode selected data={zoneData()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    const input = screen.getByDisplayValue('New Zone');

    // The ack (a board event carries the zone), then a resync reload.
    const acked = {
      ...board,
      objects: { ...board.objects, [zoneId]: created?.objectData },
    } as unknown as Board;
    act(() => canvas.rerenderBoard(acked));
    node.rerenderNode(<ZoneNode selected data={zoneData()} />);
    resyncReload();

    fireEvent.change(input, { target: { value: 'Renamed after reload' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(boardPatches(patch)).toHaveLength(1);
  });

  it('a new markdown note delete confirmed after a reload never dispatches', async () => {
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add Markdown Note' }));
    act(() => {
      (flowProps as unknown as { onPaneClick: (event: unknown) => void }).onPaneClick({
        clientX: 50,
        clientY: 60,
      });
    });
    fireEvent.change(await screen.findByPlaceholderText(/# Title/), {
      target: { value: 'A fresh note' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(boardPatches(patch)).toHaveLength(1);
    const noteNode = flowProps?.nodes.find((candidate) => candidate.type === 'markdown') as
      | (FlowNode & { data: Parameters<typeof MarkdownNode>[0]['data'] })
      | undefined;
    expect(noteNode).toBeTruthy();

    // Delete confirmation opened on the optimistic node, before the ack.
    renderNode(<MarkdownNode data={noteNode?.data as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect((await screen.findAllByText('Delete note?')).length).toBeGreaterThan(0);
    resyncReload();
    const okButtons = document.querySelectorAll<HTMLButtonElement>(
      '.ant-modal-confirm-btns button'
    );
    await act(async () => {
      fireEvent.click(okButtons[okButtons.length - 1]);
    });
    expect(boardPatches(patch).filter((data) => data._action === 'removeObject')).toHaveLength(0);
  });

  it('a resize batch suspended on its first PATCH sends nothing more once the canvas unmounts', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const patch = vi.fn(async () => {
      if (patch.mock.calls.length === 1) await pending.promise;
      return {};
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const view = renderCanvas(client);
    await act(async () => {});
    resize([IMPLEMENTING_ZONE_ID, 2000, 900], [REVIEWING_ZONE_ID, 900, 900]);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(patch).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      pending.resolve();
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('keeps the markdown editor and draft open when the save is rejected, and closes on a successful retry', async () => {
    const noteBoard = {
      ...board,
      objects: {
        ...board.objects,
        'markdown-1': { type: 'markdown', x: 0, y: 0, width: 300, content: 'Old note' },
      },
    } as Board;
    const patch = vi
      .fn(async () => ({}))
      .mockRejectedValueOnce(new Error('You do not have permission to edit this board.'));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client, noteBoard);
    await act(async () => {});
    const note = currentNode('markdown-1') as FlowNode & {
      data: { onEdit: (id: string, content: string, width: number) => void };
    };
    act(() => note.data.onEdit('markdown-1', 'Old note', 300));
    fireEvent.change(await screen.findByDisplayValue('Old note'), {
      target: { value: 'My careful draft' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(boardPatches(patch)).toHaveLength(1);
    // Still open, with the draft and the reason; the note shows what is saved.
    expect(screen.getByText('Edit Markdown Note')).toBeTruthy();
    expect(screen.getByDisplayValue('My careful draft')).toBeTruthy();
    expect(screen.getByText(/You do not have permission to edit this board/)).toBeTruthy();
    expect(
      (currentNode('markdown-1') as FlowNode & { data: { content: string } }).data.content
    ).toBe('Old note');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(boardPatches(patch)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText('Edit Markdown Note')).toBeNull());
  });

  it('keeps a new markdown note draft open when its create is rejected', async () => {
    const patch = vi.fn(async () => {
      throw new Error('Forbidden');
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add Markdown Note' }));
    act(() => {
      (flowProps as unknown as { onPaneClick: (event: unknown) => void }).onPaneClick({
        clientX: 50,
        clientY: 60,
      });
    });
    fireEvent.change(await screen.findByPlaceholderText(/# Title/), {
      target: { value: 'A fresh note' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(boardPatches(patch)).toHaveLength(1);
    expect(screen.getByText('Add Markdown Note', { selector: '.ant-modal-title' })).toBeTruthy();
    expect(screen.getByDisplayValue('A fresh note')).toBeTruthy();
    expect(screen.getByText(/Forbidden/)).toBeTruthy();
    // The optimistic note is rolled back.
    expect(flowProps?.nodes.some((candidate) => candidate.type === 'markdown')).toBe(false);
  });

  const noteBoard = {
    ...board,
    objects: {
      ...board.objects,
      'markdown-1': { type: 'markdown', x: 0, y: 0, width: 300, content: 'Old note' },
    },
  } as Board;
  type NoteData = { onEdit: (id: string, content: string, width: number) => void };
  const openNote = (content = 'Old note') =>
    act(() =>
      (currentNode('markdown-1') as FlowNode & { data: NoteData }).data.onEdit(
        'markdown-1',
        content,
        300
      )
    );

  it('keeps a markdown draft rejected by a reload to copy or discard, and saves only after reopening', async () => {
    copySpy.mockClear();
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client, noteBoard);
    await act(async () => {});
    openNote();
    fireEvent.change(await screen.findByDisplayValue('Old note'), {
      target: { value: 'My careful draft' },
    });
    resyncReload();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(patch).not.toHaveBeenCalled();
    // The editor stays open with the draft and says why; Save stays refused.
    expect(screen.getByText('Edit Markdown Note')).toBeTruthy();
    expect(screen.getByDisplayValue('My careful draft')).toBeTruthy();
    expect(screen.getByText(/Board reloaded — changes not saved/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-apply to reloaded board' })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await act(async () => {
      fireEvent.click(save);
    });
    // Opening the note again while its editor is open changes nothing.
    openNote();
    expect(screen.getByDisplayValue('My careful draft')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }));
    });
    expect(copySpy).toHaveBeenCalledExactlyOnceWith('My careful draft');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('Edit Markdown Note')).toBeNull());
    expect(patch).not.toHaveBeenCalled();

    // Reopening edits the reloaded note under a ticket captured at open.
    openNote();
    fireEvent.change(await screen.findByDisplayValue('Old note'), {
      target: { value: 'Edited after reopening' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(boardPatches(patch)).toEqual([
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: 'markdown-1',
        objectData: expect.objectContaining({ content: 'Edited after reopening' }),
      }),
    ]);
    await waitFor(() => expect(screen.queryByText('Edit Markdown Note')).toBeNull());
  });

  it('keeps a markdown draft whose note a reload deleted, and says the note no longer exists', async () => {
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const canvas = renderCanvas(client, noteBoard);
    await act(async () => {});
    openNote();
    fireEvent.change(await screen.findByDisplayValue('Old note'), {
      target: { value: 'Draft of a deleted note' },
    });
    // The reload brings a board without the note.
    act(() => canvas.rerenderBoard(board));
    resyncReload();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Draft of a deleted note')).toBeTruthy();
    expect(screen.getByText(/This note no longer exists/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the unsaved draft of a zone a reload deleted, to copy or discard', async () => {
    copySpy.mockClear();
    const patch = vi.fn(async () => ({}));
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const canvas = renderCanvas(client);
    await act(async () => {});
    type ZoneData = Parameters<typeof ZoneNode>[0]['data'];
    const zoneData = (currentNode(IMPLEMENTING_ZONE_ID) as FlowNode & { data: ZoneData }).data;
    const node = renderNode(<ZoneNode selected data={zoneData} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename zone' }));
    fireEvent.change(screen.getByDisplayValue('Implementing'), {
      target: { value: 'Unsaved rename' },
    });

    // The reload drops the zone, so React Flow unmounts its node.
    const { [IMPLEMENTING_ZONE_ID]: _deleted, ...remaining } = board.objects ?? {};
    act(() => canvas.rerenderBoard({ ...board, objects: remaining } as Board));
    resyncReload();
    act(() => node.unmount());

    expect(await screen.findByText('Zone changes not saved')).toBeTruthy();
    expect(screen.getByText('Zone "Implementing" no longer exists.')).toBeTruthy();
    expect(screen.getByLabelText('Unsaved draft for zone Implementing')).toHaveValue(
      'Label: Unsaved rename'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }));
    });
    expect(copySpy).toHaveBeenCalledExactlyOnceWith('Label: Unsaved rename');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('Zone changes not saved')).toBeNull());
    expect(patch).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setRealtimeAuthorityScope(null);
  });

  it('persists a second drag after the first pending PATCH is acknowledged', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const patch = vi.fn(async (_id: string, data: Partial<BoardEntityObject>) => {
      if (patch.mock.calls.length === 1) await pending;
      const result = { ...implementingPlacement, ...data };
      boardObjectPatched(result);
      return result;
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    renderCanvas(client, board, { app: false });
    await act(async () => {});
    const drag = (x: number) =>
      act(() => {
        const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x, y: 200 } };
        flowProps?.onNodeDragStart?.({}, node);
        flowProps?.onNodeDrag?.({}, node);
        flowProps?.onNodeDragStop?.({}, node);
      });
    drag(1800);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(patch).toHaveBeenCalledTimes(1);
    drag(1900);
    await act(async () => {
      release();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toMatchObject({
      position: { x: 160, y: 120 },
      zone_id: IMPLEMENTING_ZONE_ID,
    });
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get(BOARD_ID)
        ?.find((row) => row.branch_id === BRANCH_ID)?.position
    ).toEqual({ x: 160, y: 120 });
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: { x: 160, y: 120 },
    });
  });

  it.each(
    ['branch', 'card'].flatMap((entity) =>
      [false, true].flatMap((drained) =>
        ['before-http', 'after-http'].flatMap((ack) =>
          [false, true].map((crossZone) => ({ entity, drained, ack, crossZone }))
        )
      )
    )
  )(
    'preserves $entity newer intent (drained=$drained, ack=$ack, crossZone=$crossZone)',
    async ({ entity, drained, ack, crossZone }) => {
      vi.useFakeTimers();
      const initial = entity === 'branch' ? implementingPlacement : reviewingCardPlacement;
      const nodeId = entity === 'branch' ? BRANCH_ID : `card-${card.card_id}`;
      const requests: Array<{ result: BoardEntityObject; release: () => void }> = [];
      const patch = vi.fn(
        (_id: string, data: Partial<BoardEntityObject>) =>
          new Promise<BoardEntityObject>((resolve) => {
            const result = { ...initial, ...data };
            requests.push({ result, release: () => resolve(result) });
          })
      );
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      renderCanvas(client, board, { app: false });
      await act(async () => {});
      const drag = (x: number) =>
        act(() => {
          const node = { ...currentNode(nodeId), positionAbsolute: { x, y: 200 } };
          flowProps?.onNodeDragStart?.({}, node);
          flowProps?.onNodeDrag?.({}, node);
          flowProps?.onNodeDragStop?.({}, node);
        });
      const firstX = entity === 'branch' ? 1800 : 3000;
      const secondX = crossZone ? (entity === 'branch' ? 3000 : 1800) : firstX + 100;
      drag(firstX);
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      drag(secondX);
      if (drained)
        await act(async () => {
          vi.advanceTimersByTime(501);
        });
      // A second timer may have drained, but it must not overtake this node's HTTP write.
      expect(patch).toHaveBeenCalledTimes(1);
      if (ack === 'before-http') act(() => boardObjectPatched(requests[0].result));
      await act(async () => requests[0].release());
      if (ack === 'after-http') act(() => boardObjectPatched(requests[0].result));
      if (!drained)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(501);
        });
      expect(patch).toHaveBeenCalledTimes(2);
      const zoneId = secondX < 2800 ? IMPLEMENTING_ZONE_ID : REVIEWING_ZONE_ID;
      const expected = { x: secondX - (zoneId === IMPLEMENTING_ZONE_ID ? 1740 : 2890), y: 120 };
      expect(requests[1].result).toMatchObject({ position: expected, zone_id: zoneId });
      expect(requests[1].result.placement_write_id).not.toBe(requests[0].result.placement_write_id);
      await act(async () => {
        boardObjectPatched(requests[1].result);
        requests[1].release();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(patch).toHaveBeenCalledTimes(2);
      expect(
        agorStore
          .getState()
          .boardObjectsByBoardId.get(BOARD_ID)
          ?.find((row) => row.object_id === initial.object_id)
      ).toMatchObject({ position: expected, zone_id: zoneId });
      expect(currentNode(nodeId)).toMatchObject({ position: expected, parentId: zoneId });
    }
  );

  it.each([
    'external',
    'external-aba',
    'external-matches-inflight',
    'board-switch',
    'auth-switch',
    'unmount',
    'rapid-reordered',
  ])('fences overlapping drained writes after %s', async (change) => {
    vi.useFakeTimers();
    const requests: Array<{ result: BoardEntityObject; release: () => void }> = [];
    const patch = vi.fn(
      (_id: string, data: Partial<BoardEntityObject>) =>
        new Promise<BoardEntityObject>((resolve) => {
          const result = { ...implementingPlacement, ...data };
          requests.push({ result, release: () => resolve(result) });
        })
    );
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const view = renderCanvas(client, board, { app: false });
    await act(async () => {});
    const drag = (x: number) =>
      act(() => {
        const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x, y: 200 } };
        flowProps?.onNodeDragStart?.({}, node);
        flowProps?.onNodeDrag?.({}, node);
        flowProps?.onNodeDragStop?.({}, node);
      });
    drag(1800);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    drag(1900);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(patch).toHaveBeenCalledTimes(1);
    if (change === 'rapid-reordered') {
      // Coalesce multiple already-drained and still-pending generations, including ABA.
      drag(1800);
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      drag(2000);
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      await act(async () => requests[0].release()); // HTTP before its event
      expect(patch).toHaveBeenCalledTimes(2);
      expect(requests[1].result.position).toEqual({ x: 260, y: 120 });
      drag(2100);
      act(() => boardObjectPatched(requests[1].result));
      act(() => boardObjectPatched(requests[0].result)); // old event arrives last
      await act(async () => requests[1].release());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(501);
      });
      expect(patch).toHaveBeenCalledTimes(3);
      expect(requests[2].result.position).toEqual({ x: 360, y: 120 });
      await act(async () => {
        boardObjectPatched(requests[2].result);
        requests[2].release();
      });
      expect(currentNode(BRANCH_ID).position).toEqual({ x: 360, y: 120 });
    } else {
      if (change.startsWith('external'))
        act(() => {
          boardObjectPatched({
            ...implementingPlacement,
            position:
              change === 'external-matches-inflight'
                ? requests[0].result.position
                : { x: 400, y: 300 },
          });
          if (change === 'external-aba') boardObjectPatched(implementingPlacement);
        });
      else if (change === 'board-switch')
        view.rerenderBoard({ ...board, board_id: 'other-board' } as Board);
      else if (change === 'auth-switch')
        view.rerenderBoard(board, { connection: { ...CONNECTED, authGeneration: 2 } });
      else view.unmount();
      // Neither an old success nor its late realtime echo may resurrect invalidated work.
      await act(async () => {
        boardObjectPatched(requests[0].result);
        requests[0].release();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(patch).toHaveBeenCalledTimes(1);
    }
  });

  it.each([false, true])(
    'bases a newer drag on live authority before React renders (initially unplaced=%s)',
    async (unplaced) => {
      vi.useFakeTimers();
      if (unplaced)
        agorStore.setState({
          boardObjectsByBoardId: new Map([[BOARD_ID, [reviewingCardPlacement]]]),
        });
      const patch = vi.fn(async (_id: string, data: Partial<BoardEntityObject>) => {
        const result = { ...implementingPlacement, ...data };
        boardObjectPatched(result);
        return result;
      });
      const client = { service: () => ({ patch }) } as unknown as AgorClient;
      renderCanvas(client, board, { app: false });
      await act(async () => {});
      const beforeRender = flowProps!;
      const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x: 1900, y: 200 } };
      act(() => {
        boardObjectPatched({ ...implementingPlacement, position: { x: 400, y: 300 } });
        beforeRender.onNodeDragStart?.({}, node);
        beforeRender.onNodeDrag?.({}, node);
        beforeRender.onNodeDragStop?.({}, node);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch.mock.calls[0][1].position).toEqual({ x: 160, y: 120 });
      expect(currentNode(BRANCH_ID).position).toEqual({ x: 160, y: 120 });
    }
  );

  it('does not persist a stale drag after cross-zone authority advances', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;

    renderCanvas(client, board, { app: false });
    await act(async () => {});

    const staleBranchNode = {
      ...currentNode(BRANCH_ID),
      position: { x: 60, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, staleBranchNode);
      flowProps?.onNodeDrag?.({}, staleBranchNode);
      flowProps?.onNodeDragStop?.({}, staleBranchNode);
    });

    // Queue an unrelated, valid card write after the branch. Both entries use
    // the production shared debounce, so reconciliation must invalidate only
    // the superseded branch entry.
    const validCardNode = {
      ...currentNode(`card-${card.card_id}`),
      position: { x: 120, y: 400 },
      positionAbsolute: { x: 3010, y: 480 },
      width: 380,
      height: 120,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, validCardNode);
      flowProps?.onNodeDrag?.({}, validCardNode);
      flowProps?.onNodeDragStop?.({}, validCardNode);
    });

    act(() =>
      boardObjectPatched({
        ...implementingPlacement,
        zone_id: REVIEWING_ZONE_ID,
        position: { x: 20, y: 100 },
      })
    );
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('board-object-card', {
      placement_write_id: expect.any(String),
      position: { x: 120, y: 400 },
      zone_id: REVIEWING_ZONE_ID,
    });
    expect(patch).not.toHaveBeenCalledWith('board-object-branch', expect.anything());
  });

  it.each([IMPLEMENTING_ZONE_ID, REVIEWING_ZONE_ID, 'context-replaced', 'new-placement'])(
    'discards a drained branch write when authority advances to %s while another PATCH awaits',
    async (zoneId) => {
      vi.useFakeTimers();
      if (zoneId === 'new-placement') {
        agorStore.setState({
          boardObjectsByBoardId: new Map([[BOARD_ID, [reviewingCardPlacement]]]),
        });
      }
      const expectedZoneId = zoneId === 'new-placement' ? REVIEWING_ZONE_ID : zoneId;
      let releaseCard!: () => void;
      const cardPending = new Promise<void>((resolve) => {
        releaseCard = resolve;
      });
      const patch = vi.fn((id: string) =>
        id === reviewingCardPlacement.object_id ? cardPending : Promise.resolve()
      );
      const create = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch, create })) } as unknown as AgorClient;
      renderCanvas(client, board, { app: false });
      await act(async () => {});
      for (const node of [
        {
          ...currentNode(BRANCH_ID),
          positionAbsolute: { x: 1800, y: 200 },
        },
        {
          ...currentNode(`card-${card.card_id}`),
          positionAbsolute: { x: 3010, y: 480 },
        },
      ]) {
        act(() => {
          flowProps?.onNodeDragStart?.({}, node);
          flowProps?.onNodeDrag?.({}, node);
          flowProps?.onNodeDragStop?.({}, node);
        });
      }
      // The timer has drained its ref into a private batch. The card PATCH
      // suspends that batch before the accumulated branch PATCH is sent.
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      act(() => {
        if (zoneId === 'context-replaced') {
          // A new tenant/board context has no authority for this old object.
          agorStore.setState({ boardObjectsByBoardId: new Map() });
        } else {
          boardObjectPatched({
            ...implementingPlacement,
            zone_id: expectedZoneId,
            position: { x: 40, y: 260 },
          });
        }
      });
      await act(async () => {
        releaseCard();
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      if (zoneId !== 'context-replaced') {
        expect(currentNode(BRANCH_ID)).toMatchObject({
          parentId: expectedZoneId,
          position: { x: 40, y: 260 },
        });
      }
    }
  );

  it.each(
    (['always_new', 'show_picker'] as const).flatMap((behavior) =>
      [
        'board-switch',
        'placement-changed',
        'new-placement',
        'unchanged',
        'unload',
        'unload-reload',
      ].map((change) => ({
        behavior,
        change,
      }))
    )
  )(
    'rechecks $behavior trigger and placement authority after $change while a batch suspends',
    async ({ behavior, change }) => {
      vi.useFakeTimers();
      const initiallyPlaced = change !== 'new-placement';
      const unpinned = { ...implementingPlacement, zone_id: null };
      agorStore.setState({
        boardObjectsByBoardId: new Map([
          [BOARD_ID, [reviewingCardPlacement, ...(initiallyPlaced ? [unpinned] : [])]],
        ]),
      });
      const triggerBoard = {
        ...board,
        objects: {
          ...board.objects,
          [IMPLEMENTING_ZONE_ID]: {
            ...board.objects?.[IMPLEMENTING_ZONE_ID],
            trigger: { behavior, prompt_template: 'Review this fictional fixture.' },
          },
        },
      } as Board;
      let releaseCard!: () => void;
      const cardPending = new Promise<void>((resolve) => {
        releaseCard = resolve;
      });
      const patch = vi.fn((id: string) =>
        id === reviewingCardPlacement.object_id ? cardPending : Promise.resolve()
      );
      const create = vi.fn().mockResolvedValue({ session: { mcp_defaults_skipped: 2 } });
      const client = { service: vi.fn(() => ({ patch, create })) } as unknown as AgorClient;
      const view = renderCanvas(client, triggerBoard);
      await act(async () => {});
      // Put the card first, so its PATCH suspends before branch trigger handling.
      for (const node of [
        { ...currentNode(`card-${card.card_id}`), positionAbsolute: { x: 3010, y: 480 } },
        { ...currentNode(BRANCH_ID), positionAbsolute: { x: 1800, y: 200 } },
      ]) {
        act(() => {
          flowProps?.onNodeDragStart?.({}, node);
          flowProps?.onNodeDrag?.({}, node);
          flowProps?.onNodeDragStop?.({}, node);
        });
      }
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      if (change === 'board-switch') {
        // The old unpinned row remains cached and compares equal unless board
        // identity is explicitly checked. No zone frame can detect this.
        view.rerenderBoard({ ...triggerBoard, board_id: 'board-other' } as Board);
      } else if (change === 'unload' || change === 'unload-reload') {
        // The board unloads (a reconnect) while the batch awaits the card's
        // PATCH; a reload is a new partition lifetime, never the old one.
        act(() => agorStore.getState().resetBoardPartitions());
        if (change === 'unload-reload') act(() => markFixtureLoaded());
      } else if (change !== 'unchanged') {
        act(() =>
          boardObjectPatched({
            ...implementingPlacement,
            zone_id: REVIEWING_ZONE_ID,
            position: { x: 40, y: 260 },
          })
        );
      }
      await act(async () => {
        releaseCard();
      });
      if (change === 'unchanged') {
        expect(patch).toHaveBeenCalledTimes(2);
        if (behavior === 'always_new') {
          expect(create).toHaveBeenCalledTimes(1);
          expect(
            screen.getByText(/2 unavailable default MCP server\(s\) were skipped/)
          ).toBeTruthy();
        } else expect(screen.getByTestId('zone-trigger-picker')).toBeTruthy();
      } else {
        expect(patch, change).toHaveBeenCalledTimes(1);
        expect(create, change).not.toHaveBeenCalled();
        expect(screen.queryByTestId('zone-trigger-picker'), change).toBeNull();
      }
      view.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  );

  it('preserves relative placement when the parent zone moves during a queued drag', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const view = renderCanvas(client, board, { app: false });
    await act(async () => {});
    const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x: 1800, y: 200 } };
    act(() => {
      flowProps?.onNodeDragStart?.({}, node);
      flowProps?.onNodeDrag?.({}, node);
      flowProps?.onNodeDragStop?.({}, node);
    });
    const movedBoard = {
      ...board,
      objects: {
        ...board.objects,
        [IMPLEMENTING_ZONE_ID]: { ...board.objects?.[IMPLEMENTING_ZONE_ID], x: 2100, y: 400 },
      },
    } as Board;
    view.rerenderBoard(movedBoard);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(patch).not.toHaveBeenCalled();
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: implementingPlacement.position,
    });
  });

  it('does not persist a stale drag after same-zone auto-arrange advances', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;

    renderCanvas(client, board, { app: false });
    await act(async () => {});

    const staleBranchNode = {
      ...currentNode(BRANCH_ID),
      position: { x: 60, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, staleBranchNode);
      flowProps?.onNodeDrag?.({}, staleBranchNode);
      flowProps?.onNodeDragStop?.({}, staleBranchNode);
      boardObjectPatched({
        ...implementingPlacement,
        position: { x: 40, y: 260 },
      });
    });
    await act(async () => {});

    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('drops stale local absolute geometry when set_zone moves a branch before a delayed local echo', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;

    const view = renderCanvas(client, board, { app: false });

    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: { x: 20, y: 100 },
    });

    // A local arrange/drag has accepted absolute geometry over the artifact,
    // but its debounced persistence has not completed yet.
    const staleLocalNode = {
      ...currentNode(BRANCH_ID),
      position: { x: 60, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, staleLocalNode);
      flowProps?.onNodeDrag?.({}, staleLocalNode);
      flowProps?.onNodeDragStop?.({}, staleLocalNode);
    });

    // This is the real set_zone production boundary: the board-object event,
    // not a branch/session payload, owns zone_id and the zone-relative position.
    const reviewingPlacement = {
      ...implementingPlacement,
      zone_id: REVIEWING_ZONE_ID,
      position: { x: 20, y: 100 },
    };
    act(() => boardObjectPatched(reviewingPlacement));

    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 20, y: 100 },
      zIndex: 500,
    });

    const reviewZone = board.objects?.[REVIEWING_ZONE_ID];
    const artifact = board.objects?.['artifact-large'];
    expect(reviewZone?.type).toBe('zone');
    expect(artifact?.type).toBe('artifact');
    if (reviewZone?.type !== 'zone' || artifact?.type !== 'artifact') return;
    const authoritativeAbsoluteBottom = reviewZone.y + currentNode(BRANCH_ID).position.y + 180;
    expect(authoritativeAbsoluteBottom).toBeLessThan(artifact.y);

    // A subsequent automatic child arrange changes only the persisted relative
    // position. It is equally authoritative and must not be replaced by the
    // previous animation/drag absolute point.
    const secondStaleLocalNode = {
      ...currentNode(BRANCH_ID),
      position: { x: -1090, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, secondStaleLocalNode);
      flowProps?.onNodeDrag?.({}, secondStaleLocalNode);
      flowProps?.onNodeDragStop?.({}, secondStaleLocalNode);
      boardObjectPatched({
        ...reviewingPlacement,
        position: { x: 40, y: 260 },
      });
    });
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    // Moving the zone itself does not rewrite child placement. React Flow must
    // keep the child relationship and the same relative position across repeat
    // zone moves rather than materializing positionAbsolute into board state.
    const movedBoard = {
      ...board,
      objects: {
        ...board.objects,
        [REVIEWING_ZONE_ID]: {
          ...board.objects?.[REVIEWING_ZONE_ID],
          type: 'zone',
          x: 3050,
          y: 240,
        },
      },
    } as unknown as Board;
    view.rerenderBoard(movedBoard);
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    // Session/task completion traffic may repaint the card, but cannot replace
    // the board-object placement or sever its React Flow parent relationship.
    act(() =>
      sessionPatched({
        session_id: 'session-1',
        branch_id: BRANCH_ID,
        status: 'completed',
        archived: false,
      } as unknown as Session)
    );
    view.rerenderBoard(movedBoard, { branches: [{ ...branch, notes: 'patched' }] });
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    view.unmount();

    // Hydration/remount has no local override state at all and reconstructs the
    // same parent/relative geometry solely from the board-object row.
    renderCanvas(client, movedBoard, { app: false });
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });
  });
});
