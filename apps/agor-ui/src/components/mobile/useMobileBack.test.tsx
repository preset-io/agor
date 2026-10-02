import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
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

function RedirectedPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const goBack = useMobileBack('/m');
  // A redirect like the device router's: it replaces the deep-linked entry, giving it a new key.
  useEffect(() => {
    if (pathname === '/teammates') navigate('/m/teammates', { replace: true });
  }, [navigate, pathname]);
  return (
    <>
      <span data-testid="path">{pathname}</span>
      <button type="button" onClick={goBack}>
        Back
      </button>
    </>
  );
}

describe('useMobileBack with the browser router', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('goes to the fallback after a redirected deep link instead of leaving the app', async () => {
    window.history.replaceState(null, '', '/teammates');
    render(
      <BrowserRouter>
        <RedirectedPage />
      </BrowserRouter>
    );
    expect(screen.getByTestId('path')).toHaveTextContent('/m/teammates');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Back' })));
    expect(screen.getByTestId('path')).toHaveTextContent('/m');
    expect(window.location.pathname).toBe('/m');
  });
});
