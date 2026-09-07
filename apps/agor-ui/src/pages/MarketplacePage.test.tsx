import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { theme } from 'antd';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplacePage } from './MarketplacePage';

vi.mock('../components/Marketplace', () => ({
  CatalogTab: () => <div>Catalog content</div>,
  MyServersTab: ({ requestedServerId }: { requestedServerId?: string | null }) => (
    <div>Servers content {requestedServerId && `Drawer ${requestedServerId}`}</div>
  ),
  SessionsTab: () => <div>Sessions content</div>,
  CredentialsTab: ({
    onOpenServerSettings,
  }: {
    onOpenServerSettings?: (serverId: string) => void;
  }) => (
    <div>
      Credentials content
      <button type="button" onClick={() => onOpenServerSettings?.('server-1')}>
        Mock manage server
      </button>
    </div>
  ),
  useMarketplaceOverview: () => ({
    overview: {
      servers: [],
      attachments: [],
      credentials: [
        {
          mcp_server_id: 'server-1',
          server_name: 'server',
          method: 'oauth',
          status: 'active',
        },
      ],
      generated_at: '',
    },
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
      <button type="button" onClick={() => navigate(1)}>
        Browser forward
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
          path="/catalog/*"
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

describe('Catalog tab routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes exactly the four production tabs', () => {
    renderPage(['/catalog']);

    expect(screen.getByRole('heading', { name: 'Catalog' })).toBeVisible();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Catalog',
      'My Servers',
      'Sessions',
      'Credentials (1)',
    ]);
  });

  it('separates the Catalog header icon and label with the theme spacing token', () => {
    renderPage(['/catalog']);

    const headerBrand = screen.getByTestId('catalog-header-brand');
    expect(headerBrand).toHaveStyle({ columnGap: `${theme.getDesignToken().marginXS}px` });
    expect(headerBrand.querySelector('.anticon-shop')).toBeInTheDocument();
    expect(headerBrand).toHaveTextContent('Catalog');
  });

  it('deep-links directly to each tab and normalizes the root to Catalog', async () => {
    renderPage(['/catalog/sessions']);
    expect(screen.getByText('Sessions content')).toBeVisible();
    expect(screen.getByTestId('route')).toHaveTextContent('/catalog/sessions');

    fireEvent.click(screen.getByText('Credentials (1)'));
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/catalog/credentials')
    );
    expect(screen.getByText('Credentials content')).toBeVisible();
    fireEvent.click(screen.getByText('Browser back'));
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/catalog/sessions'));
    expect(screen.getByText('Sessions content')).toBeVisible();
    fireEvent.click(screen.getByText('Browser forward'));
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/catalog/credentials')
    );
    expect(screen.getByText('Credentials content')).toBeVisible();
  });

  it('uses history for tab changes so browser Back restores the previous tab', async () => {
    renderPage(['/catalog/credentials']);
    fireEvent.click(screen.getByText('Sessions'));
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/catalog/sessions'));
    fireEvent.click(screen.getByText('Browser back'));
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/catalog/credentials')
    );
    expect(screen.getByText('Credentials content')).toBeVisible();
  });

  it('routes credential recovery into the Catalog server drawer', async () => {
    renderPage(['/catalog/credentials']);

    fireEvent.click(screen.getByRole('button', { name: 'Mock manage server' }));
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/catalog/servers'));
    expect(screen.getByText(/Drawer server-1/)).toBeVisible();
  });

  it('normalizes an unsupported Catalog subroute without adding a history entry', async () => {
    renderPage(['/catalog/not-a-tab']);
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/catalog'));
    expect(screen.getByText('Catalog content')).toBeVisible();
  });
});
