import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkContentPreviewModal } from './LinkContentPreviewModal';
import * as linkContent from './linkContent';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LinkContentPreviewModal', () => {
  it('preserves plain-text formatting when the shared preview handles a text link', async () => {
    vi.spyOn(linkContent, 'fetchLinkMarkdownText').mockResolvedValue('# Not a heading');

    render(
      <LinkContentPreviewModal
        target={{ linkId: 'link-1', title: 'notes.txt' }}
        kind="text"
        onClose={vi.fn()}
      />
    );

    const content = await screen.findByText('# Not a heading');
    expect(content.tagName).toBe('PRE');
    expect(screen.queryByRole('heading', { name: 'Not a heading' })).not.toBeInTheDocument();
  });
});
