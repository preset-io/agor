import type { AgorClient, Board, Branch, Repo, User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { userScopeCoverage } from '../../test/userScopeCoverage';
import { TeammatesTable } from './TeammatesTable';

function renderWithProviders(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

afterEach(() => setRealtimeAuthorityScope(null));

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

it('waits for the user scope before saying "No teammates yet", and counts sessions on the server', async () => {
  // Step 3: the store holds only the user scope; nothing global backs this table.
  agorStore.getState().reset();
  setRealtimeAuthorityScope('me:member:1');
  const sessionsFind = vi.fn(async () => [{ id: 'branch-1', session_count: 4 }]);
  const client = {
    service: () => ({ find: sessionsFind, on: () => {}, off: () => {} }),
  } as unknown as AgorClient;
  const { rerender } = renderWithProviders(
    <TeammatesTable
      client={client}
      branchById={new Map()}
      repoById={new Map()}
      boardById={new Map()}
      userById={new Map()}
    />
  );
  expect(screen.queryByText('No teammates yet')).not.toBeInTheDocument();
  act(() => agorStore.setState({ coverage: userScopeCoverage({ teammates: true }) }));
  expect(screen.getByText('No teammates yet')).toBeInTheDocument();

  // U3 delivered a teammate: its delete warning counts sessions with the aggregate.
  const teammate = makeTeammate(1);
  rerender(
    <MemoryRouter>
      <TeammatesTable
        client={client}
        branchById={new Map([[teammate.branch_id, teammate]])}
        repoById={new Map()}
        boardById={new Map()}
        userById={new Map()}
      />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Archive or delete teammate' }));
  expect(sessionsFind).toHaveBeenCalledWith({ query: { group_by: 'branch_id' } });
});
