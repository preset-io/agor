import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplacePage } from './MarketplacePage';

vi.mock('../components/Marketplace', () => ({
  CatalogTab: () => <div>Catalog content</div>,
  MyServersTab: () => <div>Servers content</div>,
  SessionsTab: () => <div>Sessions content</div>,
  CredentialsTab: () => <div>Credentials content</div>,
  useMarketplaceOverview: () => ({
    overview: { servers: [], attachments: [], credentials: [], generated_at: '' },
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  }),
}));

const RouteState = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="route">{location.pathname}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Browser back
      </button>
    </>
  );
};

function renderPage(entries: string[], index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <RouteState />
      <Routes>
        <Route
          path="/marketplace/*"
          element={
            <MarketplacePage
              client={null}
              connected={false}
              connecting={false}
              authGeneration={0}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('Marketplace tab routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deep-links directly to each tab and normalizes the root to Catalog', async () => {
    renderPage(['/marketplace/sessions']);
    expect(screen.getByText('Sessions content')).toBeVisible();
    expect(screen.getByTestId('route')).toHaveTextContent('/marketplace/sessions');

    fireEvent.click(screen.getByText('Credentials'));
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/marketplace/credentials')
    );
    expect(screen.getByText('Credentials content')).toBeVisible();
  });

  it('uses history for tab changes so browser Back restores the previous tab', async () => {
    renderPage(['/marketplace/credentials']);
    fireEvent.click(screen.getByText('Sessions'));
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/marketplace/sessions')
    );
    fireEvent.click(screen.getByText('Browser back'));
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/marketplace/credentials')
    );
    expect(screen.getByText('Credentials content')).toBeVisible();
  });

  it('redirects the legacy root without adding a history entry', async () => {
    renderPage(['/marketplace']);
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/marketplace/catalog')
    );
    expect(screen.getByText('Catalog content')).toBeVisible();
  });
});
