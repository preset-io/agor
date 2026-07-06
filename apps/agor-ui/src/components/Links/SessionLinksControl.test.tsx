import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import { LinkRow } from './SessionLinksControl';

const uploadMarkdownItem: LinkDisplayItem = {
  key: 'link-1',
  name: 'notes.md',
  targetKey: 'file:notes.md',
  category: 'markdown',
  source: 'upload',
  ownerScope: 'session',
  isPinned: true,
  filePath: 'notes.md',
  linkId: 'link-1',
};

describe('LinkRow', () => {
  it('keeps the body preview action separate from the pin action', () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();
    const onTogglePinned = vi.fn();

    render(
      <MemoryRouter>
        <LinkRow
          item={uploadMarkdownItem}
          onPreview={onPreview}
          onDownload={onDownload}
          onTogglePinned={onTogglePinned}
        />
      </MemoryRouter>
    );

    const previewButtons = screen.getAllByRole('button', { name: /preview notes\.md/i });
    expect(previewButtons).toHaveLength(2);

    fireEvent.click(previewButtons[0]);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();
    expect(onTogglePinned).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /unpin from session notes\.md/i }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onTogglePinned).toHaveBeenCalledTimes(1);

    fireEvent.click(previewButtons[1]);
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onTogglePinned).toHaveBeenCalledTimes(1);
  });
});
