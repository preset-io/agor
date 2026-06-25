import type { Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import {
  REACT_FLOW_DRAG_HANDLE_SELECTOR,
  REACT_FLOW_NO_DRAG_CLASS,
} from '../../utils/reactFlowDragClasses';
import BranchCard from './BranchCard';

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

describe('BranchCard drag handle', () => {
  it('lets the branch title participate in the header drag handle', () => {
    render(
      <ConnectionProvider value={connected}>
        <BranchCard
          branch={
            {
              branch_id: 'branch-1',
              name: 'feature/canvas-drag',
              repo_id: 'repo-1',
              path: '/tmp/feature-canvas-drag',
              filesystem_status: 'ready',
              archived: false,
            } as unknown as Branch
          }
          repo={{ repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo}
          sessions={[]}
          userById={new Map()}
          client={null}
        />
      </ConnectionProvider>
    );

    const title = screen.getByText('feature/canvas-drag');

    expect(title.closest(REACT_FLOW_DRAG_HANDLE_SELECTOR)).not.toBeNull();
    expect(title.closest(`.${REACT_FLOW_NO_DRAG_CLASS}`)).toBeNull();
  });

  it('opens terminals with structured branch id routing instead of raw cd input', () => {
    const onOpenTerminal = vi.fn();
    render(
      <ConnectionProvider value={connected}>
        <BranchCard
          branch={
            {
              branch_id: 'branch-1',
              name: 'feature/canvas-drag',
              repo_id: 'repo-1',
              path: '/tmp/feature-canvas-drag',
              filesystem_status: 'ready',
              archived: false,
            } as unknown as Branch
          }
          repo={{ repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo}
          sessions={[]}
          userById={new Map()}
          client={null}
          onOpenTerminal={onOpenTerminal}
        />
      </ConnectionProvider>
    );

    fireEvent.click(screen.getByTitle('Open terminal in branch directory'));

    expect(onOpenTerminal).toHaveBeenCalledWith([], 'branch-1');
  });
});
