import type { Branch, Repo, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { theme as antdTheme, ConfigProvider } from 'antd';
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

const branch = {
  branch_id: 'branch-1',
  name: 'feature/canvas-drag',
  repo_id: 'repo-1',
  path: '/tmp/feature-canvas-drag',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo;

describe('BranchCard drag handle', () => {
  it('lets the branch title participate in the header drag handle', () => {
    render(
      <ConnectionProvider value={connected}>
        <BranchCard branch={branch} repo={repo} sessions={[]} userById={new Map()} client={null} />
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
          branch={branch}
          repo={repo}
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

  it('mounts the archive modal on demand and removes it after close', async () => {
    render(
      <ConnectionProvider value={connected}>
        <BranchCard
          branch={branch}
          repo={repo}
          sessions={[]}
          userById={new Map()}
          client={null}
          onArchiveOrDelete={vi.fn()}
        />
      </ConnectionProvider>
    );

    expect(screen.queryByText('Archive or Delete Branch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Archive or delete branch'));
    expect(await screen.findByText('Archive or Delete Branch')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText('Archive or Delete Branch')).not.toBeInTheDocument()
    );
  });

  it('uses a darker primary background surface while a branch session is executing', async () => {
    const runningSession = {
      session_id: 'session-running',
      branch_id: 'branch-1',
      title: 'Running task',
      status: 'running',
      archived: false,
      agentic_tool: 'codex',
      ready_for_prompt: false,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    } as unknown as Session;

    const { container } = render(
      <ConfigProvider
        theme={{
          algorithm: antdTheme.darkAlgorithm,
          token: { colorBgBase: 'rgb(10, 11, 12)', colorPrimaryBg: 'rgb(1, 2, 3)' },
        }}
      >
        <ConnectionProvider value={connected}>
          <BranchCard
            branch={branch}
            repo={repo}
            sessions={[runningSession]}
            userById={new Map()}
            client={null}
          />
        </ConnectionProvider>
      </ConfigProvider>
    );

    expect(container.querySelector('.ant-card')?.getAttribute('style')).toContain(
      'background-color: color-mix(in srgb, rgb(1, 2, 3) 67%, rgb(10, 11, 12));'
    );
    // Session sections hydrate a frame after mount (useProgressiveMount).
    await waitFor(() =>
      expect(container.querySelector('.ant-tree-title > div')).toHaveStyle({ width: '100%' })
    );
  });
});
