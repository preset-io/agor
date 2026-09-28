import { cleanup, render, screen } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CatalogTab } from './CatalogTab';
import { MCPCatalogModal } from './MCPCatalogModal';
import { catalogUser, makeCatalogClient } from './MCPCatalogModal.test-fixtures';

afterEach(cleanup);

const NO_MOTION = { token: { motion: false } };

/** The toolbar is one control row that never overflows; returns which of its two states it is in. */
function expectOneControlRow(): 'full' | 'collapsed' {
  const search = screen
    .getByRole('textbox', { name: 'Search MCP servers' })
    .closest<HTMLElement>('.ant-input-affix-wrapper');
  const row = search?.parentElement;
  if (!search || !row) throw new Error('Toolbar row not found');
  const rects = Array.from(row.children).map((control) => control.getBoundingClientRect());
  for (const rect of rects) {
    expect(Math.round(rect.height)).toBe(32);
    expect(Math.round(rect.top)).toBe(Math.round(rects[0].top));
  }
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  if (rects.length === 2) {
    expect(row).toContainElement(screen.getByRole('button', { name: 'Filters' }));
    return 'collapsed';
  }
  expect(rects).toHaveLength(4);
  return 'full';
}

it.each([
  [1440, 'full'],
  [1024, 'full'],
  [820, 'full'],
  [600, 'collapsed'],
  [390, 'collapsed'],
] as const)('keeps the catalog toolbar to one row at %ipx', async (width, state) => {
  await page.viewport(width, 900);
  render(
    <ConfigProvider theme={NO_MOTION}>
      <MemoryRouter>
        <CatalogTab
          client={makeCatalogClient().client}
          connected
          startingSession={false}
          startSessionError={null}
          connecting={false}
          authGeneration={1}
          currentUser={catalogUser}
        />
      </MemoryRouter>
    </ConfigProvider>
  );
  await screen.findByRole('button', { name: 'Open DeepWiki' });
  expect(expectOneControlRow()).toBe(state);
});

it.each([
  [1440, 'full'],
  [820, 'collapsed'],
  [390, 'collapsed'],
] as const)(
  'collapses by container width inside the catalog modal at %ipx',
  async (width, state) => {
    await page.viewport(width, 900);
    render(
      <ConfigProvider theme={NO_MOTION}>
        <App>
          <MemoryRouter>
            <MCPCatalogModal
              client={makeCatalogClient().client}
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
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    expect(expectOneControlRow()).toBe(state);
  }
);
