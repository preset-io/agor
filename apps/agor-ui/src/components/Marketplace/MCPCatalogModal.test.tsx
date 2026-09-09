import type { UserID } from '@agor/core/types';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogHarness, catalogUser, makeCatalogClient } from './MCPCatalogModal.test-fixtures';

configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

describe('app-owned MCP Catalog', () => {
  it('mounts on demand, shares four tabs, releases subscriptions/timers and resets on reopen', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    expect(api.listenerCount()).toBe(0);
    const trigger = screen.getByRole('button', { name: 'Open MCP Catalog' });
    trigger.focus();
    fireEvent.click(trigger);
    const modal = await screen.findByRole('dialog', { name: 'MCP Catalog' });
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    expect(api.listenerCount()).toBeGreaterThan(0);
    expect(
      within(modal)
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Catalog', 'My Servers (1)', 'Sessions (1)', 'Credentials (1)']);
    // Schedule realtime revalidation just before closing; teardown cancels it.
    act(() => api.emit('socket:marketplace:changed'));
    fireEvent.click(within(modal).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(api.listenerCount()).toBe(0));
    await waitFor(() => expect(trigger).toHaveFocus());
    const reads = api.overviewRead.mock.calls.length;
    act(() => window.dispatchEvent(new Event('focus')));
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(api.overviewRead).toHaveBeenCalledTimes(reads);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'MCP Catalog' });
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(api.overviewRead.mock.calls.length).toBeGreaterThan(reads));
  });

  it('hands Credentials off to My Servers without navigation and restores the settings action', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open MCP Catalog' }));
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    fireEvent.click(screen.getByRole('tab', { name: /Credentials/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Settings OAuth connection for Saved DeepWiki' })
    );
    const drawer = await screen.findByRole('dialog', { name: /Server settings/ });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Settings for Saved DeepWiki' })).toHaveFocus()
    );
    expect(screen.getByRole('tab', { name: /My Servers/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('route').textContent).toBe('/');
  }, 30_000);

  it('does not claim credentials are empty before the first caller-scoped read completes', async () => {
    const api = makeCatalogClient();
    api.overviewRead.mockReturnValueOnce(new Promise(() => {}));
    render(<CatalogHarness client={api.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open MCP Catalog' }));
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    fireEvent.click(screen.getByRole('tab', { name: 'Credentials' }));
    expect(screen.queryByText('No saved Catalog credentials')).not.toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Saved MCP credential metadata' })
    ).toBeInTheDocument();
  });

  // Real Select, Modal and Sessions-tab mounts can exceed 15s under CI CPU contention.
  it('closes the session disclosure before Catalog and restores the stable MCP trigger', async () => {
    const api = makeCatalogClient();
    render(<CatalogHarness client={api.client} />);
    const trigger = screen.getByRole('button', { name: /^MCP servers\./ });
    fireEvent.click(trigger);
    const disclosure = screen.getByRole('dialog', { name: 'Session MCP servers' });
    fireEvent.change(within(disclosure).getByRole('combobox'), { target: { value: 'no-match' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Browse the MCP Catalog for all available MCPs' })
    );
    expect(screen.queryByRole('dialog', { name: 'Session MCP servers' })).not.toBeInTheDocument();
    const modal = await screen.findByRole('dialog', { name: 'MCP Catalog' });
    fireEvent.click(within(modal).getByRole('tab', { name: /Sessions/ }));
    fireEvent.click(within(modal).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }, 30_000);

  it('discards caller-private modal state synchronously on identity replacement', async () => {
    const api = makeCatalogClient();
    const view = render(<CatalogHarness client={api.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open MCP Catalog' }));
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    view.rerender(
      <CatalogHarness client={api.client} user={{ ...catalogUser, user_id: 'bob' as UserID }} />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.listenerCount()).toBe(0);
  });

  it.each(['/catalog', '/catalog/sessions', '/marketplace/credentials'])(
    'does not auto-open or normalize removed URL %s',
    (path) => {
      const api = makeCatalogClient();
      render(<CatalogHarness client={api.client} path={path} />);
      expect(screen.getByTestId('route')).toHaveTextContent(path);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.overviewRead).not.toHaveBeenCalled();
    }
  );
});
