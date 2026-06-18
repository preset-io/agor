import type { Board } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import SessionCanvas from './SessionCanvas';

let reactFlowProps: Record<string, unknown> | null = null;

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
  useNodesState: (initialNodes: unknown[]) => [initialNodes, vi.fn(), vi.fn()],
}));

vi.mock('./canvas/AppNode', () => ({
  AppNode: () => <div data-testid="app-node" />,
}));

vi.mock('./canvas/ArtifactNode', () => ({
  ArtifactNode: () => <div data-testid="artifact-node" />,
}));

beforeEach(() => {
  reactFlowProps = null;
});

describe('SessionCanvas zoom shortcuts', () => {
  it('uses Command or Control plus scroll to zoom while preserving scroll panning', () => {
    render(
      <SessionCanvas
        board={null}
        client={null}
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
    );

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
});
