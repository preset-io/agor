import type { Board, Branch, Repo, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AssistantsTable } from './AssistantsTable';

function renderWithProviders(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'preset-io/agor-assistant',
    name: 'agor-assistant',
    default_branch: 'main',
    ...overrides,
  } as Repo;
}

describe('AssistantsTable', () => {
  it('delegates assistant creation to the shared create flow', () => {
    const onCreateAssistant = vi.fn();
    const repo = makeRepo();

    renderWithProviders(
      <AssistantsTable
        branchById={new Map<string, Branch>()}
        repoById={new Map([[repo.repo_id, repo]])}
        boardById={new Map<string, Board>()}
        sessionsByBranch={new Map<string, Session[]>()}
        userById={new Map<string, User>()}
        onCreateAssistant={onCreateAssistant}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Create Assistant/i }));

    expect(onCreateAssistant).toHaveBeenCalledTimes(1);
  });
});
