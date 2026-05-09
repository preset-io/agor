import { render } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionCanvas from './SessionCanvas';

let reactFlowProps: Record<string, unknown> | null = null;

vi.mock('reactflow', () => ({
  Background: () => <div data-testid="react-flow-background" />,
  ControlButton: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button type="button" onClick={onClick}>
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
        sessionsByWorktree={new Map()}
        userById={new Map()}
        repoById={new Map()}
        worktrees={[]}
        worktreeById={new Map()}
        boardObjectById={new Map()}
        commentById={new Map()}
        cardById={new Map()}
      />
    );

    expect(reactFlowProps?.panOnScroll).toBe(true);
    expect(reactFlowProps?.zoomActivationKeyCode).toEqual(['Meta', 'Control']);
  });
});
