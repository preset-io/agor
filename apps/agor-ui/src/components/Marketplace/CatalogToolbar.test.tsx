import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogToolbar } from './CatalogToolbar';

function selectInput(label: string): HTMLElement {
  const input = document.querySelector(`input[aria-label="${label}"]`);
  if (!(input instanceof HTMLElement)) throw new Error(`${label} select not found`);
  return input;
}

function openSelect(label: string): void {
  fireEvent.mouseDown(selectInput(label));
}

function selectOption(label: string): void {
  const option = Array.from(document.querySelectorAll('.ant-select-item-option-content')).find(
    (node) => node.textContent === label
  );
  if (!(option instanceof HTMLElement)) throw new Error(`${label} option not found`);
  fireEvent.click(option);
}

describe('Marketplace catalog toolbar', () => {
  it('publishes category choices from the Category select and resets to All', () => {
    const onCategoryChange = vi.fn();
    const props = {
      category: 'observability' as const,
      sort: 'popularity' as const,
      search: '',
      onSearchChange: vi.fn(),
      onCategoryChange,
      onCapabilityChange: vi.fn(),
      onSortChange: vi.fn(),
      matchSummary: null,
    };
    render(<CatalogToolbar {...props} />);

    const select = selectInput('Filter by category').closest('.ant-select') as HTMLElement;
    expect(within(select).getByText('Category')).toBeVisible();
    expect(within(select).getByText('Observability')).toBeVisible();
    openSelect('Filter by category');
    selectOption('Dev tools');
    expect(onCategoryChange).toHaveBeenLastCalledWith('dev-tools');

    openSelect('Filter by category');
    selectOption('All');
    expect(onCategoryChange).toHaveBeenLastCalledWith(undefined);
  });

  it('groups the capability vocabulary and publishes a selected capability', () => {
    const onCapabilityChange = vi.fn();
    render(
      <CatalogToolbar
        sort="popularity"
        search=""
        onSearchChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onCapabilityChange={onCapabilityChange}
        onSortChange={vi.fn()}
        matchSummary={null}
      />
    );

    const capability = selectInput('Filter by capability').closest('.ant-select') as HTMLElement;
    expect(within(capability).getByText('Capability')).toBeVisible();
    expect(within(capability).getByText('Any')).toBeVisible();

    openSelect('Filter by capability');
    const input = selectInput('Filter by capability');
    expect(document.querySelector('.ant-select-item-group')).toHaveTextContent('Building software');

    fireEvent.change(input, { target: { value: 'Databases' } });
    expect(document.querySelector('.ant-select-item-group')).toHaveTextContent('Data');

    fireEvent.change(input, { target: { value: 'Logs' } });
    expect(document.querySelector('.ant-select-item-group')).toHaveTextContent(
      'Knowing what is happening'
    );
    selectOption('Logs');

    expect(onCapabilityChange.mock.calls.at(-1)?.[0]).toBe('logs');
  });

  it('labels the default ordering Curated, changes sorting, and renders match context', () => {
    const onSortChange = vi.fn();
    render(
      <CatalogToolbar
        sort="popularity"
        search=""
        onSearchChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onCapabilityChange={vi.fn()}
        onSortChange={onSortChange}
        matchSummary={{ matched: 3, total: 52 }}
      />
    );

    const sort = selectInput('Sort servers').closest('.ant-select') as HTMLElement;
    expect(within(sort).getByText('Sort')).toBeVisible();
    expect(within(sort).getByText('Curated')).toBeVisible();
    expect(screen.getByText('3 of 52 servers match')).toBeVisible();
    openSelect('Sort servers');
    selectOption('A–Z');

    expect(onSortChange.mock.calls.at(-1)?.[0]).toBe('name');
  });

  it('supports clearing search and capability and resetting category and sort', () => {
    const onSearchChange = vi.fn();
    const onCategoryChange = vi.fn();
    const onCapabilityChange = vi.fn();
    const onSortChange = vi.fn();
    const { container } = render(
      <CatalogToolbar
        category="search"
        capability="web-search"
        sort="name"
        search="documentation"
        onSearchChange={onSearchChange}
        onCategoryChange={onCategoryChange}
        onCapabilityChange={onCapabilityChange}
        onSortChange={onSortChange}
        matchSummary={{ matched: 1, total: 52 }}
      />
    );

    fireEvent.click(container.querySelector('.ant-input-clear-icon')!);
    expect(onSearchChange).toHaveBeenLastCalledWith('');

    const capability = selectInput('Filter by capability');
    fireEvent.mouseEnter(capability.closest('.ant-select')!);
    fireEvent.click(
      within(capability.closest('.ant-select')!).getByRole('button', { name: 'Clear' })
    );
    expect(onCapabilityChange).toHaveBeenLastCalledWith(undefined);

    openSelect('Filter by category');
    selectOption('All');
    expect(onCategoryChange).toHaveBeenLastCalledWith(undefined);

    openSelect('Sort servers');
    selectOption('Curated');
    expect(onSortChange.mock.calls.at(-1)?.[0]).toBe('popularity');
  });
});
