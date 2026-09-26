import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { MCPCatalogModal } from './MCPCatalogModal';
import { catalogEntry, catalogUser, makeCatalogClient } from './MCPCatalogModal.test-fixtures';

// Native keyboard/pointer sequences must not be batched in React act.
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(cleanup);

it.each(['loading', 'empty', 'populated'] as const)(
  'keeps the %s Catalog inside its horizontal scroll boundary',
  async (state) => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      ...catalogEntry,
      name: `com.example/server-${index}`,
      title: `Server ${index}`,
    }));
    const api = makeCatalogClient(state === 'empty' ? [] : entries);
    if (state === 'loading') {
      vi.spyOn(api.client.service('mcp-catalog'), 'find').mockImplementation(
        () => new Promise(() => {})
      );
    }
    render(
      <ConfigProvider>
        <App>
          <MemoryRouter>
            <MCPCatalogModal
              client={api.client}
              connected
              connecting={false}
              authGeneration={1}
              currentUser={catalogUser}
              open
              onClose={vi.fn()}
              afterClose={vi.fn()}
              onOpenSession={vi.fn()}
            />
          </MemoryRouter>
        </App>
      </ConfigProvider>
    );
    if (state === 'populated') await screen.findByRole('button', { name: 'Open Server 0' });
    if (state === 'empty') await screen.findByText('No servers in the catalog yet');
    const modal = screen.getByRole('dialog');
    const body = modal.querySelector<HTMLElement>('.ant-modal-body');
    if (!body) throw new Error('Catalog modal body missing');
    await waitFor(() => expect(modal.className).not.toContain('ant-zoom'));
    // The body is the intended vertical scroller. Check its content too, so
    // clipping an oversized grid cannot make this regression pass.
    const boundaries = [document.documentElement, modal, body, screen.getByRole('tabpanel')];
    for (const element of boundaries) {
      expect(element.scrollWidth, `${state}: ${element.className}`).toBeLessThanOrEqual(
        element.clientWidth + 1
      );
    }
    if (state === 'populated') {
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      const lastCard = screen.getByRole('button', { name: 'Open Server 23' });
      lastCard.focus();
      expect(lastCard).toHaveFocus();
      expect(body.scrollTop).toBeGreaterThan(0);
      const bounds = lastCard.getBoundingClientRect();
      const bodyBounds = body.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(bodyBounds.left);
      expect(bounds.right).toBeLessThanOrEqual(bodyBounds.right + 1);
      const search = screen.getByRole('textbox', { name: 'Search MCP servers' });
      await userEvent.fill(search, 'no-such-provider');
      await screen.findByText('No servers match');
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
    }
  }
);
