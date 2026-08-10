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
