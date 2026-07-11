import type { Branch, Link, Repo } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { makeTestLink } from '../Links/testUtils';
import BranchCard from './BranchCard';

vi.mock('./BranchSessionSections', () => ({
  BranchSessionSections: () => <div data-testid="branch-session-sections" />,
}));

const branch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'feature/links',
  path: '/tmp/feature-links',
  filesystem_status: 'ready',
  archived: false,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
} as unknown as Branch;

const repo = {
  repo_id: 'repo-1',
  slug: 'preset-io/agor',
} as unknown as Repo;

const makeLink = (overrides: Partial<Link> = {}) =>
  makeTestLink({
    branch_id: 'branch-1',
    session_id: null,
    url: 'https://example.com/runbook',
    is_pinned: true,
    title: 'Runbook',
    ...overrides,
  });

describe('BranchCard pinned links', () => {
  beforeEach(() => {
    const pinned = makeLink();
    const unpinned = makeLink({
      link_id: 'link-2' as Link['link_id'],
      is_pinned: false,
      title: 'Draft',
    });
    agorStore.setState({
      ...EMPTY_MAPS,
      linksByBranch: new Map([['branch-1', [pinned, unpinned]]]),
      linkById: new Map([
        [pinned.link_id, pinned],
        [unpinned.link_id, unpinned],
      ]),
    });
  });

  it('renders pinned branch links from the centralized branch selector only', () => {
    render(
      <MemoryRouter>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <BranchCard
            branch={branch}
            repo={repo}
            sessions={[]}
            userById={new Map()}
            client={null}
          />
        </ConnectionProvider>
      </MemoryRouter>
    );

    expect(screen.getByText('Runbook')).toBeInTheDocument();
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
  });
});
