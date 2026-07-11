import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkContentPreviewModal } from './LinkContentPreviewModal';
import * as linkContent from './linkContent';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LinkContentPreviewModal', () => {
  it('preserves plain-text formatting when the shared preview handles a text link', async () => {
    const fetchText = vi
      .spyOn(linkContent, 'fetchLinkMarkdownText')
      .mockResolvedValue('# Not a heading');

    const { rerender } = render(
      <LinkContentPreviewModal
        target={{ linkId: 'link-1', title: 'notes.txt' }}
        kind="text"
        onClose={vi.fn()}
      />
    );

    const content = await screen.findByText('# Not a heading');
    expect(content.tagName).toBe('PRE');
    expect(screen.queryByRole('heading', { name: 'Not a heading' })).not.toBeInTheDocument();

    rerender(
      <LinkContentPreviewModal
        target={{ linkId: 'link-1', title: 'renamed-notes.txt' }}
        kind="text"
        onClose={vi.fn()}
      />
    );
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('revokes an image object URL that resolves after the preview closes', async () => {
    let resolveImage!: (value: string) => void;
    vi.spyOn(linkContent, 'fetchLinkImageObjectUrl').mockReturnValue(
      new Promise((resolve) => {
        resolveImage = resolve;
      })
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { unmount } = render(
      <LinkContentPreviewModal
        target={{ linkId: 'link-image', title: 'image.png' }}
        kind="image"
        onClose={vi.fn()}
      />
    );

    unmount();
    resolveImage('blob:late-preview');

    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:late-preview'));
  });
});
