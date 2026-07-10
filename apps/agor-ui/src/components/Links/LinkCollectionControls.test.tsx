import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getLinkCategoryOptions, LinkCollectionControls } from './LinkCollectionControls';
import type { LinkCategoryTabKey } from './linkOrganizer';

const counts: Record<LinkCategoryTabKey, number> = {
  all: 5,
  files: 2,
  links: 1,
  knowledge: 1,
  issues: 1,
};

describe('LinkCollectionControls', () => {
  it('builds stable category options and reports category/search changes', () => {
    const onCategoryChange = vi.fn();
    const onSearchChange = vi.fn();

    render(
      <LinkCollectionControls
        categoryCounts={counts}
        activeCategory="all"
        onCategoryChange={onCategoryChange}
        searchQuery=""
        onSearchChange={onSearchChange}
        sortOrder="az"
        onSortChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Files 2'));
    expect(onCategoryChange).toHaveBeenCalledWith('files');

    fireEvent.change(screen.getByLabelText('Search links'), { target: { value: 'report' } });
    expect(onSearchChange).toHaveBeenCalledWith('report');

    expect(getLinkCategoryOptions(counts).map(({ value }) => value)).toEqual([
      'all',
      'files',
      'links',
      'knowledge',
      'issues',
    ]);
  });
});
