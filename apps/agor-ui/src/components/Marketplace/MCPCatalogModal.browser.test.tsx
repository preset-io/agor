import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CatalogHarness, makeCatalogClient } from './MCPCatalogModal.test-fixtures';

checkBrowserSanity();
// Native Playwright input must commit mousedown before focus/mouseup. Wrapping
// the complete sequence in React act batches those events and breaks AntD Tabs.
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

async function findCatalogModal() {
  // AntD deliberately uses the same aria ID for all overlays in NODE_ENV=test.
  // Scope by the actual title instead of that test-only ambiguous ID.
  const title = await screen.findByText('MCP Catalog', { selector: 'span' });
  const modal = title.closest<HTMLElement>('[role="dialog"]');
  if (!modal) throw new Error('Catalog title must belong to a modal dialog');
  return modal;
}

async function activateTab(name: RegExp) {
  const tab = screen.getByRole('tab', { name });
  act(() => tab.focus());
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'));
}

function expectInViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
}

describe('MCP Catalog real Chromium flows', () => {
  it('opens from the header with Enter/Space, searches, closes with Escape, tears down and restores focus', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    const trigger = screen.getByRole('button', { name: 'Open MCP Catalog' });
    // Header may horizontally overflow on phone; scroll the actual entry into view.
    trigger.scrollIntoView();
    act(() => trigger.focus());
    await userEvent.keyboard('{Enter}');
    const modal = await findCatalogModal();
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    expectInViewport(modal);
    const height = modal.offsetHeight;
    const search = within(modal).getByPlaceholderText(/Search/);
    await userEvent.fill(search, 'no-such-provider');
    await screen.findByText(/No.*match/i);
    await userEvent.clear(search);
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    await activateTab(/Credentials/);
    expect(modal.offsetHeight).toBe(height);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(api.listenerCount()).toBe(0));
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.keyboard(' ');
    await findCatalogModal();
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('route')).toHaveTextContent('/');
  });

  it('opens from session browse and keyboard no-match action, closes the disclosure and restores its stable trigger', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    const trigger = screen.getByRole('button', { name: /^MCP servers\./ });
    await userEvent.click(trigger);
    let disclosure = screen.getByRole('dialog', { name: 'Session MCP servers' });
    await userEvent.click(within(disclosure).getByRole('button', { name: 'Open MCP Catalog' }));
    expect(screen.queryByRole('dialog', { name: 'Session MCP servers' })).not.toBeInTheDocument();
    let modal = await findCatalogModal();
    await activateTab(/Sessions/);
    await userEvent.click(within(modal).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    disclosure = screen.getByRole('dialog', { name: 'Session MCP servers' });
    await userEvent.fill(within(disclosure).getByRole('combobox'), 'missing-server');
    const browse = await screen.findByRole('button', {
      name: 'Browse the MCP Catalog for all available MCPs',
    });
    // The no-results action remains in the native keyboard tab order.
    await userEvent.tab();
    expect(browse).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    modal = await findCatalogModal();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await activateTab(/My Servers/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => expect(api.listenerCount()).toBe(0));
  });

  it('Connect then Start session removes the portaled detail drawer before the destination renders', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open MCP Catalog' }));
    const card = await screen.findByRole('button', { name: 'Open DeepWiki' });
    await userEvent.click(card);
    const drawer = await screen.findByRole('dialog', { name: /DeepWiki/ });
    await userEvent.click(within(drawer).getByRole('checkbox', { name: /I understand/ }));
    const connect = within(drawer).getByRole('button', { name: /Connect/ });
    await waitFor(() => expect(connect).toBeEnabled());
    await userEvent.click(connect);
    await userEvent.click(await screen.findByRole('button', { name: 'Start new session' }));
    const open = await screen.findByRole('button', { name: 'Start session', exact: true });
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    await waitFor(() => expect(screen.getByTestId('route').textContent).toMatch(/^\/s\//));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    expect(api.listenerCount()).toBe(0);
    expect(api.connect).toHaveBeenCalledOnce();
  });

  it('Sessions tab handoff also tears down the owner', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open MCP Catalog' }));
    const modal = await findCatalogModal();
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    await waitFor(() =>
      expect(modal.getAnimations().some((animation) => animation.playState === 'running')).toBe(
        false
      )
    );
    await activateTab(/Sessions/);
    const destination = await screen.findByRole('button', {
      name: 'Open session Catalog destination',
    });
    await userEvent.click(destination);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.listenerCount()).toBe(0);
    await waitFor(() => expect(screen.getByTestId('route').textContent).toMatch(/^\/s\//));
  });

  it.each(['/catalog/sessions', '/marketplace/credentials'])(
    'never auto-opens or normalizes %s',
    async (path) => {
      const api = makeCatalogClient();
      render(<CatalogHarness client={api.client} path={path} />);
      await act(() => Promise.resolve());
      expect(screen.getByTestId('route')).toHaveTextContent(path);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.overviewRead).not.toHaveBeenCalled();
    }
  );
});
