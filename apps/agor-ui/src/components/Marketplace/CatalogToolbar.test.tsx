import { fireEvent, render, screen } from '@testing-library/react';
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
  it('publishes category choices from the Segmented control and resets to All', () => {
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

    expect(screen.getByText('Observability').closest('label')).toHaveClass(
      'ant-segmented-item-selected'
    );
    fireEvent.click(screen.getByText('Dev tools').closest('label')!);
    expect(onCategoryChange).toHaveBeenLastCalledWith('dev-tools');

    fireEvent.click(screen.getByText('All').closest('label')!);
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

    const sort = selectInput('Sort servers');
    expect(sort.parentElement).toHaveTextContent('Sort: Curated');
    expect(screen.getByText('3 of 52 servers match')).toBeVisible();
    openSelect('Sort servers');
    selectOption('Sort: A–Z');

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
    fireEvent.mouseDown(capability.closest('.ant-select')!.querySelector('.ant-select-clear')!);
    expect(onCapabilityChange).toHaveBeenLastCalledWith(undefined);

    fireEvent.click(screen.getByText('All').closest('label')!);
    expect(onCategoryChange).toHaveBeenLastCalledWith(undefined);

    openSelect('Sort servers');
    selectOption('Sort: Curated');
    expect(onSortChange.mock.calls.at(-1)?.[0]).toBe('popularity');
  });
});
