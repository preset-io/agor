import type { Board, Branch, Repo, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TeammatesTable } from './TeammatesTable';

function renderWithProviders(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'preset-io/agor-teammate',
    name: 'agor-teammate',
    default_branch: 'main',
    ...overrides,
  } as Repo;
}

function makeTeammate(index: number): Branch {
  return {
    branch_id: `branch-${index}`,
    repo_id: 'repo-1',
    name: `teammate-${index}`,
    created_by: 'user-1',
    archived: false,
    custom_context: {
      teammate: { kind: 'teammate', displayName: `Teammate ${index}` },
    },
  } as unknown as Branch;
}

/** antd only auto-renders the size changer once the row count exceeds 50. */
function makeTeammates(count: number): Map<string, Branch> {
  const branchById = new Map<string, Branch>();
  for (let i = 0; i < count; i += 1) {
    const teammate = makeTeammate(i);
    branchById.set(teammate.branch_id, teammate);
  }
  return branchById;
}

describe('TeammatesTable', () => {
  it('delegates teammate creation to the shared create flow', () => {
    const onCreateTeammate = vi.fn();
    const repo = makeRepo();

    renderWithProviders(
      <TeammatesTable
        branchById={new Map<string, Branch>()}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map<string, Board>()}
        sessionsByBranch={new Map<string, Session[]>()}
        userById={new Map<string, User>()}
        onCreateTeammate={onCreateTeammate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Create AI teammate/i }));

    expect(onCreateTeammate).toHaveBeenCalledTimes(1);
  });

  it('applies a page size picked from the pagination size changer', async () => {
    const repo = makeRepo();

    const { container } = renderWithProviders(
      <TeammatesTable
        branchById={makeTeammates(60)}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map<string, Board>()}
        sessionsByBranch={new Map<string, Session[]>()}
        userById={new Map<string, User>()}
      />
    );

    expect(container.querySelectorAll('.ant-table-row')).toHaveLength(10);

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Page Size' }));
    fireEvent.click(await screen.findByTitle('20 / page'));

    expect(container.querySelectorAll('.ant-table-row')).toHaveLength(20);
  });
});

it('resets the inventory page on search and distinguishes primary owner from creator', () => {
  const branches = makeTeammates(21);
  const user = {
    user_id: 'user-1',
    name: 'Original creator',
    email: 'creator@example.test',
  } as User;
  renderWithProviders(
    <TeammatesTable
      branchById={branches}
      repoById={new Map()}
      boardById={new Map()}
      sessionsByBranch={new Map()}
      userById={new Map([[user.user_id, user]])}
    />
  );
  fireEvent.click(screen.getByTitle('3'));
  fireEvent.change(screen.getByPlaceholderText('Search teammates...'), {
    target: { value: 'Teammate 20' },
  });
  expect(screen.getByText('Teammate 20')).toBeInTheDocument();
  expect(screen.queryByText('Original creator')).not.toBeInTheDocument();
  expect(screen.getByText('Unavailable user')).toBeInTheDocument();
});

it('searches tokens across teammate, board and email-only owner using the shared search pattern', () => {
  const branch = {
    ...makeTeammate(1),
    board_id: 'board-1',
    primary_owner_user_id: 'owner-1',
  } as Branch;
  renderWithProviders(
    <TeammatesTable
      branchById={new Map([[branch.branch_id, branch]])}
      repoById={new Map()}
      boardById={new Map([['board-1', { board_id: 'board-1', name: 'Engineering' } as Board]])}
      sessionsByBranch={new Map()}
      userById={new Map([['owner-1', { user_id: 'owner-1', email: 'owner@example.test' } as User]])}
    />
  );
  fireEvent.change(screen.getByPlaceholderText('Search teammates...'), {
    target: { value: 'Teammate Engineering owner@example.test' },
  });
  expect(screen.getAllByRole('row')[1]).toHaveTextContent('Teammate 1');
  fireEvent.change(screen.getByPlaceholderText('Search teammates...'), {
    target: { value: 'Teammate Finance owner@example.test' },
  });
  expect(screen.queryByRole('button', { name: 'Edit teammate' })).not.toBeInTheDocument();
});
