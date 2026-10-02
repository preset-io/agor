import { cleanup, configure, render, screen, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { CatalogTab } from './CatalogTab';
import { MCPCatalogModal } from './MCPCatalogModal';
import { catalogEntry, catalogUser, makeCatalogClient } from './MCPCatalogModal.test-fixtures';

beforeEach(() => {
  // Browser events run outside React's synthetic act environment.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

const NO_MOTION = { token: { motion: false } };

it.each([1440, 390])(
  'clears filters to All/Any and updates results without losing search or sort at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    const { client } = makeCatalogClient([
      catalogEntry,
      { ...catalogEntry, name: 'test/a', title: 'Keep A' },
      { ...catalogEntry, name: 'test/b', title: 'Keep B', category: 'search' },
      {
        ...catalogEntry,
        name: 'test/c',
        title: 'Keep C',
        category: 'search',
        capabilities: ['logs'],
      },
    ]);
    render(
      <ConfigProvider theme={NO_MOTION}>
        <MemoryRouter>
          <CatalogTab
            client={client}
            connected
            connecting={false}
            authGeneration={1}
            currentUser={catalogUser}
          />
        </MemoryRouter>
      </ConfigProvider>
    );
    await screen.findByRole('button', { name: 'Open DeepWiki' });
    await userEvent.fill(screen.getByRole('textbox', { name: 'Search MCP servers' }), 'keep');
    if (width === 390) await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const select = (name: string) => screen.getByRole('combobox', { name });
    const control = (name: string) => select(name).closest<HTMLElement>('.ant-select')!;
    const choose = async (name: string, option: string) => {
      await userEvent.click(select(name));
      const popup = document
        .getElementById(select(name).getAttribute('aria-controls')!)
        ?.closest<HTMLElement>('.ant-select-dropdown');
      if (!popup) throw new Error(`${name} popup not found`);
      await userEvent.click(within(popup).getByText(option, { exact: true }));
    };
    const category = control('Filter by category');
    const capability = control('Filter by capability');
    expect(within(category).getByText('All')).toBeVisible();
    expect(within(capability).getByText('Any')).toBeVisible();
    expect(category.querySelector('.ant-select-clear')).toBeNull();
    expect(capability.querySelector('.ant-select-clear')).toBeNull();
    await choose('Sort servers', 'A–Z');
    await choose('Filter by category', 'Dev tools');
    await choose('Filter by capability', 'Docs');

    const expectResults = async (count: number) => {
      await screen.findByText(`${count} of 4 servers match`);
      const cards = screen.getAllByRole('button', { name: /^Open Keep/ });
      expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(
        ['Open Keep A', 'Open Keep B', 'Open Keep C'].slice(0, count)
      );
      expect(screen.queryByRole('button', { name: 'Open DeepWiki' })).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Search MCP servers' })).toHaveValue('keep');
      expect(control('Sort servers')).toHaveTextContent('A–Z');
      if (width === 390) {
        expect(
          screen.getByRole('button', {
            name: count === 1 ? 'Filters, 2 active' : count === 2 ? 'Filters, 1 active' : 'Filters',
          })
        ).toBeVisible();
        expect(
          screen.getByRole('button', {
            name: `Show ${count} ${count === 1 ? 'server' : 'servers'}`,
          })
        ).toBeVisible();
        if (count === 3) expect(document.querySelector('.ant-badge-count')).toBeNull();
        else
          expect(document.querySelector('.ant-badge-count')).toHaveTextContent(String(3 - count));
      }
    };
    await expectResults(1);
    await userEvent.hover(category);
    await userEvent.click(category.querySelector<HTMLElement>('.ant-select-clear')!);
    expect(within(category).getByText('All')).toBeVisible();
    expect(category.querySelector('.ant-select-clear')).toBeNull();
    expect(within(capability).getByText('Docs')).toBeVisible();
    await expectResults(2);
    await userEvent.hover(capability);
    await userEvent.click(capability.querySelector<HTMLElement>('.ant-select-clear')!);
    expect(within(capability).getByText('Any')).toBeVisible();
    expect(capability.querySelector('.ant-select-clear')).toBeNull();
    await expectResults(3);
  }
);

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

function ModalHarness({ motion }: { motion: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfigProvider theme={{ token: { motion } }}>
      <App>
        <MemoryRouter>
          <MCPCatalogModal
            client={makeCatalogClient().client}
            connected
            connecting={false}
            authGeneration={1}
            currentUser={catalogUser}
            open={open}
            onClose={() => setOpen(false)}
            afterClose={vi.fn()}
            onOpenSession={vi.fn()}
          />
        </MemoryRouter>
      </App>
    </ConfigProvider>
  );
}

async function openFiltersWithKeyboard() {
  await screen.findByRole('button', { name: 'Open DeepWiki' });
  screen.getByRole('textbox', { name: 'Search MCP servers' }).focus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Filters' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  return screen.findByRole('dialog', { name: 'Filters' });
}

it.each([true, false])(
  'enters the sheet and unwinds popup, sheet, then host with Escape (motion: %s)',
  async (motion) => {
    await page.viewport(390, 900);
    render(<ModalHarness motion={motion} />);
    const sheet = await openFiltersWithKeyboard();
    const category = within(sheet).getByRole('combobox', { name: 'Filter by category' });
    await expect.poll(() => document.activeElement).toBe(category);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await screen.findByRole('button', { name: 'Filters, 1 active' });
    await userEvent.keyboard('{ArrowDown}');
    expect(category).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => category.getAttribute('aria-expanded')).toBe('false');
    // Escape belongs to the popup until its exit animation releases the portal.
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.ant-select-dropdown')).every(
          (popup) => getComputedStyle(popup).display === 'none'
        )
      )
      .toBe(true);
    expect(sheet).toBeVisible();
    expect(category).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'MCP Catalog' })).toBeVisible();
    await expect
      .poll(() => document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Filters, 1 active' }));
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => screen.queryByRole('dialog', { name: 'MCP Catalog' })).toBeNull();
  }
);

it('transfers sheet focus into the full toolbar when the container widens', async () => {
  await page.viewport(390, 900);
  render(<ModalHarness motion />);
  const sheet = await openFiltersWithKeyboard();
  const category = within(sheet).getByRole('combobox', { name: 'Filter by category' });
  // Wait for sheet entry (and the enclosing modal animation) before resizing.
  await expect.poll(() => document.activeElement).toBe(category);
  await page.viewport(1440, 900);
  await expect.poll(() => screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
  const search = screen.getByRole('textbox', { name: 'Search MCP servers' });
  await expect.poll(() => document.activeElement).toBe(search);
  await userEvent.tab();
  expect(screen.getByRole('combobox', { name: 'Filter by category' })).toHaveFocus();
  // The sheet must not reopen when returning to the narrow layout.
  await page.viewport(390, 900);
  await screen.findByRole('button', { name: 'Filters' });
  expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
});

it('does not steal background focus when widening a closed sheet', async () => {
  await page.viewport(390, 900);
  render(<ModalHarness motion={false} />);
  const sheet = await openFiltersWithKeyboard();
  await expect
    .poll(() => document.activeElement)
    .toBe(within(sheet).getByRole('combobox', { name: 'Filter by category' }));
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
  const catalogTab = screen.getByRole('tab', { name: 'Catalog' });
  catalogTab.focus();
  expect(catalogTab).toHaveFocus();
  await page.viewport(1440, 900);
  await expect.poll(() => screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
  expect(catalogTab).toHaveFocus();
});

it('keeps sheet controls and footer reachable at a short height', async () => {
  await page.viewport(390, 390);
  render(<ModalHarness motion={false} />);
  const sheet = await openFiltersWithKeyboard();
  const category = within(sheet).getByRole('combobox', { name: 'Filter by category' });
  await expect.poll(() => document.activeElement).toBe(category);
  await userEvent.tab();
  expect(within(sheet).getByRole('combobox', { name: 'Filter by capability' })).toHaveFocus();
  await userEvent.tab();
  const sort = within(sheet).getByRole('combobox', { name: 'Sort servers' });
  expect(sort).toHaveFocus();
  // The popup and its active option mount asynchronously. Send the next key
  // only once the previous action has committed, including on a busy runner.
  await userEvent.keyboard('{ArrowDown}');
  await expect.poll(() => sort.getAttribute('aria-expanded')).toBe('true');
  await userEvent.keyboard('{ArrowDown}');
  await expect
    .poll(() =>
      document
        .getElementById(sort.getAttribute('aria-activedescendant') ?? '')
        ?.getAttribute('aria-label')
    )
    .toBe('A–Z');
  await userEvent.keyboard('{Enter}');
  const reset = within(sheet).getByRole('button', { name: 'Reset' });
  await expect.poll(() => reset.hasAttribute('disabled')).toBe(false);
  await expect.poll(() => sort.getAttribute('aria-expanded')).toBe('false');
  await userEvent.tab();
  expect(reset).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await userEvent.tab();
  const show = within(sheet).getByRole('button', { name: 'Show 1 server' });
  expect(show).toHaveFocus();
  for (const control of [category, sort, reset, show]) {
    const rect = control.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(
      control.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    ).toBe(true);
  }
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Filters' })).toHaveFocus();
});
