import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { ONBOARDING_INTEGRATION_RECOMMENDATIONS as recs } from '../../utils/onboardingGoals';
import {
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
afterEach(cleanup);
type Props = ComponentProps<typeof OnboardingToolsStep>;
function fixture(overrides: Partial<Props> = {}) {
  const api = makeCatalogClient([githubHandoffEntry]);
  const props: Props = {
    client: api.client,
    user: catalogUser,
    connected: true,
    authGeneration: 1,
    kit: [recs.github, recs.linear, recs.notion, recs.firecrawl],
    isSelected: () => true,
    onToggle: vi.fn(),
    onConnected: vi.fn(),
    gatewayIntent: 'prefer-existing',
    onGatewayIntent: vi.fn(),
    ...overrides,
  };
  return { api, props };
}
function Harness({ props, largeType = false }: { props: Props; largeType?: boolean }) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { motion: false, ...(largeType ? { fontSize: 16 } : {}) },
      }}
    >
      <App>
        <MemoryRouter>
          <section
            aria-label="Onboarding tools"
            style={{
              width: 'calc(100% - 32px)',
              maxWidth: 730,
              margin: '16px auto',
              maxHeight: 'calc(100dvh - 32px)',
              overflow: 'auto',
            }}
          >
            <OnboardingToolsStep {...props} />
          </section>
        </MemoryRouter>
      </App>
    </ConfigProvider>
  );
}
function assertGeometry(rows: HTMLElement[]) {
  const first = rows[0].getBoundingClientRect();
  let previousBottom = first.top;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    expect(rect.left).toBeCloseTo(first.left, 1);
    expect(rect.width).toBeCloseTo(first.width, 1);
    expect(rect.top).toBeGreaterThanOrEqual(previousBottom);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    previousBottom = rect.bottom;
  }
}
function assertFlushActions(root: HTMLElement) {
  for (const action of root.querySelectorAll<HTMLElement>('.ant-btn-link, .ant-btn-text')) {
    expect(getComputedStyle(action).paddingLeft).toBe('0px');
    expect(getComputedStyle(action).paddingInlineStart).toBe('0px');
  }
}

describe('Kasia-derived MCP rows — real layout', () => {
  it('uses one full-width provider per row, quieter descriptions, aligned uncropped local logos and flush actions', async () => {
    const { props, api } = fixture();
    vi.mocked(api.client.service('mcp-catalog/readiness').get).mockImplementation(async (key) => ({
      catalog_key: key,
      state: key === githubHandoffEntry.name ? 'bearer_required' : 'oauth_required',
    }));
    render(<Harness props={props} />);
    await screen.findByText('Token required');
    await waitFor(() => expect(screen.getAllByText('Sign in required')).toHaveLength(3));
    const list = screen.getByRole('list', { name: 'Suggested MCP tools' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    assertGeometry(rows);
    assertFlushActions(list);
    let logoLeft: number | undefined;
    for (const row of rows) {
      const name = row.getAttribute('aria-labelledby')!;
      const heading = document.getElementById(name)!;
      const action = within(row).getByRole('button', { name: /through Catalog for/ });
      const [descriptionId, stateId] = action.getAttribute('aria-describedby')!.split(' ');
      const description = document.getElementById(descriptionId)!;
      expect(parseFloat(getComputedStyle(heading).fontSize)).toBe(14);
      expect(parseFloat(getComputedStyle(description).fontSize)).toBe(12);
      expect(getComputedStyle(action).fontSize).toBe(getComputedStyle(description).fontSize);
      expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
      const state = document.getElementById(stateId)!;
      expect(state).toHaveClass('ant-tag', 'ant-tag-warning');
      expect(state).toHaveTextContent(/Token required|Sign in required/);
      expect(getComputedStyle(state).fontSize).toBe(getComputedStyle(description).fontSize);
      expect(state.getBoundingClientRect().left).toBe(description.getBoundingClientRect().left);
      expect(state.getBoundingClientRect().width).toBeLessThan(row.clientWidth);
      expect(action).toHaveAccessibleDescription(/Token required|Sign in required/);
      expect(Number(getComputedStyle(heading.querySelector('strong')!).fontWeight)).toBeGreaterThan(
        Number(getComputedStyle(description).fontWeight)
      );
      expect(getComputedStyle(description).color).not.toBe(getComputedStyle(heading).color);
      expect(document.getElementById(stateId)).toBeInTheDocument();
      const logo = within(row).getByRole('img', { name: /logo$/ });
      const rect = logo.getBoundingClientRect();
      expect(rect.width).toBe(20);
      expect(rect.height).toBe(20);
      logoLeft ??= rect.left;
      expect(rect.left).toBe(logoLeft);
      expect(logo.querySelector('path')?.getAttribute('d')).toBeTruthy();
      expect(row.querySelector('img')).toBeNull(); // Inline assets cannot break on fetch/CSP/offline.
    }
    const github = screen.getByRole('img', { name: 'GitHub logo' });
    expect(github).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet');
    const path = github.querySelector('path')! as SVGGraphicsElement;
    const painted = path.getBBox();
    expect(painted.x).toBeGreaterThanOrEqual(-0.1);
    expect(painted.x + painted.width).toBeLessThanOrEqual(24.1);
    expect(painted.y).toBeGreaterThanOrEqual(-0.1);
    expect(painted.y + painted.height).toBeLessThanOrEqual(24.1);
    expect(screen.getByRole('img', { name: 'Firecrawl logo' })).toHaveClass('anticon');
  });

  it('wraps long names/descriptions in dense lists, respects custom typography and preserves full accessible labels', async () => {
    const longName = 'VeryLongProviderNameWithoutBreaks'.repeat(4);
    const longDescription = 'A long purpose description with space to wrap. '.repeat(5);
    const kit = Array.from({ length: 20 }, (_, i) => ({
      ...recs.github,
      id: i === 0 ? 'constructor' : `missing-${i}`,
      name: `${longName} ${i}`,
      description: longDescription,
    }));
    const { props } = fixture({ kit });
    render(<Harness props={props} largeType />);
    const list = screen.getByRole('list', { name: 'Suggested MCP tools' });
    const rows = within(list).getAllByRole('listitem');
    assertGeometry(rows);
    assertFlushActions(list);
    for (const row of rows) {
      const logo = within(row).getByRole('img');
      expect(logo).toHaveClass('anticon');
      expect(logo.getBoundingClientRect().width).toBe(20);
      const action = within(row).getByRole('button', {
        name: /Sign in through Catalog for VeryLong/,
      });
      expect(action.getAttribute('aria-label')).toContain(longName);
      const desc = document.getElementById(action.getAttribute('aria-describedby')!.split(' ')[0])!;
      expect(getComputedStyle(action).fontSize).toBe(getComputedStyle(desc).fontSize);
      expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
      expect(action).toHaveAccessibleDescription(/A long purpose description/);
    }
    const first = document.getElementById(rows[0].getAttribute('aria-labelledby')!)!;
    expect(getComputedStyle(first).fontSize).toBe('16px');
    const lastCheck = within(rows.at(-1)!).getByRole('checkbox');
    await userEvent.click(lastCheck);
    expect(props.onToggle).toHaveBeenCalledWith('missing-19');
    lastCheck.focus();
    await userEvent.keyboard(' ');
    expect(lastCheck).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Onboarding tools' }).scrollTop).toBeGreaterThan(0);
  });

  it('renders loading/error/retry/ready states from Catalog, without granting access or retaining old tenant state', async () => {
    const { props, api } = fixture({ kit: [recs.github] });
    const get = vi.mocked(api.client.service('mcp-catalog/readiness').get);
    let resolve!: (value: never) => void;
    get.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const view = render(<Harness props={props} />);
    expect(screen.getByText('Checking connection…')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalled());
    view.rerender(<Harness props={{ ...props, connected: false, authGeneration: 2 }} />);
    resolve({ state: 'installed_ready' } as never);
    expect(screen.getByText('Reconnect to check connection')).toBeInTheDocument();
    expect(screen.queryByText('Ready to use')).not.toBeInTheDocument();
    get.mockRejectedValueOnce(new Error('Do not echo provider internals'));
    view.rerender(<Harness props={{ ...props, authGeneration: 3 }} />);
    await screen.findByText('Could not check connection');
    expect(screen.queryByText('Do not echo provider internals')).not.toBeInTheDocument();
    get.mockResolvedValue({ state: 'installed_ready' } as never);
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry connection check for GitHub' })
    );
    await screen.findByText('Ready to use');
    const action = screen.getByRole('button', { name: 'Sign in through Catalog for GitHub' });
    expect(action).toHaveAccessibleDescription(/Ready to use/);
    expect(api.connect).not.toHaveBeenCalled();
  });
});
