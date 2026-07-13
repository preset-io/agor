import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkAttachmentCard } from './LinkAttachmentCard';

describe('LinkAttachmentCard', () => {
  it('renders an Ant Design action and opens the resolved target', () => {
    const onOpenTarget = vi.fn();
    render(
      <LinkAttachmentCard
        kind="url"
        title="Runbook"
        url="https://example.com/runbook"
        compact
        onDark
        onOpenTarget={onOpenTarget}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Runbook' }));
    expect(onOpenTarget).toHaveBeenCalledWith({
      href: 'https://example.com/runbook',
      navigation: 'external',
    });
  });

  it('preserves the preview kind when opening uploaded text', () => {
    const onOpenPreview = vi.fn();
    render(
      <LinkAttachmentCard
        kind="document"
        source="upload"
        linkId="link-1"
        title="notes.txt"
        filePath="notes.txt"
        mimeType="text/plain"
        onOpenPreview={onOpenPreview}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview notes.txt' }));
    expect(onOpenPreview).toHaveBeenCalledWith(
      { linkId: 'link-1', title: 'notes.txt', subtitle: 'notes.txt' },
      'text'
    );
  });

  it('names uploaded binary actions as downloads', () => {
    render(
      <LinkAttachmentCard
        kind="document"
        source="upload"
        linkId="link-2"
        title="report.pdf"
        filePath="report.pdf"
        mimeType="application/pdf"
      />
    );

    expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeInTheDocument();
  });
});
