import type { Board, Branch, Repo, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { StandaloneSettingsDrillProvider } from './SettingsDrill';
import { TeammatesTable } from './TeammatesTable';

// TeammateTab is a heavy form (repo ensure, agent config); stub it — the point
// here is that "Create AI teammate" opens the drill-in in place.
vi.mock('../CreateDialog/tabs/TeammateTab', () => ({
  TeammateTab: () => <div data-testid="teammate-tab">teammate form</div>,
}));

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <AntdApp>
        <StandaloneSettingsDrillProvider>{ui}</StandaloneSettingsDrillProvider>
      </AntdApp>
    </MemoryRouter>
  );
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

function renderTable(onCreateTeammate = vi.fn()) {
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
  return { onCreateTeammate };
}

describe('TeammatesTable', () => {
  it('opens the create teammate form in place (does not leave Settings)', () => {
    const { onCreateTeammate } = renderTable();

    fireEvent.click(screen.getByRole('button', { name: /Create AI teammate/i }));

    // Drill-in opened with the teammate form — the callback fires on Save, not open.
    expect(screen.getByRole('heading', { name: /New AI teammate/i })).toBeInTheDocument();
    expect(screen.getByTestId('teammate-tab')).toBeInTheDocument();
    expect(onCreateTeammate).not.toHaveBeenCalled();
  });
});
