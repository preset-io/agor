import type { Session } from '@agor-live/client';
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
            element={<MobileSearchPage onOpenWorkspaceSettings={vi.fn()} />}
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

  it('shows the at-rest hint before the query is long enough', () => {
    useGlobalSearchMock.mockReturnValue({ results: EMPTY_RESULTS, hasAnyResults: false });
    render(
      <MemoryRouter initialEntries={['/m/search']}>
        <MobileSearchPage onOpenWorkspaceSettings={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Find sessions, branches, boards/)).toBeInTheDocument();
  });
});
