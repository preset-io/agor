import type { AgorClient, Board } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import SessionCanvas from './SessionCanvas';

let reactFlowProps: Record<string, unknown> | null = null;
// Stable spy for the `useNodesState` setter (onNodesChangeInternal). Lets tests
// assert that onNodesChange forwards changes to React Flow's internal handler.
const onNodesChangeInternalSpy = vi.fn();
// Stable spy for the raw setNodes setter (setNodesUnsafe). Lets tests inspect
// the functional updater passed when zIndex needs to change for zone selection.
const setNodesUnsafeSpy = vi.fn();

vi.mock('reactflow', () => ({
  Background: () => <div data-testid="react-flow-background" />,
  ControlButton: ({
    children,
    onClick,
    ...props
  }: {
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Controls: ({ children }: { children?: ReactNode }) => (
    <div data-testid="react-flow-controls">{children}</div>
  ),
  MiniMap: () => <div data-testid="react-flow-minimap" />,
  ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
    reactFlowProps = props;
    return <div data-testid="react-flow">{props.children}</div>;
  },
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useEdgesState: (initialEdges: unknown[]) => [initialEdges, vi.fn(), vi.fn()],
  useNodesState: (initialNodes: unknown[]) => [
    initialNodes,
    setNodesUnsafeSpy,
    onNodesChangeInternalSpy,
  ],
}));

vi.mock('./canvas/AppNode', () => ({
  AppNode: () => <div data-testid="app-node" />,
}));

vi.mock('./canvas/ArtifactNode', () => ({
  ArtifactNode: () => <div data-testid="artifact-node" />,
}));

beforeEach(() => {
  reactFlowProps = null;
  onNodesChangeInternalSpy.mockClear();
  setNodesUnsafeSpy.mockClear();
});

describe('SessionCanvas zoom shortcuts', () => {
  it('uses Command or Control plus scroll to zoom while preserving scroll panning', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);

    expect(reactFlowProps?.panOnScroll).toBe(true);
    expect(reactFlowProps?.zoomActivationKeyCode).toEqual(['Meta', 'Control']);
  });

  it('opens the markdown note modal when the markdown tool clicks a board node', async () => {
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
          board={
            {
              board_id: 'board-1',
              name: 'Board',
              slug: 'board',
              objects: {
                'zone-1': {
                  type: 'zone',
                  x: 0,
                  y: 0,
                  width: 1200,
                  height: 900,
                  label: 'Large Zone',
                  borderColor: '#d9d9d9',
                  backgroundColor: '#d9d9d91a',
                },
              },
              created_at: '2026-06-18T00:00:00.000Z',
              last_updated: '2026-06-18T00:00:00.000Z',
              created_by: 'user-1',
              url: 'http://localhost/ui/b/board/',
              archived: false,
            } as unknown as Board
          }
          client={null}
          branches={[]}
        />
      </ConnectionProvider>
    );

    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Markdown Note' }));
    await waitFor(() => expect(reactFlowProps?.className).toBe('tool-mode-markdown'));

    act(() => {
      (reactFlowProps?.onNodeClick as (event: unknown, node: unknown) => void)?.(
        { clientX: 240, clientY: 320 },
        { id: 'zone-1', type: 'zone' }
      );
    });

    expect(await screen.findByText('Add Markdown Note')).toBeInTheDocument();
  });

  describe('onNodesChange zone resize via O(1) getNode lookup', () => {
    const zoneBoard = {
      board_id: 'board-1',
      name: 'Board',
      slug: 'board',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 1200,
          height: 900,
          label: 'Large Zone',
          borderColor: '#d9d9d9',
          backgroundColor: '#d9d9d91a',
        },
      },
      created_at: '2026-06-18T00:00:00.000Z',
      last_updated: '2026-06-18T00:00:00.000Z',
      created_by: 'user-1',
      url: 'http://localhost/ui/b/board/',
      archived: false,
    } as unknown as Board;

    // Render the canvas, then wire up React Flow's instance via onInit with a
    // controlled `getNode`. In controlled mode React Flow returns the exact node
    // objects we pass, so dims live on `node.style` — same source the handler
    // reads. The zone node carries 1200x900 to drive the no-op-resize check.
    function renderCanvas(client: AgorClient | null) {
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
            board={zoneBoard}
            client={client}
            sessionById={new Map()}
            sessionsByBranch={new Map()}
            userById={new Map()}
            repoById={new Map()}
            branches={[]}
            branchById={new Map()}
            boardObjectById={new Map()}
            boardObjectsByBoardId={new Map()}
            commentById={new Map()}
            cardById={new Map()}
          />
        </ConnectionProvider>
      );

      const zoneNode = {
        id: 'zone-1',
        type: 'zone',
        position: { x: 0, y: 0 },
        style: { width: 1200, height: 900 },
      };
      const getNode = vi.fn((id: string) => (id === 'zone-1' ? zoneNode : undefined));
      act(() => {
        (reactFlowProps?.onInit as (instance: unknown) => void)?.({
          getNode,
          screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
          fitView: vi.fn(),
        });
      });

      const onNodesChange = reactFlowProps?.onNodesChange as (changes: unknown[]) => void;
      return { getNode, onNodesChange };
    }

    function makeClient() {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      return { client, patch };
    }

    it('forwards non-dimensions changes through onNodesChangeInternal', () => {
      const { onNodesChange } = renderCanvas(null);
      const changes = [{ type: 'position', id: 'zone-1', position: { x: 5, y: 5 } }];

      act(() => onNodesChange(changes));

      expect(onNodesChangeInternalSpy).toHaveBeenCalledWith(changes);
    });

    it('skips persisting a no-op resize within the 1px tolerance', async () => {
      const { client, patch } = makeClient();
      const { getNode, onNodesChange } = renderCanvas(client);

      vi.useFakeTimers();
      // Incoming dims sit within 1px of the node's current 1200x900 → no-op.
      act(() =>
        onNodesChange([
          { type: 'dimensions', id: 'zone-1', dimensions: { width: 1200.4, height: 899.6 } },
        ])
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      vi.useRealTimers();

      expect(getNode).toHaveBeenCalledWith('zone-1'); // real lookup HIT
      expect(patch).not.toHaveBeenCalled(); // no debounce-persist for a no-op
      expect(onNodesChangeInternalSpy).toHaveBeenCalled(); // change still forwarded
    });

    it('debounce-persists a real resize via a boards patch after 500ms', async () => {
      const { client, patch } = makeClient();
      const { onNodesChange } = renderCanvas(client);

      vi.useFakeTimers();
      act(() =>
        onNodesChange([
          { type: 'dimensions', id: 'zone-1', dimensions: { width: 1000, height: 700 } },
        ])
      );

      // Nothing persisted until the 500ms debounce elapses.
      expect(patch).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      vi.useRealTimers();

      expect(client.service).toHaveBeenCalledWith('boards');
      expect(patch).toHaveBeenCalledWith(
        'board-1',
        expect.objectContaining({
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({ type: 'zone', width: 1000, height: 700 }),
        })
      );
    });

    it('treats a dimensions change for an unknown id as a safe no-op miss', () => {
      const { client, patch } = makeClient();
      const { getNode, onNodesChange } = renderCanvas(client);

      expect(() =>
        act(() =>
          onNodesChange([
            { type: 'dimensions', id: 'missing-node', dimensions: { width: 10, height: 10 } },
          ])
        )
      ).not.toThrow();

      expect(getNode).toHaveBeenCalledWith('missing-node');
      expect(patch).not.toHaveBeenCalled();
    });

    describe('zone select zIndex', () => {
      // The setNodes wrapper in SessionCanvas calls setNodesUnsafe with a
      // functional updater. We capture that updater and call it with mock nodes
      // to assert what the zIndex transition produces.
      function getLastSetNodesUpdater() {
        const calls = setNodesUnsafeSpy.mock.calls;
        const last = calls.at(-1);
        return last?.[0] as ((nodes: unknown[]) => unknown[]) | undefined;
      }

      it('raises zone zIndex to 101 when the zone is selected', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 100 }];
        const result = updater!(mockNodes) as typeof mockNodes;
        expect(result[0].zIndex).toBe(101);
      });

      it('restores zone zIndex to 100 when the zone is deselected', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: false }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 101 }];
        const result = updater!(mockNodes) as typeof mockNodes;
        expect(result[0].zIndex).toBe(100);
      });

      it('returns the same node array reference when no zone is in the select changes', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        // Select a non-zone node (e.g. a branch) — zone-1 is untouched
        act(() => onNodesChange([{ type: 'select', id: 'branch-999', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 100 }];
        const result = updater!(mockNodes);
        // Guard returns currentNodes unchanged so React can bail out on re-render
        expect(result).toBe(mockNodes);
      });

      it('returns the same node array reference when zone zIndex is already current', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 101 }];
        const result = updater!(mockNodes);
        // No-op select echoes from React Flow must not allocate a fresh nodes
        // array, or controlled ReactFlow can re-emit selection indefinitely.
        expect(result).toBe(mockNodes);
      });
    });
  });
});
