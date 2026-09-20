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
    // If description shared the toolbar row (the old layout), its nearest block
    // container would also hold the search input. It must not.
    expect(description.closest('div')).not.toContainElement(search);
  });

  it('renders the structured slots: title, count, and the primary action', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(<ResponsiveSettingsHeader {...slots} />);

    expect(screen.getByRole('heading', { name: 'Boards' })).toBeInTheDocument();
    expect(screen.getByText('3 boards')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Board' })).toBeInTheDocument();
  });

  it('bounds the search width on desktop (header owns the width)', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(<ResponsiveSettingsHeader {...slots} />);

    expect(screen.getByRole('textbox', { name: 'Search' }).closest('div')).toHaveStyle({
      width: '320px',
    });
  });

  it('stacks and gives the search full width on narrow screens', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: false });
    render(<ResponsiveSettingsHeader {...slots} />);

    expect(screen.getByRole('textbox', { name: 'Search' }).closest('div')).toHaveStyle({
      width: '100%',
    });
  });
});
