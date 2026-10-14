import { cleanup, configure, render, screen, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import type { RequestedCatalogTool } from '../../utils/teammateBootstrapPrompt';
import {
  catalogEntry,
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
  const [picked, setPicked] = useState<RequestedCatalogTool[]>([]);
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <App>
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
            connected
            hasTeammate
            picked={picked}
            onPickedChange={setPicked}
          />
        </section>
      </App>
    </ConfigProvider>
  );
}

describe('onboarding tools wall in Chromium', () => {
  it('keeps the toolbar on one row and lays tiles out in 3 columns (2 on narrow phones)', async () => {
    render(<Harness api={makeCatalogClient(entries)} />);
    const github = await screen.findByRole('button', { name: 'GitHub' });

    const search = screen.getByPlaceholderText('Search tools').getBoundingClientRect();
    const category = screen
      .getByRole('combobox', { name: 'Filter by category' })
      .closest('.ant-select')!
      .getBoundingClientRect();
    expect(Math.abs(search.top - category.top)).toBeLessThan(8);
    expect(category.right).toBeLessThanOrEqual(
      screen.getByRole('region', { name: 'Onboarding tools' }).getBoundingClientRect().right + 0.5
    );

    const tiles = entries.map((entry) => screen.getByRole('button', { name: entry.title }));
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

  it('toggles a pick with a primary-colour outline and opens no drawer', async () => {
    render(<Harness api={makeCatalogClient(entries)} />);
    const github = await screen.findByRole('button', { name: 'GitHub' });
    const border = () => getComputedStyle(github).borderTopColor;
    const unpicked = border();

    await userEvent.click(github);
    expect(github).toHaveAttribute('aria-pressed', 'true');
    await userEvent.hover(screen.getByPlaceholderText('Search tools'));
    const { colorPrimary } = theme.getDesignToken({ algorithm: theme.darkAlgorithm });
    const probe = document.createElement('span');
    probe.style.color = colorPrimary;
    document.body.append(probe);
    expect(border()).toBe(getComputedStyle(probe).color);
    probe.remove();
    expect(document.querySelector('.ant-drawer')).toBeNull();

    await userEvent.click(github);
    expect(github).toHaveAttribute('aria-pressed', 'false');
    await userEvent.hover(screen.getByPlaceholderText('Search tools'));
    expect(border()).toBe(unpicked);
  });
});
