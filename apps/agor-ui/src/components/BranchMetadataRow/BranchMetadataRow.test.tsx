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

const userById = new Map<string, User>([
  ['user-2', { user_id: 'user-2', name: 'sam', email: 'sam@example.com' } as User],
]);

describe('BranchMetadataRow', () => {
  it('renders the pill and metadata links inline in a single wrapping row', () => {
    render(
      <BranchMetadataRow branch={branch} repo={repo} userById={userById} currentUserId="user-1">
        <div data-testid="branch-pill" />
      </BranchMetadataRow>
    );

    const pill = screen.getByTestId('branch-pill');
    const issue = screen.getByText(/Issue:/);
    const pr = screen.getByText(/PR:/);
    const createdBy = screen.getByText('sam');

    // All items share ONE row container (no stacked second row), pill first.
    const row = pill.parentElement as HTMLElement;
    for (const item of [issue, pr, createdBy]) {
      expect(row.contains(item)).toBe(true);
    }
    expect(row.firstElementChild).toBe(pill);
    // Pill precedes every metadata link in document order.
    for (const item of [createdBy, issue, pr]) {
      expect(pill.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('omits metadata links the branch does not have and created-by without a user map', () => {
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
