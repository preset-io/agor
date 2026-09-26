import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useMobileBack } from './useMobileBack';

function Detail() {
  const goBack = useMobileBack('/m');
  return (
    <button type="button" onClick={goBack}>
      Back
    </button>
  );
}

function Origin() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/m/search')}>
      Open search
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/m" element={<div>home</div>} />
        <Route path="/m/board" element={<Origin />} />
        <Route path="/m/search" element={<Detail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('useMobileBack', () => {
  it('returns to the screen the user came from', () => {
    renderAt('/m/board');
    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Open search' })).toBeInTheDocument();
  });

  it('goes to the fallback on a cold deep link instead of leaving the app', () => {
    renderAt('/m/search');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('home')).toBeInTheDocument();
  });
});
