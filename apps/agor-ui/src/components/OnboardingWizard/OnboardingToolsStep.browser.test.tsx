import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import {
  catalogEntry,
  catalogUser,
  githubHandoffEntry,
  makeCatalogClient,
} from '../Marketplace/MCPCatalogModal.test-fixtures';
import { OnboardingToolsStep } from './OnboardingToolsStep';

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => {
  agorStore.setState({ ...EMPTY_MAPS });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entries = [
  githubHandoffEntry,
  ...['Notion', 'Linear', 'Atlassian Rovo with a very long product name', 'Sentry'].map(
    (title) => ({ ...catalogEntry, name: `com.${title.split(' ')[0].toLowerCase()}/mcp`, title })
  ),
];

function Harness({ api }: { api: ReturnType<typeof makeCatalogClient> }) {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <App>
        <MemoryRouter>
          <section
            aria-label="Onboarding tools"
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: 'calc(100% - 32px)',
              maxWidth: 666,
              height: 560,
              margin: '16px auto',
            }}
          >
            <OnboardingToolsStep
              client={api.client}
              user={catalogUser}
              connected
              authGeneration={1}
              onConnected={vi.fn()}
            />
          </section>
        </MemoryRouter>
      </App>
    </ConfigProvider>
  );
}

describe('onboarding tools wall in Chromium', () => {
  it('keeps the toolbar on one row and lays tiles out in 3 columns (2 on narrow phones)', async () => {
    render(<Harness api={makeCatalogClient(entries)} />);
    const github = await screen.findByRole('button', { name: 'GitHub: view details' });

    const search = screen.getByPlaceholderText('Search tools').getBoundingClientRect();
    const category = screen
      .getByRole('combobox', { name: 'Filter by category' })
      .closest('.ant-select')!
      .getBoundingClientRect();
    expect(Math.abs(search.top - category.top)).toBeLessThan(8);
    expect(category.right).toBeLessThanOrEqual(
      screen.getByRole('region', { name: 'Onboarding tools' }).getBoundingClientRect().right + 0.5
    );

    const tiles = entries.map((entry) =>
      screen.getByRole('button', { name: `${entry.title}: view details` })
    );
    const firstRowTop = Math.min(...tiles.map((tile) => tile.getBoundingClientRect().top));
    const columns = tiles.filter(
      (tile) => Math.abs(tile.getBoundingClientRect().top - firstRowTop) < 1
    ).length;
    expect(columns).toBe(window.innerWidth <= 480 ? 2 : 3);
    // Short names never truncate; tiles show no description.
    expect(within(github).getByText('GitHub').scrollWidth).toBeLessThanOrEqual(
      within(github).getByText('GitHub').clientWidth
    );
    expect(screen.queryByText(githubHandoffEntry.benefit)).not.toBeInTheDocument();
  });

  it('opens the existing Catalog drawer from a tile and restores focus on close', async () => {
    const api = makeCatalogClient(entries);
    render(<Harness api={api} />);
    const tile = await screen.findByRole('button', { name: 'GitHub: view details' });
    await userEvent.click(tile);

    const dialog = await screen.findByRole('dialog', { name: /GitHub/ });
    await within(dialog).findByPlaceholderText('Paste your GitHub bearer access token');
    expect(document.querySelectorAll('.ant-drawer')).toHaveLength(1);
    expect(api.client.service('mcp-catalog/start-session').create).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(tile).toHaveFocus());
  });
});
