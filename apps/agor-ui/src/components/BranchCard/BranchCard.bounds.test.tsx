import type { Branch, Repo, Session } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { COLLAPSED_BRANCH_NODES_STORAGE_KEY } from '../../utils/collapsedBranchNodes';
import BranchCard from './BranchCard';

// Hold the actual card in its deferred state, as when earlier cards consume
// the board's progressive-mount slots during the initial fit-to-view.
vi.mock('../../hooks/useProgressiveMount', () => ({ useProgressiveMount: () => false }));

beforeEach(() => localStorage.clear());

it.each([
  { count: 2, collapsed: false, height: 138 },
  { count: 1001, collapsed: false, height: 454 },
  { count: 1001, collapsed: true, height: 54 },
])(
  'bounds the deferred shell for $count sessions (collapsed: $collapsed)',
  ({ count, collapsed, height }) => {
    const branch = {
      branch_id: 'branch-1',
      name: 'feature/bounded-sessions',
      repo_id: 'repo-1',
      filesystem_status: 'ready',
    } as Branch;
    const sessions = Array.from({ length: count }, (_, index) => ({
      session_id: `session-${index}`,
      branch_id: branch.branch_id,
      status: 'idle',
      agentic_tool: 'codex',
      archived: false,
    })) as Session[];
    if (collapsed) {
      localStorage.setItem(
        COLLAPSED_BRANCH_NODES_STORAGE_KEY,
        JSON.stringify({ [branch.branch_id]: { sections: ['sessions'] } })
      );
    }

    render(
      <BranchCard
        branch={branch}
        repo={{ repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo}
        sessions={sessions}
        userById={new Map()}
        client={null}
      />
    );

    expect(screen.getByText(`Sessions (${count})`).parentElement).toHaveStyle({
      minHeight: `${height}px`,
    });
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  }
);
