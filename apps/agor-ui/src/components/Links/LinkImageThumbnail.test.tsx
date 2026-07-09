import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkImageThumbnail } from './LinkImageThumbnail';

describe('LinkImageThumbnail', () => {
  it('does not download image content before click-to-preview', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onOpen = vi.fn();

    render(
      <LinkImageThumbnail
        linkId="link-1"
        title="screenshot.png"
        subtitle="/home/agor/.agor/uploads/screenshot.png"
        onOpen={onOpen}
      />
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Click to preview')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /open image preview for screenshot\.png/i })
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith({
      linkId: 'link-1',
      title: 'screenshot.png',
      subtitle: 'screenshot.png',
    });

    fetchSpy.mockRestore();
  });
});
