import type { Branch, Repo, User } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BranchMetadataRow } from './BranchMetadataRow';

const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

const branch = {
  branch_id: 'branch-1',
  repo_id: repo.repo_id,
  name: 'feature/layout',
  created_by: 'user-2',
  issue_url: 'https://github.com/preset-io/agor/issues/1',
  pull_request_url: 'https://github.com/preset-io/agor/pull/2',
} as Branch;

const sam = { user_id: 'user-2', name: 'sam', email: 'sam@example.com', role: 'member' } as User;
const alice = {
  user_id: 'user-3',
  name: 'alice',
  email: 'alice@example.com',
  role: 'member',
} as User;

describe('BranchMetadataRow', () => {
  it('renders the pill, owner badge, and metadata links inline', () => {
    render(
      <BranchMetadataRow branch={branch} repo={repo} owners={[sam]} currentUserId="user-1">
        <div data-testid="branch-pill" />
      </BranchMetadataRow>
    );

    const pill = screen.getByTestId('branch-pill');
    const issue = screen.getByText(/Issue:/);
    const pr = screen.getByText(/PR:/);
    const ownerName = screen.getByText('sam');

    const row = pill.parentElement as HTMLElement;
    for (const item of [issue, pr, ownerName]) {
      expect(row.contains(item)).toBe(true);
    }
    expect(row.firstElementChild).toBe(pill);
    for (const item of [ownerName, issue, pr]) {
      expect(pill.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('shows multiple owners', () => {
    render(
      <BranchMetadataRow branch={branch} repo={repo} owners={[sam, alice]} currentUserId="user-1">
        <div data-testid="branch-pill" />
      </BranchMetadataRow>
    );

    expect(screen.getByText('sam')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('hides owner tag when the sole owner is the current user', () => {
    render(
      <BranchMetadataRow branch={branch} repo={repo} owners={[sam]} currentUserId="user-2">
        <div data-testid="branch-pill" />
      </BranchMetadataRow>
    );

    expect(screen.queryByText('sam')).not.toBeInTheDocument();
  });

  it('omits metadata links the branch does not have and owner tag without owners', () => {
    render(
      <BranchMetadataRow
        branch={{ ...branch, issue_url: undefined, pull_request_url: undefined } as Branch}
        repo={repo}
      >
        <div data-testid="branch-pill" />
      </BranchMetadataRow>
    );

    expect(screen.getByTestId('branch-pill')).toBeInTheDocument();
    expect(screen.queryByText(/Issue:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PR:/)).not.toBeInTheDocument();
    expect(screen.queryByText('sam')).not.toBeInTheDocument();
  });
});
