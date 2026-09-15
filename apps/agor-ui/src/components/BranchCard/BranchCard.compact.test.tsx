import type { Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import BranchCard from './BranchCard';

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const branch = {
  branch_id: 'branch-1',
  name: 'feature/canvas-density',
  repo_id: 'repo-1',
  path: '/tmp/feature-canvas-density',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo;

function renderCard(props: Partial<React.ComponentProps<typeof BranchCard>> = {}) {
  return render(
    <ConnectionProvider value={connected}>
      <BranchCard
        branch={branch}
        repo={repo}
        sessions={[]}
        userById={new Map()}
        client={null}
        {...props}
      />
    </ConnectionProvider>
  );
}

describe('BranchCard compact toggle', () => {
  it('asks for compact=true when collapsing an expanded worktree card', () => {
    const onToggleCompact = vi.fn();
    renderCard({ onToggleCompact });

    fireEvent.click(screen.getByLabelText('Collapse card'));

    expect(onToggleCompact).toHaveBeenCalledWith('branch-1', true);
  });

  it('asks for compact=false when expanding a collapsed worktree card', () => {
    const onToggleCompact = vi.fn();
    renderCard({ compact: true, onToggleCompact });

    fireEvent.click(screen.getByLabelText('Expand card'));

    expect(onToggleCompact).toHaveBeenCalledWith('branch-1', false);
  });

  it('keeps the toggle reachable while collapsed', () => {
    // Collapsing hides the metadata, notes and session sections; the header
    // action group survives, which is what makes the state recoverable.
    renderCard({ compact: true, onToggleCompact: vi.fn() });

    expect(screen.getByLabelText('Expand card')).toBeTruthy();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
  });

  it('keeps Sessions and density together before Pin and the remaining header actions', () => {
    renderCard({
      compact: true,
      isPinned: true,
      onUnpin: vi.fn(),
      onToggleCompact: vi.fn(),
      onOpenTerminal: vi.fn(),
    });

    const sessions = screen.getByLabelText('Sessions (0)');
    const expand = screen.getByLabelText('Expand card');
    const actions = sessions.closest('.ant-space');
    const buttons = actions?.querySelectorAll('button');

    expect(buttons?.[0]).toBe(sessions);
    expect(buttons?.[1]).toBe(expand);
    expect(sessions.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('renders no toggle when the viewer cannot mutate the board', () => {
    renderCard({ compact: true });

    expect(screen.queryByLabelText('Expand card')).toBeNull();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
  });

  it('omits the board-only density control on the panel and popover surfaces', () => {
    renderCard({ panelMode: true, onToggleCompact: vi.fn() });
    expect(screen.queryByLabelText('Collapse card')).toBeNull();

    renderCard({ inPopover: true, onToggleCompact: vi.fn() });
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
  });

  it('keeps the exposed worktree header actions interactive in a stack', () => {
    const onToggleCompact = vi.fn();
    const onAutoZoneInteraction = vi.fn();
    const { container } = renderCard({
      compact: true,
      onToggleCompact,
      onAutoZoneInteraction,
    });

    const header = container.querySelector('[data-zone-stack-header]');
    const expand = screen.getByLabelText('Expand card');
    expect(header).toContainElement(expand);
    expect(expand).not.toBeDisabled();
    fireEvent.pointerDown(expand);
    fireEvent.click(expand);
    expect(onAutoZoneInteraction).toHaveBeenCalledWith('branch-1');
    expect(onToggleCompact).toHaveBeenCalledWith('branch-1', false);
  });
});
