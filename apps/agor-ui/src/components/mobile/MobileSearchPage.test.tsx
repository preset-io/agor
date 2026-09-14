import {
  type Artifact,
  artifactFullscreenPath,
  type Branch,
  type Session,
} from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_RESULTS } from '../GlobalSearch/types';
import { MobileSearchPage } from './MobileSearchPage';

// Reuse the real shared hook's shape but control its output so the test stays
// a unit test (the hook itself is covered by the desktop search suite).
const useGlobalSearchMock = vi.fn();
vi.mock('../GlobalSearch/useGlobalSearch', () => ({
  useGlobalSearch: (input: unknown) => useGlobalSearchMock(input),
}));

describe('MobileSearchPage', () => {
  it('searches globally (ownedByMe:false) and navigates to a tapped session result', () => {
    const session = { session_id: 'sess-1', title: 'Fix the login bug' } as Session;
    useGlobalSearchMock.mockReturnValue({
      results: { ...EMPTY_RESULTS, session: [{ type: 'session', item: session }] },
      hasAnyResults: true,
    });

    render(
      <MemoryRouter initialEntries={['/m/search']}>
        <Routes>
          <Route
            path="/m/search"
            element={<MobileSearchPage onOpenWorkspaceSettings={vi.fn()} onOpenBranch={vi.fn()} />}
          />
          <Route path="/m/session/:id" element={<div>session view</div>} />
        </Routes>
      </MemoryRouter>
    );

    // Global scope: the shared hook is asked with ownedByMe false.
    expect(useGlobalSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownedByMe: false, activeTypeChip: 'all' })
    );

    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), {
      target: { value: 'login' },
    });

    fireEvent.click(screen.getByText('Fix the login bug'));
    expect(screen.getByText('session view')).toBeInTheDocument();
  });

  it.each(['branch', 'teammate'] as const)(
    'opens the matched %s directly, including branches without a board',
    (type) => {
      const branch = { branch_id: 'branch-1', name: 'Fictional project', board_id: null } as Branch;
      const onOpenBranch = vi.fn();
      useGlobalSearchMock.mockReturnValue({
        results: { ...EMPTY_RESULTS, [type]: [{ type, item: branch }] },
        hasAnyResults: true,
      });
      render(
        <MemoryRouter initialEntries={['/m/search']}>
          <MobileSearchPage onOpenWorkspaceSettings={vi.fn()} onOpenBranch={onOpenBranch} />
        </MemoryRouter>
      );
      fireEvent.change(screen.getByPlaceholderText(/Search sessions/), {
        target: { value: 'project' },
      });
      fireEvent.keyDown(screen.getByRole('button', { name: 'Fictional project' }), {
        key: 'Enter',
      });
      expect(onOpenBranch).toHaveBeenCalledWith(branch.branch_id);
    }
  );

  it('opens an artifact itself rather than its parent board', () => {
    const artifact = {
      artifact_id: '018f0000-0000-7000-8000-000000000001',
      name: 'Fictional chart',
    } as Artifact;
    useGlobalSearchMock.mockReturnValue({
      results: {
        ...EMPTY_RESULTS,
        artifact: [{ type: 'artifact', item: artifact, parentBranch: { board_id: 'board-1' } }],
      },
      hasAnyResults: true,
    });
    render(
      <MemoryRouter initialEntries={['/m/search']}>
        <Routes>
          <Route
            path="/m/search"
            element={<MobileSearchPage onOpenWorkspaceSettings={vi.fn()} onOpenBranch={vi.fn()} />}
          />
          <Route
            path={artifactFullscreenPath(artifact.artifact_id)}
            element={<div>Artifact content</div>}
          />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), {
      target: { value: 'chart' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fictional chart' }));
    expect(screen.getByText('Artifact content')).toBeInTheDocument();
  });

  it('shows the at-rest hint before the query is long enough', () => {
    useGlobalSearchMock.mockReturnValue({ results: EMPTY_RESULTS, hasAnyResults: false });
    render(
      <MemoryRouter initialEntries={['/m/search']}>
        <MobileSearchPage onOpenWorkspaceSettings={vi.fn()} onOpenBranch={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Find sessions, branches, boards/)).toBeInTheDocument();
  });
});
