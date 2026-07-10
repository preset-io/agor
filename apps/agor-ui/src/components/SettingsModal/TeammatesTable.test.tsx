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
});
