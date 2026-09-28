import { render, screen } from '@testing-library/react';
import { Button, Grid, Input, Select } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

describe('ResponsiveSettingsHeader', () => {
  afterEach(() => vi.restoreAllMocks());

  const slots = {
    title: 'Boards',
    description: 'Create and manage boards for organizing sessions.',
    search: <Input aria-label="Search" />,
    filters: <Select aria-label="Filter" options={[{ value: 'active', label: 'Active' }]} />,
    count: '3 boards',
    primaryActions: <Button>New Board</Button>,
  };

  it('renders the description on its own line, never beside the toolbar (the reported bug)', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(<ResponsiveSettingsHeader {...slots} />);

    const description = screen.getByText('Create and manage boards for organizing sessions.');
    const search = screen.getByRole('textbox', { name: 'Search' });
    expect(description.closest('div')).not.toContainElement(search);
  });

  it('renders the structured slots: title, count, and the primary action', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(<ResponsiveSettingsHeader {...slots} />);

    expect(screen.getByRole('heading', { name: 'Boards' })).toBeInTheDocument();
    expect(screen.getByText('3 boards')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Board' })).toBeInTheDocument();
  });

  it('places the primary action on the title row (before the description) when a title is given', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(<ResponsiveSettingsHeader {...slots} />);

    const action = screen.getByRole('button', { name: 'New Board' });
    const description = screen.getByText('Create and manage boards for organizing sessions.');
    // The header-row action precedes the description in DOM order.
    expect(
      action.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('falls back to the toolbar for the primary action when no title is passed', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(
      <ResponsiveSettingsHeader
        description="Manage personal API keys."
        search={<Input aria-label="Search" />}
        count="2 keys"
        primaryActions={<Button>Create New Key</Button>}
      />
    );

    const action = screen.getByRole('button', { name: 'Create New Key' });
    const description = screen.getByText('Manage personal API keys.');
    expect(action).toBeInTheDocument();
    // No title → the action follows the description (it's in the toolbar row).
    expect(
      description.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('bounds the search width on desktop and goes full-width on narrow screens', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    const { rerender } = render(<ResponsiveSettingsHeader {...slots} />);
    expect(screen.getByRole('textbox', { name: 'Search' }).closest('div')).toHaveStyle({
      width: '320px',
    });

    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: false });
    rerender(<ResponsiveSettingsHeader {...slots} />);
    expect(screen.getByRole('textbox', { name: 'Search' }).closest('div')).toHaveStyle({
      width: '100%',
    });
  });
});
